import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { configIdentity } from "../../src/server/classification/orchestrator.ts";
const repository = fileURLToPath(new URL("../../", import.meta.url));
let root = "", privateRoot = "";
beforeAll(async () => {
  // .cache is gitignored, so a fresh checkout (CI) does not have it.
  await mkdir(join(repository, ".cache"), { recursive: true });
  root = await mkdtemp(join(repository, ".cache", "classification-entry-"));
  for (const part of ["src", "scripts", "config"]) await cp(join(repository, part), join(root, part), { recursive: true });
  privateRoot = join(root, ".cache", "classification", "private"); await mkdir(privateRoot, { recursive: true });
  await writeFile(join(privateRoot, "invalid.json"), '{"unknown":true}');
  await writeFile(join(privateRoot, "calls.json"), "0");
  await writeFile(join(root, "scripts", "classification-effects.ts"), `
    import { writeFile } from 'node:fs/promises';
    import { classifyBounded } from '../src/server/classification/orchestrator.ts';
    export async function classificationEffects() { return { run: async (config, startingBalance, signal, startingUnknown) => {
      if (config.phase === 'A') return { code:'complete', processed:0, rejected:0, calls:0, spend:{actual:0,unknown:0} };
      let calls = 0; const item = { title:'Synthetic film', release_year:2000, overview:'Synthetic', genres:[], keywords:[], runtime_minutes:100, us_certification:'PG', original_language:'en', credits:[] };
      if (config.configId === 'cancel-test') setTimeout(() => process.emit('SIGINT'), 20);
      return classifyBounded({ config, startingBalance, startingUnknown, signal, items:[item,item,item], classifier: { classify: async () => {
        if (config.configId === 'cancel-test') return new Promise(() => {});
        calls++; await writeFile('.cache/classification/private/calls.json', String(calls)); return {status:'failed',retryable:false,cost:3};
      } } });
    } }; }
  `);
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
export function runClassification(cwd: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test" }; if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const child = spawn(process.execPath, [join(cwd, "scripts", "classification.ts"), ...args], { cwd, env, shell: false, windowsHide: true, timeout: 15000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", v => { stdout += v; }); child.stderr.setEncoding("utf8").on("data", v => { stderr += v; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
it("shipped config accepts both normal and lowercase Windows cwd paths", async () => {
  for (const cwd of process.platform === "win32" ? [root, root.toLowerCase()] : [root]) {
    const result = await runClassification(cwd, ["run", "--config", "config/classification.example.json"]);
    expect(result.code).toBe(0); expect(result.stdout).toContain("code=complete"); expect(result.stderr).toBe("");
  }
});
it.each(["anchors-import", "reviews-import", "anchors-ingest", "agreement", "coverage"])("%s real entry rejects malformed files without effects", async action => {
  const result = await runClassification(root, [action, "--input", join(privateRoot, "invalid.json"), ...(action === "agreement" || action === "coverage" ? ["--as-of", "2026-10-07T00:00:00.000Z"] : [])]);
  expect(result.code).toBe(1); expect(result.stdout).toContain("code=invalid_input"); expect(result.stderr).toBe("");
});
it.each(["run", "anchors-ingest"])("%s live entry refuses before credentials or provider", async action => {
  const result = await runClassification(root, [action, "--live"]);
  expect(result.code).toBe(1); expect(result.stdout).toContain(action === "run" ? "code=classifier_unconfigured" : "code=anchor_ingest_live_unavailable");
});
it.each(["anchors-template", "reviews-template"])("%s writes only on explicit flag and refuses overwrite", async action => {
  const path = join(privateRoot, `${action}.json`);
  const first = await runClassification(root, [action, "--output", path, "--write"]);
  expect(first.code).toBe(0);
  const repeat = await runClassification(root, [action, "--output", path, "--write"]);
  expect(repeat.code).toBe(1); expect(repeat.stdout).toContain("code=report_exists");
});
it("export real entry requires explicit store and rejects unknown flags", async () => {
  expect((await runClassification(root, ["export", "--as-of", "2026-10-07T00:00:00.000Z", "--read-local", "--output", join(privateRoot, "export.json")])).stdout).toContain("code=local_store_unconfigured");
  expect((await runClassification(root, ["run", "--surprise"])).stdout).toContain("code=invalid_arguments");
});
it("continuation without prior report refuses with zero fake transport calls", async () => {
  const config = { version: "classification-run-v1", phase: "B", candidates: ["synthetic"], configId: "synthetic-v1", spendCap: 10, perCallMaximum: 3,
    maxCalls: 3, maxAttempts: 3, attemptMs: 100, durationMs: 1000, continuation: true };
  await writeFile(join(privateRoot, "run.json"), JSON.stringify(config));
  const result = await runClassification(root, ["run", "--config", join(privateRoot, "run.json")]);
  expect(result.code).toBe(1); expect(result.stdout).toContain("code=prior_report_required");
  expect(await readFile(join(privateRoot, "calls.json"), "utf8")).toBe("0");
});
it("continuation process stops fake transport at the remaining phase cap", async () => {
  const config = JSON.parse(await readFile(join(privateRoot, "run.json"), "utf8"));
  await writeFile(join(privateRoot, "prior.json"), JSON.stringify({ version: "classification-spend-v1", phase: "B", candidates: ["synthetic"], configId: configIdentity(config), actual: 4, unknown: 0 }));
  const result = await runClassification(root, ["run", "--config", join(privateRoot, "run.json"), "--prior-report", join(privateRoot, "prior.json")]);
  expect(result.code).toBe(2); expect(result.stdout).toContain("code=spend_cap");
  expect(await readFile(join(privateRoot, "calls.json"), "utf8")).toBe("2");
});
it("real entry settles its SIGINT handler without claiming native Windows delivery", async () => {
  const config = JSON.parse(await readFile(join(privateRoot, "run.json"), "utf8"));
  await writeFile(join(privateRoot, "cancel.json"), JSON.stringify({ ...config, continuation: false, configId: "cancel-test" }));
  const result = await runClassification(root, ["run", "--config", join(privateRoot, "cancel.json")]);
  expect(result.code).toBe(2); expect(result.stdout).toContain("code=cancelled"); expect(result.stderr).toBe("");
});
