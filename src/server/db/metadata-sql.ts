import type { MovieMetadata } from "../../domain/metadata.ts";

export const columns = [
  "title",
  "release_date",
  "release_date_source",
  "release_date_semantics",
  "release_date_checked_at",
  "runtime_minutes",
  "original_language",
  "us_certification",
  "certification_source",
  "certification_checked_at",
  "overview",
  "poster_path",
  "genres",
  "keywords",
  "production_company_evidence",
  "origin_group",
  "origin_evidence",
  "origin_mapping_version",
  "origin_checked_at",
  "rating",
  "vote_count",
  "metadata_source",
  "metadata_refreshed_at"
] as const;

// Identifiers are code constants, never caller-controlled. All values are parameters.
export const insertMovie = `INSERT INTO app.movies (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`;

export const updateMovie = `UPDATE app.movies SET ${columns.map((c, i) => `${c}=$${i + 1}`).join(",")},metadata_state='active',updated_at=now() WHERE id=$24`;

// Accept only code-owned columns; timestamps match canonical metadata values.
export function columnExpression(column: typeof columns[number]): string {
  return ["release_date_checked_at", "certification_checked_at", "origin_checked_at", "metadata_refreshed_at"].includes(column)
    ? `CASE WHEN ${column} IS NULL THEN NULL ELSE to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`
    : column;
}

export const readMovie = `SELECT jsonb_build_array(${columns.map(columnExpression).join(",")}) AS aggregate FROM app.movies WHERE id=$1 FOR UPDATE`;

export function movieValues(m: MovieMetadata): unknown[] {
  return [
    m.title,
    m.release?.date ?? null,
    m.release?.source ?? null,
    m.release?.semantics ?? null,
    m.release?.checkedAt ?? null,
    m.runtimeMinutes,
    m.originalLanguage,
    m.certification?.value ?? null,
    m.certification?.source ?? null,
    m.certification?.checkedAt ?? null,
    m.overview,
    m.posterPath,
    [...m.genres],
    [...m.keywords],
    JSON.stringify(m.companies),
    m.origin.group,
    JSON.stringify(m.origin.evidence),
    m.origin.mappingVersion,
    m.origin.checkedAt,
    m.rating,
    m.voteCount,
    m.metadataSource,
    m.checkedAt
  ];
}

export function canonicalValues(m: MovieMetadata): unknown[] {
  const values = movieValues(m);
  values[14] = m.companies;
  values[16] = m.origin.evidence;
  return values;
}
