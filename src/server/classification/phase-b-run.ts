import { ClassificationError, validateOutput, record, array } from "../../domain/classification.ts";
import { decodeJson, prepareInput } from "./codec.ts";
import { attempts, candidateId, maximumCost, phaseBIdentity, priorBalance, priorReport } from "./phase-b.ts";
import type { PhaseBConfig, PhaseBReport } from "./phase-b.ts";
import type { createAnthropic } from "./anthropic.ts";
import type { Output } from "../../domain/classification.ts";

/** All counters are invocation-local. Restart/continuation requires the saved report. */
export async function runPhaseB(options: {
  config: PhaseBConfig; items: readonly unknown[]; classifier: ReturnType<typeof createAnthropic>;
  signal: AbortSignal; prior?: unknown; pilot?: unknown; now?: () => number;
  check?: () => Promise<void>; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  persist: (output: Output, fingerprint: string, index: number, candidate: string) => Promise<void>;
  save: (report: PhaseBReport) => Promise<void>;
  storedCompleted?: PhaseBReport["completed"];
}) {
  const { config, classifier, signal } = options, now = options.now ?? Date.now;
  const balance = priorBalance(config, options.prior, options.pilot);
  if (options.items.length !== config.movieIds.length) throw new ClassificationError("invalid_input");
  const items = options.items.map(prepareInput);
  const previous = options.prior === undefined ? null : priorReport(options.prior, config.phaseId);
  const completed = [...(previous?.completed ?? [])];
  for (const row of options.storedCompleted ?? []) if (!completed.some(v => v.movieId === row.movieId && v.candidate === row.candidate && v.fingerprint === row.fingerprint)) completed.push(row);
  // Guarded storage also recovers a committed pair whose client lost the COMMIT reply.
  const available = options.storedCompleted ?? completed;
  const done = (index: number, candidate: string) => available.some(v => v.movieId === config.movieIds[index] && v.candidate === candidate && v.fingerprint === items[index].fingerprint);
  const skipped = items.reduce((sum, _, i) => sum + config.candidates.filter(c => done(i, candidateId(c))).length, 0);
  const report: PhaseBReport = { version: "classification-phase-b-report-v2", phaseId: config.phaseId, stage: config.stage,
    report: config.report, previousReport: previous?.report ?? null, movieIds: config.movieIds, completed, skipped,
    configId: phaseBIdentity(config), candidates: config.candidates, ...balance, code: "complete", calls: 0, processed: 0, rejected: 0, excluded: [], measurements: [] };
  const excluded: PhaseBReport["excluded"][number][] = [];
  const measurements: PhaseBReport["measurements"][number][] = [...(previous?.measurements ?? [])];
  report.excluded = excluded; report.measurements = measurements;
  const maxAttempts = attempts(config);
  if (completed.length + items.length * config.candidates.length - skipped > 1000 || measurements.length + (items.length * config.candidates.length - skipped) * maxAttempts > 1000) throw new ClassificationError("body_limit");
  const duration = Math.min(13 * 3600000, config.movieIds.length * maxAttempts * config.candidates.reduce((sum, c) => sum + c.timeoutMs, 0) + 1200000 + 180000 + 1800000);
  const end = now() + duration;
  const sleep = options.sleep ?? ((ms: number, s: AbortSignal) => new Promise<void>((resolve, reject) => {
    s.throwIfAborted(); const abort = () => { clearTimeout(timer); reject(new ClassificationError("cancelled")); };
    const timer = setTimeout(() => { s.removeEventListener("abort", abort); resolve(); }, ms); s.addEventListener("abort", abort, { once: true });
  }));
  // Preserve ambiguous accounting if persistence or local finalization fails.
  try {
    await options.check?.(); signal.throwIfAborted();
    const counts: Awaited<ReturnType<typeof classifier.count>>[][] = [];
    for (const [index, item] of items.entries()) {
      const row = [];
      for (const c of config.candidates) {
        if (done(index, candidateId(c))) { row.push({ countedTokens: 0, fallback: false, budget: 0 }); continue; }
        await options.check?.(); signal.throwIfAborted();
        if (now() + 20000 > end) throw new ClassificationError("deadline");
        const counted = await classifier.count(item.input, c, signal, config.fallbackOverhead);
        if (config.stage === "main" && counted.fallback) {
          const pilotRows = array(record(options.pilot, "pilot_report_required").measurements, 1000, "pilot_report_required").map(v => record(v, "pilot_report_required"));
          if (!pilotRows.some(m => typeof m.candidate === "string" && m.candidate.startsWith(c.model + ":") && m.fallback === true && m.outcome === "ok")) throw new ClassificationError("count_overhead_required");
        }
        row.push(counted);
      }
      counts.push(row);
      if (row.some((v, j) => v.budget > 5000 || v.budget + config.candidates[j].maxTokens > config.candidates[j].contextTokens)) excluded.push({ movieId: config.movieIds[index], reason: "input_oversized", counts: row.map((v, j) => ({ candidate: candidateId(config.candidates[j]), ...v })) });
    }
    if (config.stage === "pilot" && excluded.length) throw new ClassificationError("pilot_input_oversized");
    if (excluded.length === items.length) throw new ClassificationError("input_oversized");
    const projection = counts.reduce((sum, row, i) => excluded.some(v => v.movieId === config.movieIds[i]) ? sum : sum + row.reduce((total, v, j) => total + (done(i, candidateId(config.candidates[j])) ? 0 : maximumCost(v.budget, config.candidates[j]) * maxAttempts), 0), 0);
    if (report.actual + report.unknown + projection > config.spendCap) throw new ClassificationError("spend_cap");
    outer: for (const [index, item] of items.entries()) {
      if (excluded.some(v => v.movieId === config.movieIds[index])) continue;
      for (const [j, c] of config.candidates.entries()) {
      if (done(index, candidateId(c))) continue;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await options.check?.(); signal.throwIfAborted();
        if (now() + c.timeoutMs > end) { report.code = "deadline"; break outer; }
        const reserved = maximumCost(counts[index][j].budget, c);
        if (report.actual + report.unknown + reserved > config.spendCap) { report.code = "spend_cap"; break outer; }
        report.calls++;
        const controller = new AbortController(), deadline = now() + c.timeoutMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: Awaited<ReturnType<typeof classifier.classify>>;
        try {
          result = await Promise.race([classifier.classify(item.input, { candidate: candidateId(c), signal: AbortSignal.any([signal, controller.signal]), deadline }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ClassificationError("timeout")); }, c.timeoutMs); })]);
        } catch {
          report.unknown += reserved; report.code = signal.aborted ? "cancelled" : "timeout";
          measurements.push({ movieId: config.movieIds[index], fingerprint: item.fingerprint, candidate: candidateId(c), countedTokens: counts[index][j].countedTokens, fallback: counts[index][j].fallback,
            inputTokens: null, outputTokens: null, visibleCharacters: 0, elapsedMs: c.timeoutMs, outcome: report.code }); break outer;
        } finally { clearTimeout(timer); }
        const cost = result.status === "ok" ? result.actualCost : result.cost;
        const outcome = result.status === "ok" ? "validated" : result.reason;
        const measure = { movieId: config.movieIds[index], fingerprint: item.fingerprint, candidate: candidateId(c), ...result.measurement, countedTokens: counts[index][j].countedTokens, fallback: counts[index][j].fallback, outcome };
        measurements.push(measure);
        if (cost === null || !Number.isSafeInteger(cost) || cost < 0) { report.unknown += reserved; report.code = signal.aborted ? "cancelled" : "spend_unknown"; break outer; }
        report.actual += cost;
        if (cost > reserved || report.actual + report.unknown > config.spendCap) { report.code = "spend_cap"; break outer; }
        if (result.status === "failed") {
          if (result.reason === "model_mismatch") { report.code = "model_mismatch"; break outer; }
          if (!result.retryable || attempt + 1 === maxAttempts) break;
          const delay = Math.max((attempt + 1) * 1000, result.retryAfterMs ?? 0);
          if (delay > c.timeoutMs || now() + delay + c.timeoutMs > end) { report.code = "deadline"; break outer; }
          await sleep(delay, signal); continue;
        }
        let output: Output;
        try { output = validateOutput(decodeJson(result.output), item.input); }
        catch { report.rejected++; measure.outcome = "invalid_output"; break; }
        await options.persist(output, item.fingerprint, index, candidateId(c));
        measure.outcome = "ok"; completed.push({ movieId: config.movieIds[index], candidate: candidateId(c), fingerprint: item.fingerprint });
        report.processed++; break;
      }
      }
    }
    if (report.code === "complete" && (excluded.length || report.processed + skipped !== items.length * config.candidates.length)) report.code = "partial";
  } catch (e) { report.code = signal.aborted ? "cancelled" : e instanceof ClassificationError ? e.code : "database_failed"; }
  await options.save(report);
  return report;
}
