import { pathToFileURL } from "node:url";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { safePrivateDirectory } from "./private-directory.ts";
import { ClassificationError, text } from "../src/domain/classification.ts";
import { SweepError } from "../src/server/providers/sweep-error.ts";
import { coverage, agreement, compareAgreement } from "../src/domain/classification-reports.ts";
import { decodeJson } from "../src/server/classification/codec.ts";
import { date, decodeHuman, decodeSnapshot, template } from "../src/server/classification/files.ts";
import { decodeRunConfig, phaseBalance } from "../src/server/classification/orchestrator.ts";
import { decodeAnchorIds } from "../src/server/ingestion/anchor-metadata.ts";
import { classificationEffects } from "./classification-effects.ts";
import { decodeAnchorConfig, decodePhaseB } from "../src/server/classification/phase-b.ts";
import type { ClassificationEffects } from "./classification-effects.ts";

const allowed: Record<string, readonly string[]> = {
  "anchors-template": ["--output", "--write"], "reviews-template": ["--output", "--write"],
  "anchors-import": ["--input", "--apply"], "reviews-import": ["--input", "--apply"],
  "anchors-ingest": ["--input", "--config", "--live"], run: ["--config", "--prior-report", "--live"],
  agreement: ["--input", "--compare-with", "--as-of", "--write-report", "--output"], coverage: ["--input", "--as-of", "--write-report", "--output"],
  export: ["--as-of", "--read-local", "--output", "--model-id", "--phase-b"],
};
const booleans = ["--write", "--apply", "--live", "--read-local", "--write-report", "--phase-b"];
const codes = new Set(["invalid_input", "invalid_arguments", "invalid_json", "body_limit", "private_path_required", "report_exists", "file_failed",
  "classifier_unconfigured", "anchor_ingest_live_unavailable", "local_store_unconfigured", "prior_report_required", "prior_report_mismatch", "unauthorized",
  "anchor_movie_unresolved", "review_parent_invalid", "readback_failed", "cancelled", "deadline", "call_limit", "spend_cap", "spend_unknown", "database_failed", "evidence_expired", "input_changed", "backoff_failed",
  "terms_required", "rates_required", "billing_check_required", "pilot_report_required", "count_overhead_required", "count_failed", "input_oversized", "pilot_input_oversized", "credential_invalid", "model_mismatch", "upgrade_required", "refresh_overlap", "refresh_lock_lost", "timeout", "phase_state_invalid", "phase_report_pending"]);
