import { array, ClassificationError, exact, record, unique } from "../../domain/classification.ts";
import { tmdbId } from "../providers/tmdb-validation.ts";
import type { MetadataStore, StoreContext } from "../db/metadata-store.ts";
import type { MetadataProvider, ProviderContext } from "../providers/metadata-provider.ts";
export function decodeAnchorIds(value: unknown) {
  const r = record(value); exact(r, ["version", "ids"]);
  if (r.version !== "classification-anchor-ids-v1") throw new ClassificationError("invalid_input");
  return unique(array(r.ids, 50).map(v => { if (typeof v !== "string") throw new ClassificationError("invalid_input"); return tmdbId(v); }));
}
export async function ingestAnchorIds(options: {
  ids: unknown; provider: MetadataProvider; store: MetadataStore; capability: object; context: ProviderContext; storeContext: StoreContext;
}) {
  const ids = decodeAnchorIds(options.ids), additions: string[] = [];
  if (options.context.budget.maxAttempts > 100 || options.context.budget.deadline - options.context.now() > 600000) throw new ClassificationError("invalid_input");
  let unchanged = 0;
  for (const externalId of ids) {
    options.context.signal.throwIfAborted();
    if (options.context.now() >= options.context.budget.deadline || options.context.budget.attempts >= options.context.budget.maxAttempts) throw new ClassificationError("deadline");
    const key = { source: "tmdb" as const, externalId };
    const existing = await options.store.resolveMovie(key, options.storeContext);
    if (existing) { unchanged++; continue; }
    const response = await options.provider.getMovie(key, options.context);
    if (response.status !== "ok") throw new ClassificationError(response.status === "not_found" ? "anchor_movie_unresolved" : "metadata_failed");
    if (!response.value.keys.some(k => k.source === "tmdb" && k.externalId === externalId)) throw new ClassificationError("metadata_failed");
    const written = await options.store.persistMovie(options.capability, response.value, 1000, options.storeContext);
    if (!["created", "updated", "unchanged"].includes(written.status) || !("movieId" in written)) throw new ClassificationError("metadata_failed");
    if (await options.store.resolveMovie(key, options.storeContext) !== written.movieId) throw new ClassificationError("readback_failed");
    if (written.status === "created") additions.push(written.movieId); else unchanged++;
  }
  return { inserted: additions.length, unchanged, additions };
}
