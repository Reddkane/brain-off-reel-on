import { expect, it } from "vitest";
import { decodeHuman, decodeSnapshot, template } from "../../src/server/classification/files.ts";
it("review templates distinguish unassessed fields from explicit high uncertainty", () => {
  expect(template("human_review").rows[0].uncertainty.attention_demand).toBe("unassessed");
  expect(template("human_anchor").rows[0].uncertainty.attention_demand).toBe("high");
});
it("unassessed is accepted in human reviews and rejected in anchors", () => {
  const row = { movie_id: "30000000-0000-4000-8000-000000000001", tmdb_id: null,
    scores: { narrative_complexity: 1, attention_demand: 1, emotional_burden: 1, on_screen_text_dependence: 0 },
    uncertainty: { narrative_complexity: "unassessed", attention_demand: "high", emotional_burden: "unassessed", on_screen_text_dependence: "unassessed" },
    parent_id: "40000000-0000-4000-8000-000000000001", action: "accept", evidence: {} };
  expect(decodeHuman({ version: "classification-reviews-v1", rubric: "low-brain-v1", rows: [row] }, "human_review").rows[0].uncertainty.narrative_complexity).toBe("unassessed");
  const anchor = { movie_id: row.movie_id, tmdb_id: null, scores: row.scores, uncertainty: row.uncertainty };
  expect(() => decodeHuman({ version: "classification-anchors-v1", rubric: "low-brain-v1", rows: [anchor] }, "human_anchor")).toThrow("invalid_input");
});
it("human imports validate exact identities, scores, versions and bounds", () => {
  for (const bad of [null, { version: "invented", rubric: "low-brain-v1", rows: [] }, { version: "classification-anchors-v1", rubric: "low-brain-v1", rows: [{ movie_id: "not-uuid" }] }]) {
    expect(() => decodeHuman(bad, "human_anchor")).toThrow("invalid_input");
  }
});
it("snapshot rejects incomplete fields, invalid dates and duplicate movies", () => {
  expect(() => decodeSnapshot({ version: "classification-snapshot-v1", movies: [], revisions: [] })).toThrow("invalid_input");
});
