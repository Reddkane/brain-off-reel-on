import { expect, it } from "vitest";
import { phaseBalance, classifyBounded, configIdentity } from "../../src/server/classification/orchestrator.ts";
import type { Classifier } from "../../src/server/classification/orchestrator.ts";
import { movie, output } from "./fixtures.ts";
import { ClassificationError } from "../../src/domain/classification.ts";
const config = { version: "classification-run-v1", phase: "B", candidates: ["synthetic"], configId: "synthetic-v1", spendCap: 10, perCallMaximum: 3,
  maxCalls: 3, maxAttempts: 3, attemptMs: 100, durationMs: 1000, continuation: true };
it.each(["input_changed", "database_failed"])("known spend survives %s persistence failure without phantom carry-over", async code => {
  const result = await classifyBounded({ config, startingBalance: 0, items: [movie()], signal: new AbortController().signal,
    classifier: { classify: async () => ({ status: "ok", output: output(), actualCost: 1 }) },
    persist: async () => { throw code === "input_changed" ? new ClassificationError(code) : new Error("synthetic DB timeout"); } });
  expect(result).toMatchObject({ code, calls: 1, processed: 0, spend: { actual: 1, unknown: 0 } });
  expect(phaseBalance(config, result.spend)).toBe(1);
});
it.each([false, true])("backoff failure (cancel=%s) does not reserve a second unknown charge", async cancel => {
  const controller = new AbortController();
  const result = await classifyBounded({ config, startingBalance: 0, items: [movie()], signal: controller.signal,
    classifier: { classify: async () => ({ status: "failed", retryable: true, cost: 1 }) },
    backoff: async () => { if (cancel) controller.abort(); throw new Error("synthetic backoff failure"); } });
  expect(result).toMatchObject({ code: cancel ? "cancelled" : "backoff_failed", calls: 1, spend: { actual: 1, unknown: 0 } });
});
it("transport exception still reserves unknown spend", async () => {
  const result = await classifyBounded({ config, startingBalance: 0, items: [movie()], signal: new AbortController().signal,
    classifier: { classify: async () => { throw new Error("synthetic transport failure"); } } });
  expect(result).toMatchObject({ code: "spend_unknown", calls: 1, spend: { actual: 0, unknown: 3 } });
});
it("continuation refuses missing and mismatched reports before transport", () => {
  expect(() => phaseBalance(config)).toThrow("prior_report_required");
  expect(() => phaseBalance(config, { version: "classification-spend-v1", phase: "C", candidates: ["synthetic"], configId: "synthetic-v1", actual: 1, unknown: 2 })).toThrow("prior_report_mismatch");
});
it("cap starts from actual plus unknown spend", () => {
  expect(phaseBalance(config, { version: "classification-spend-v1", phase: "B", candidates: ["synthetic"], configId: configIdentity(config), actual: 4, unknown: 4 })).toBe(8);
});
it("same config label cannot hide changed limits in a continuation", () => {
  expect(() => phaseBalance({ ...config, attemptMs: 200 }, { version: "classification-spend-v1", phase: "B", candidates: ["synthetic"], configId: configIdentity(config), actual: 1, unknown: 0 })).toThrow("prior_report_mismatch");
});
it("carry-over cannot exceed remaining cap", async () => {
  let calls = 0;
  const result = await classifyBounded({ config, startingBalance: 8, items: [movie()], signal: new AbortController().signal,
    classifier: { classify: async () => { calls++; return { status: "ok", output: output(), actualCost: 1 }; } } });
  expect(calls).toBe(0); expect(result).toMatchObject({ code: "spend_cap", calls: 0 });
});
it("carried unknown cost remains unknown and unexpected actual usage is not lost", async () => {
  const base = { config, startingBalance: 8, startingUnknown: 4, items: [movie()], signal: new AbortController().signal,
    classifier: { classify: async () => ({ status: "ok" as const, output: output(), actualCost: 1 }) } };
  expect(await classifyBounded(base)).toMatchObject({ spend: { actual: 4, unknown: 4 } });
  expect(await classifyBounded({ ...base, startingBalance: 0, startingUnknown: 0, classifier: { classify: async () => ({ status: "ok", output: output(), actualCost: 11 }) } })).toMatchObject({ spend: { actual: 11 }, code: "spend_cap" });
});
it("successful validation, invalid output, transient retry and cancellation are bounded", async () => {
  let calls = 0;
  const classifier: Classifier = { classify: async () => { calls++; return calls === 1 ? { status: "failed", retryable: true, cost: 0 } : { status: "ok", output: output(), actualCost: 1 }; } };
  expect(await classifyBounded({ config: { ...config, continuation: false }, startingBalance: 0, items: [movie()], classifier, signal: new AbortController().signal, backoff: async () => {} })).toMatchObject({ processed: 1, calls: 2 });
  const malformed = await classifyBounded({ config: { ...config, continuation: false }, startingBalance: 0, items: [movie()], classifier: { classify: async () => ({ status: "ok", output: { bad: true }, actualCost: 1 }) }, signal: new AbortController().signal });
  expect(malformed).toMatchObject({ rejected: 1, calls: 1 });
  const abort = new AbortController(); abort.abort();
  expect(await classifyBounded({ config, startingBalance: 0, items: [movie()], classifier, signal: abort.signal })).toMatchObject({ code: "cancelled", calls: 0 });
});
it("raw JSON classifier output is decoded without losing duplicate keys", async () => {
  const base = { config: { ...config, continuation: false }, startingBalance: 0, items: [movie()], signal: new AbortController().signal };
  expect(await classifyBounded({ ...base, classifier: { classify: async () => ({ status: "ok", output: JSON.stringify(output()), actualCost: 1 }) } })).toMatchObject({ processed: 1 });
  const duplicate = JSON.stringify(output()).replace('"narrative_complexity":1', '"narrative_complexity":4,"narrative_complexity":1');
  expect(await classifyBounded({ ...base, classifier: { classify: async () => ({ status: "ok", output: duplicate, actualCost: 1 }) } })).toMatchObject({ rejected: 1, calls: 1 });
});
