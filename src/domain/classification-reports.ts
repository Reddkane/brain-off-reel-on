import { burdens, fields, policyVersion, rubricVersion } from "./classification.ts";
import type { Burden, Revision, Scores } from "./classification.ts";
import type { MovieId } from "./ids.ts";
export interface LinkEvidence {
  checkedAt: string; promotedAt: string | null; membershipAt: string | null; expiresAt: string;
  subscription: boolean; included: boolean; validDestination: boolean;
}
export interface Snapshot {
  rejected?: number; retentionDeadline?: string;
  version: string; modelId: string; promptId: string; rubric: string; policy: string; emotionalCap: number | null;
  movies: readonly { id: MovieId; active: boolean; title: string; inputFingerprint: string | null; links: readonly LinkEvidence[] }[]; revisions: readonly Revision[];
}
function time(value: string): number { return Date.parse(value); }
function before(r: Revision, at: string): boolean { return time(r.createdAt) <= time(at); }
function latest(rows: readonly Revision[]): Revision | undefined {
  return [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
}
function model(snapshot: Snapshot, id: MovieId, at: string) {
  return latest(snapshot.revisions.filter(r => r.kind === "model" && r.movieId === id && r.rubric === snapshot.rubric && r.modelId === snapshot.modelId && r.promptId === snapshot.promptId && before(r, at)));
}
export function gating(emotionalCap: number | null): readonly Burden[] { return emotionalCap === null ? ["narrative_complexity", "attention_demand"] : ["narrative_complexity", "attention_demand", "emotional_burden"]; }
function fresh(r: Revision, at: string): boolean { return r.evidenceExpiresAt === null || time(r.evidenceExpiresAt) > time(at); }
function passes(s: Scores, emotional: number | null): boolean { return s.narrative_complexity <= 2 && s.attention_demand <= 2 && (emotional === null || s.emotional_burden <= emotional); }
export function effective(snapshot: Snapshot, r: Revision, at: string) {
  const review = latest(snapshot.revisions.filter(v => v.kind === "human_review" && v.parent === r.id && v.movieId === r.movieId && v.rubric === r.rubric && before(v, at)));
  const uncertainty = { ...r.uncertainty };
  let scores = r.scores;
  if (review && review.action !== "defer" && fresh(review, at)) {
    if (review.action === "replace") scores = review.scores;
    for (const f of burdens) {
      const e = review.evidence[f];
      const assessed = review.uncertainty[f];
      if (assessed === "unassessed") {
        if (review.action === "replace" && scores[f] !== r.scores[f]) uncertainty[f] = "high";
      } else if (assessed === "medium" || assessed === "high") uncertainty[f] = assessed;
      else if (assessed === "low" && e && time(e.checkedAt) <= time(at) && (e.expiresAt === null || time(e.expiresAt) > time(at)) &&
        (e.type !== "content_guide" || f === "emotional_burden")) uncertainty[f] = "low";
      else uncertainty[f] = "high";
    }
  } else if (review) {
    // Latest valid defer cancels an earlier resolution, including initially-low gates.
    for (const f of gating(snapshot.emotionalCap)) uncertainty[f] = "high";
  }
  return { scores, uncertainty, review, passing: fresh(r, at) && passes(scores, snapshot.emotionalCap) && gating(snapshot.emotionalCap).every(f => uncertainty[f] === "low") };
}
export function linkReady(link: LinkEvidence, at: string): boolean {
  const limit = time(at) - 48 * 3600000;
  return link.subscription && link.included && link.validDestination && time(link.expiresAt) > time(at) && time(link.checkedAt) <= time(at) &&
    ((time(link.checkedAt) >= limit && (link.promotedAt === null || time(link.promotedAt) <= time(link.checkedAt))) ||
      (link.promotedAt !== null && time(link.promotedAt) <= time(at) && time(link.promotedAt) >= time(link.checkedAt) && link.membershipAt !== null && time(link.membershipAt) >= limit && time(link.membershipAt) <= time(at)));
}
export function coverage(snapshot: Snapshot, at: string) {
  let classified = 0, capPassing = 0, capLinked = 0, modelPassing = 0, effectivePassing = 0, flagged = 0, reviewed = 0, linked = 0, modelLinked = 0, effectiveLinked = 0, expired = 0, stale = 0, humanOnly = 0;
  const uncertainty = Object.fromEntries(fields.map(f => [f, { low: 0, medium: 0, high: 0 }]));
  const actions = { accept: 0, replace: 0, defer: 0, unresolved: 0 };
  const active = snapshot.movies.filter(m => m.active);
  for (const m of active) {
    const ready = m.links.some(l => linkReady(l, at)); if (ready) linked++;
    const r = model(snapshot, m.id, at);
    if (!r) { flagged++; if (snapshot.revisions.some(v => v.movieId === m.id && v.kind === "human_anchor")) humanOnly++; continue; }
    classified++; if (!fresh(r, at)) expired++;
    const current = m.inputFingerprint === r.fingerprint; if (!current) stale++;
    const e = effective(snapshot, r, at), anchor = latest(snapshot.revisions.filter(v => v.movieId === m.id && v.kind === "human_anchor" && v.rubric === snapshot.rubric && before(v, at)));
    const cap = current && fresh(r, at) && passes(r.scores, snapshot.emotionalCap);
    const mp = cap && gating(snapshot.emotionalCap).every(f => r.uncertainty[f] === "low");
    if (cap) capPassing++; if (cap && ready) capLinked++; if (mp) modelPassing++; if (mp && ready) modelLinked++;
    for (const f of fields) { const u = e.uncertainty[f]; if (u && u !== "unassessed") uncertainty[f][u]++; }
    if (e.passing && current) effectivePassing++; if (e.passing && current && ready) effectiveLinked++;
    if (e.review) { reviewed++; if (e.review.action) actions[e.review.action]++; if (!e.passing) actions.unresolved++; }
    if (!current || !fresh(r, at) || gating(snapshot.emotionalCap).some(f => e.uncertainty[f] !== "low" || e.scores[f] === (f === "emotional_burden" ? snapshot.emotionalCap : 2) || e.scores[f] === (f === "emotional_burden" ? Number(snapshot.emotionalCap) : 2) + 1) ||
      (anchor && burdens.some(f => Math.abs(anchor.scores[f] - r.scores[f]) >= 2 || passes(anchor.scores, snapshot.emotionalCap) !== cap))) flagged++;
  }
  return { policy: policyVersion, rubric: rubricVersion, active: active.length, classified, unclassified: active.length - classified, rejected: snapshot.rejected ?? 0, humanOnly,
    capPassing, capLinked, modelPassing, effectivePassing, flagged, flaggedFraction: active.length ? flagged / active.length : null, reviewed, linked, modelLinked, effectiveLinked, expired, stale, actions, uncertainty };
}
function ranks(values: readonly number[]): number[] {
  const ordered = [...values].sort((a, b) => a - b);
  return values.map(v => { const start = ordered.indexOf(v), end = ordered.lastIndexOf(v); return (start + end) / 2 + 1; });
}
function correlation(x: readonly number[], y: readonly number[]): number | null {
  if (x.length < 2) return null;
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  const dx = x.map(v => v - mx), dy = y.map(v => v - my), denominator = Math.sqrt(dx.reduce((a, b) => a + b * b, 0) * dy.reduce((a, b) => a + b * b, 0));
  return denominator === 0 ? null : dx.reduce((a, b, i) => a + b * dy[i], 0) / denominator;
}
export function agreement(snapshot: Snapshot, at: string) {
  const pairs = snapshot.movies.flatMap(m => {
    const a = latest(snapshot.revisions.filter(r => r.kind === "human_anchor" && r.movieId === m.id && r.rubric === snapshot.rubric && before(r, at)));
    const b = model(snapshot, m.id, at); return a && b && fresh(b, at) && m.inputFingerprint === b.fingerprint ? [{ a, b, title: m.title }] : [];
  });
  function metric(field: Burden, selected = pairs) {
    const n = selected.length, confusion = Array.from({ length: 5 }, () => Array<number>(5).fill(0));
    let exact = 0, withinOne = 0, observed = 0;
    for (const p of selected) { const a = p.a.scores[field], b = p.b.scores[field]; confusion[a][b]++; if (a === b) exact++; if (Math.abs(a - b) <= 1) withinOne++; observed += (a - b) ** 2; }
    const rows = confusion.map(r => r.reduce((a, b) => a + b, 0)), cols = confusion.map((_, j) => confusion.reduce((a, r) => a + r[j], 0));
    let expected = 0; for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) expected += rows[i] * cols[j] * (i - j) ** 2;
    return { n, confusion, rows, cols, exact: n ? exact / n : null, withinOne: n ? withinOne / n : null,
      kappa: n && expected ? 1 - observed * n / expected : null, reason: !n ? "no_pairs" : !expected ? "zero_expected_disagreement" : null };
  }
  const examples = ["The Red Balloon", "Paddington", "Back to the Future", "Memento", "Primer", "Shaun the Sheep Movie", "The Princess Bride", "Knives Out", "Tinker Tailor Soldier Spy", "The Many Adventures of Winnie the Pooh", "The Truman Show", "Manchester by the Sea", "Requiem for a Dream", "The Da Vinci Code", "Searching"];
  const excluded = pairs.filter(p => !examples.includes(p.title));
  return { pairs: pairs.length, candidates: snapshot.movies.length, unpaired: snapshot.movies.length - pairs.length,
    attributes: Object.fromEntries(burdens.map(f => [f, metric(f)])), exampleOverlap: pairs.length - excluded.length,
    withoutExamples: Object.fromEntries(burdens.map(f => [f, metric(f, excluded)])),
    spearman: { human: correlation(ranks(pairs.map(p => p.a.scores.narrative_complexity)), ranks(pairs.map(p => p.a.scores.attention_demand))),
      model: correlation(ranks(pairs.map(p => p.b.scores.narrative_complexity)), ranks(pairs.map(p => p.b.scores.attention_demand))) },
    disagreements: pairs.filter(p => Math.abs(p.a.scores.narrative_complexity - p.a.scores.attention_demand) >= 2 || Math.abs(p.b.scores.narrative_complexity - p.b.scores.attention_demand) >= 2 || passes(p.a.scores, snapshot.emotionalCap) !== passes(p.b.scores, snapshot.emotionalCap)).map(p => p.a.movieId),
    caveat: "Sparse ordinal anchor agreement is descriptive; no bootstrap interval in Phase A." };
}
