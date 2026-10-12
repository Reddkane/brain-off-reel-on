import { ClassificationError, array, choice, exact, integer, record, text, unique } from "../../domain/classification.ts";
import { movieId } from "../providers/tmdb-validation.ts";
import type { MovieId } from "../../domain/ids.ts";
import { hash } from "./codec.ts";

export interface Candidate {
  model: string; effort: "low" | "medium" | "high"; maxTokens: number; timeoutMs: number;
  contextTokens: number; inputRate: number; outputRate: number;
}
interface Check { url: string; checkedAt: string }
export interface PhaseBConfig {
  version: "classification-phase-b-v1"; phaseId: string; stage: "pilot" | "main";
  movieIds: readonly MovieId[]; candidates: readonly Candidate[]; spendCap: number;
  rates: Check; terms: Check & { noTraining: true }; rejectionBilling: Check & { zeroCost: boolean };
  fallbackOverhead: number; pilotReport: string | null; continuation: boolean; report: string;
}
export function freshCheck(value: unknown, now: number, code: string): Check {
  const r = record(value, code), url = text(r.url, 300, code), checkedAt = text(r.checkedAt, 30, code);
  const time = Date.parse(checkedAt);
  let host = ""; try { const u = new URL(url); if (u.protocol !== "https:" || u.username || u.password) throw new Error(); host = u.hostname; } catch { throw new ClassificationError(code); }
  if (!/^(?:[a-z]+\.)*(?:anthropic\.com|claude\.com)$/.test(host) || !Number.isFinite(time) || time > now || now - time > 7 * 86400000) throw new ClassificationError(code);
  return { url, checkedAt };
}
function filename(value: unknown): string {
  const v = text(value, 120); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(v) || v.startsWith("phase-head-")) throw new ClassificationError("private_path_required"); return v;
}
export function decodePhaseB(value: unknown, now = Date.now()): PhaseBConfig {
  const r = record(value); exact(r, ["version", "phaseId", "stage", "movieIds", "candidates", "spendCap", "rates", "terms", "rejectionBilling", "fallbackOverhead", "pilotReport", "continuation", "report"]);
  if (r.version !== "classification-phase-b-v1" || typeof r.continuation !== "boolean") throw new ClassificationError("invalid_input");
  const terms = record(r.terms, "terms_required"); exact(terms, ["url", "checkedAt", "noTraining"], "terms_required");
  if (terms.noTraining !== true) throw new ClassificationError("terms_required");
  const termCheck = freshCheck(terms, now, "terms_required");
  const rates = record(r.rates, "rates_required"); exact(rates, ["url", "checkedAt"], "rates_required");
  const rateCheck = freshCheck(rates, now, "rates_required");
  const billing = record(r.rejectionBilling, "billing_check_required"); exact(billing, ["url", "checkedAt", "zeroCost"], "billing_check_required");
  if (typeof billing.zeroCost !== "boolean") throw new ClassificationError("billing_check_required");
  const billingCheck = freshCheck(billing, now, "billing_check_required");
  const candidates = array(r.candidates, 2).map(v => {
    const c = record(v); exact(c, ["model", "effort", "maxTokens", "timeoutMs", "contextTokens", "inputRate", "outputRate"]);
    return { model: choice(c.model, ["claude-sonnet-5-5", "claude-opus-5-5"]), effort: choice(c.effort, ["low", "medium", "high"] as const),
      maxTokens: integer(c.maxTokens, 1024, 128000), timeoutMs: integer(c.timeoutMs, 1000, 600000), contextTokens: integer(c.contextTokens, 15500, 1000000),
      inputRate: integer(c.inputRate, 1, 1000, "rates_required"), outputRate: integer(c.outputRate, 1, 1000, "rates_required") };
  });
  if (candidates.length !== 2) throw new ClassificationError("invalid_input"); unique(candidates.map(c => c.model));
  const stage = choice(r.stage, ["pilot", "main"] as const);
  const movieIds = unique(array(r.movieIds, 30).map(v => movieId(text(v, 36))));
  if (!movieIds.length || (stage === "pilot" && movieIds.length !== 2)) throw new ClassificationError("invalid_input");
  const pilotReport = r.pilotReport === null ? null : filename(r.pilotReport);
  if ((stage === "main") !== (pilotReport !== null)) throw new ClassificationError("pilot_report_required");
  return { version: "classification-phase-b-v1", phaseId: text(r.phaseId, 96), stage, movieIds, candidates,
    spendCap: integer(r.spendCap, 1, 35000000), rates: rateCheck, terms: { ...termCheck, noTraining: true },
    rejectionBilling: { ...billingCheck, zeroCost: billing.zeroCost }, fallbackOverhead: integer(r.fallbackOverhead, 256, 5000),
    pilotReport, continuation: r.continuation, report: filename(r.report) };
}
export function candidateId(c: Candidate): string { return `${c.model}:effort=${c.effort}:out=${c.maxTokens}:ms=${c.timeoutMs}:v1`; }
export function phaseBIdentity(c: PhaseBConfig): string { return hash({ ...c, continuation: false, report: null }); }
export function maximumCost(input: number, c: Candidate): number { return input * c.inputRate + c.maxTokens * c.outputRate; }
export function attempts(c: PhaseBConfig): number { return c.stage === "pilot" ? 2 : 3; }
export function decodeAnchorConfig(value: unknown, now = Date.now()) {
  const c = record(value); exact(c, ["version", "terms", "report"]);
  if (c.version !== "classification-anchor-live-v1") throw new ClassificationError("invalid_input");
  const terms = record(c.terms); exact(terms, ["url", "checkedAt", "accepted"]);
  if (terms.accepted !== true) throw new ClassificationError("terms_required");
  const url = text(terms.url, 300), checkedAt = text(terms.checkedAt, 30), time = Date.parse(checkedAt);
  if (!/^https:\/\/(?:www\.|developer\.)?themoviedb\.org\//.test(url) || !Number.isFinite(time) || time > now || now - time > 7 * 86400000) throw new ClassificationError("terms_required");
  return { report: filename(c.report) };
}

export interface PhaseBReport {
  version: "classification-phase-b-report-v2"; phaseId: string; stage: string; configId: string; candidates: readonly Candidate[];
  report: string; previousReport: string | null; movieIds: readonly MovieId[]; skipped: number;
  completed: readonly { movieId: MovieId; candidate: string; fingerprint: string }[];
  actual: number; unknown: number; code: string; calls: number; processed: number; rejected: number;
  excluded: readonly { movieId: string; reason: string; counts: readonly { candidate: string; countedTokens: number; budget: number; fallback: boolean }[] }[];
  measurements: readonly { movieId: MovieId; fingerprint: string; candidate: string; inputTokens: number | null; outputTokens: number | null;
    visibleCharacters: number; elapsedMs: number; countedTokens: number; fallback: boolean; outcome: string }[];
}
export function priorReport(value: unknown, phaseId: string) {
  const r = record(value, "prior_report_mismatch");
  if (r.version !== "classification-phase-b-report-v2" || r.phaseId !== phaseId) throw new ClassificationError("prior_report_mismatch");
  const actual = integer(r.actual, 0, 1000000000, "prior_report_mismatch"), unknown = integer(r.unknown, 0, 1000000000, "prior_report_mismatch");
  const completed = array(r.completed, 1000, "prior_report_mismatch").map(v => {
    const row = record(v, "prior_report_mismatch"); exact(row, ["movieId", "candidate", "fingerprint"], "prior_report_mismatch");
    const fingerprint = text(row.fingerprint, 64, "prior_report_mismatch");
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new ClassificationError("prior_report_mismatch");
    return { movieId: movieId(text(row.movieId, 36)), candidate: text(row.candidate, 96), fingerprint };
  });
  unique(completed.map(c => `${c.movieId}/${c.candidate}/${c.fingerprint}`), "prior_report_mismatch");
  const measurements = array(r.measurements, 1000, "prior_report_mismatch").map(v => {
    const m = record(v, "prior_report_mismatch");
    exact(m, ["movieId", "fingerprint", "candidate", "inputTokens", "outputTokens", "visibleCharacters", "elapsedMs", "countedTokens", "fallback", "outcome"], "prior_report_mismatch");
    if (typeof m.fallback !== "boolean") throw new ClassificationError("prior_report_mismatch");
    const fingerprint = text(m.fingerprint, 64); if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new ClassificationError("prior_report_mismatch");
    return { movieId: movieId(text(m.movieId, 36)), candidate: text(m.candidate, 96), fingerprint,
      inputTokens: m.inputTokens === null ? null : integer(m.inputTokens, 0, 1000000000), outputTokens: m.outputTokens === null ? null : integer(m.outputTokens, 0, 1000000000),
      visibleCharacters: integer(m.visibleCharacters, 0, 10000000), elapsedMs: integer(m.elapsedMs, 0, 13 * 3600000), countedTokens: integer(m.countedTokens, 0, 1000000), fallback: m.fallback, outcome: text(m.outcome, 64) };
  });
  return { r, actual, unknown, completed, measurements, report: filename(r.report) };
}
export function priorBalance(config: PhaseBConfig, prior: unknown, pilot: unknown): { actual: number; unknown: number } {
  if (!config.continuation) {
    if (prior !== undefined) throw new ClassificationError("prior_report_mismatch");
    if (config.stage !== "pilot") throw new ClassificationError("prior_report_required");
    return { actual: 0, unknown: 0 }; // Production additionally checks phase pointer and DB.
  }
  if (prior === undefined) throw new ClassificationError("prior_report_required");
  const previous = priorReport(prior, config.phaseId);
  if (config.stage === "main") {
    const p = priorReport(pilot, config.phaseId);
    if (p.r.stage !== "pilot" || p.r.code !== "complete" || previous.actual < p.actual || previous.unknown < p.unknown) throw new ClassificationError("pilot_report_required");
    const selected = array(p.r.movieIds, 2).map(v => movieId(text(v, 36)));
    if (selected.length !== 2) throw new ClassificationError("pilot_report_required");
    const pilotCandidates = array(p.r.candidates, 2).map(v => record(v));
    for (const c of config.candidates) {
      const pc = pilotCandidates.find(v => v.model === c.model);
      if (!pc) throw new ClassificationError("pilot_report_required");
      const id = `${text(pc.model, 32)}:effort=${text(pc.effort, 8)}:out=${integer(pc.maxTokens, 1024, 128000)}:ms=${integer(pc.timeoutMs, 1000, 600000)}:v1`;
      const rows = p.measurements.filter(m => m.candidate === id && m.outcome === "ok" && selected.includes(movieId(text(m.movieId, 36))));
      if (new Set(rows.map(m => m.movieId)).size !== 2 || selected.some(movie => !p.completed.some(v => v.movieId === movie && v.candidate === id))) throw new ClassificationError("pilot_report_required");
      if (rows.some(m => m.fallback === true && config.fallbackOverhead < Math.max(0, integer(m.inputTokens, 0, 1000000) - integer(m.countedTokens, 0, 1000000)) + 256)) throw new ClassificationError("count_overhead_required");
    }
  }
  return { actual: previous.actual, unknown: previous.unknown };
}
