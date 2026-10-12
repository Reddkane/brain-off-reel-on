import { ClassificationError, fields } from "../../domain/classification.ts";
import type { Projected } from "../../domain/classification.ts";
import type { Classifier } from "./orchestrator.ts";
import type { Candidate } from "./phase-b.ts";
import { candidateId } from "./phase-b.ts";
import { buildPrompt, decodeJson } from "./codec.ts";

const enumSchema = (values: readonly string[]) => ({ type: "string", enum: values });
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const outputSchema = objectSchema({
  narrative_complexity: { type: "integer", enum: [0, 1, 2, 3, 4] }, attention_demand: { type: "integer", enum: [0, 1, 2, 3, 4] },
  emotional_burden: { type: "integer", enum: [0, 1, 2, 3, 4] }, on_screen_text_dependence: { type: "integer", enum: [0, 1, 2, 3, 4] },
  pacing: enumSchema(["slow", "moderate", "fast", "variable"]), tone: { type: "array", items: enumSchema(["light", "warm", "comic", "adventurous", "tense", "somber", "bleak", "reflective", "surreal"]) },
  content_tags: { type: "array", items: enumSchema(["violence", "death", "grief", "abuse", "self_harm", "sexual_violence", "substance_use", "threat"]) },
  field_provenance: objectSchema(Object.fromEntries(fields.map(f => [f, objectSchema({ basis: { type: "array", items: enumSchema(["supplied_evidence", "model_prior_knowledge"]) }, evidence_refs: { type: "array", items: { type: "string" } } })]))),
  field_uncertainty: objectSchema(Object.fromEntries(fields.map(f => [f, enumSchema(["low", "medium", "high"])]))),
});
export function requestBody(input: Projected, c: Candidate) {
  return { model: c.model, max_tokens: c.maxTokens, messages: [{ role: "user", content: buildPrompt(input) }],
    output_config: { effort: c.effort, format: { type: "json_schema", schema: outputSchema } } };
}
export interface AnthropicIO { fetch: typeof fetch; now: () => number }
export interface Measurement { inputTokens: number | null; outputTokens: number | null; visibleCharacters: number; elapsedMs: number }
function isObject(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function token(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
export function usageCost(value: unknown, c: Candidate): number | null {
  if (!isObject(value) || !token(value.input_tokens) || !token(value.output_tokens) ||
    (value.cache_creation_input_tokens !== undefined && value.cache_creation_input_tokens !== 0) ||
    (value.cache_read_input_tokens !== undefined && value.cache_read_input_tokens !== 0) ||
    (value.service_tier !== undefined && value.service_tier !== "standard")) return null;
  const cost = value.input_tokens * c.inputRate + value.output_tokens * c.outputRate;
  return Number.isSafeInteger(cost) ? cost : null;
}
const errorTypes: Record<number, string> = { 400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error", 404: "not_found_error", 409: "conflict_error", 413: "request_too_large", 429: "rate_limit_error", 529: "overloaded_error" };
function rejection(status: number, body: unknown): boolean {
  return errorTypes[status] !== undefined && isObject(body) && body.type === "error" && isObject(body.error) && body.error.type === errorTypes[status] && typeof body.error.message === "string";
}
export function createAnthropic(key: string, candidates: readonly Candidate[], io: AnthropicIO = { fetch: (...args) => fetch(...args), now: Date.now }, zeroCostVerified = false) {
  if (!key || /[\r\n]/.test(key)) throw new ClassificationError("credential_invalid");
  async function request(path: "messages" | "messages/count_tokens", body: unknown, signal: AbortSignal, deadline: number) {
    const remaining = deadline - io.now(); if (remaining <= 0) throw new ClassificationError("timeout");
    const timeout = AbortSignal.timeout(remaining);
    const response = await io.fetch(`https://api.anthropic.com/v1/${path}`, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, timeout]),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.body) throw new ClassificationError("protocol_failed");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 262144) throw new ClassificationError("body_limit"); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return { status: response.status, body: decodeJson(bodyText, 262144), retryAfter: response.headers.get("retry-after") };
  }
  return {
    async count(input: Projected, c: Candidate, signal: AbortSignal, overhead: number) {
      const full = requestBody(input, c), { max_tokens: _max, ...body } = full; void _max;
      try {
        let result = await request("messages/count_tokens", body, signal, io.now() + 10000), fallback = false;
        if (result.status === 400 && rejection(400, result.body)) {
          const { output_config: _format, ...base } = body; void _format;
          result = await request("messages/count_tokens", base, signal, io.now() + 10000); fallback = true;
        }
        if (result.status !== 200 || !isObject(result.body) || !token(result.body.input_tokens)) throw new ClassificationError("count_failed");
        const countedTokens = result.body.input_tokens;
        return { countedTokens, fallback, budget: Math.ceil(countedTokens * 1.10) + (fallback ? overhead : 256) };
      } catch { throw new ClassificationError("count_failed"); }
    },
    async classify(input: Projected, ctx: Parameters<Classifier["classify"]>[1]) {
      const c = candidates.find(v => candidateId(v) === ctx.candidate); if (!c) throw new ClassificationError("invalid_input");
      const started = io.now();
      const measurement: Measurement = { inputTokens: null, outputTokens: null, visibleCharacters: 0, elapsedMs: 0 };
      try {
        const response = await request("messages", requestBody(input, c), ctx.signal, ctx.deadline);
        measurement.elapsedMs = Math.max(0, io.now() - started);
        if (response.status !== 200) {
          const known = zeroCostVerified && rejection(response.status, response.body);
          const wait = response.retryAfter !== null && /^\d+(?:\.\d+)?$/.test(response.retryAfter) ? Math.ceil(Number(response.retryAfter) * 1000) :
            response.retryAfter !== null && Number.isFinite(Date.parse(response.retryAfter)) ? Math.max(0, Date.parse(response.retryAfter) - io.now()) : 0;
          return { status: "failed" as const, cost: known ? 0 : null, retryable: known && [429, 529].includes(response.status),
            reason: response.status === 429 ? "throttled" : response.status === 529 ? "overloaded" : response.status >= 500 ? "server_failed" : "request_rejected", retryAfterMs: wait, measurement };
        }
        const body = response.body;
        if (!isObject(body)) return { status: "failed" as const, cost: null, retryable: false, reason: "protocol_failed", measurement };
        const cost = usageCost(body.usage, c);
        if (isObject(body.usage)) { measurement.inputTokens = token(body.usage.input_tokens) ? body.usage.input_tokens : null; measurement.outputTokens = token(body.usage.output_tokens) ? body.usage.output_tokens : null; }
        const blocks = Array.isArray(body.content) ? body.content : [];
        const texts: string[] = [];
        for (const b of blocks) if (isObject(b)) {
          if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
        }
        measurement.visibleCharacters = texts.reduce((n, s) => n + s.length, 0);
        const reason = body.model !== c.model ? "model_mismatch" : body.stop_reason === "refusal" ? "refusal" : body.stop_reason === "max_tokens" ? "truncation" : body.stop_reason !== "end_turn" || body.type !== "message" || body.role !== "assistant" || texts.length !== 1 ? "protocol_failed" : null;
        if (reason) return { status: "failed" as const, cost, retryable: false, reason, measurement };
        return { status: "ok" as const, output: texts[0], actualCost: cost, measurement };
      } catch (e) {
        measurement.elapsedMs = Math.max(0, io.now() - started);
        return { status: "failed" as const, cost: null, retryable: false, reason: ctx.signal.aborted || io.now() >= ctx.deadline ? "timeout" : e instanceof ClassificationError ? "protocol_failed" : "connection_failed", measurement };
      }
    },
  };
}
