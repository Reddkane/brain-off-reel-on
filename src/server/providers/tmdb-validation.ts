import type { MovieId, TmdbMovieId, TmdbProviderId } from "../../domain/ids.ts";

import type {
  Certification,
  Credit,
  DiscoveryBatch,
  DiscoveryPage,
  ExternalMovieKey,
  Issue,
  MovieMetadata,
  ProviderResult,
} from "../../domain/metadata.ts";

import { normalizeCertification, normalizeRelease, releaseDay, strictDate } from "../../domain/metadata-evidence.ts";
import type { ReleaseEvent } from "../../domain/metadata-evidence.ts";
import { deriveOrigin } from "../../domain/production-origin.ts";
import type { OriginMapping } from "../../domain/production-origin.ts";

export class InvalidInput extends Error {
  readonly code: "invalid_input" | "identity_conflict";

  constructor(code: "invalid_input" | "identity_conflict" = "invalid_input") {
    super(code);
    this.code = code;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null))
    throw new InvalidInput();

  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(k => !keys.includes(k)))
    throw new InvalidInput();
}

export function text(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000]/.test(value))
    throw new InvalidInput();

  return value;
}

export function optionalText(value: unknown, max = 500): string | null {
  return value === null || value === undefined || value === "" ? null : text(value, max);
}

export function integer(value: unknown, min = 0, max = 2147483647): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new InvalidInput();

  return value;
}

export function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new InvalidInput();

  return value;
}

export function tmdbId(value: unknown): TmdbMovieId {
  if (typeof value !== "string" ||
    !/^[1-9][0-9]*$/.test(value) ||
    value.length > 10 ||
    Number(value) > 2147483647)
    throw new InvalidInput();

  return value as TmdbMovieId;
}

export function providerId(value: unknown): TmdbProviderId {
  return tmdbId(value) as string as TmdbProviderId;
}

export function movieId(value: unknown): MovieId {
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new InvalidInput();

  return value.toLowerCase() as MovieId;
}

export function imdbId(value: unknown): string | null {
  const id = optionalText(value);

  if (id !== null && !/^tt[0-9]{7,10}$/.test(id))
    throw new InvalidInput();

  return id;
}

export function instant(value: unknown): string {
  const at = text(value);

  if (!releaseDay(at) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at))
    throw new InvalidInput();

  return at;
}

function responseId(value: unknown): TmdbMovieId {
  return tmdbId(String(integer(value, 1)));
}

function names(value: unknown, max: number): string[] {
  return [...new Set(array(value, max).map(v => {
    const o = object(v);
    integer(o.id, 1);
    return text(o.name);
  }))].sort();
}

function events(value: unknown, requested: string): ReleaseEvent[] {
  const root = object(value);

  if (root.id !== undefined && responseId(root.id) !== requested)
    throw new InvalidInput("identity_conflict");

  const result: ReleaseEvent[] = [];

  for (const group of array(root.results, 500)) {
    const g = object(group), country = text(g.iso_3166_1);

    if (!/^[A-Z]{2}$/.test(country))
      throw new InvalidInput();

    for (const raw of array(g.release_dates, 5000)) {
      const e = object(raw);
      const date = typeof e.release_date === "string" ? releaseDay(e.release_date) : null;

      if (!date || typeof e.certification !== "string" || e.certification.length > 500)
        throw new InvalidInput();

      result.push({
        country,
        date,
        type: integer(e.type, 1, 6),
        certification: e.certification
      });

      if (result.length > 5000)
        throw new InvalidInput();
    }
  }

  return result;
}

