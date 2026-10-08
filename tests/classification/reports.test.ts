import { expect, it } from "vitest";
import { coverage, agreement } from "../../src/domain/classification-reports.ts";
import type { Revision } from "../../src/domain/classification.ts";
import { movieId } from "../../src/server/providers/tmdb-validation.ts";
const at = "2026-10-07T12:00:00.000Z";
const id = movieId("30000000-0000-4000-8000-000000000001");
export function revision(extra: Partial<Revision> = {}): Revision {
  return { id: "40000000-0000-4000-8000-000000000001", movieId: id, rubric: "low-brain-v1", kind: "model",
    scores: { narrative_complexity: 1, attention_demand: 1, emotional_burden: 1, on_screen_text_dependence: 0 },
    uncertainty: { narrative_complexity: "medium", attention_demand: "medium", emotional_burden: "low", on_screen_text_dependence: "low" },
    createdAt: "2026-10-07T10:00:00.000Z", fingerprint: "a".repeat(64), modelId: "synthetic", promptId: "classification-v1", parent: null, action: null, evidence: {}, evidenceExpiresAt: null, ...extra };
}
export function review(action: "accept" | "replace" | "defer", hour: number): Revision {
  const parent = revision();
  return revision({ id: `40000000-0000-4000-8000-00000000000${hour}`, kind: "human_review", parent: parent.id, modelId: null, promptId: null,
    action, createdAt: `2026-10-07T${hour}:00:00.000Z`, uncertainty: { ...parent.uncertainty, narrative_complexity: "low", attention_demand: "low" },
    evidence: Object.fromEntries(["narrative_complexity", "attention_demand"].map(f => [f, { type: "detailed_synopsis", reference: "synthetic:story", checkedAt: at, expiresAt: null }])) });
}
export function snapshot(revisions: Revision[]) {
  return { version: "classification-snapshot-v1", modelId: "synthetic", promptId: "classification-v1", rubric: "low-brain-v1", policy: "classification-report-v1", emotionalCap: null,
    movies: [{ id, active: true, title: "Synthetic film", inputFingerprint: "a".repeat(64), links: [{ checkedAt: at, promotedAt: null, membershipAt: null, expiresAt: "2026-11-01T00:00:00.000Z", subscription: true, included: true, validDestination: true }] }], revisions };
}
it("accept then defer cancels eligibility; anchors never resolve it", () => {
  expect(coverage(snapshot([revision(), review("accept", 10), review("defer", 11)]), at)).toMatchObject({ effectivePassing: 0, effectiveLinked: 0 });
  expect(coverage(snapshot([revision(), revision({ kind: "human_anchor", uncertainty: {}, modelId: null, promptId: null })]), at)).toMatchObject({ effectivePassing: 0 });
});
it("defer then accept resolves eligibility for the exact parent", () => {
  expect(coverage(snapshot([revision(), review("defer", 10), review("accept", 11)]), at)).toMatchObject({ modelPassing: 0, effectivePassing: 1, effectiveLinked: 1 });
});
it.each(["accept", "replace"] as const)("%s reviewer uncertainty overrides an initially low model gate", action => {
  for (const uncertainty of ["medium", "high"] as const) {
    const parent = revision({ uncertainty: { ...revision().uncertainty, narrative_complexity: "low", attention_demand: "low" } });
    const r = review(action, 11); r.uncertainty = { ...r.uncertainty, attention_demand: uncertainty };
    expect(coverage(snapshot([parent, r]), at)).toMatchObject({ modelPassing: 1, effectivePassing: 0 });
    r.evidence = {};
    expect(coverage(snapshot([parent, r]), at)).toMatchObject({ effectivePassing: 0 });
  }
});
it("unassessed keeps unchanged parent gates; unsupported low and changed unassessed scores block", () => {
  const parent = revision({ uncertainty: { ...revision().uncertainty, narrative_complexity: "low", attention_demand: "low" } });
  const r = review("accept", 11); r.evidence = {};
  r.uncertainty = { ...r.uncertainty, narrative_complexity: "unassessed", attention_demand: "unassessed" };
  expect(coverage(snapshot([parent, r]), at)).toMatchObject({ effectivePassing: 1 });
  r.uncertainty = { ...r.uncertainty, attention_demand: "low" };
  expect(coverage(snapshot([parent, r]), at)).toMatchObject({ effectivePassing: 0 });
  r.action = "replace"; r.scores = { ...r.scores, attention_demand: 2 };
  r.uncertainty = { ...r.uncertainty, attention_demand: "unassessed" };
  expect(coverage(snapshot([parent, r]), at)).toMatchObject({ effectivePassing: 0 });
});
it("replaced scores can reduce coverage; wrong parent and unsupported evidence cannot resolve", () => {
  const r = review("replace", 11); r.scores.attention_demand = 4;
  expect(coverage(snapshot([revision(), r]), at)).toMatchObject({ effectivePassing: 0 });
  const wrong = review("accept", 11); wrong.parent = "40000000-0000-4000-8000-000000000099";
  expect(coverage(snapshot([revision(), wrong]), at)).toMatchObject({ effectivePassing: 0 });
  const unsupported = review("accept", 11); unsupported.evidence = { attention_demand: { type: "content_guide", reference: "synthetic:guide", checkedAt: at, expiresAt: null } };
  expect(coverage(snapshot([revision(), unsupported]), at)).toMatchObject({ effectivePassing: 0 });
});
it("coverage intersects fresh links, excludes retired and deduplicates offers", () => {
  const s = snapshot([revision({ uncertainty: { narrative_complexity: "low", attention_demand: "low", pacing: "high" } })]);
  s.movies[0].links[0].expiresAt = "2026-10-06T00:00:00.000Z";
  expect(coverage(s, at)).toMatchObject({ modelPassing: 1, effectivePassing: 1, effectiveLinked: 0 });
  s.movies[0].active = false;
  expect(coverage(s, at)).toMatchObject({ active: 0 });
});
it("agreement uses film/rubric despite distinct metadata fingerprints", () => {
  const anchor = revision({ id: "40000000-0000-4000-8000-000000000009", kind: "human_anchor", modelId: null, promptId: null, fingerprint: "b".repeat(64) });
  expect(agreement(snapshot([revision(), anchor]), at)).toMatchObject({ pairs: 1, attributes: { attention_demand: { exact: 1, withinOne: 1, kappa: null } } });
});
it("changed stored input flags old model labels and excludes their eligible coverage", () => {
  const s = snapshot([revision({ uncertainty: { narrative_complexity: "low", attention_demand: "low" } })]);
  const changed = { ...s, movies: s.movies.map(m => ({ ...m, inputFingerprint: "b".repeat(64) })) };
  expect(coverage(changed, at)).toMatchObject({ stale: 1, effectivePassing: 0, effectiveLinked: 0 });
});
it("independently calculated quadratic kappa 2/3 and exact 2/3", () => {
  const pairs = [0, 1, 2].flatMap((n, index) => {
    const uuid = movieId(`30000000-0000-4000-8000-00000000000${index + 1}`);
    return [revision({ movieId: uuid, scores: { ...revision().scores, narrative_complexity: n } }),
      revision({ movieId: uuid, kind: "human_anchor", modelId: null, promptId: null, scores: { ...revision().scores, narrative_complexity: index === 2 ? 1 : n } })];
  });
  // Squared disagreement = 1/3. Nine equally weighted marginal pairs sum to 9: expected = 1.
  expect(agreement({ ...snapshot(pairs), movies: [1, 2, 3].map(n => ({ ...snapshot([]).movies[0], id: movieId(`30000000-0000-4000-8000-00000000000${n}`) })) }, at)).toMatchObject({ pairs: 3, attributes: { narrative_complexity: { exact: 2 / 3, withinOne: 1, kappa: 1 - 1 / 3 } } });
});
