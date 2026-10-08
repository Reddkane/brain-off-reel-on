import { array, burdens, choice, ClassificationError, exact, integer, record, rubricVersion, policyVersion, scores, text, uncertainties, validateOutput } from "../../domain/classification.ts";
import type { Burden, Revision, ReviewEvidence, Scores, Uncertainty } from "../../domain/classification.ts";
import type { MovieId, TmdbMovieId } from "../../domain/ids.ts";
import type { Snapshot } from "../../domain/classification-reports.ts";
import { movieId, tmdbId } from "../providers/tmdb-validation.ts";
export function uuid(value: unknown): string {
  const s = text(value, 36); if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s)) throw new ClassificationError("invalid_input"); return s;
}
export function date(value: unknown): string {
  const s = text(value, 27); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s.replace(/\.(\d{3})\d{3}Z$/, ".$1Z")) throw new ClassificationError("invalid_input"); return s;
}
export interface HumanRow {
  movieId: MovieId | null; tmdbId: TmdbMovieId | null; scores: Scores; uncertainty: Record<string, Uncertainty | "unassessed">;
  parent: string | null; action: "accept" | "replace" | "defer" | null; evidence: Partial<Record<Burden, ReviewEvidence>>;
}
export interface HumanDocument { kind: "human_anchor" | "human_review"; rubric: string; rows: readonly HumanRow[] }
function reviewUncertainties(value: unknown): Record<string, Uncertainty | "unassessed"> {
  const r = record(value); exact(r, burdens);
  return Object.fromEntries(burdens.map(f => [f, choice(r[f], ["low", "medium", "high", "unassessed"] as const)]));
}
function evidence(value: unknown): Partial<Record<Burden, ReviewEvidence>> {
  const r = record(value), result: Partial<Record<Burden, ReviewEvidence>> = {};
  if (Object.keys(r).some(k => !burdens.includes(k as Burden))) throw new ClassificationError("invalid_input");
  for (const key of burdens.filter(k => Object.hasOwn(r, k))) {
    const field = choice<Burden>(key, burdens), e = record(r[key]); exact(e, ["type", "reference", "checkedAt", "expiresAt"]);
    result[field] = { type: choice(e.type, ["direct_observation", "detailed_synopsis", "content_guide"]), reference: text(e.reference, 500), checkedAt: date(e.checkedAt), expiresAt: e.expiresAt === null ? null : date(e.expiresAt) };
    if (result[field]!.expiresAt !== null && Date.parse(result[field]!.expiresAt!) <= Date.parse(result[field]!.checkedAt)) throw new ClassificationError("invalid_input");
  }
  return result;
}
export function decodeHuman(value: unknown, kind: "human_anchor" | "human_review"): HumanDocument {
  choice(kind, ["human_anchor", "human_review"]);
  const r = record(value); exact(r, ["version", "rubric", "rows"]);
  if (r.version !== (kind === "human_anchor" ? "classification-anchors-v1" : "classification-reviews-v1") || r.rubric !== rubricVersion) throw new ClassificationError("invalid_input");
  const identities = new Set<string>();
  const rows = array(r.rows, kind === "human_anchor" ? 50 : 20).map(raw => {
    const v = record(raw), names = ["movie_id", "tmdb_id", "scores", "uncertainty", ...(kind === "human_review" ? ["parent_id", "action", "evidence"] : [])];
    exact(v, [...names, ...(Object.hasOwn(v, "note") ? ["note"] : [])]);
    if (Object.hasOwn(v, "note") && (typeof v.note !== "string" || v.note.length > 500)) throw new ClassificationError("invalid_input");
    const id = v.movie_id === null ? null : movieId(uuid(v.movie_id)), external = v.tmdb_id === null ? null : tmdbId(text(v.tmdb_id, 16));
    if ((id === null) === (external === null)) throw new ClassificationError("invalid_input");
    const key = `${id ?? external}/${kind === "human_review" ? String(v.parent_id) : "anchor"}`;
    if (identities.has(key)) throw new ClassificationError("invalid_input"); identities.add(key);
    const s = record(v.scores); exact(s, burdens);
    return { movieId: id, tmdbId: external, scores: scores(s), uncertainty: kind === "human_review" ? reviewUncertainties(v.uncertainty) : uncertainties(v.uncertainty, burdens),
      parent: kind === "human_review" ? uuid(v.parent_id) : null,
      action: kind === "human_review" ? choice(v.action, ["accept", "replace", "defer"] as const) : null,
      evidence: kind === "human_review" ? evidence(v.evidence) : {} };
  });
  return { kind, rubric: rubricVersion, rows };
}
export function template(kind: "human_anchor" | "human_review") {
  return { version: kind === "human_anchor" ? "classification-anchors-v1" : "classification-reviews-v1", rubric: rubricVersion,
    rows: [{ movie_id: null, tmdb_id: null, scores: Object.fromEntries(burdens.map(f => [f, null])),
      uncertainty: Object.fromEntries(burdens.map(f => [f, kind === "human_review" ? "unassessed" : "high"])), note: "", ...(kind === "human_review" ? { parent_id: null, action: "defer", evidence: {} } : {}) }] };
}
export function decodeRevision(value: unknown): Revision {
  const r = record(value);
  exact(r, ["id", "movieId", "rubric", "kind", "scores", "uncertainty", "createdAt", "fingerprint", "modelId", "promptId", "parent", "action", "evidence", "evidenceExpiresAt"]);
  const kind = choice(r.kind, ["model", "human_anchor", "human_review"] as const), s = record(r.scores); exact(s, burdens);
  const unc = record(r.uncertainty), names = kind === "model" ? [...burdens, "pacing", "tone", "content_tags"] : [...burdens];
  const fp = text(r.fingerprint, 64); if (!/^[a-f0-9]{64}$/.test(fp) || r.rubric !== rubricVersion) throw new ClassificationError("invalid_input");
  const revision: Revision = { id: uuid(r.id), movieId: movieId(uuid(r.movieId)), rubric: rubricVersion, kind, scores: scores(s), uncertainty: kind === "human_review" ? reviewUncertainties(unc) : uncertainties(unc, names),
    createdAt: date(r.createdAt), fingerprint: fp, modelId: r.modelId === null ? null : text(r.modelId, 96), promptId: r.promptId === null ? null : text(r.promptId, 96),
    parent: r.parent === null ? null : uuid(r.parent), action: r.action === null ? null : choice(r.action, ["accept", "replace", "defer"] as const),
    evidence: evidence(r.evidence), evidenceExpiresAt: r.evidenceExpiresAt === null ? null : date(r.evidenceExpiresAt) };
  if (kind === "model" ? revision.modelId === null || revision.promptId === null || revision.parent !== null || revision.action !== null : revision.modelId !== null || revision.promptId !== null || (kind === "human_review" ? revision.parent === null || revision.action === null : revision.parent !== null || revision.action !== null)) throw new ClassificationError("invalid_input");
  return revision;
}
function bool(v: unknown): boolean { if (typeof v !== "boolean") throw new ClassificationError("invalid_input"); return v; }
export function decodeSnapshot(value: unknown): Snapshot {
  const r = record(value); exact(r, ["version", "modelId", "promptId", "rubric", "policy", "emotionalCap", "movies", "revisions", "rejected", "retentionDeadline"]);
  if (r.version !== "classification-snapshot-v1" || r.rubric !== rubricVersion || r.policy !== policyVersion) throw new ClassificationError("invalid_input");
  const movies = array(r.movies, 1000).map(raw => {
    const m = record(raw); exact(m, ["id", "active", "title", "inputFingerprint", "links"]);
    const fp = m.inputFingerprint === null ? null : text(m.inputFingerprint, 64);
    if (fp !== null && !/^[a-f0-9]{64}$/.test(fp)) throw new ClassificationError("invalid_input");
    return { id: movieId(uuid(m.id)), active: bool(m.active), title: text(m.title, 300), inputFingerprint: fp, links: array(m.links, 100).map(raw => {
      const l = record(raw); exact(l, ["checkedAt", "promotedAt", "membershipAt", "expiresAt", "subscription", "included", "validDestination"]);
      return { checkedAt: date(l.checkedAt), promotedAt: l.promotedAt === null ? null : date(l.promotedAt), membershipAt: l.membershipAt === null ? null : date(l.membershipAt), expiresAt: date(l.expiresAt), subscription: bool(l.subscription), included: bool(l.included), validDestination: bool(l.validDestination) };
    }) };
  });
  const revisions = array(r.revisions, 10000).map(decodeRevision);
  if (new Set(movies.map(m => m.id)).size !== movies.length || new Set(revisions.map(v => v.id)).size !== revisions.length || revisions.some(v => !movies.some(m => m.id === v.movieId))) throw new ClassificationError("invalid_input");
  return { version: "classification-snapshot-v1", modelId: text(r.modelId, 96), promptId: text(r.promptId, 96), rubric: rubricVersion, policy: policyVersion,
    emotionalCap: r.emotionalCap === null ? null : integer(r.emotionalCap, 0, 4), movies, revisions,
    rejected: integer(r.rejected, 0, 10000), retentionDeadline: date(r.retentionDeadline) };
}

