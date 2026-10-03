import { movieId, providerId, tmdbId } from "../../src/server/providers/tmdb-validation.ts";
import type { MovieId, TmdbMovieId, TmdbProviderId } from "../../src/domain/ids.ts";

// Root-project controls: effect constructors must not enter the pure TS graph.
export const internal: MovieId = movieId("30000000-0000-4000-8000-000000000001");

export const external: TmdbMovieId = tmdbId("900001");
export const provider: TmdbProviderId = providerId("900101");

// @ts-expect-error -- validated external text is not an internal UUID
export const wrongInternal: MovieId = tmdbId("900001");

// @ts-expect-error -- validated movie text is not a provider ID
export const wrongProvider: TmdbProviderId = tmdbId("900001");

// @ts-expect-error -- validated internal UUID is not external text
export const wrongExternal: TmdbMovieId = movieId("30000000-0000-4000-8000-000000000001");
