import type { MovieId } from "../../domain/ids.ts";
import type { ExternalMovieKey, Issue, MovieMetadata } from "../../domain/metadata.ts";
import type { PersonalFields } from "../../domain/ratings-import.ts";

export interface OperatorContext {
  readonly profileId: string;
  readonly accountId: string;
}

export interface ResolvedRating {
  readonly movieId: MovieId;
  readonly key: ExternalMovieKey;
  readonly fields: PersonalFields;
  readonly indices: readonly number[];
}

export type CatalogWriteResult = {
  readonly status: "created" | "updated" | "unchanged" | "stale";
  readonly movieId: MovieId;
  readonly issues: readonly Issue[];
} | {
  readonly status: "identity_conflict" | "catalog_limit" | "failed";
  readonly code?: string;
};

export interface RatingsResult {
  readonly status: "applied" | "unchanged" | "unresolved" | "conflict" | "unauthorized" | "invalid" | "failed";
  readonly changed: number;
  readonly indices: readonly number[];
}

export interface RunProgress {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: "running" | "success" | "partial" | "failed";
  readonly processed: number;
  readonly failed: number;
  readonly checkpoint: Readonly<Record<string, unknown>>;
}

export interface StoreContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface MetadataStore {
  persistMovie(capability: object, metadata: MovieMetadata, cap: number, context: StoreContext): Promise<CatalogWriteResult>;
  resolveMovie(key: ExternalMovieKey, context: StoreContext): Promise<MovieId | null>;
  authorizeProfile(operator: OperatorContext, context: StoreContext): Promise<boolean>;
  applyRatings(operator: OperatorContext, rows: readonly ResolvedRating[], context: StoreContext): Promise<RatingsResult>;
  recordRun(capability: object, progress: RunProgress, context: StoreContext): Promise<boolean>;
}
