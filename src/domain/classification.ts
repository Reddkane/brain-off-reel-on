import type { MovieId } from "./ids.ts";

export const rubricVersion = "low-brain-v1";
export const promptVersion = "classification-v1";
export const policyVersion = "classification-report-v1";
export type Burden = "narrative_complexity" | "attention_demand" | "emotional_burden" | "on_screen_text_dependence";
export type Field = Burden | "pacing" | "tone" | "content_tags";
export const burdens: readonly Burden[] = ["narrative_complexity", "attention_demand", "emotional_burden", "on_screen_text_dependence"];
export const fields: readonly Field[] = [...burdens, "pacing", "tone", "content_tags"];
export type Uncertainty = "low" | "medium" | "high";
export type Basis = "supplied_evidence" | "model_prior_knowledge";
export interface Scores { narrative_complexity: number; attention_demand: number; emotional_burden: number; on_screen_text_dependence: number }
export interface Provenance { basis: readonly Basis[]; evidence_refs: readonly string[] }
export interface Output extends Scores {
  pacing: string; tone: readonly string[]; content_tags: readonly string[];
  field_provenance: Readonly<Record<string, Provenance>>;
  field_uncertainty: Readonly<Record<string, Uncertainty>>;
}
export class ClassificationError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function record(value: unknown, code = "invalid_input"): Record<string, unknown> {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !d.enumerable || d.get || d.set)) throw new ClassificationError(code);
  return value;
}
export function exact(value: Record<string, unknown>, names: readonly string[], code = "invalid_input") {
  if (Object.keys(value).sort().join("|") !== [...names].sort().join("|")) throw new ClassificationError(code);
}
export function text(value: unknown, max: number, code = "invalid_input"): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ClassificationError(code);
  return value;
}
export function integer(value: unknown, min: number, max: number, code = "invalid_input"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ClassificationError(code);
  return value;
}
export function array(value: unknown, max: number, code = "invalid_input"): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ClassificationError(code);
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new ClassificationError(code);
  return value;
}
export function choice<T extends string>(value: unknown, choices: readonly T[], code = "invalid_input"): T {
  const found = choices.find(c => c === value);
  if (found === undefined) throw new ClassificationError(code);
  return found;
}
export function unique<T>(values: readonly T[], code = "invalid_input"): readonly T[] {
  if (new Set(values).size !== values.length) throw new ClassificationError(code);
  return values;
}
export function scores(value: Record<string, unknown>, code = "invalid_input"): Scores {
  return { narrative_complexity: integer(value.narrative_complexity, 0, 4, code), attention_demand: integer(value.attention_demand, 0, 4, code),
    emotional_burden: integer(value.emotional_burden, 0, 4, code), on_screen_text_dependence: integer(value.on_screen_text_dependence, 0, 4, code) };
}
export function uncertainties(value: unknown, names: readonly string[], code = "invalid_input"): Record<string, Uncertainty> {
  const r = record(value, code); exact(r, names, code);
  return Object.fromEntries(names.map(f => [f, choice<Uncertainty>(r[f], ["low", "medium", "high"], code)]));
}
const pacing = ["slow", "moderate", "fast", "variable"];
const tones = ["light", "warm", "comic", "adventurous", "tense", "somber", "bleak", "reflective", "surreal"];
const tags = ["violence", "death", "grief", "abuse", "self_harm", "sexual_violence", "substance_use", "threat"];
export function validateOutput(value: unknown, input: unknown): Output {
  const code = "invalid_output", r = record(value, code), evidence = record(input, code);
  exact(r, [...fields, "field_provenance", "field_uncertainty"], code);
  const provenance = record(r.field_provenance, code); exact(provenance, fields, code);
  const entries = fields.map(f => {
    const p = record(provenance[f], code); exact(p, ["basis", "evidence_refs"], code);
    const basis = unique(array(p.basis, 2, code).map(b => choice<Basis>(b, ["supplied_evidence", "model_prior_knowledge"], code)), code);
    if (!basis.length) throw new ClassificationError(code);
    const refs = unique(array(p.evidence_refs, 8, code).map(ref => text(ref, 96, code)), code);
    if (basis.includes("supplied_evidence") !== (refs.length > 0)) throw new ClassificationError(code);
    for (const ref of refs) {
      if (!["title", "release_year", "overview", "genres", "keywords", "runtime_minutes", "us_certification", "original_language", "credits"].includes(ref) ||
        evidence[ref] === null || evidence[ref] === undefined || evidence[ref] === "" || (Array.isArray(evidence[ref]) && !evidence[ref].length)) throw new ClassificationError(code);
    }
    return [f, { basis, evidence_refs: refs }];
  });
  return { ...scores(r, code), pacing: choice(r.pacing, pacing, code),
    tone: unique(array(r.tone, 4, code).map(t => choice(t, tones, code)), code),
    content_tags: unique(array(r.content_tags, 8, code).map(t => choice(t, tags, code)), code),
    field_provenance: Object.fromEntries(entries), field_uncertainty: uncertainties(r.field_uncertainty, fields, code) };
}
export interface Projected {
  title: string; release_year: number | null; overview: string | null; genres: readonly string[]; keywords: readonly string[];
  runtime_minutes: number | null; us_certification: string | null; original_language: string | null;
  credits: readonly { name: string; role: string }[]; truncated: readonly string[];
}
export function projectMovie(value: unknown): Projected {
  const r = record(value), truncated: string[] = [];
  function trim(v: unknown, max: number, path: string): string {
    const s = text(v, 100000); if (s.length > max) truncated.push(path); return s.slice(0, max);
  }
  function strings(v: unknown, max: number, path: string): readonly string[] {
    const all = [...unique(array(v, 1000).map(x => trim(x, 100, path)))].sort();
    if (all.length > max) truncated.push(path); return all.slice(0, max);
  }
  const credits = array(r.credits, 1000).map(v => {
    const c = record(v);
    return { name: trim(c.name, 200, "credits"), role: trim(c.role, 64, "credits"),
      billing: c.billing_order === null || c.billing_order === undefined ? 100000 : integer(c.billing_order, 0, 100000),
      source: c.source === undefined ? "" : text(c.source, 32), id: c.person_external_id === undefined ? "" : text(c.person_external_id, 128) };
  }).sort((a, b) => Number(b.role === "director") - Number(a.role === "director") || a.billing - b.billing ||
    a.source.localeCompare(b.source) || a.id.localeCompare(b.id) || a.name.localeCompare(b.name));
  if (credits.length > 12) truncated.push("credits");
  return { title: trim(r.title, 300, "title"), release_year: r.release_year === null ? null : integer(r.release_year, 1, 9999),
    overview: r.overview === null || r.overview === "" ? null : trim(r.overview, 6000, "overview"),
    genres: strings(r.genres, 20, "genres"), keywords: strings(r.keywords, 50, "keywords"),
    runtime_minutes: r.runtime_minutes === null ? null : integer(r.runtime_minutes, 1, 1000),
    us_certification: r.us_certification === null ? null : choice(r.us_certification, ["G", "PG", "PG-13", "R", "NC-17", "NR"]),
    original_language: r.original_language === null ? null : text(r.original_language, 16),
    credits: credits.slice(0, 12).map(c => ({ name: c.name, role: c.role })), truncated: [...new Set(truncated)].sort() };
}
export interface ReviewEvidence { type: "direct_observation" | "detailed_synopsis" | "content_guide"; reference: string; checkedAt: string; expiresAt: string | null }
export interface Revision {
  id: string; movieId: MovieId; rubric: string; kind: "model" | "human_anchor" | "human_review";
  scores: Scores; uncertainty: Readonly<Record<string, Uncertainty | "unassessed">>; createdAt: string; fingerprint: string;
  modelId: string | null; promptId: string | null; parent: string | null; action: "accept" | "replace" | "defer" | null;
  evidence: Readonly<Partial<Record<Burden, ReviewEvidence>>>; evidenceExpiresAt: string | null;
}
