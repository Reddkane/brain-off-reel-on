import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const repository = fileURLToPath(new URL("../../", import.meta.url));
/** Credential-free copy; tests may redirect only its effect composition to owned resources. */
export async function operatorCopy() {
  const cache = join(repository, ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "provider-seed-cli-"));
  async function cleanup() {
    const owned = relative(cache, root);
    assert(!isAbsolute(owned) && !owned.startsWith("..") && owned.startsWith("provider-seed-cli-"));
    await rm(root, { recursive: true, force: true });
  }
  try {
    for (const part of ["scripts", "src", "supabase/migrations", "tooling/db-image.txt", "tooling/metadata-disposable.ts"])
      await cp(join(repository, part), join(root, part), { recursive: true });
  }
  catch (error) { await cleanup(); throw error; }
  return {
    root,
    cleanup,
    run(script: string, args: string[]) {
      return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
        if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
        const child = spawn(process.execPath, [join(root, "scripts", script), ...args], {
          cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
        });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
  };
}
