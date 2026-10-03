import type { TmdbMovieId, TmdbProviderId } from "./ids.ts";
export type IssueCode = "invalid_input" | "identity_conflict" | "release_ambiguous" | "certification_missing" | "certification_ambiguous" | "origin_unknown" | "credit_name_conflict" | "page_stalled" | "totals_changed" | "changed_to_unknown" | "possible_duplicate";

export interface Issue {
  readonly code: IssueCode;
  readonly field?: "release" | "certification" | "origin" | "credits";
  readonly severity: "info" | "warning" | "error";
}

export type ExternalMovieKey = {
  readonly source: "tmdb";
  readonly externalId: TmdbMovieId;
} | {
  readonly source: "imdb";
  readonly externalId: string;
};

export interface DateEvidence {
  readonly date: string;
  readonly source: string;
  readonly semantics: "original_release" | "theatrical" | "digital" | "other";
  readonly checkedAt: string;
}

export type Certification = "G" | "PG" | "PG-13" | "R" | "NC-17" | "NR";

export interface CertificationEvidence {
  readonly value: Certification;
  readonly source: string;
  readonly checkedAt: string;
}

export interface CertificationRecord {
  readonly date: string;
  readonly type: number;
  readonly value: Certification | "blank" | "unrecognized";
}

export interface CompanyEvidence {
  readonly source: "tmdb";
  readonly external_id: string;
  readonly name: string;
  readonly checked_at: string;
}

export type OriginGroup = "streamer_produced_financed" | "traditional_studio" | "independent" | "mixed" | "unknown";
export type Relationship = "commissioning" | "financing" | "production" | "co_production" | "acquisition" | "distribution" | "uncertain";

export interface OriginEvidence {
  readonly source: string;
  readonly checked_at: string;
  readonly relationship: Relationship;
  readonly company_source?: string;
  readonly company_external_id?: string;
  readonly evidence_text: string;
  readonly reference?: string;
}

export interface OriginResult {
  readonly group: OriginGroup;
  readonly evidence: readonly OriginEvidence[];
  readonly mappingVersion: string;
  readonly checkedAt: string;
  readonly issues: readonly Issue[];
}

export interface Credit {
  readonly source: "tmdb";
  readonly personExternalId: string;
  readonly name: string;
  readonly role: string;
  readonly billingOrder: number | null;
}

export interface MovieMetadata {
  readonly keys: readonly ExternalMovieKey[];
  readonly title: string;
  readonly release: DateEvidence | null;
  readonly runtimeMinutes: number | null;
  readonly originalLanguage: string | null;
  readonly certification: CertificationEvidence | null;
  readonly overview: string | null;
  readonly posterPath: string | null;
  readonly genres: readonly string[];
  readonly keywords: readonly string[];
  readonly companies: readonly CompanyEvidence[];
  readonly origin: OriginResult;
  readonly rating: number | null;
  readonly voteCount: number | null;
  readonly credits: readonly Credit[];
  readonly metadataSource: "tmdb";
  readonly checkedAt: string;
}

export interface DiscoveryBatch {
  readonly id: string;
  readonly providerKey: TmdbProviderId;
  readonly cohort: "recent" | "older" | "undated_probe";
  readonly originProbe: "unfiltered" | "streamer" | "studio" | "independent";
  readonly sort: "popularity.desc" | "primary_release_date.desc" | "vote_count.desc" | "title.asc";
  readonly dateBounds: {
    readonly from?: string;
    readonly through?: string;
  };
  readonly companyIds: readonly string[];
  readonly page: number;
}

export interface DiscoveryPage {
  readonly batchId: string;
  readonly page: number;
  readonly totalPages: number;
  readonly totalResults: number;
  readonly candidateKeys: readonly ExternalMovieKey[];
  readonly issues: readonly Issue[];
}

export type ProviderResult<T> = {
  readonly status: "ok";
  readonly value: T;
  readonly issues: readonly Issue[];
  readonly inspection?: {
    readonly usCertifications: readonly CertificationRecord[];
    readonly total: number;
    readonly truncated: boolean;
  };
} | {
  readonly status: "not_found";
} | {
  readonly status: "invalid";
  readonly issues: readonly Issue[];
} | {
  readonly status: "failed";
  readonly code: "auth" | "budget" | "deadline" | "cancelled" | "network" | "throttled" | "http" | "body_limit";
  readonly retryable: boolean;
};
