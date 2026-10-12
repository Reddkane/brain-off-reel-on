import { expect, it } from "vitest";
import { createAnthropic } from "../../src/server/classification/anthropic.ts";
import { runPhaseB } from "../../src/server/classification/phase-b-run.ts";
import { decodePhaseB, priorBalance, candidateId, phaseBIdentity } from "../../src/server/classification/phase-b.ts";
import { decodeAnthropicKey, classificationPath } from "../../scripts/classification-private.ts";
import { phaseBConfig, movie, output } from "./fixtures.ts";
import type { PhaseBReport } from "../../src/server/classification/phase-b.ts";
import { agreement, coverage, compareAgreement } from "../../src/domain/classification-reports.ts";
import type { Snapshot } from "../../src/domain/classification-reports.ts";
import { movieId } from "../../src/server/providers/tmdb-validation.ts";
import { classificationEffects } from "../../scripts/classification-effects.ts";
import type { ClassificationIO } from "../../scripts/classification-effects.ts";

async function run(extra: { config?: unknown; status?: number; error?: unknown; counts?: number[]; throwFetch?: boolean; failPersist?: boolean; retryAfter?: string; fallback?: boolean; stop?: string } = {}) {
  const config = decodePhaseB(extra.config ?? phaseBConfig()); let paid = 0, counted = 0, saved: PhaseBReport | undefined, persisted = 0; const waits: number[] = [];
  const classifier = createAnthropic("synthetic-key", config.candidates, { now: Date.now, fetch: async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(url).endsWith("count_tokens")) {
      counted++;
      if (extra.fallback && request.output_config) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Synthetic output config rejection" } }), { status: 400 });
      return new Response(JSON.stringify({ input_tokens: extra.counts?.[counted - 1] ?? 1000 }));
    }
    paid++; expect(counted).toBeGreaterThanOrEqual(4);
    if (extra.throwFetch) throw new Error("SYNTHETIC_SECRET_CONNECTION_ERROR");
    if (extra.status && paid === 1) return new Response(JSON.stringify(extra.error ?? {}), { status: extra.status, headers: { "retry-after": extra.retryAfter ?? "2" } });
    return new Response(JSON.stringify({ type: "message", role: "assistant", model: request.model, stop_reason: extra.stop ?? "end_turn", content: [{ type: "text", text: JSON.stringify(output()) }],
      usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" } }));
  } }, config.rejectionBilling.zeroCost);
  const result = await runPhaseB({ config, items: [movie(), movie()], classifier, signal: new AbortController().signal,
    sleep: async ms => { waits.push(ms); }, persist: async () => { if (extra.failPersist) throw new Error("SYNTHETIC_PRIVATE_SQL"); persisted++; }, save: async r => { saved = r; } });
  return { result, paid, counted, saved, persisted, waits, config };
}
it("pilot records four measured pairs and spends once per single-request call", async () => {
  const r = await run(); expect(r).toMatchObject({ paid: 4, counted: 4, persisted: 4 });
  expect(r.result).toMatchObject({ code: "complete", processed: 4, actual: 42000, unknown: 0 });
  expect(r.result.measurements).toHaveLength(4); expect(r.result.measurements.every(m => m.inputTokens === 1000 && m.outputTokens === 500)).toBe(true);
});
it("verified throttling/overload retries, ambiguous failures stop and reserve", async () => {
  for (const [status, type] of [[429, "rate_limit_error"], [529, "overloaded_error"]] as const) {
    const r = await run({ status, error: { type: "error", error: { type, message: "Synthetic" } } });
    expect(r).toMatchObject({ paid: 5, waits: [2000], result: { code: "complete", unknown: 0 } });
  }
  for (const r of [await run({ status: 429 }), await run({ status: 500 }), await run({ throwFetch: true }), await run({ status: 429, error: { type: "error", error: { type: "rate_limit_error", message: "Synthetic" } }, config: { ...phaseBConfig(), rejectionBilling: { ...phaseBConfig().rejectionBilling, zeroCost: false } } })]) {
    expect(r.paid).toBe(1); expect(r.result).toMatchObject({ code: "spend_unknown", actual: 0 }); expect(r.result.unknown).toBeGreaterThan(100000);
  }
});
it("large Retry-After stops rather than sleeping beyond attempt/invocation bounds", async () => {
  const r = await run({ status: 429, error: { type: "error", error: { type: "rate_limit_error", message: "Synthetic" } }, retryAfter: "100000" });
  expect(r.paid).toBe(1); expect(r.waits).toEqual([]); expect(r.result.code).toBe("deadline");
});
it("all-title preflight refuses cap and oversized pilot before any paid attempt", async () => {
  const cap = await run({ config: { ...phaseBConfig(), spendCap: 1 } }); expect(cap.paid).toBe(0); expect(cap.result.code).toBe("spend_cap");
  const total = await run({ config: { ...phaseBConfig(), spendCap: 200000 } }); expect(total.paid).toBe(0); expect(total.result.code).toBe("spend_cap");
  const oversized = await run({ counts: [1000, 1000, 8000, 1000] }); expect(oversized.paid).toBe(0); expect(oversized.result).toMatchObject({ code: "pilot_input_oversized", excluded: [{ reason: "input_oversized" }] });
});
it("fallback records raw counts and main requires measured overhead/pilot spend despite changed settings", async () => {
  const pilot = (await run({ fallback: true })).result;
  const main = decodePhaseB({ ...phaseBConfig(), stage: "main", pilotReport: "pilot-synthetic.json", continuation: true });
  expect(priorBalance(main, pilot, pilot)).toEqual({ actual: 42000, unknown: 0 });
  expect(() => priorBalance(main, undefined, undefined)).toThrow("prior_report_required");
  const changed = decodePhaseB({ ...main, candidates: main.candidates.map(c => ({ ...c, effort: "low" })) });
  expect(priorBalance(changed, pilot, pilot).actual).toBe(42000);
  const highUsage = { ...pilot, measurements: pilot.measurements.map(m => ({ ...m, inputTokens: 1500 })) };
  expect(() => priorBalance(main, highUsage, highUsage)).toThrow("count_overhead_required");
  const continuation = { ...main, continuation: true };
  expect(priorBalance(continuation, { ...pilot, configId: phaseBIdentity(changed) }, pilot).actual).toBe(42000);
  expect(() => priorBalance(continuation, { ...pilot, phaseId: "different-phase" }, pilot)).toThrow("prior_report_mismatch");
});
it("main excludes an oversized title from both candidates before dispatch", async () => {
  const pilot = (await run()).result, config = decodePhaseB({ ...phaseBConfig(), stage: "main", pilotReport: "pilot-synthetic.json", continuation: true });
  let calls = 0; const classifier = createAnthropic("synthetic-key", config.candidates, { now: Date.now, fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("count_tokens")) return new Response(JSON.stringify({ input_tokens: body.messages[0].content.includes("Long synthetic") ? 8000 : 1000 }));
    calls++; return new Response(JSON.stringify({ type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(output()) }], usage: { input_tokens: 1000, output_tokens: 500 } }));
  } }, true);
  const report = await runPhaseB({ config, prior: pilot, pilot, classifier, items: [movie({ title: "Main synthetic" }), movie({ title: "Long synthetic" })], signal: new AbortController().signal, persist: async () => {}, save: async () => {} });
  expect(calls).toBe(2); expect(report).toMatchObject({ code: "partial", processed: 2, actual: 63000, excluded: [{ movieId: config.movieIds[1], reason: "input_oversized" }] });
});
it("main cannot switch to fallback counting without a pilot fallback measurement", async () => {
  const pilot = (await run()).result, config = decodePhaseB({ ...phaseBConfig(), stage: "main", pilotReport: "pilot-synthetic.json", continuation: true }); let paid = 0;
  const classifier = createAnthropic("synthetic-key", config.candidates, { now: Date.now, fetch: async (url, init) => {
    if (!String(url).endsWith("count_tokens")) { paid++; throw new Error("paid_forbidden"); }
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body.output_config ? { type: "error", error: { type: "invalid_request_error", message: "Synthetic unsupported config" } } : { input_tokens: 1000 }), { status: body.output_config ? 400 : 200 });
  } }, true);
  const result = await runPhaseB({ config, prior: pilot, pilot, classifier, items: [movie({ title: "New main synthetic" }), movie()], signal: new AbortController().signal, persist: async () => {}, save: async () => {} });
  expect(result.code).toBe("count_overhead_required"); expect(paid).toBe(0);
});
it("local persistence failure retains actual spend and safe code", async () => {
  const r = await run({ failPersist: true }); expect(r.result).toMatchObject({ code: "database_failed", actual: 7000, unknown: 0 });
  expect(JSON.stringify(r.result)).not.toContain("SYNTHETIC_PRIVATE_SQL");
});
it("truncation/refusal preserve spend and stay outside invalid-label counts", async () => {
  for (const [stop, outcome] of [["max_tokens", "truncation"], ["refusal", "refusal"]]) {
    const r = await run({ stop }); expect(r.paid).toBe(4); expect(r.result).toMatchObject({ code: "partial", processed: 0, rejected: 0, actual: 42000 });
    expect(r.result.measurements.every(m => m.outcome === outcome)).toBe(true);
  }
});
it("credentials reject duplicate/evaluated assignments and escaping paths", async () => {
  expect(decodeAnthropicKey("ANTHROPIC_API_KEY='synthetic-key-123'\n")).toBe("synthetic-key-123");
  for (const source of ["ANTHROPIC_API_KEY=$(whoami)", "ANTHROPIC_API_KEY=synthetic-key-123\nANTHROPIC_API_KEY=synthetic-key-456", "ANTHROPIC_API_KEY=synthetic-key-123\nOTHER_KEY=secret"]) expect(() => decodeAnthropicKey(source)).toThrow("credential_invalid");
  await expect(classificationPath("../escape.json")).rejects.toThrow("private_path_required");
  expect(candidateId(decodePhaseB(phaseBConfig()).candidates[0]).length).toBeLessThanOrEqual(96);
});
it("Phase B caps/paired bootstrap preserve policy, n, undefined cases and seed", () => {
  const s: Snapshot = { version: "classification-snapshot-v1", rubric: "low-brain-v1", policy: "classification-report-v2", emotionalCap: 2, modelId: "synthetic", promptId: "classification-v1", movies: [], revisions: [] };
  const human = [0, 1, 3, 4], model = [0, 2, 2, 4], at = "2026-10-08T12:00:00.000Z";
  for (let i = 0; i < 4; i++) {
    const id = movieId(`30000000-0000-4000-8000-00000000000${i}`);
    s.movies = [...s.movies, { id, active: true, title: "Synthetic title", inputFingerprint: "a".repeat(64), links: [] }];
    for (const kind of ["model", "human_anchor"] as const) {
      const score = kind === "model" ? model[i] : human[i];
      s.revisions = [...s.revisions, { id: `${kind}-${i}`, movieId: id, kind, rubric: s.rubric, scores: { narrative_complexity: score, attention_demand: score, emotional_burden: 3, on_screen_text_dependence: 0 }, uncertainty: { narrative_complexity: "low", attention_demand: "low", emotional_burden: "low" }, fingerprint: "a".repeat(64), modelId: kind === "model" ? s.modelId : null, promptId: kind === "model" ? s.promptId : null, parent: null, action: null, evidence: {}, evidenceExpiresAt: null, createdAt: at }];
    }
  }
  const r = agreement(s, at); expect(r.attributes.narrative_complexity.kappa).toBeCloseTo(8 / 9); expect(r.bootstrap?.n).toBe(4);
  expect(r.bootstrap?.attributes.emotional_burden).toMatchObject({ low: null, high: null, undefinedReplicates: 2000 });
  expect(r.bootstrap).toEqual(agreement(s, at).bootstrap); expect(r.bootstrap).not.toEqual(agreement(s, at, 7).bootstrap);
  expect(coverage(s, at)).toMatchObject({ policy: "classification-report-v2", capPassing: 0, effectivePassing: 0 });
  const second: Snapshot = { ...s, modelId: "second", movies: [...s.movies].reverse(), revisions: s.revisions.filter(r => r.movieId !== s.movies[0].id).map(r => r.kind === "model" ? { ...r, modelId: "second" } : r) };
  const compared = compareAgreement([s, second], at); expect(compared.commonPairs).toBe(3);
  expect(compared.candidates[0].common.bootstrap?.n).toBe(3); expect(compared.candidates[0].common.bootstrap).toEqual(compared.candidates[1].common.bootstrap);
});
it("production composition refuses terms before storage, provider and credential callbacks", async () => {
  let effects = 0; const forbidden = async () => { effects++; throw new Error("effect_forbidden"); };
  const io: ClassificationIO = { inspect: forbidden, password: forbidden, key: forbidden, tmdbToken: forbidden, pool: () => { effects++; throw new Error("effect_forbidden"); }, guard: forbidden,
    anthropic: { now: Date.now, fetch: forbidden }, metadata: { fetch: forbidden, sleep: forbidden } };
  const composed = await classificationEffects({ action: "run", signal: new AbortController().signal }, io);
  const config = decodePhaseB(phaseBConfig());
  await expect(composed.phaseB!({ ...config, terms: { ...config.terms, noTraining: false } } as unknown as typeof config, undefined, new AbortController().signal)).rejects.toThrow("terms_required");
  expect(effects).toBe(0); await composed.close!();
});
