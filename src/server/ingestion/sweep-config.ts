import { array, exactKeys, integer, object, text, tmdbId } from "../providers/tmdb-validation.ts";
import { SweepError } from "../providers/watchmode.ts";
export const sweepMaxima = { durationMs: 600000, credits: 100, pages: 60, details: 100, tmdbAttempts: 300, databaseMs: 120000, catalog: 1000 };
export interface SweepConfig {
  readonly version: "availability-sweeps-v1";
  readonly generation: string;
  readonly limits: typeof sweepMaxima;
  readonly refreshIds: readonly string[];
  readonly terms: {
    readonly accepted: boolean;
    readonly checkedAt: string;
    readonly source: string;
    readonly decision: string;
  };
}
export function decodeSweepConfig(input: unknown): SweepConfig {
  try {
    const value = object(input);
    exactKeys(value, ["version", "generation", "region", "adTierPolicy", "limits", "refreshIds", "terms"]);
    if (value.version !== "availability-sweeps-v1" || value.region !== "US" || value.adTierPolicy !== "allow_unverified_with_label_and_correction")
      throw new Error();
    const generation = text(value.generation, 64);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(generation))
      throw new Error();
    const supplied = object(value.limits);
    exactKeys(supplied, Object.keys(sweepMaxima));
    const limits = { ...sweepMaxima };
    for (const key of Object.keys(sweepMaxima) as (keyof typeof sweepMaxima)[])
      limits[key] = integer(supplied[key], key === "durationMs" ? 31000 : key === "databaseMs" ? 10000 : 1, sweepMaxima[key]);
    const terms = object(value.terms);
    exactKeys(terms, ["accepted", "checkedAt", "source", "decision"]);
    if (typeof terms.accepted !== "boolean" || typeof terms.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(terms.checkedAt) ||
      Number.isNaN(Date.parse(terms.checkedAt)) || new Date(terms.checkedAt).toISOString().slice(0, 10) !== terms.checkedAt)
      throw new Error();
    const source = text(terms.source, 500), decision = text(terms.decision, 1000);
    if (source !== "https://api.watchmode.com/terms/" || decision !== "noncommercial_free_use_with_attribution_and_30_day_cache_limit")
      throw new Error();
    const refreshIds = array(value.refreshIds, 100).map(v => tmdbId(text(v, 10)));
    if (new Set(refreshIds).size !== refreshIds.length)
      throw new Error();
    return { version: "availability-sweeps-v1", generation, limits, refreshIds, terms: { accepted: terms.accepted, checkedAt: terms.checkedAt, source, decision } };
  }
  catch {
    throw new SweepError("config_invalid");
  }
}
