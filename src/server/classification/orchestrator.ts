import { ClassificationError, array, exact, integer, record, text, unique, validateOutput } from "../../domain/classification.ts";
import type { Output, Projected } from "../../domain/classification.ts";
import { decodeJson, hash, prepareInput } from "./codec.ts";
export interface RunConfig {
  version: string; phase: string; candidates: readonly string[]; configId: string; spendCap: number; perCallMaximum: number;
  maxCalls: number; maxAttempts: number; attemptMs: number; durationMs: number; continuation: boolean;
}
export function decodeRunConfig(value: unknown): RunConfig {
  const r = record(value); exact(r, ["version", "phase", "candidates", "configId", "spendCap", "perCallMaximum", "maxCalls", "maxAttempts", "attemptMs", "durationMs", "continuation"]);
  if (r.version !== "classification-run-v1" || !["A", "B"].includes(String(r.phase)) || typeof r.continuation !== "boolean") throw new ClassificationError("invalid_input");
  const candidates = unique(array(r.candidates, 2).map(v => text(v, 96)));
  if (!candidates.length) throw new ClassificationError("invalid_input");
  const config = { version: "classification-run-v1", phase: text(r.phase, 1), candidates, configId: text(r.configId, 128),
    spendCap: integer(r.spendCap, 0, 1000000000), perCallMaximum: integer(r.perCallMaximum, 0, 1000000000),
    maxCalls: integer(r.maxCalls, 1, 180), maxAttempts: integer(r.maxAttempts, 1, 3), attemptMs: integer(r.attemptMs, 1, 600000),
    durationMs: integer(r.durationMs, 1, 3600000), continuation: r.continuation };
  if (config.phase === "A" && config.spendCap !== 0) throw new ClassificationError("invalid_input");
  return config;
}
export function phaseBalance(value: unknown, prior?: unknown): number {
  const config = decodeRunConfig(value);
  if (!config.continuation) { if (prior !== undefined) throw new ClassificationError("prior_report_mismatch"); return 0; }
  if (prior === undefined) throw new ClassificationError("prior_report_required");
  const r = record(prior, "prior_report_mismatch");
  exact(r, ["version", "phase", "candidates", "configId", "actual", "unknown"], "prior_report_mismatch");
  if (r.version !== "classification-spend-v1" || r.phase !== config.phase || r.configId !== configIdentity(config) ||
    JSON.stringify(r.candidates) !== JSON.stringify(config.candidates)) throw new ClassificationError("prior_report_mismatch");
  return integer(r.actual, 0, config.spendCap, "prior_report_mismatch") + integer(r.unknown, 0, config.spendCap, "prior_report_mismatch");
}
export function configIdentity(config: RunConfig): string { return hash({ ...decodeRunConfig(config), continuation: false }); }
export interface Classifier {
  classify(input: Projected, context: { signal: AbortSignal; deadline: number; candidate: string }): Promise<
    { status: "ok"; output: unknown; actualCost: number | null } | { status: "failed"; retryable: boolean; cost: number | null }>;
}
export interface TokenCounter { count(prompt: string, candidate: string): number }
export async function classifyBounded(options: {
  config: RunConfig; startingBalance: number; startingUnknown?: number; items: readonly unknown[]; classifier: Classifier; signal: AbortSignal;
  backoff?: (ms: number, signal: AbortSignal) => Promise<void>; persist?: (output: Output, fingerprint: string, index: number, candidate: string) => Promise<void>;
}) {
  const config = decodeRunConfig(options.config);
  integer(options.startingBalance, 0, 2000000000);
  integer(options.startingUnknown ?? 0, 0, options.startingBalance);
  if (options.items.length > 30) throw new ClassificationError("invalid_input");
  // Assemble every item before the first request so invalid later rows cannot spend early.
  const items = options.items.map(prepareInput);
  const end = Date.now() + config.durationMs;
  let calls = 0, processed = 0, rejected = 0, actual = options.startingBalance - (options.startingUnknown ?? 0), unknown = options.startingUnknown ?? 0, code = "complete";
  const backoff = options.backoff ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new ClassificationError("cancelled")); return; }
    const stop = () => { clearTimeout(timer); reject(new ClassificationError("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  }));
  outer: for (const [index, item] of items.entries()) for (const candidate of config.candidates) {
    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
      if (options.signal.aborted) { code = "cancelled"; break outer; }
      if (Date.now() + config.attemptMs > end) { code = "deadline"; break outer; }
      if (calls >= config.maxCalls) { code = "call_limit"; break outer; }
      if (actual + unknown + config.perCallMaximum > config.spendCap) { code = "spend_cap"; break outer; }
      calls++;
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      let result: Awaited<ReturnType<Classifier["classify"]>>;
      try {
        result = await Promise.race([options.classifier.classify(item.input, { signal, candidate, deadline: Date.now() + config.attemptMs }),
          new Promise<never>((_, reject) => {
            abortListener = () => reject(new ClassificationError("cancelled"));
            options.signal.addEventListener("abort", abortListener, { once: true });
            timer = setTimeout(() => { controller.abort(); reject(new ClassificationError("deadline")); }, config.attemptMs);
          })]);
      } catch {
        unknown += config.perCallMaximum; code = options.signal.aborted ? "cancelled" : "spend_unknown"; break outer;
      } finally {
        clearTimeout(timer); if (abortListener) options.signal.removeEventListener("abort", abortListener);
      }
      // Once metering is known, local failures must never add an unknown call charge.
      const cost = result.status === "ok" ? result.actualCost : result.cost;
      if (cost === null || !Number.isSafeInteger(cost) || cost < 0) { unknown += config.perCallMaximum; code = "spend_unknown"; break outer; }
      if (cost > config.perCallMaximum) { actual += cost; code = "spend_cap"; break outer; }
      actual += cost;
      if (result.status === "failed") {
        if (!result.retryable || attempt + 1 === config.maxAttempts) { rejected++; break; }
        try { await backoff((attempt + 1) * 1000, options.signal); }
        catch { code = options.signal.aborted ? "cancelled" : "backoff_failed"; break outer; }
        continue;
      }
      let output: Output;
      try { output = validateOutput(typeof result.output === "string" ? decodeJson(result.output) : result.output, item.input); }
      catch { rejected++; break; }
      try { await options.persist?.(output, item.fingerprint, index, candidate); }
      catch (e) {
        code = options.signal.aborted ? "cancelled" : e instanceof ClassificationError ? e.code : "database_failed";
        break outer;
      }
      processed++; break;
    }
  }
  if (code === "complete" && rejected) code = "partial";
  return { code, calls, processed, rejected, spend: { version: "classification-spend-v1", phase: config.phase, candidates: config.candidates, configId: configIdentity(config), actual, unknown } };
}
