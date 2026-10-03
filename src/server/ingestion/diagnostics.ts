import type { Issue, MovieMetadata } from "../../domain/metadata.ts";
import { cohort } from "./discovery.ts";

export interface Diagnostics {
  operations: number;
  unique: number;
  duplicates: number;
  selected: number;
  details: number;
  resolved: number;
  persisted: number;
  failed: number;
  readonly issues: Record<string, number>;
  readonly cohorts: Record<string, number>;
  readonly origins: Record<string, number>;
  readonly missing: Record<string, number>;
  readonly sourceCohorts: Record<string, number>;
  readonly bounds: string[];
  readonly batches: Record<string, {
    pages: number;
    status: "requested" | "empty" | "failed" | "truncated" | "complete";
    candidates: number;
  }>;
  readonly memberships: Record<string, string[]>;
  readonly notConfigured: readonly string[];
  readonly availability: "not_measured";
  readonly filtering: "not_measured";
  readonly scoring: "not_measured";
}

export function diagnostics(notConfigured: readonly string[]): Diagnostics {
  return {
    operations: 0,
    unique: 0,
    duplicates: 0,
    selected: 0,
    details: 0,
    resolved: 0,
    persisted: 0,
    failed: 0,
    issues: {},
    cohorts: {},
    origins: {},
    missing: {},
    sourceCohorts: {},
    bounds: [],
    batches: {},
    memberships: {},
    notConfigured,
    availability: "not_measured",
    filtering: "not_measured",
    scoring: "not_measured"
  };
}

export function countIssues(d: Diagnostics, issues: readonly Issue[]) {
  for (const i of issues)
    d.issues[i.code] = (d.issues[i.code] ?? 0) + 1;
}

export function countMetadata(d: Diagnostics, m: MovieMetadata, asOf: string) {
  const c = cohort(m.release?.date ?? null, asOf);
  d.cohorts[c] = (d.cohorts[c] ?? 0) + 1;
  d.origins[m.origin.group] = (d.origins[m.origin.group] ?? 0) + 1;

  for (const [key, absent] of [
    ["release", m.release === null],
    ["certification", m.certification === null],
    ["runtime", m.runtimeMinutes === null],
    ["companies", !m.companies.length]
  ] as const) if (absent)
      d.missing[key] = (d.missing[key] ?? 0) + 1;
}