export function decodeStoredRevision(row: Record<string, unknown>): Revision {
  const e = row.input_evidence as Record<string, unknown>;
  if (!e || e.version !== "classification-evidence-v1") throw new ClassificationError("legacy_revision");
  if (e.kind === "model") {
    validateOutput({ ...Object.fromEntries(burdens.map(f => [f, row[f]])), pacing: row.pacing, tone: row.tone, content_tags: row.content_tags,
      field_provenance: row.field_provenance, field_uncertainty: row.field_uncertainty }, Object.fromEntries((e.availablePaths as string[]).map(p => [p, true])));
  } else {
    const provenance = row.field_provenance as Record<string, { basis: string[]; evidence_refs: string[] }>;
    if (Object.keys(provenance).sort().join() !== [...burdens].sort().join() || burdens.some(f => JSON.stringify(provenance[f]) !== JSON.stringify({ basis: ["human"], evidence_refs: [] }))) throw new ClassificationError("invalid_input");
  }
  return decodeRevision({ id: row.id, movieId: row.movie_id, rubric: row.rubric_version, kind: e.kind, scores: Object.fromEntries(burdens.map(f => [f, row[f]])),
    uncertainty: row.field_uncertainty, createdAt: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at as Date).toISOString(), fingerprint: row.input_fingerprint, modelId: row.model_id, promptId: row.prompt_id,
    parent: row.subject_classification_id, action: e.action, evidence: e.evidence, evidenceExpiresAt: e.evidenceExpiresAt });
}
