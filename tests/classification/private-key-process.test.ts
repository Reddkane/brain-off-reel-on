import { cp, mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, relative, isAbsolute } from "node:path";
import { expect, it } from "vitest";
function child(command: string, args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string }>(resolve => execFile(command, args, { cwd, windowsHide: true, timeout: 15000,
    env: { NODE_ENV: "test", PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout: stdout + (error ? stderr || (!stdout ? String(error.code) : "") : "") })));
}
it("actual credential reader accepts private synthetic file and rejects broad permissions without printing key", async () => {
  const cache = join(process.cwd(), ".cache"); await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "classification-key-"));
  try {
    for (const part of ["scripts", "src"]) await cp(part, join(root, part), { recursive: true });
    const dir = join(root, ".cache/classification/private"); await mkdir(dir, { recursive: true });
    const file = join(dir, "anthropic.env"); await writeFile(file, "ANTHROPIC_API_KEY=synthetic-key-123\n", { mode: 0o600 });
    if (process.platform === "win32") {
      const setup = await child("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $p='.cache/classification/private/anthropic.env'; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleSpecific($r)}; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($u,'FullControl','Allow')); Set-Acl -LiteralPath $p -AclObject $a"], root);
      expect(setup).toEqual({ code: 0, stdout: "" });
    }
    const args = ["--input-type=module", "-e", "import {readAnthropicKey} from './scripts/classification-private.ts'; try { await readAnthropicKey(); console.log('present'); } catch { console.log('refused'); process.exitCode=1; }"];
    expect(await child(process.execPath, args, root)).toEqual({ code: 0, stdout: "present\n" });
    if (process.platform === "win32") {
      const broaden = await child("icacls.exe", [".cache/classification/private/anthropic.env", "/grant", "*S-1-5-32-545:R"], root);
      expect(broaden.code).toBe(0);
    } else await chmod(file, 0o644);
    expect(await child(process.execPath, args, root)).toEqual({ code: 1, stdout: "refused\n" });
  } finally {
    const owned = relative(cache, root); if (!owned.startsWith("classification-key-") || isAbsolute(owned)) throw new Error("test_cleanup_guard");
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
