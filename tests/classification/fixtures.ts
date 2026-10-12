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
export function phaseBConfig() {
  const checked = { url: "https://www.anthropic.com/legal/commercial-terms", checkedAt: new Date().toISOString() };
  return { version: "classification-phase-b-v1", phaseId: "synthetic-phase", stage: "pilot", movieIds: ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"],
    candidates: [{ model: "claude-sonnet-5-5", effort: "high", maxTokens: 10500, timeoutMs: 180000, contextTokens: 200000, inputRate: 2, outputRate: 10 },
      { model: "claude-opus-5-5", effort: "medium", maxTokens: 10500, timeoutMs: 300000, contextTokens: 200000, inputRate: 4, outputRate: 20 }],
    spendCap: 35000000, rates: checked, terms: { ...checked, noTraining: true }, rejectionBilling: { ...checked, zeroCost: true },
    fallbackOverhead: 256, pilotReport: null, continuation: false, report: "pilot-synthetic.json" };
}
