import { currentMigrationCount } from "./catalog-schema.ts";
import { pathToFileURL } from "node:url";
import { boundedText, privateJson } from "./catalog-config.ts";
import { sweepCodes } from "../src/server/providers/sweep-error.ts";
import { sweepMaxima } from "../src/server/ingestion/sweep-config.ts";
/** Manual operator decision support; no execution loop or authorization effects. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("report_invalid");
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("report_invalid");
  return value;
}
function catalog(value: unknown) {
  const row = record(value);
  return { active: count(row.active), total: count(row.active) + count(row.retired) };
}
function checkpoints(value: unknown) {
  const report = record(value), checkpoint = record(report.checkpoint);
  if (!Array.isArray(checkpoint.sweeps) || !Array.isArray(report.services) || checkpoint.sweeps.length !== 4 || report.services.length !== 4)
    throw new Error("checkpoint_invalid");
  const services = report.services.map(record), sweeps = checkpoint.sweeps.map(record);
  const sources = new Set(), ids = new Set();
  for (const sweep of sweeps) {
    if (typeof sweep.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sweep.id) ||
      ![203, 387, 372, 157].includes(count(sweep.source)) || sources.has(sweep.source) || ids.has(sweep.id) ||
      typeof sweep.complete !== "boolean" || count(sweep.nextPage) < 1) throw new Error("checkpoint_invalid");
    sources.add(sweep.source); ids.add(sweep.id);
    const matches = services.filter(service => service.id === sweep.id && service.source_id === sweep.source);
    if (matches.length !== 1 || count(matches[0].pages) + 1 !== sweep.nextPage ||
      matches[0].outcome !== (sweep.complete ? "complete" : null)) throw new Error("checkpoint_invalid");
  }
  return sweeps;
}
export function batchDecision(exit: number, report: unknown, previous: unknown, aggregate: unknown) {
  let netNewTitles: number | null = null, catalogProgress = false, resumeProgress = false;
  const result = (decision: "stop" | "continue" | "cap", reason: string) => ({ decision, reason, netNewTitles, catalogProgress, resumeProgress });
  try {
    const r = record(report), totals = record(aggregate);
    if (r.readback !== "verified" || typeof r.runId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.runId))
      return result("stop", "report_invalid");
    const allowed = ["detail_budget", "wall_budget", "database_budget"];
    const permitted = exit === 0 && r.code === "complete" && r.outcome === "success" ||
      exit === 2 && (allowed.includes(String(r.code)) || r.code === "catalog_limit") && r.outcome === "partial";
    if (!permitted || count(r.failed) > 0) return result("stop", "run_failure");
    const evidence = record(r.evidence);
    if (count(evidence.sourceFailures) > 0 || !["complete", ...allowed].includes(String(evidence.code)))
      return result("stop", "evidence_failure");
    const current = catalog(r.evidenceReadback), sweeps = checkpoints(r);
    const prior = typeof previous === "number" ? count(previous) : catalog(record(previous).evidenceReadback).total;
    netNewTitles = current.total - prior;
    if (netNewTitles < 0 || current.active > 1000) return result("stop", "catalog_delta_invalid");
    const pages = count(r.pages), persisted = count(r.persisted);
    if (pages > 60 || count(r.details) > 100 || count(r.attemptedCredits) > 100 || count(r.tmdbAttempts) > 300)
      return result("stop", "run_ceiling");
    if (netNewTitles > persisted) return result("stop", "catalog_delta_invalid");
    catalogProgress = persisted > 0 && netNewTitles > 0;
    if (typeof previous !== "number" && record(previous).readback !== "verified") return result("stop", "previous_readback_invalid");
    const oldSweeps = typeof previous === "number" ? [] : checkpoints(previous);
    const committedPages = sweeps.reduce((sum, sweep) => {
      const old = oldSweeps.find(s => s.id === sweep.id && s.source === sweep.source);
      return sum + count(sweep.nextPage) - (old ? count(old.nextPage) : 1);
    }, 0);
    if (committedPages !== pages) return result("stop", "committed_pages_mismatch");
    for (const sweep of sweeps.filter(s => !s.complete)) {
      const old = oldSweeps.find(s => s.id === sweep.id);
      if (old && (old.source !== sweep.source || old.complete || count(sweep.nextPage) < count(old.nextPage)))
        return result("stop", "checkpoint_nonadvancing");
      // An unfinished previous sweep cannot silently be replaced by another ID.
      if (!old && oldSweeps.some(s => s.source === sweep.source && !s.complete))
        return result("stop", "checkpoint_restarted");
      if (pages > 0 && count(sweep.nextPage) > (old ? count(old.nextPage) : 1)) resumeProgress = true;
    }
    // Aggregates include this invocation, and must account for its spend.
    const runs = count(totals.runs), credits = count(totals.attemptedCredits), details = count(totals.details), attempts = count(totals.tmdbAttempts);
    if (runs < 1 || credits < count(r.attemptedCredits) || details < count(r.details) || attempts < count(r.tmdbAttempts))
      return result("stop", "aggregate_invalid");
    if (runs > 9 || credits > 900 || details > 900 || attempts > 2700) return result("stop", "batch_ceiling");
    if (r.code === "catalog_limit" && current.active !== 1000) return result("stop", "cap_unverified");
    if (current.active === 1000) return result("cap", "catalog_limit_verified");
    if (runs >= 9 || credits >= 900 || details >= 900 || attempts >= 2700) return result("stop", "batch_ceiling");
    if (sweeps.every(s => s.complete) && netNewTitles === 0) return result("stop", "completed_rescan_no_additions");
    return catalogProgress || resumeProgress ? result("continue", "progress") : result("stop", "no_progress");
  }
  catch { return result("stop", "report_invalid"); }
}

export interface BatchCLIIO {
  readonly read: (path: string) => Promise<string>;
  readonly output: (text: string) => void;
}
/** Explicit files and recorded process exits, in invocation order. Never starts work. */
export async function batchCommand(args: readonly string[], io: BatchCLIIO): Promise<number> {
  try {
    if (args[0] !== "--manifest" || !args[1] || args[1].startsWith("--") ||
      args.length < 6 || (args.length - 2) % 4 !== 0 || (args.length - 2) / 4 > 9) throw new Error();
    const inputs: { path: string; exit: number }[] = [];
    for (let i = 2; i < args.length; i += 4) {
      if (args[i] !== "--report" || !args[i + 1] || args[i + 1].startsWith("--") ||
        args[i + 2] !== "--exit" || !/^[012]$/.test(args[i + 3])) throw new Error();
      inputs.push({ path: args[i + 1], exit: Number(args[i + 3]) });
    }
    const manifest = record(privateJson(await io.read(args[1]))), digest = record(manifest.digest), acquisition = record(manifest.acquisition);
    if (manifest.success !== true || manifest.phase !== "after-upgrade" || typeof manifest.schemaState !== "number" || ![6, currentMigrationCount].includes(manifest.schemaState) ||
      acquisition.mappings_without_acquisition !== "0" ||
      typeof digest.movies !== "string" || !/^(?:0|[1-9]\d*)$/.test(digest.movies)) throw new Error();
    let previous: unknown = count(Number(digest.movies));
    const totals = { runs: 0, attemptedCredits: 0, details: 0, tmdbAttempts: 0 };
    const seen = new Set<string>();
    let previousEnd = -Infinity, generation: unknown, terms: string | undefined;
    let final: (ReturnType<typeof batchDecision> & { runId: string; exit: number; code: string; stoppedAtRun?: number }) | undefined;
    for (const input of inputs) {
      const report = record(privateJson(await io.read(input.path))), limits = record(report.limits);
      if (report.version !== "availability-sweeps-v1" || typeof report.generation !== "string" || !report.generation ||
        typeof report.runId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(report.runId) ||
        typeof report.code !== "string" || !sweepCodes.some(code => code === report.code) || seen.has(report.runId) || typeof report.startedAt !== "string" ||
        !Number.isFinite(Date.parse(report.startedAt)) || new Date(report.startedAt).toISOString() !== report.startedAt ||
        Date.parse(report.startedAt) < previousEnd ||
        !Object.entries(sweepMaxima).every(([key, limit]) => limits[key] === limit) || record(report.terms).accepted !== true)
        throw new Error();
      const decisionTerms = JSON.stringify(report.terms);
      if (totals.runs && (generation !== report.generation || terms !== decisionTerms)) throw new Error();
      generation = report.generation; terms = decisionTerms;
      seen.add(report.runId);
      previousEnd = Date.parse(report.startedAt) + count(report.elapsedMs);
      totals.runs++;
      totals.attemptedCredits = count(totals.attemptedCredits + count(report.attemptedCredits));
      totals.details = count(totals.details + count(report.details));
      totals.tmdbAttempts = count(totals.tmdbAttempts + count(report.tmdbAttempts));
      if (!final || final.decision === "continue") {
        const decision = batchDecision(input.exit, report, previous, totals);
        final = { ...decision, runId: report.runId, exit: input.exit, code: report.code,
          ...(decision.decision !== "continue" ? { stoppedAtRun: totals.runs } : {}) };
        previous = report;
      }
    }
    if (!final) throw new Error();
    io.output(JSON.stringify({ ...final, totals }));
    return final.decision === "stop" ? 2 : 0;
  }
  catch {
    io.output(JSON.stringify({ decision: "stop", reason: "batch_inputs_invalid" }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await batchCommand(process.argv.slice(2), {
    read: path => boundedText(path, 262144), output: text => console.log(text),
  });
}
