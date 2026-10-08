import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const cases = [
  { name: "validator", file: "src/domain/classification.ts", from: " || value < min || value > max", to: "", test: "tests/classification/core.test.ts" },
  { name: "provenance", file: "src/domain/classification.ts", from: "return [f, { basis, evidence_refs: refs }];", to: "return [f, { basis: basis.slice(0, 1), evidence_refs: refs }];", test: "tests/classification/core.test.ts" },
  { name: "personal_sentinel", file: "src/server/classification/codec.ts", from: 'hash({ version: "classification-input-v1", input })', to: 'hash({ version: "classification-input-v1", input, history: (value as { history?: unknown }).history })', test: "tests/classification/core.test.ts" },
  { name: "coverage_intersection", file: "src/domain/classification-reports.ts", from: "if (e.passing && current && ready) effectiveLinked++;", to: "if (e.passing && current) effectiveLinked++;", test: "tests/classification/reports.test.ts" },
];
function checksum(s: string) { return createHash("sha256").update(s).digest("hex"); }
function run(args: string[]) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, shell: false, timeout: 240000 }); let output = "";
    child.stdout.setEncoding("utf8").on("data", v => { output += v; }); child.stderr.setEncoding("utf8").on("data", v => { output += v; });
    child.on("error", reject); child.on("close", code => resolve({ code: code ?? 1, output }));
  });
}
await mkdir(".cache/classification/evidence", { recursive: true });
const lock = await open(".cache/classification/controls.lock", "wx");
try {
  for (const c of cases) {
    const original = await readFile(c.file, "utf8");
    if (original.split(c.from).length !== 2) throw new Error(`control_anchor_${c.name}`);
    let result;
    try { await writeFile(c.file, original.replace(c.from, c.to)); result = await run(["node_modules/vitest/vitest.mjs", "run", c.test]); }
    finally { await writeFile(c.file, original); if (checksum(await readFile(c.file, "utf8")) !== checksum(original)) throw new Error("control_restore_failed"); }
    await writeFile(`.cache/classification/evidence/control-${c.name}.log`, result.output);
    if (result.code === 0 || !result.output.includes("AssertionError")) throw new Error(`control_not_observed_${c.name}`);
    console.log(`control=${c.name} exit=${result.code} restored=true`);
  }
  const offline = await run(["node_modules/vitest/vitest.mjs", "run", "tests/classification"]);
  await writeFile(".cache/classification/evidence/controls-offline-green.log", offline.output);
  if (offline.code) throw new Error("control_final_offline_failed");
  const db = await run(["--test", "tests/db/classification.test.ts"]);
  await writeFile(".cache/classification/evidence/controls-db-green.log", db.output);
  if (db.code) throw new Error("control_final_db_failed");
  console.log("controls=4 offline=0 db=0 restored=true");
} finally { await lock.close(); await unlink(".cache/classification/controls.lock"); }
