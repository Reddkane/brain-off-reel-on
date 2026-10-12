import { lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { execFile } from "node:child_process";
import { ClassificationError } from "../src/domain/classification.ts";
import { decodeJson, hash } from "../src/server/classification/codec.ts";
import type { PhaseBConfig, PhaseBReport } from "../src/server/classification/phase-b.ts";
import { priorReport } from "../src/server/classification/phase-b.ts";
import { safePrivateDirectory } from "./private-directory.ts";

export async function classificationPath(name: string, write = false) {
  const root = resolve(".cache/classification/private"), path = resolve(root, name), rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel.split(sep).includes("..")) throw new ClassificationError("private_path_required");
  const parent = resolve(path, ".."), parts = relative(resolve("."), parent).split(sep);
  if (write) await safePrivateDirectory(resolve("."), parts);
  let current = resolve(".");
  for (const part of parts) {
    current = resolve(current, part); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new ClassificationError("private_path_required");
  }
  if (!write) { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new ClassificationError("private_path_required"); }
  return path;
}
export async function classificationText(name: string, max = 262144) {
  const path = await classificationPath(name), file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(max + 1); let size = 0;
    while (size < buffer.length) { const r = await file.read(buffer, size, buffer.length - size, null); if (!r.bytesRead) break; size += r.bytesRead; }
    if (size > max) throw new ClassificationError("body_limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally { await file.close(); }
}
export async function classificationJson(name: string) { return decodeJson(await classificationText(name), 262144); }
function phasePointerName(phaseId: string) { return `phase-head-${hash(phaseId)}.json`; }
/** Called under the classification session lock; refuses stale branches and lost reports. */
export async function checkPhaseHistory(config: PhaseBConfig, prior: unknown, hasModels: boolean) {
  let head: unknown;
  try { head = await classificationJson(phasePointerName(config.phaseId)); }
  catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw new ClassificationError("phase_state_invalid"); }
  if (head === undefined) {
    if (hasModels || config.continuation || prior !== undefined) throw new ClassificationError("prior_report_required");
    return;
  }
  if (!head || typeof head !== "object" || !("version" in head) || head.version !== "classification-phase-head-v1" || !("phaseId" in head) || head.phaseId !== config.phaseId) throw new ClassificationError("phase_state_invalid");
  if (!("state" in head) || head.state !== "complete") throw new ClassificationError("phase_report_pending");
  if (!config.continuation || prior === undefined) throw new ClassificationError("prior_report_required");
  const previous = priorReport(prior, config.phaseId);
  if (!("reportHash" in head) || head.reportHash !== hash(prior) || !("report" in head) || head.report !== previous.report) throw new ClassificationError("prior_report_mismatch");
}
export async function writePhaseHead(config: PhaseBConfig, report?: PhaseBReport) {
  const name = phasePointerName(config.phaseId), target = await classificationPath(name, true);
  const temporary = await classificationPath(`phase-head-temp-${randomUUID()}.json`, true), file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ version: "classification-phase-head-v1", phaseId: config.phaseId, state: report ? "complete" : "pending", report: config.report, reportHash: report ? hash(report) : null }) + "\n");
    await file.sync(); await file.close(); await rename(temporary, target);
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
export function decodeAnthropicKey(source: string): string {
  const lines = source.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith("#"));
  if (lines.length !== 1) throw new ClassificationError("credential_invalid");
  const match = /^\s*ANTHROPIC_API_KEY\s*=\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*$/.exec(lines[0]);
  const key = match && (match[1] ?? match[2] ?? match[3]);
  if (!key || key.length < 10 || key.length > 4096) throw new ClassificationError("credential_invalid"); return key;
}
export async function readAnthropicKey(): Promise<string> {
  try {
    const path = await classificationPath("anthropic.env");
    if (process.platform === "win32") {
      // Only an ACL verdict leaves the child; the credential is never read there.
      const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=Get-Acl -LiteralPath '.cache/classification/private/anthropic.env'; $bad=@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18','S-1-5-32-544') }); if($bad.Count -ne 0){exit 1}; Write-Output 'private'`;
      await new Promise<void>((resolvePromise, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000 }, (error, stdout) => error || stdout.trim() !== "private" ? reject(new ClassificationError("credential_invalid")) : resolvePromise()));
    } else if (((await lstat(path)).mode & 0o077) !== 0) throw new ClassificationError("credential_invalid");
    return decodeAnthropicKey(await classificationText("anthropic.env", 8192));
  } catch { throw new ClassificationError("credential_invalid"); }
}
