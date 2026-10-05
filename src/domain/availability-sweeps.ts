/** Normalized candidate identities; neither membership nor selection proves access. */
export interface SweepCandidate {
  readonly watchmodeId: number;
  readonly tmdbId: string | null;
  readonly popularity: number | null;
}
export function popularityOrder(a: SweepCandidate, b: SweepCandidate): number {
  if (a.popularity === null && b.popularity !== null)
    return 1;
  if (b.popularity === null && a.popularity !== null)
    return -1;
  return (b.popularity ?? 0) - (a.popularity ?? 0) || a.watchmodeId - b.watchmodeId;
}
export type EnrichmentOutcome = "created" | "updated" | "unchanged" | "stale" |
  "failed" | "not_found" | "identity_conflict";

/** Choose a turn from queues already filtered, deduplicated and sorted by the caller. */
export function nextCandidate(queues: readonly (readonly SweepCandidate[])[], cursor: number) {
  for (let offset = 0; offset < queues.length; offset++) {
    const service = (cursor + offset) % queues.length;
    const candidate = queues[service][0];
    if (candidate) return { candidate, service };
  }
  return undefined;
}
