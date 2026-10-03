import type { ExternalMovieKey } from "../../domain/metadata.ts";
import type { PersonalFields, Taste } from "../../domain/ratings-import.ts";
import { strictDate } from "../../domain/metadata-evidence.ts";
import type { MetadataStore, OperatorContext, RatingsResult, ResolvedRating, StoreContext } from "../db/metadata-store.ts";
import { array, exactKeys, integer, InvalidInput, object, tmdbId } from "../providers/tmdb-validation.ts";

export interface SeedRow {
  readonly key: ExternalMovieKey;
  readonly fields: PersonalFields;
  readonly indices: readonly number[];
}

export interface RatingsSeed {
  readonly synthetic: boolean;
  readonly rows: readonly SeedRow[];
}

export class SeedConflict extends InvalidInput {
  readonly indices: readonly number[];

  constructor(indices: readonly number[]) {
    super("identity_conflict");
    this.indices = indices;
  }
}

export function decodeSeed(input: unknown, asOf: string): RatingsSeed {
  if (!strictDate(asOf))
    throw new InvalidInput();

  const seed = object(input);
  exactKeys(seed, ["version", "synthetic", "rows"]);

  if (seed.version !== "ratings-v1" ||
    (seed.synthetic !== undefined &&
      typeof seed.synthetic !== "boolean"))
    throw new InvalidInput();

  const unique = new Map<string, SeedRow>();

  array(seed.rows, 100).forEach((raw, index) => {
    const r = object(raw);
    exactKeys(r, ["source", "external_id", "watched", "watched_on", "taste_rating", "tired_viewing_rating"]);

    if (r.source !== "tmdb" ||
      !["watched", "watched_on", "taste_rating", "tired_viewing_rating"].some(k => Object.hasOwn(r, k)))
      throw new InvalidInput();

    const key: ExternalMovieKey = {
      source: "tmdb",
      externalId: tmdbId(r.external_id)
    };

    if (Object.hasOwn(r, "watched") && typeof r.watched !== "boolean")
      throw new InvalidInput();

    if (Object.hasOwn(r, "watched_on") &&
      (typeof r.watched_on !== "string" ||
        !strictDate(r.watched_on) ||
        r.watched_on > asOf ||
        r.watched === false))
      throw new InvalidInput();

    if (Object.hasOwn(r, "taste_rating") &&
      !["loved", "liked", "meh", "disliked"].includes(String(r.taste_rating)))
      throw new InvalidInput();

    if (Object.hasOwn(r, "tired_viewing_rating"))
      integer(r.tired_viewing_rating, 0, 4);

    const fields: PersonalFields = {
      ...(r.watched !== undefined ? {
        watched: r.watched as boolean
      } : {}),

      ...(r.watched_on !== undefined ? {
        watched_on: r.watched_on as string
      } : {}),

      ...(r.taste_rating !== undefined ? {
        taste_rating: r.taste_rating as Taste
      } : {}),

      ...(r.tired_viewing_rating !== undefined ? {
        tired_viewing_rating: r.tired_viewing_rating as number
      } : {})
    };

    const prev = unique.get(key.externalId);

    if (prev && JSON.stringify(prev.fields) !== JSON.stringify(fields))
      throw new SeedConflict([...prev.indices, index]);

    unique.set(key.externalId, {
      key,
      fields,
      indices: [...(prev?.indices ?? []), index]
    });
  });

  return {
    synthetic: seed.synthetic === true,
    rows: [...unique.values()]
  };
}

export async function importRatings(
  store: MetadataStore,
  operator: OperatorContext,
  seed: RatingsSeed,
  resolve: (key: ExternalMovieKey) => Promise<ResolvedRating["movieId"] | null>,
  context: StoreContext
): Promise<RatingsResult> {
  if (!(await store.authorizeProfile(operator, context))) return {
    status: "unauthorized",
    changed: 0,
    indices: []
  };

  const rows: ResolvedRating[] = [], unresolved: number[] = [];

  try {
    for (const row of seed.rows) {
      const movieId = await resolve(row.key);

      if (!movieId)
        unresolved.push(...row.indices);
      else rows.push({
        ...row,
        movieId
      });
    }
  } catch {
    return {
      status: "failed",
      changed: 0,
      indices: []
    };
  }

  if (unresolved.length) return {
    status: "unresolved",
    changed: 0,
    indices: unresolved
  };

  return store.applyRatings(operator, rows, context);
}
