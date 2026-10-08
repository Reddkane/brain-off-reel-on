export const fields = ["narrative_complexity", "attention_demand", "emotional_burden", "on_screen_text_dependence", "pacing", "tone", "content_tags"];
export function output() {
  return { narrative_complexity: 1, attention_demand: 2, emotional_burden: 1, on_screen_text_dependence: 0,
    pacing: "moderate", tone: ["warm"], content_tags: [],
    field_provenance: Object.fromEntries(fields.map(f => [f, { basis: ["model_prior_knowledge"], evidence_refs: [] as string[] }])),
    field_uncertainty: Object.fromEntries(fields.map(f => [f, "low"])) };
}
export function movie(extra = {}) {
  return { title: "Synthetic film", release_year: 2000, overview: "Synthetic overview", genres: ["Drama"], keywords: ["clue"],
    runtime_minutes: 100, us_certification: "PG", original_language: "en", credits: [], ...extra };
}