export function decodeMovie(value: unknown, requested: ExternalMovieKey, at: string, mapping: OriginMapping): {
  value: MovieMetadata;
  issues: Issue[];
  inspection: Extract<ProviderResult<MovieMetadata>, {
    status: "ok";
  }>["inspection"];
} {
  if (requested.source !== "tmdb")
    throw new InvalidInput();

  tmdbId(requested.externalId);
  instant(at);
  const root = object(value);

  if (responseId(root.id) !== requested.externalId)
    throw new InvalidInput("identity_conflict");

  if (root.adult !== false || root.video !== false)
    throw new InvalidInput();

  const appended = ["release_dates", "keywords", "credits", "external_ids"].map(k => object(root[k]));

  if (appended.some(c => c.success === false))
    throw new InvalidInput();

  for (const component of appended) if (component.id !== undefined &&
    responseId(component.id) !== requested.externalId)
    throw new InvalidInput("identity_conflict");

  const [releases, keywords, credits, external] = appended;

  if (!Object.hasOwn(external, "imdb_id"))
    throw new InvalidInput();

  const primary = optionalText(root.release_date);

  if (primary !== null && !strictDate(primary))
    throw new InvalidInput();

  const ev = events(releases, requested.externalId), release = normalizeRelease(ev, primary, at), cert = normalizeCertification(ev, at);
  const us = ev.filter(e => e.country === "US");

  const inspection = {
    usCertifications: us.slice(0, 50).map(e => ({
      date: e.date,
      type: e.type,
      value: (["G", "PG", "PG-13", "R", "NC-17", "NR"].includes(e.certification) ? e.certification as Certification : e.certification.trim() === "" ? "blank" as const : "unrecognized" as const)
    })),

    total: us.length,
    truncated: us.length > 50
  };

  const imdbRoot = imdbId(root.imdb_id), imdbExternal = imdbId(external.imdb_id);

  if (imdbRoot && imdbExternal && imdbRoot !== imdbExternal)
    throw new InvalidInput("identity_conflict");

  const imdb = imdbRoot ?? imdbExternal;
  const keys: ExternalMovieKey[] = [requested];

  if (imdb) keys.push({
    source: "imdb",
    externalId: imdb
  });

  const companies = array(root.production_companies, 100).map(v => {
    const c = object(v);

    return {
      source: "tmdb" as const,
      external_id: responseId(c.id),
      name: text(c.name),
      checked_at: at
    };
  }).sort((a, b) => a.external_id.localeCompare(b.external_id));

  const cast = array(credits.cast, 2000), crew = array(credits.crew, 2000);

  if (cast.length + crew.length > 2000)
    throw new InvalidInput();

  const castCredits: Credit[] = cast.map(v => {
    const c = object(v);

    return {
      source: "tmdb",
      personExternalId: responseId(c.id),
      name: text(c.name),
      role: "cast",
      billingOrder: c.order === undefined || c.order === null ? null : integer(c.order)
    };
  });

  const crewCredits: Credit[] = crew.map(v => {
    const c = object(v);

    return {
      source: "tmdb" as const,
      personExternalId: responseId(c.id),
      name: text(c.name),
      role: text(c.job),
      billingOrder: null
    };
  }).filter(c => ["Director", "Writer", "Screenplay"].includes(c.role));

  const issues: Issue[] = [...release.issues, ...cert.issues];
  const unique = new Map<string, Credit>();

  for (const c of [...castCredits.sort(
    (a, b) => (a.billingOrder ?? 2147483647) - (b.billingOrder ?? 2147483647) ||
      Number(a.personExternalId) - Number(b.personExternalId)
  ), ...crewCredits]) {
    const key = `${c.personExternalId}/${c.role}`;
    const prev = unique.get(key);

    if (prev && prev.name !== c.name) issues.push({
      code: "credit_name_conflict",
      field: "credits",
      severity: "warning"
    });
    else if (!prev)
      unique.set(key, c);
  }

  const selected = [...unique.values()];
  const finalCredits = [...selected.filter(c => c.role === "cast").slice(0, 20), ...selected.filter(c => c.role !== "cast")].sort((a, b) => a.role.localeCompare(b.role) ||
    a.personExternalId.localeCompare(b.personExternalId));
  const origin = deriveOrigin(companies, requested, release.release, mapping, at);
  issues.push(...origin.issues);
  const runtime = root.runtime === null ||
    root.runtime === undefined ? null : integer(root.runtime);
  const votes = root.vote_count === null ||
    root.vote_count === undefined ? null : integer(root.vote_count);
  let rating: number | null = null;

  if (root.vote_average !== null && root.vote_average !== undefined) {
    if (typeof root.vote_average !== "number" ||
      !Number.isFinite(root.vote_average) ||
      root.vote_average < 0 ||
      root.vote_average > 10)
      throw new InvalidInput();

    rating = root.vote_average === 0 &&
      votes === 0 ? null : Math.round(root.vote_average * 100) / 100;
  }

  const poster = optionalText(root.poster_path, 256);

  if (poster && (!/^\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(poster)))
    throw new InvalidInput();

  return {
    value: {
      keys,
      title: text(root.title),
      release: release.release,
      runtimeMinutes: runtime || null,
      originalLanguage: optionalText(root.original_language),
      certification: cert.certification,
      overview: optionalText(root.overview, 20000),
      posterPath: poster,
      genres: names(root.genres, 100),
      keywords: names(keywords.keywords, 500),
      companies,
      origin,
      rating,
      voteCount: votes,
      credits: finalCredits,
      metadataSource: "tmdb",
      checkedAt: at
    },

    issues,
    inspection
  };
}

export function decodePage(value: unknown, batch: DiscoveryBatch): DiscoveryPage {
  const root = object(value);

  if (integer(root.page, 1, 5) !== batch.page)
    throw new InvalidInput();

  const keys = array(root.results, 100).map(v => ({
    source: "tmdb" as const,
    externalId: responseId(object(v).id)
  }));

  return {
    batchId: batch.id,
    page: batch.page,
    totalPages: integer(root.total_pages),
    totalResults: integer(root.total_results),
    candidateKeys: keys,
    issues: []
  };
}
