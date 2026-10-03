import type { DiscoveryBatch, DiscoveryPage, ExternalMovieKey, MovieMetadata, ProviderResult } from "../../domain/metadata.ts";

export interface RequestBudget {
  attempts: number;
  readonly maxAttempts: number;
  readonly deadline: number;
  stopped: boolean;
}

export interface ProviderContext {
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly budget: RequestBudget;
}

export interface MetadataProvider {
  discover(batch: DiscoveryBatch, context: ProviderContext): Promise<ProviderResult<DiscoveryPage>>;
  getMovie(key: ExternalMovieKey, context: ProviderContext): Promise<ProviderResult<MovieMetadata>>;
}
