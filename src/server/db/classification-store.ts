import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { StoreContext } from "./metadata-store.ts";
import { burdens, ClassificationError, policyVersion, promptVersion, rubricVersion, text, validateOutput } from "../../domain/classification.ts";
import type { Output, Revision } from "../../domain/classification.ts";
import type { MovieId } from "../../domain/ids.ts";
import type { Snapshot } from "../../domain/classification-reports.ts";
import { calendarMonths } from "../../domain/availability-evidence.ts";
import { decodeHuman, decodeStoredRevision } from "../classification/files.ts";
import type { HumanDocument } from "../classification/files.ts";
import { hash, prepareInput } from "../classification/codec.ts";
import { movieId } from "../providers/tmdb-validation.ts";
import { providerWebLink } from "../providers/watchmode-sources.ts";

const metadataSelect = `SELECT m.id,m.title,extract(year FROM m.release_date)::int AS release_year,m.overview,m.genres,m.keywords,
 m.runtime_minutes,m.us_certification,m.original_language,m.metadata_refreshed_at,m.metadata_source,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',name,'role',role,'billing_order',billing_order,'source',source,'person_external_id',person_external_id) ORDER BY billing_order,source,person_external_id)
 FROM (SELECT * FROM app.movie_credits WHERE movie_id=m.id ORDER BY (role='director') DESC,billing_order,source,person_external_id,name LIMIT 13) AS limited),'[]'::jsonb) AS credits FROM app.movies m`;
