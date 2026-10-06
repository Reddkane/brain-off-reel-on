import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
const repository = fileURLToPath(new URL("../../", import.meta.url));
let root = "", emptyPath = "";
// A copied checkout inside .cache resolves node_modules but has no private credentials;
// an empty PATH makes every docker call fail before any container is touched.
beforeAll(async () => {
  await mkdir(join(repository, ".cache"), { recursive: true });
  root = await mkdtemp(join(repository, ".cache", "catalog-entry-test-"));
  for (const part of ["scripts", "src", "tooling/db-image.txt"])
    await cp(join(repository, part), join(root, part), { recursive: true });
  emptyPath = join(root, "empty-path");
  await mkdir(emptyPath);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
function run(args: string[]) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: emptyPath };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const child = spawn(process.execPath, [join(root, "scripts", "catalog-local.ts"), ...args], {
      cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 20000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
it.each([
  [["backup", "--phase", "before-upgrade"], "setup_credential_failed"],
  [["backup", "--phase", "after-upgrade"], "setup_credential_failed"],
  [["inspect"], "docker_failed"],
  [["setup"], "docker_failed"],
  [["upgrade"], "docker_failed"],
  [["start"], "docker_failed"],
  [["stop"], "docker_failed"],
  [["backup", "--phase", "during-upgrade"], "invalid_arguments"],
])("process entry %j settles with a fixed diagnostic", async (args, code) => {
  const result = await run(args);
  expect(result.stderr).not.toMatch(/unsettled top-level await/);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe(code);
  expect(result.code).toBe(1);
}, 30000);
