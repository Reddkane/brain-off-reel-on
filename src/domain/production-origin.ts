import type {
  CompanyEvidence,
  DateEvidence,
  ExternalMovieKey,
  OriginEvidence,
  OriginGroup,
  OriginResult,
  Relationship,
} from "./metadata.ts";

export interface OriginRule {
  readonly source: "tmdb";
  readonly externalId: string;
  readonly name: string;
  readonly scope: "company" | "movie";
  readonly group: Exclude<OriginGroup, "mixed" | "unknown">;
  readonly relationship: Relationship;
  readonly from: string;
  readonly through: string | null;
  readonly reference: string;
  readonly evidence: string;
  readonly checkedAt: string;
  readonly limitations: string;
}

export interface OriginMapping {
  readonly version: string;
  readonly rules: readonly OriginRule[];
  readonly missingCategories: readonly string[];
}

export function deriveOrigin(
  companies: readonly CompanyEvidence[],
  movieKey: ExternalMovieKey,
  release: DateEvidence | null,
  mapping: OriginMapping,
  at: string
): OriginResult {
  const qualifying = mapping.rules.filter(
    r => ["production", "co_production", "commissioning", "financing"].includes(r.relationship) &&
      /^https:\/\//.test(r.reference) &&
      release !== null &&
      release.date >= r.from &&
      (r.through === null ||
        release.date <= r.through) &&
      r.checkedAt <= at &&
      (r.scope === "movie" ? movieKey.source === r.source &&
        movieKey.externalId === r.externalId : companies.some(c => c.source === r.source &&
          c.external_id === r.externalId &&
          c.name === r.name))
  );

  const evidence: OriginEvidence[] = qualifying.map(r => ({
    source: `mapping/${mapping.version}`,
    checked_at: at,
    relationship: r.relationship,

    ...(r.scope === "company" ? {
      company_source: r.source,
      company_external_id: r.externalId
    } : {}),

    evidence_text: r.evidence,
    reference: r.reference
  }));

  const uncovered = companies.some(c => !qualifying.some(r => r.scope === "company" &&
    r.externalId === c.external_id));

  const conflicting = mapping.rules.some(
    r => !["production", "co_production", "commissioning", "financing"].includes(r.relationship) &&
      release !== null &&
      release.date >= r.from &&
      (r.through === null ||
        release.date <= r.through) &&
      companies.some(c => r.scope === "company" &&
        c.external_id === r.externalId &&
        c.name === r.name)
  );

  const groups = [...new Set(qualifying.map(r => r.group))];
  const group = groups.length === 0 ||
    ((uncovered ||
      conflicting) &&
      !qualifying.some(r => r.scope === "movie")) ? "unknown" : groups.length > 1 ? "mixed" : groups[0];

  return {
    group,
    evidence,
    mappingVersion: mapping.version,
    checkedAt: at,

    issues: group === "unknown" ? [{
      code: "origin_unknown",
      field: "origin",
      severity: "warning"
    }] : []
  };
}
