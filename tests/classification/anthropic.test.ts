import { expect, it } from "vitest";
import { createAnthropic, requestBody, usageCost } from "../../src/server/classification/anthropic.ts";
import { decodePhaseB, candidateId, phaseBIdentity } from "../../src/server/classification/phase-b.ts";
import { prepareInput } from "../../src/server/classification/codec.ts";
import { movie, output, phaseBConfig } from "./fixtures.ts";
function response(stop = "end_turn", usage: unknown = { input_tokens: 1234, output_tokens: 567, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" }) {
  return { type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: stop,
    content: [{ type: "thinking", thinking: "Synthetic thinking", signature: "synthetic" }, { type: "text", text: JSON.stringify(output()) }], usage };
}
function adapter(body: unknown, status = 200, verified = true, headers = {}) {
  let requests = 0;
  const c = decodePhaseB(phaseBConfig()).candidates[0];
  const classifier = createAnthropic("synthetic-key", [c], { fetch: async () => { requests++; return new Response(JSON.stringify(body), { status, headers }); }, now: Date.now }, verified);
  return { classifier, c, requests: () => requests };
}
const context = () => ({ candidate: candidateId(decodePhaseB(phaseBConfig()).candidates[0]), deadline: Date.now() + 1000, signal: new AbortController().signal });
it("hand-computed metering accepts realistic standard/cache-zero usage", () => {
  expect(usageCost(response().usage, decodePhaseB(phaseBConfig()).candidates[0])).toBe(8138);
  for (const usage of [null, {}, { input_tokens: -1, output_tokens: 1 }, { ...response().usage as object, cache_read_input_tokens: 1 }, { ...response().usage as object, service_tier: "priority" }])
    expect(usageCost(usage, decodePhaseB(phaseBConfig()).candidates[0])).toBeNull();
});
it("production request has explicit effort/schema and no fallback/prefill/tools/thinking disable", () => {
  const body = requestBody(prepareInput(movie()).input, decodePhaseB(phaseBConfig()).candidates[0]);
  expect(body.output_config.effort).toBe("high"); expect(body.output_config.format.type).toBe("json_schema");
  expect(body.messages.map(m => m.role)).toEqual(["user"]);
  expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config"]);
  expect(JSON.stringify(body)).not.toContain("fallbacks");
});
it("real response text is extracted, refusal/truncation classified, single request only", async () => {
  for (const [stop, reason] of [["end_turn", "ok"], ["refusal", "refusal"], ["max_tokens", "truncation"]]) {
    const a = adapter(response(stop)); const r = await a.classifier.classify(prepareInput(movie()).input, context());
    expect(r.status === "ok" ? "ok" : r.reason).toBe(reason); expect(a.requests()).toBe(1);
    expect(r.status === "ok" ? r.actualCost : r.cost).toBe(8138);
  }
});
it("verified well-formed 429/529 reject at zero cost; malformed/500/unverified stay unknown", async () => {
  for (const [status, type] of [[429, "rate_limit_error"], [529, "overloaded_error"], [400, "invalid_request_error"]] as const) {
    const a = adapter({ type: "error", error: { type, message: "Synthetic rejection" } }, status, true, { "retry-after": "2" });
    expect(await a.classifier.classify(prepareInput(movie()).input, context())).toMatchObject({ status: "failed", cost: 0, retryable: status !== 400, retryAfterMs: 2000 });
    expect(a.requests()).toBe(1);
  }
  for (const a of [adapter({}, 429), adapter({ type: "error", error: { type: "api_error", message: "Synthetic" } }, 500), adapter({ type: "error", error: { type: "rate_limit_error", message: "Synthetic" } }, 429, false)])
    expect(await a.classifier.classify(prepareInput(movie()).input, context())).toMatchObject({ status: "failed", cost: null, retryable: false });
});
it("model mismatch retains known usage; missing usage stops; count failure never dispatches paid call", async () => {
  const a = adapter({ ...response(), model: "different-model" });
  expect(await a.classifier.classify(prepareInput(movie()).input, context())).toMatchObject({ reason: "model_mismatch", cost: 8138 });
  expect(await adapter(response("end_turn", null)).classifier.classify(prepareInput(movie()).input, context())).toMatchObject({ actualCost: null });
  const b = adapter({}, 500); await expect(b.classifier.count(prepareInput(movie()).input, b.c, context().signal, 256)).rejects.toThrow("count_failed"); expect(b.requests()).toBe(1);
});
it("freshness/terms config gates precede effect creation and identity is readable/settings-distinct", () => {
  const cfg = phaseBConfig(); expect(candidateId(decodePhaseB(cfg).candidates[1])).toBe("claude-opus-5-5:effort=medium:out=10500:ms=300000:v1");
  expect(() => decodePhaseB({ ...cfg, terms: { ...cfg.terms, noTraining: false } })).toThrow("terms_required");
  expect(() => decodePhaseB({ ...cfg, rates: { ...cfg.rates, checkedAt: "2020-01-01T00:00:00.000Z" } })).toThrow("rates_required");
  expect(() => decodePhaseB({ ...cfg, terms: { ...cfg.terms, checkedAt: "2020-01-01T00:00:00.000Z" } })).toThrow("terms_required");
  expect(() => decodePhaseB({ ...cfg, rejectionBilling: { ...cfg.rejectionBilling, checkedAt: "2099-01-01T00:00:00.000Z" } })).toThrow("billing_check_required");
  expect(phaseBIdentity(decodePhaseB(cfg))).not.toBe(phaseBIdentity(decodePhaseB({ ...cfg, candidates: cfg.candidates.map(c => ({ ...c, maxTokens: 10000 })) })));
});
it("full counter request contains the exact classify prompt/schema and fallback is explicit", async () => {
  const transcript: Record<string, unknown>[] = [], c = decodePhaseB(phaseBConfig()).candidates[0], input = prepareInput(movie()).input;
  const classifier = createAnthropic("synthetic-key", [c], { now: Date.now, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); transcript.push(body);
    return new Response(JSON.stringify(transcript.length === 1 ? { input_tokens: 1000 } : response()));
  } }, true);
  await classifier.count(input, c, context().signal, 256); await classifier.classify(input, context());
  const { max_tokens: _max, ...paid } = transcript[1]; void _max;
  expect(transcript[0]).toEqual(paid); expect(transcript[0]).toHaveProperty("output_config.format.schema");
});
it("timeout and connection loss have distinct safe outcomes and no automatic retry", async () => {
  const c = decodePhaseB(phaseBConfig()).candidates[0];
  for (const aborted of [false, true]) {
    const controller = new AbortController(); if (aborted) controller.abort(); let calls = 0;
    const classifier = createAnthropic("synthetic-key", [c], { now: Date.now, fetch: async () => { calls++; throw new Error("SYNTHETIC_SECRET"); } }, true);
    const result = await classifier.classify(prepareInput(movie()).input, { ...context(), signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", cost: null, retryable: false, reason: aborted ? "timeout" : "connection_failed" }); expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
  }
});