function flags(args: readonly string[]) {
  const action = args[0], permitted = allowed[action]; if (!permitted) throw new ClassificationError("invalid_arguments");
  const values: Record<string, string | boolean> = {};
  for (let i = 1; i < args.length; i++) {
    const f = args[i]; if (!permitted.includes(f) || Object.hasOwn(values, f)) throw new ClassificationError("invalid_arguments");
    if (booleans.includes(f)) values[f] = true;
    else { const value = args[++i]; if (!value || value.startsWith("--")) throw new ClassificationError("invalid_arguments"); values[f] = value; }
  }
  return { action, values };
}
function required(values: Record<string, string | boolean>, key: string): string {
  const v = values[key]; if (typeof v !== "string") throw new ClassificationError("invalid_arguments"); return v;
}
async function safePath(name: string, write: boolean, publicConfig = false) {
  const path = resolve(name), root = resolve(".cache/classification/private"), rel = relative(root, path);
  const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (publicConfig && samePath(path, resolve("config/classification.example.json"))) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(resolve(await realpath(path)), path)) throw new ClassificationError("private_path_required"); return path;
  }
  if (!rel || isAbsolute(rel) || rel.split(sep).includes("..")) throw new ClassificationError("private_path_required");
  const parts = relative(resolve("."), resolve(path, "..")).split(sep);
  if (write) await safePrivateDirectory(resolve("."), parts);
  else {
    let current = resolve(".");
    for (const part of parts) { current = resolve(current, part); const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(resolve(await realpath(current)), current)) throw new ClassificationError("private_path_required"); }
  }
  if (!write) { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || !samePath(resolve(await realpath(path)), path)) throw new ClassificationError("private_path_required"); }
  return path;
}
async function read(name: string, max: number, publicConfig = false) {
  const path = await safePath(name, false, publicConfig), file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(max + 1); let size = 0;
    while (size < buffer.length) { const r = await file.read(buffer, size, buffer.length - size, null); if (!r.bytesRead) break; size += r.bytesRead; }
    return decodeJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)), max);
  } finally { await file.close(); }
}
async function write(name: string, value: unknown) {
  const path = await safePath(name, true); let file;
  const content = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new ClassificationError("body_limit");
  try { file = await open(path, "wx", 0o600); await file.writeFile(content); }
  catch (e) { if (e && typeof e === "object" && "code" in e && e.code === "EEXIST") throw new ClassificationError("report_exists"); throw e; }
  finally { await file?.close(); }
}
export async function classificationCommand(args: string[], signal = new AbortController().signal, supplied?: ClassificationEffects) {
  let action = "invalid", processed = 0, rejected = 0, code = "complete", exit = 0;
  let resolvedEffects: ClassificationEffects | undefined;
  try {
    const parsed = flags(args); action = parsed.action; const v = parsed.values;
    const effects = async () => { resolvedEffects ??= supplied ?? await classificationEffects({ action, signal, modelId: typeof v["--model-id"] === "string" ? v["--model-id"] : undefined }); return resolvedEffects; };
    signal.throwIfAborted();
    if (action.endsWith("-template")) {
      const blank = template(action === "anchors-template" ? "human_anchor" : "human_review");
      if (v["--write"]) await write(required(v, "--output"), blank); else console.log(JSON.stringify(blank));
    } else if (action.endsWith("-import")) {
      const document = decodeHuman(await read(required(v, "--input"), 131072), action === "anchors-import" ? "human_anchor" : "human_review"); processed = document.rows.length;
      if (v["--apply"]) { const io = await effects(); if (!io.store || !io.capability) throw new ClassificationError("local_store_unconfigured");
        const result = await io.store.appendHuman(io.capability, document, { signal, deadline: Date.now() + 10000 }); processed = result.inserted + result.unchanged; }
    } else if (action === "anchors-ingest") {
      if (v["--live"] && (!v["--config"] || !v["--input"])) throw new ClassificationError("anchor_ingest_live_unavailable");
      processed = decodeAnchorIds(await read(required(v, "--input"), 16384)).length;
      if (v["--config"]) {
        const config = await read(required(v, "--config"), 16384, true);
        if (v["--live"]) { decodeAnchorConfig(config); const io = await effects(); if (!io.ingest) throw new ClassificationError("anchor_ingest_live_unavailable");
          const result = await io.ingest(await read(required(v, "--input"), 16384), config, signal); processed = result.inserted + result.unchanged; }
        else if (config && typeof config === "object" && "version" in config && config.version === "classification-anchor-live-v1") decodeAnchorConfig(config);
        else decodeRunConfig(config);
      }
    } else if (action === "run") {
      if (v["--live"] && !v["--config"]) throw new ClassificationError("classifier_unconfigured");
      const rawConfig = await read(required(v, "--config"), 16384, true);
      if (rawConfig && typeof rawConfig === "object" && "version" in rawConfig && rawConfig.version === "classification-phase-b-v1") {
        const config = decodePhaseB(rawConfig); let prior: unknown;
        if (config.continuation && !v["--prior-report"]) throw new ClassificationError("prior_report_required");
        if (v["--prior-report"]) prior = await read(required(v, "--prior-report"), 262144);
        if (v["--live"]) { const io = await effects(); if (!io.phaseB) throw new ClassificationError("classifier_unconfigured");
          const result = await io.phaseB(config, prior, signal); processed = result.processed; rejected = result.rejected; code = result.code; exit = code === "complete" ? 0 : ["partial", "cancelled", "deadline", "spend_cap", "spend_unknown"].includes(code) ? 2 : 1; }
      } else {
        const config = decodeRunConfig(rawConfig);
        let prior: unknown;
        if (config.continuation && !v["--prior-report"]) throw new ClassificationError("prior_report_required");
        if (v["--prior-report"]) {
          try { prior = await read(required(v, "--prior-report"), 16384); } catch { throw new ClassificationError("prior_report_mismatch"); }
        }
        const balance = phaseBalance(config, prior);
        if (v["--live"]) throw new ClassificationError("classifier_unconfigured");
        // Legacy synthetic composition remains available; default returns no effects.
        const io = supplied ?? await classificationEffects(); resolvedEffects = io;
        const startingUnknown = prior && typeof prior === "object" && "unknown" in prior && typeof prior.unknown === "number" ? prior.unknown : 0;
        if (io.run) { const result = await io.run(config, balance, signal, startingUnknown); processed = result.processed; rejected = result.rejected; code = result.code; exit = code === "complete" ? 0 : 2; }
      }
    } else if (action === "export") {
      const at = date(required(v, "--as-of"));
      if (v["--model-id"]) text(required(v, "--model-id"), 96);
      if (v["--read-local"]) { const io = await effects(); if (!io.store || !io.capability || !io.modelId) throw new ClassificationError("local_store_unconfigured");
        const snapshot = await io.store.snapshot(io.capability, at, io.modelId, { signal, deadline: Date.now() + 10000 }, !!v["--phase-b"]);
        await write(required(v, "--output"), decodeSnapshot(snapshot)); processed = snapshot.movies.length; }
    } else {
      const at = date(required(v, "--as-of")), snapshot = decodeSnapshot(await read(required(v, "--input"), 16 * 1024 * 1024));
      if (snapshot.retentionDeadline && Date.parse(snapshot.retentionDeadline) <= Date.now()) throw new ClassificationError("evidence_expired");
      const second = v["--compare-with"] ? decodeSnapshot(await read(required(v, "--compare-with"), 16 * 1024 * 1024)) : null;
      if (second && (second.policy !== snapshot.policy || second.emotionalCap !== snapshot.emotionalCap || second.promptId !== snapshot.promptId || second.modelId === snapshot.modelId || (second.retentionDeadline && Date.parse(second.retentionDeadline) <= Date.now()))) throw new ClassificationError("invalid_input");
      const report = action === "coverage" ? coverage(snapshot, at) : second ? compareAgreement([snapshot, second], at) : agreement(snapshot, at); processed = snapshot.movies.length;
      if (v["--write-report"]) await write(required(v, "--output"), report);
      if (action === "agreement" && "pairs" in report && !report.pairs) { exit = 2; code = "insufficient_data"; }
      if ("commonPairs" in report && !report.commonPairs) { exit = 2; code = "insufficient_data"; }
    }
    signal.throwIfAborted();
  } catch (e) {
    exit = signal.aborted ? 2 : 1; code = signal.aborted ? "cancelled" : (e instanceof ClassificationError || e instanceof SweepError) && codes.has(e.code) ? e.code : "file_failed"; rejected++;
  } finally {
    try { await resolvedEffects?.close?.(); } catch { exit = 1; code = "database_failed"; }
  }
  console.log(`exit=${exit} code=${code} action=${action} processed=${processed} rejected=${rejected}`); return exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), interrupt = () => controller.abort(); process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try { process.exitCode = await classificationCommand(process.argv.slice(2), controller.signal); }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
