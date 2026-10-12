import { expect, it } from "vitest";
import { phaseBConfig, movie, output } from "./fixtures.ts";
import { decodePhaseB, priorBalance, candidateId, phaseBIdentity } from "../../src/server/classification/phase-b.ts";
import { runPhaseB } from "../../src/server/classification/phase-b-run.ts";
import { prepareInput } from "../../src/server/classification/codec.ts";
import { createAnthropic } from "../../src/server/classification/anthropic.ts";
import { classificationPath, checkPhaseHistory, writePhaseHead } from "../../scripts/classification-private.ts";
import { unlink } from "node:fs/promises";
import { hash } from "../../src/server/classification/codec.ts";

async function firstPilot() {
  const config = decodePhaseB(phaseBConfig());
  const classifier = fake(config);
  return runPhaseB({ config, classifier: classifier.adapter, items: [movie(), movie()], signal: new AbortController().signal, persist: async () => {}, save: async () => {} });
}
function fake(config: ReturnType<typeof decodePhaseB>) {
  let counted = 0, paid = 0;
  return { calls: () => ({ counted, paid }), adapter: createAnthropic("synthetic-key", config.candidates, { now: Date.now, fetch: async (url, init) => {
    if (String(url).endsWith("count_tokens")) { counted++; return new Response('{"input_tokens":1000}'); }
    paid++; const r = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ type: "message", role: "assistant", model: r.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(output()) }], usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" } }));
  } }, true) };
}
it("fresh main cannot reset prior main spend to the pilot balance", async () => {
  const pilot = await firstPilot();
  const main = decodePhaseB({ ...phaseBConfig(), stage: "main", pilotReport: "pilot.json" });
  expect(() => priorBalance(main, undefined, pilot)).toThrow("prior_report_required");
  const previous = { ...pilot, stage: "main", actual: 15230000, unknown: 100000 };
  expect(priorBalance({ ...main, continuation: true }, previous, pilot)).toEqual({ actual: 15230000, unknown: 100000 });
  expect(() => decodePhaseB({ ...phaseBConfig(), report: "phase-head-unsafe.json" })).toThrow("private_path_required");
});
it("rechecked rates, changed settings, changed selection and pilot reruns preserve every prior charge", async () => {
  const prior = { ...await firstPilot(), actual: 15230000, unknown: 100000 };
  const cfg = phaseBConfig(), checkedAt = new Date(Date.now() - 86400000).toISOString();
  const config = decodePhaseB({ ...cfg, continuation: true, rates: { ...cfg.rates, checkedAt }, terms: { ...cfg.terms, checkedAt }, candidates: cfg.candidates.map(c => ({ ...c, effort: "low", inputRate: 3 })) });
  expect(phaseBIdentity(config)).not.toBe(prior.configId);
  expect(priorBalance(config, prior, undefined)).toEqual({ actual: 15230000, unknown: 100000 });
});
it("continuation skips committed pairs and projects only remaining work under the remaining cap", async () => {
  const prior = await firstPilot(), config = decodePhaseB({ ...phaseBConfig(), continuation: true, report: "next.json", spendCap: 16000000 });
  const remaining = { ...prior, actual: 15230000, completed: prior.completed.slice(0, 3) };
  const transport = fake(config);
  const result = await runPhaseB({ config, prior: remaining, classifier: transport.adapter, items: [movie(), movie()], signal: new AbortController().signal, persist: async () => {}, save: async () => {} });
  expect(transport.calls()).toEqual({ counted: 1, paid: 1 });
  expect(result).toMatchObject({ skipped: 3, processed: 1, code: "complete", actual: 15244000, previousReport: prior.report });
  expect(result.measurements.at(-1)?.movieId).toBe(config.movieIds[1]);
});
it("changed candidate settings or metadata are new pairs, not pooled successes", async () => {
  const prior = await firstPilot(), config = decodePhaseB({ ...phaseBConfig(), continuation: true, candidates: phaseBConfig().candidates.map(c => ({ ...c, effort: "low" })) });
  const transport = fake(config);
  const r = await runPhaseB({ config, prior, classifier: transport.adapter, items: [movie(), movie()], signal: new AbortController().signal, persist: async () => {}, save: async () => {} });
  expect(transport.calls()).toEqual({ counted: 4, paid: 4 }); expect(r.skipped).toBe(0); expect(r.actual).toBe(84000);
  expect(r.completed.some(c => c.candidate === candidateId(config.candidates[0]) && c.fingerprint === prepareInput(movie()).fingerprint)).toBe(true);
});
it("persistence failure never marks an attempted pair as successfully completed", async () => {
  const config = decodePhaseB(phaseBConfig()), transport = fake(config);
  const r = await runPhaseB({ config, classifier: transport.adapter, items: [movie(), movie()], signal: new AbortController().signal, persist: async () => { throw new Error("synthetic-failure"); }, save: async () => {} });
  expect(r.completed).toEqual([]); expect(r.measurements[0].outcome).not.toBe("ok"); expect(r.actual).toBe(7000);
});
it("guarded DB completions recover a lost commit reply without paying again or dropping spend", async () => {
  const prior = await firstPilot(), config = decodePhaseB({ ...phaseBConfig(), continuation: true, report: "recovered.json" }), transport = fake(config);
  const lostReply = { ...prior, completed: [], processed: 0, code: "database_failed" };
  const result = await runPhaseB({ config, prior: lostReply, storedCompleted: prior.completed, classifier: transport.adapter, items: [movie(), movie()], signal: new AbortController().signal, persist: async () => {}, save: async () => {} });
  expect(transport.calls()).toEqual({ paid: 0, counted: 0 }); expect(result.actual).toBe(42000); expect(result.skipped).toBe(4);
});
it("durable phase pointer refuses fresh/stale reports, covers no-result reruns and pending failures", async () => {
  const prior = await firstPilot(), config = decodePhaseB({ ...phaseBConfig(), phaseId: `synthetic-ledger-${Date.now()}`, report: "ledger.json" });
  const path = await classificationPath(`phase-head-${hash(config.phaseId)}.json`, true);
  try {
    await expect(checkPhaseHistory(config, undefined, true)).rejects.toThrow("prior_report_required");
    await checkPhaseHistory(config, undefined, false);
    await writePhaseHead(config);
    await expect(checkPhaseHistory(config, undefined, false)).rejects.toThrow("phase_report_pending");
    const saved = { ...prior, phaseId: config.phaseId, actual: 12345, report: config.report };
    await writePhaseHead(config, saved);
    await expect(checkPhaseHistory(config, undefined, false)).rejects.toThrow("prior_report_required");
    await checkPhaseHistory({ ...config, continuation: true }, saved, true);
    await expect(checkPhaseHistory({ ...config, continuation: true }, { ...saved, actual: 1 }, true)).rejects.toThrow("prior_report_mismatch");
  } finally { await unlink(path).catch(() => {}); }
});
