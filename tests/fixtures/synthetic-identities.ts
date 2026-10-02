import type {
  MovieId,
  StreamingProviderId,
  TmdbMovieId,
  TmdbProviderId,
} from "../../src/domain/ids";

// Invented fixture text, deliberately identical across brands.
// These values are not real UUIDs, provider IDs, or personal data.
export const syntheticMovieId = "synthetic-identity" as MovieId;
export const syntheticStreamingProviderId = "synthetic-identity" as StreamingProviderId;
export const syntheticTmdbMovieId = "synthetic-identity" as TmdbMovieId;
export const syntheticTmdbProviderId = "synthetic-identity" as TmdbProviderId;