function iso(v: string | Date): string { return new Date(v).toISOString(); }
export function createClassificationStore(options: { pool: Pool; guard: (client: PoolClient) => Promise<void>; capability: object }) {
  const { pool } = options;
  if (!pool.listenerCount("error")) pool.on("error", () => {});
  async function transaction<T>(capability: object, ctx: StoreContext, work: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    if (capability !== options.capability) throw new ClassificationError("unauthorized");
    ctx.signal.throwIfAborted(); if (ctx.deadline <= Date.now()) throw new ClassificationError("deadline");
    const client = await pool.connect(); let released = false, destroy = false, begun = false;
    const abort = () => { destroy = true; if (!released) { released = true; client.release(true); } };
    const timer = setTimeout(abort, Math.max(1, Math.min(10000, ctx.deadline - Date.now())));
    ctx.signal.addEventListener("abort", abort, { once: true });
    client.on("error", abort);
    try {
      await options.guard(client); await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN"); begun = true;
      await client.query("SET LOCAL ROLE service_role");
      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','2000',true)", [String(Math.max(1, Math.min(8000, ctx.deadline - Date.now())))]);
      await client.query("SELECT subject_classification_id FROM app.movie_classifications LIMIT 0");
      await client.query("SELECT pg_advisory_xact_lock(730007)");
      const result = await work(client); ctx.signal.throwIfAborted(); if (destroy || Date.now() >= ctx.deadline) throw new ClassificationError("deadline");
      if ((await client.query("COMMIT")).command !== "COMMIT") throw new ClassificationError("database_failed"); begun = false; return result;
    } catch (e) { if (begun && !released) await client.query("ROLLBACK").catch(() => { destroy = true; }); throw e; }
    finally { clearTimeout(timer); ctx.signal.removeEventListener("abort", abort); client.off("error", abort); if (!released) client.release(destroy); }
  }
  async function insert(client: PoolClient, r: Revision, output?: Output, availablePaths: readonly string[] = []) {
    const envelope = { version: "classification-evidence-v1", kind: r.kind, action: r.action, evidence: r.evidence,
      evidenceExpiresAt: r.evidenceExpiresAt, availablePaths };
    const provenance = output?.field_provenance ?? Object.fromEntries(burdens.map(f => [f, { basis: ["human"], evidence_refs: [] }]));
    await client.query(`INSERT INTO app.movie_classifications(id,movie_id,rubric_version,narrative_complexity,attention_demand,emotional_burden,on_screen_text_dependence,
      pacing,tone,content_tags,field_provenance,field_uncertainty,input_evidence,input_fingerprint,model_id,prompt_id,review_status,subject_classification_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,clock_timestamp())`,
    [r.id, r.movieId, r.rubric, r.scores.narrative_complexity, r.scores.attention_demand, r.scores.emotional_burden, r.scores.on_screen_text_dependence,
      output?.pacing ?? null, output?.tone ?? [], output?.content_tags ?? [], JSON.stringify(provenance), JSON.stringify(r.uncertainty), JSON.stringify(envelope),
      r.fingerprint, r.modelId, r.promptId, r.kind === "model" ? "unreviewed" : "reviewed", r.parent]);
    const row = (await client.query("SELECT * FROM app.movie_classifications WHERE id=$1", [r.id])).rows[0];
    if (!row || row.input_fingerprint !== r.fingerprint || row.movie_id !== r.movieId) throw new ClassificationError("readback_failed");
  }
  return {
    async appendHuman(capability: object, supplied: HumanDocument, ctx: StoreContext) {
      // Revalidate at the effect boundary; caller types do not grant trusted values.
      const document = decodeHuman({ version: supplied.kind === "human_anchor" ? "classification-anchors-v1" : "classification-reviews-v1", rubric: supplied.rubric,
        rows: supplied.rows.map(r => ({ movie_id: r.movieId, tmdb_id: r.tmdbId, scores: r.scores, uncertainty: r.uncertainty,
          ...(supplied.kind === "human_review" ? { parent_id: r.parent, action: r.action, evidence: r.evidence } : {}) })) }, supplied.kind);
      return transaction(capability, ctx, async client => {
        let inserted = 0, unchanged = 0; const identities = new Set<string>();
        for (const human of document.rows) {
          const resolved = human.movieId ?? (await client.query("SELECT movie_id FROM app.movie_external_ids WHERE source='tmdb' AND external_id=$1", [human.tmdbId])).rows[0]?.movie_id;
          const found = resolved && (await client.query("SELECT id FROM app.movies WHERE id=$1 FOR SHARE", [resolved])).rows[0];
          if (!found) throw new ClassificationError("anchor_movie_unresolved");
          const id = movieId(found.id), key = `${id}/${human.parent ?? "anchor"}`;
          if (identities.has(key)) throw new ClassificationError("invalid_input"); identities.add(key);
          const now = new Date().toISOString();
          if (human.parent) {
            const raw = (await client.query("SELECT * FROM app.movie_classifications WHERE id=$1", [human.parent])).rows[0];
            let parent: Revision | undefined;
            try { parent = raw && decodeStoredRevision(raw); }
            catch { throw new ClassificationError("review_parent_invalid"); }
            if (!parent || parent.kind !== "model" || parent.movieId !== id || parent.rubric !== document.rubric) throw new ClassificationError("review_parent_invalid");
            if (human.action === "accept" && burdens.some(f => human.scores[f] !== parent.scores[f])) throw new ClassificationError("invalid_input");
            if (Object.values(human.evidence).some(e => e && e.checkedAt > now)) throw new ClassificationError("invalid_input");
          }
          const judgment = { movieId: id, rubric: document.rubric, kind: document.kind, scores: human.scores, uncertainty: human.uncertainty,
            parent: human.parent, action: human.action, evidence: human.evidence };
          const fingerprint = hash(judgment);
          // Only the latest revision is an idempotency match: accept -> defer -> accept must append.
          const previous = (await client.query(`SELECT input_fingerprint FROM app.movie_classifications
            WHERE movie_id=$1 AND rubric_version=$2 AND input_evidence->>'kind'=$3 AND subject_classification_id IS NOT DISTINCT FROM $4::uuid
            ORDER BY created_at DESC,id DESC LIMIT 1`, [id, document.rubric, document.kind, human.parent])).rows[0];
          if (previous?.input_fingerprint === fingerprint) { unchanged++; continue; }
          await insert(client, { ...judgment, id: randomUUID(), createdAt: now, fingerprint, modelId: null, promptId: null, evidenceExpiresAt: null }); inserted++;
        }
        return { inserted, unchanged };
      });
    },
    async appendModel(capability: object, id: MovieId, output: unknown, modelId: string, expectedFingerprint: string, ctx: StoreContext) {
      text(modelId, 96);
      return transaction(capability, ctx, async client => {
        const row = (await client.query(metadataSelect + " WHERE m.id=$1 FOR SHARE", [id])).rows[0];
        if (!row) throw new ClassificationError("anchor_movie_unresolved");
        const prepared = prepareInput(row); if (prepared.fingerprint !== expectedFingerprint) throw new ClassificationError("input_changed");
        const valid = validateOutput(output, prepared.input), rid = randomUUID();
        const r: Revision = { id: rid, movieId: id, rubric: rubricVersion, kind: "model", scores: valid, uncertainty: valid.field_uncertainty,
          createdAt: new Date().toISOString(), fingerprint: prepared.fingerprint, modelId, promptId: promptVersion, parent: null, action: null, evidence: {},
          evidenceExpiresAt: new Date(calendarMonths(new Date(row.metadata_refreshed_at).getTime(), 6)).toISOString() };
        await insert(client, r, valid, Object.entries(prepared.input).filter(([k, v]) => k !== "truncated" && v !== null && v !== "" && (!Array.isArray(v) || v.length)).map(([k]) => k)); return rid;
      });
    },
    async input(capability: object, id: MovieId, ctx: StoreContext) {
      return transaction(capability, ctx, async client => {
        const row = (await client.query(metadataSelect + " WHERE m.id=$1 FOR SHARE", [id])).rows[0];
        if (!row) throw new ClassificationError("anchor_movie_unresolved"); return prepareInput(row);
      });
    },
    async snapshot(capability: object, at: string, modelId: string, ctx: StoreContext): Promise<Snapshot> {
      return transaction(capability, ctx, async client => {
        const movies = (await client.query("SELECT id,title,metadata_state,metadata_refreshed_at,metadata_source FROM app.movies ORDER BY id LIMIT 1001")).rows;
        const inputs = (await client.query(metadataSelect + " ORDER BY m.id LIMIT 1001")).rows;
        const fingerprints = new Map<string, string | null>(inputs.map(row => { try { return [row.id, prepareInput(row).fingerprint]; } catch { return [row.id, null]; } }));
        const raw = (await client.query(`SELECT c.*,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM app.movie_classifications c ORDER BY c.created_at,c.id LIMIT 10001`)).rows;
        if (movies.length > 1000 || raw.length > 10000) throw new ClassificationError("body_limit");
        const revisions: Revision[] = []; for (const r of raw) { try { revisions.push(decodeStoredRevision(r)); } catch { /* Legacy/invalid revisions are excluded, never guessed. */ } }
        const links = (await client.query(`WITH latest AS (
          SELECT DISTINCT ON(movie_id) id,movie_id,checked_at FROM app.availability_snapshots WHERE source='watchmode' AND region='US' AND outcome='success' AND checked_at<=$1 ORDER BY movie_id,checked_at DESC,id DESC
        ), promoted AS (
          SELECT DISTINCT ON(s.source_id) s.id,s.source_id,e.observed_at AS completed FROM app.watchmode_sweeps s JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id
          WHERE e.outcome='complete' AND e.observed_at<=$1 AND s.observed_at+(SELECT watchmode_window FROM app.provider_retention_policy)>$1 ORDER BY s.source_id,e.observed_at DESC,s.id DESC
        ) SELECT s.movie_id,s.checked_at,p.completed,member.observed_at,l.expires_at,l.web_url,v.source_id FROM latest s
        JOIN app.watchmode_offer_variants v ON v.snapshot_id=s.id
        JOIN app.watchmode_links l ON (l.snapshot_id,l.provider_id,l.offer_type,l.requested_variant)=(v.snapshot_id,v.provider_id,v.offer_type,v.requested_variant)
        LEFT JOIN promoted p ON p.source_id=v.source_id LEFT JOIN app.movie_external_ids identity ON identity.movie_id=s.movie_id AND identity.source='watchmode'
        LEFT JOIN app.watchmode_memberships member ON member.sweep_id=p.id AND member.watchmode_id::text=identity.external_id
        WHERE v.offer_type='subscription' AND v.tier_inclusion<>'excluded' AND l.web_url IS NOT NULL`, [at])).rows;
        const deadlines = [...movies.filter(m => m.metadata_source === "tmdb").map(m => calendarMonths(new Date(m.metadata_refreshed_at).getTime(), 6)), ...links.map(l => new Date(l.expires_at).getTime())];
        const retentionDeadline = new Date(deadlines.length ? Math.min(...deadlines) : Date.parse(at) + 86400000).toISOString();
        if (Date.parse(retentionDeadline) <= Date.now()) throw new ClassificationError("evidence_expired");
        return { version: "classification-snapshot-v1", rubric: rubricVersion, policy: policyVersion, modelId, promptId: promptVersion, emotionalCap: null,
          rejected: raw.length - revisions.length, retentionDeadline,
          movies: movies.map(m => ({ id: movieId(m.id), title: m.title.slice(0, 300), active: m.metadata_state === "active", inputFingerprint: fingerprints.get(m.id) ?? null, links: links.filter(l => l.movie_id === m.id).map(l => ({
            checkedAt: iso(l.checked_at), promotedAt: l.completed ? iso(l.completed) : null, membershipAt: l.observed_at ? iso(l.observed_at) : null,
            expiresAt: iso(l.expires_at), subscription: true, included: true, validDestination: providerWebLink(Number(l.source_id), l.web_url).webUrl !== null })) })), revisions };
      }, true);
    },
  };
}
