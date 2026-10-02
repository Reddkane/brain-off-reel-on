import type { MovieId, StreamingProviderId, TmdbMovieId, TmdbProviderId } from "../../src/domain/ids";
import type { MovieIdentity } from "../../src/recommendation";
import { syntheticMovieId, syntheticStreamingProviderId, syntheticTmdbMovieId, syntheticTmdbProviderId } from "../fixtures/synthetic-identities";

// Compile-only controls; fixture assertions stay outside production source.
function acceptMovieId(id: MovieId): MovieId { return id; }
export const validMovieId: MovieId = acceptMovieId(syntheticMovieId);
function acceptStreamingProviderId(id: StreamingProviderId): StreamingProviderId { return id; }
export const validStreamingProviderId: StreamingProviderId = acceptStreamingProviderId(syntheticStreamingProviderId);
function acceptTmdbMovieId(id: TmdbMovieId): TmdbMovieId { return id; }
export const validTmdbMovieId: TmdbMovieId = acceptTmdbMovieId(syntheticTmdbMovieId);
function acceptTmdbProviderId(id: TmdbProviderId): TmdbProviderId { return id; }
export const validTmdbProviderId: TmdbProviderId = acceptTmdbProviderId(syntheticTmdbProviderId);
export const validIdentity: MovieIdentity = { id: syntheticMovieId };
// @ts-expect-error -- StreamingProviderId cannot replace MovieId
acceptMovieId(syntheticStreamingProviderId);
// @ts-expect-error -- TmdbMovieId cannot replace MovieId
acceptMovieId(syntheticTmdbMovieId);
// @ts-expect-error -- TmdbProviderId cannot replace MovieId
acceptMovieId(syntheticTmdbProviderId);
// @ts-expect-error -- raw strings are not MovieId
acceptMovieId("synthetic-identity");
// @ts-expect-error -- raw numbers are not MovieId
acceptMovieId(123);
// @ts-expect-error -- MovieId cannot replace StreamingProviderId
acceptStreamingProviderId(syntheticMovieId);
// @ts-expect-error -- TmdbMovieId cannot replace StreamingProviderId
acceptStreamingProviderId(syntheticTmdbMovieId);
// @ts-expect-error -- TmdbProviderId cannot replace StreamingProviderId
acceptStreamingProviderId(syntheticTmdbProviderId);
// @ts-expect-error -- raw strings are not StreamingProviderId
acceptStreamingProviderId("synthetic-identity");
// @ts-expect-error -- raw numbers are not StreamingProviderId
acceptStreamingProviderId(123);
// @ts-expect-error -- MovieId cannot replace TmdbMovieId
acceptTmdbMovieId(syntheticMovieId);
// @ts-expect-error -- StreamingProviderId cannot replace TmdbMovieId
acceptTmdbMovieId(syntheticStreamingProviderId);
// @ts-expect-error -- TmdbProviderId cannot replace TmdbMovieId
acceptTmdbMovieId(syntheticTmdbProviderId);
// @ts-expect-error -- raw strings are not TmdbMovieId
acceptTmdbMovieId("synthetic-identity");
// @ts-expect-error -- raw numbers are not TmdbMovieId
acceptTmdbMovieId(123);
// @ts-expect-error -- MovieId cannot replace TmdbProviderId
acceptTmdbProviderId(syntheticMovieId);
// @ts-expect-error -- StreamingProviderId cannot replace TmdbProviderId
acceptTmdbProviderId(syntheticStreamingProviderId);
// @ts-expect-error -- TmdbMovieId cannot replace TmdbProviderId
acceptTmdbProviderId(syntheticTmdbMovieId);
// @ts-expect-error -- raw strings are not TmdbProviderId
acceptTmdbProviderId("synthetic-identity");
// @ts-expect-error -- raw numbers are not TmdbProviderId
acceptTmdbProviderId(123);
