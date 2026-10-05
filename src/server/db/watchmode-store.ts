import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { SweepCandidate } from "../../domain/availability-sweeps.ts";
import { SweepError, decodeWatchmodePage } from "../providers/watchmode.ts";
import type { WatchmodePage } from "../providers/watchmode.ts";
import type { StoreContext } from "./metadata-store.ts";
import type { MovieMetadata } from "../../domain/metadata.ts";
import { readMovie, canonicalValues } from "./metadata-sql.ts";
import { instant } from "../providers/tmdb-validation.ts";
import type { SweepCode } from "../providers/sweep-error.ts";
import type { EnrichmentOutcome } from "../../domain/availability-sweeps.ts";
import type { EvidenceSweep } from "../../domain/availability-evidence.ts";
export interface SweepState {
  readonly id: string;
  readonly source: number;
  readonly generation: string;
  readonly startedAt: string;
  readonly nextPage: number;
  readonly totalPages: number | null;
  readonly terminal: string | null;
}
export interface PromotedSweep {
  readonly id: string;
  readonly source: number;
  readonly completedAt: string;
  readonly candidates: readonly (SweepCandidate & {
    readonly observedAt: string;
    readonly coolingDown: boolean;
  })[];
}
export interface PreparedHistory {
  readonly source: number;
  readonly generation: string;
  readonly now: string;
  readonly sweeps: readonly EvidenceSweep[];
}
export function createWatchmodeStore(pool: Pool, guard: (client: PoolClient) => Promise<void>) {
  if (!pool.listenerCount("error"))
    pool.on("error", () => { });
  async function transaction<T>(context: StoreContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    context.signal.throwIfAborted();
    if (Date.now() >= context.deadline)
      throw new SweepError("database_budget");
    const client = await pool.connect();
    let destroyed = false, released = false;
    const abort = () => {
      destroyed = true;
      if (!released) {
        released = true;
        client.release(true);
      }
    };
    const timer = setTimeout(abort, Math.max(1, Math.min(10000, context.deadline - Date.now())));
    context.signal.addEventListener("abort", abort, { once: true });
    client.on("error", abort);
    try {
      try {
        await guard(client);
      }
      catch {
        throw new SweepError("target_guard");
      }
      context.signal.throwIfAborted();
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE service_role");
      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','2000',true)",
        [String(Math.max(1, Math.min(5000, context.deadline - Date.now())))]);
      const result = await work(client);
      context.signal.throwIfAborted();
      if (destroyed || Date.now() >= context.deadline)
        throw new SweepError("database_budget");
      if ((await client.query("COMMIT")).command !== "COMMIT")
        throw new SweepError("checkpoint_failed");
      return result;
    }
    catch (error) {
      if (!destroyed) {
        try {
          await client.query("ROLLBACK");
        }
        catch {
          destroyed = true;
        }
      }
      if (error instanceof SweepError)
        throw error;
      throw new SweepError("checkpoint_failed");
    }
    finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      client.off("error", abort);
      if (!released)
        client.release(destroyed);
    }
  }
  async function coolingIds(client: PoolClient, now: string): Promise<readonly string[]> {
    const rows = (await client.query(`WITH latest AS (
      SELECT DISTINCT ON (tmdb_id) tmdb_id,outcome,checked_at
      FROM app.metadata_detail_attempts ORDER BY tmdb_id,checked_at DESC
    ) SELECT tmdb_id FROM latest WHERE checked_at > $1::timestamptz - CASE
      WHEN outcome IN ('not_found','identity_conflict') THEN interval '7 days'
      WHEN outcome='stale' THEN interval '1 day'
      WHEN outcome='failed' THEN interval '1 hour'
      ELSE interval '0 seconds' END`, [now])).rows;
    return rows.map(r => r.tmdb_id as string);
  }
  async function prepareHistory(source: number, generation: string, now: string, context: StoreContext): Promise<PreparedHistory> {
      return transaction(context, async client => {
        const rows = (await client.query(`SELECT s.id,s.generation,s.observed_at AS started,e.observed_at AS completed,
          e.outcome,
          (SELECT min(p.observed_at) FROM app.watchmode_pages p WHERE p.sweep_id=s.id) AS oldest,
          (SELECT count(*) FROM app.watchmode_pages p WHERE p.sweep_id=s.id)=
            (SELECT greatest(1,min(p.total_pages)) FROM app.watchmode_pages p WHERE p.sweep_id=s.id)
          AND NOT EXISTS(SELECT 1 FROM app.watchmode_pages p WHERE p.sweep_id=s.id AND
            (p.unresolved_count<>0 OR p.row_count<>(SELECT count(*) FROM app.watchmode_memberships mm WHERE mm.sweep_id=p.sweep_id AND mm.page=p.page)))
          AND (SELECT count(*) FROM app.watchmode_memberships mm WHERE mm.sweep_id=s.id)+
            (SELECT coalesce(sum(p.excluded_count),0) FROM app.watchmode_pages p WHERE p.sweep_id=s.id)=
            (SELECT min(p.total_results) FROM app.watchmode_pages p WHERE p.sweep_id=s.id) AS intact,
          extract(epoch FROM policy.watchmode_window)*1000 AS window_ms
          FROM app.watchmode_sweeps s JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id
          CROSS JOIN app.provider_retention_policy policy
          WHERE s.source_id=$1 AND s.generation=$2 AND e.observed_at<=$3::timestamptz
          AND e.observed_at >= $3::timestamptz-policy.watchmode_window
          ORDER BY s.observed_at DESC,s.id DESC LIMIT 257`, [source,generation,now])).rows;
        // Refuse an incomplete retained replay rather than inventing a drift-free prefix.
        if (rows.length>256) return {source,generation,now,sweeps:[]};
        rows.reverse();
        const sweeps: EvidenceSweep[] = rows.map(r => ({ id: r.id, generation: r.generation,
          startedAt: r.started.getTime(), completedAt: r.completed.getTime(),
          expiresAt: Math.min(r.started.getTime(), r.oldest?.getTime() ?? r.started.getTime()) + Number(r.window_ms),
          outcome: r.outcome === "complete" && r.intact ? "complete" : "interrupted",
          presenceAt: null }));
        return {source,generation,now,sweeps};
      });
  }
  return {
    transaction,
    prepareHistory,
    async history(source: number, generation: string, watchmodeId: number, now: string, context: StoreContext, prepared?: PreparedHistory): Promise<readonly EvidenceSweep[]> {
      const retained = prepared ?? await prepareHistory(source,generation,now,context);
      if (retained.source!==source || retained.generation!==generation || retained.now!==now) throw new SweepError('request_invalid');
      if (!retained.sweeps.length) return [];
      return transaction(context, async client => {
        // Primary-key lookups only; completeness is movie-independent and prepared once per run.
        const members = (await client.query(`SELECT sweep_id,observed_at FROM app.watchmode_memberships
          WHERE sweep_id=ANY($1::uuid[]) AND watchmode_id=$2`, [retained.sweeps.map(s=>s.id),watchmodeId])).rows;
        const presence = new Map(members.map(m=>[m.sweep_id,m.observed_at.getTime()]));
        return retained.sweeps.map(s=>({...s,presenceAt:presence.get(s.id)??null}));
      });
    },
    async recoverInterrupted(now: string, context: StoreContext) {
      return transaction(context, async (client) => {
        const runs = (await client.query("SELECT id,checkpoint FROM app.refresh_runs WHERE job_name='availability_sweeps_v1' AND outcome='running'")).rows;
        for (const run of runs) {
          const refs = Array.isArray(run.checkpoint?.sweeps) ? run.checkpoint.sweeps : [];
          for (const ref of refs)
            if (typeof ref?.id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.id))
              await client.query(`INSERT INTO app.watchmode_sweep_events(sweep_id,outcome,code,observed_at)
                SELECT id,'failed','sweep_interrupted',$2 FROM app.watchmode_sweeps
                WHERE id=$1 ON CONFLICT DO NOTHING`, [ref.id, now]);
          await client.query("UPDATE app.refresh_runs SET ended_at=$2,outcome='failed',diagnostic_summary='sweep_interrupted' WHERE id=$1", [run.id, now]);
        }
      });
    },
    async batch(generation: string, now: string, context: StoreContext): Promise<string> {
      return transaction(context, async (client) => {
        const rows = (await client.query(`SELECT s.* FROM app.watchmode_sweeps s WHERE NOT EXISTS
          (SELECT 1 FROM app.watchmode_sweep_events e WHERE e.sweep_id=s.id) ORDER BY s.observed_at DESC,s.id DESC`)).rows;
        let batch: string | undefined;
        for (const row of rows) {
          const expired = Date.parse(now) - row.observed_at.getTime() > 21600000;
          if (row.generation === generation && !expired && !batch)
            batch = row.batch_id;
          if (row.generation !== generation || expired || (batch && row.batch_id !== batch)) {
            const reason = row.generation !== generation ? "generation_changed" : expired ? "expired" : "superseded";
            await client.query("INSERT INTO app.watchmode_sweep_events(sweep_id,outcome,code,observed_at) VALUES($1,$2,$2,$3) ON CONFLICT DO NOTHING", [row.id, reason, now]);
          }
        }
        return batch ?? randomUUID();
      });
    },
    async cursor(context: StoreContext) {
      return transaction(context, async (client) => {
        const row = (await client.query("SELECT checkpoint FROM app.refresh_runs WHERE job_name='availability_sweeps_v1' ORDER BY started_at DESC,id DESC LIMIT 1")).rows[0];
        const page = row?.checkpoint?.nextPageService, enrichment = row?.checkpoint?.nextEnrichmentService;
        return {
          nextPageService: Number.isInteger(page) && page >= 0 && page < 4 ? page : 0,
          nextEnrichmentService: Number.isInteger(enrichment) && enrichment >= 0 && enrichment < 4 ? enrichment : 0,
        };
      });
    },
    async capacityBlocked(generation: string, now: string, context: StoreContext) {
      return transaction(context, async client => (await client.query(`SELECT DISTINCT s.source_id
                FROM app.watchmode_sweeps s JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id
                WHERE s.generation=$1 AND e.code='sweep_too_large'
                AND s.observed_at >= $2::timestamptz-interval '30 days'`, [generation, now])).rows.map(r => r.source_id as number));
    },
    async resume(source: number, generation: string, now: string, context: StoreContext, batchId?: string): Promise<SweepState> {
      instant(now);
      return transaction(context, async (client) => {
        const open = (await client.query(`SELECT s.*,e.outcome FROM app.watchmode_sweeps s
          LEFT JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id
          WHERE source_id=$1 AND (($2::uuid IS NULL AND e.sweep_id IS NULL) OR s.batch_id=$2)
          ORDER BY s.observed_at,s.id`, [source, batchId ?? null])).rows;
        let state: SweepState | undefined;
        for (const row of open) {
          const expired = Date.parse(now) - row.observed_at.getTime() > 21600000;
          if (expired || row.generation !== generation || state) {
            await client.query(`INSERT INTO app.watchmode_sweep_events(sweep_id,outcome,code,observed_at)
              VALUES($1,$2,$2,$3)`, [row.id, row.generation !== generation ? "generation_changed" : "expired", now]);
          }
          else {
            const pages = (await client.query("SELECT page,total_pages FROM app.watchmode_pages WHERE sweep_id=$1 ORDER BY page", [row.id])).rows;
            state = {
              id: row.id, source, generation, startedAt: row.observed_at.toISOString(),
              nextPage: pages.length + 1, totalPages: pages[0]?.total_pages ?? null, terminal: row.outcome ?? null,
            };
          }
        }
        if (state)
          return state;
        const id = randomUUID();
        await client.query("INSERT INTO app.watchmode_sweeps(id,batch_id,source_id,generation,observed_at) VALUES($1,$2,$3,$4,$5)", [id, batchId ?? id, source, generation, now]);
        return { id, source, generation, startedAt: now, nextPage: 1, totalPages: null, terminal: null };
      });
    },
    async page(state: SweepState, page: WatchmodePage, completedAt: string, context: StoreContext) {
      instant(page.observedAt);
      instant(completedAt);
      // Revalidate effect inputs even when callers inject a provider implementation.
      const checked = decodeWatchmodePage({
        page: page.page, total_pages: page.totalPages, total_results: page.totalResults,
        titles: page.titles.map(t => ({ id: t.watchmodeId, tmdb_id: t.tmdbId, tmdb_type: "movie", type: "movie", popularity_percentile: t.popularity }))
      }, state.nextPage, page.observedAt);
      const unresolved = page.unresolvedRows ?? 0;
      const excluded = page.excludedRows ?? 0;
      const excludedIds = page.excludedIds ?? [];
      if (!Number.isInteger(unresolved) || unresolved < 0 || unresolved > 250 ||
        !Number.isInteger(excluded) || excluded < 0 || excluded > 250 ||
        excludedIds.length !== excluded || excludedIds.some(id =>
          !Number.isInteger(id) || id < 1 || id > 2147483647) ||
        unresolved + excluded !== checked.unresolvedRows)
        throw new SweepError("page_incomplete");
      return transaction(context, async (client) => {
        const header = (await client.query(`SELECT observed_at FROM app.watchmode_sweeps
          WHERE id=$1 AND source_id=$2 AND generation=$3`, [state.id, state.source, state.generation])).rows[0];
        if (!header || Date.parse(page.observedAt) < header.observed_at.getTime() ||
          Date.parse(completedAt) < Date.parse(page.observedAt) ||
          Date.parse(completedAt) - header.observed_at.getTime() > 21600000)
          throw new SweepError("sweep_expired");
        if ((await client.query("SELECT 1 FROM app.watchmode_sweep_events WHERE sweep_id=$1", [state.id])).rowCount)
          throw new SweepError("sweep_closed");
        const existing = (await client.query("SELECT * FROM app.watchmode_pages WHERE sweep_id=$1 ORDER BY page", [state.id])).rows;
        const ids = [...checked.titles.map(t => t.watchmodeId), ...excludedIds];
        const signature = createHash("sha256").update(JSON.stringify(ids.sort((a, b) => a - b))).digest("hex");
        const repeated = existing.find(p => p.page === page.page);
        if (repeated) {
          if (repeated.signature !== signature || repeated.total_pages !== page.totalPages || repeated.total_results !== page.totalResults)
            throw new SweepError("page_conflict");
          return { complete: existing.length === Math.max(1, page.totalPages), incomplete: false };
        }
        if (page.page !== existing.length + 1)
          throw new SweepError("page_nonadvancing");
        if (existing.some(p => p.total_pages !== page.totalPages || p.total_results !== page.totalResults))
          throw new SweepError("totals_changed");
        if (existing.some(p => p.signature === signature))
          throw new SweepError("page_stalled");
        const prior = new Set((await client.query("SELECT watchmode_id FROM app.watchmode_memberships WHERE sweep_id=$1", [state.id])).rows.map(r => r.watchmode_id));
        for (const priorPage of existing)
          for (const id of priorPage.excluded_ids) prior.add(id);
        let duplicates = 0;
        for (const id of ids) {
          if (prior.has(id))
            duplicates++;
          else
            prior.add(id);
        }
        if (duplicates)
          throw new SweepError("pagination_drift");
        await client.query(`INSERT INTO app.watchmode_pages
          (sweep_id,page,total_pages,total_results,row_count,unresolved_count,excluded_count,excluded_ids,signature,observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [state.id, page.page, page.totalPages,
        page.totalResults, page.titles.length, unresolved, excluded, excludedIds, signature, page.observedAt]);
        await client.query(`INSERT INTO app.watchmode_memberships
                    (sweep_id,page,watchmode_id,tmdb_id,popularity,observed_at)
                    SELECT $1,$2,t.id,t.tmdb,t.popularity,$6 FROM unnest(
                    $3::integer[],$4::text[],$5::double precision[]) AS t(id,tmdb,popularity)`,
          [state.id, page.page, checked.titles.map(t => t.watchmodeId),
          checked.titles.map(t => t.tmdbId), checked.titles.map(t => t.popularity), page.observedAt]);
        const complete = page.page === Math.max(1, page.totalPages);
        if (complete) {
          if (unresolved || existing.some(p => p.unresolved_count > 0)) {
            await client.query("INSERT INTO app.watchmode_sweep_events(sweep_id,outcome,code,observed_at) VALUES($1,'failed','membership_incomplete',$2)", [state.id, completedAt]);
            return { complete: false, incomplete: true };
          }
          const count = (await client.query("SELECT count(*)::int AS n FROM app.watchmode_memberships WHERE sweep_id=$1", [state.id])).rows[0].n;
          const excludedTotal = excluded + existing.reduce((sum, p) => sum + p.excluded_count, 0);
          if (count + excludedTotal !== page.totalResults)
            throw new SweepError("membership_incomplete");
          await client.query("INSERT INTO app.watchmode_sweep_events(sweep_id,outcome,code,observed_at) VALUES($1,'complete','complete',$2)", [state.id, completedAt]);
        }
        return { complete, incomplete: false };
      });
    },
    async fail(id: string, code: SweepCode, now: string, context: StoreContext) {
      return transaction(context, async (client) => {
        await client.query(`INSERT INTO app.watchmode_sweep_events(sweep_id,outcome,code,observed_at)
          VALUES($1,'failed',$2,$3) ON CONFLICT DO NOTHING`, [id, code, now]);
      });
    },
    async cooling(now: string, context: StoreContext): Promise<readonly string[]> {
      return transaction(context, client => coolingIds(client, now));
    },
    async promoted(generation: string, now: string, context: StoreContext): Promise<{
      sweeps: readonly PromotedSweep[];
      conflicts: readonly number[];
    }> {
      return transaction(context, async (client) => {
        const cooling = new Set(await coolingIds(client, now));
        const headers = (await client.query(`SELECT DISTINCT ON(s.source_id) s.id,s.source_id,e.observed_at AS completed
          FROM app.watchmode_sweeps s JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id
          WHERE s.generation=$1 AND e.outcome='complete' AND s.observed_at >= $2::timestamptz-interval '30 days'
          ORDER BY s.source_id,e.observed_at DESC,s.id DESC`, [generation, now])).rows;
        const sweeps: PromotedSweep[] = [];
        for (const header of headers) {
          const rows = (await client.query(`SELECT * FROM app.watchmode_memberships
            WHERE sweep_id=$1 ORDER BY watchmode_id`, [header.id])).rows;
          sweeps.push({
            id: header.id, source: header.source_id, completedAt: header.completed.toISOString(),
            candidates: rows.map(r => ({
              watchmodeId: r.watchmode_id, tmdbId: r.tmdb_id,
              popularity: r.popularity, observedAt: r.observed_at.toISOString(), coolingDown: cooling.has(r.tmdb_id)
            })),
          });
        }
        const conflicts = (await client.query(`WITH recent AS (
                    SELECT DISTINCT watchmode_id,tmdb_id FROM app.watchmode_memberships
                    WHERE observed_at >= $1::timestamptz-interval '30 days' AND tmdb_id IS NOT NULL
                ), ambiguous_watchmode AS (
                    SELECT watchmode_id FROM recent GROUP BY watchmode_id HAVING count(*)>1
                ), ambiguous_tmdb AS (
                    SELECT tmdb_id FROM recent GROUP BY tmdb_id HAVING count(*)>1
                ) SELECT watchmode_id FROM ambiguous_watchmode UNION
                    SELECT watchmode_id FROM recent WHERE tmdb_id IN (SELECT tmdb_id FROM ambiguous_tmdb)`, [now])).rows;
        return { sweeps, conflicts: conflicts.map(r => r.watchmode_id as number) };
      });
    },
    async advance(externalId: string, references: readonly {
      sweepId: string;
      watchmodeId: number;
    }[], outcome: EnrichmentOutcome, now: string, context: StoreContext) {
      instant(now);
      return transaction(context, async (client) => {
        await client.query(`INSERT INTO app.metadata_detail_attempts(tmdb_id,outcome,checked_at)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [externalId, outcome, now]);
        for (const ref of references)
          await client.query(`INSERT INTO app.watchmode_enrichment_checks
            (sweep_id,watchmode_id,outcome,observed_at,checked_at)
            VALUES($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING`, [ref.sweepId, ref.watchmodeId, outcome, now]);
      });
    },
    async catalog(context: StoreContext) {
      return transaction(context, async (client) => ({
        count: (await client.query("SELECT count(*)::int AS n FROM app.movies WHERE metadata_state='active'")).rows[0].n,
        movies: (await client.query(`SELECT e.external_id,m.metadata_refreshed_at,m.metadata_state
          FROM app.movie_external_ids e JOIN app.movies m ON m.id=e.movie_id
          WHERE e.source='tmdb' ORDER BY m.metadata_refreshed_at,e.external_id`)).rows.map(r => ({
          tmdbId: String(r.external_id), refreshedAt: r.metadata_refreshed_at.toISOString(), retired:r.metadata_state==='retired',
        })),
      }));
    },
    async verifyMetadata(expected: ReadonlyMap<string, MovieMetadata>, context: StoreContext) {
      return transaction(context, async (client) => {
        for (const [id, metadata] of expected) {
          const row = (await client.query(readMovie, [id])).rows[0];
          const mappings = (await client.query("SELECT source,external_id FROM app.movie_external_ids WHERE movie_id=$1", [id])).rows;
          const credits = (await client.query(`SELECT source,person_external_id,name,role,billing_order
            FROM app.movie_credits WHERE movie_id=$1 AND source='tmdb' ORDER BY role,person_external_id`, [id])).rows.map(r => ({
            source: r.source, personExternalId: r.person_external_id, name: r.name,
            role: r.role, billingOrder: r.billing_order,
          }));
          const expectedCredits = [...metadata.credits].sort((a, b) => a.role.localeCompare(b.role) || a.personExternalId.localeCompare(b.personExternalId));
          if (!isDeepStrictEqual(row?.aggregate, canonicalValues(metadata)) ||
            !isDeepStrictEqual(credits, expectedCredits) ||
            metadata.keys.some(k => !mappings.some(m => m.source === k.source && m.external_id === k.externalId)))
            throw new SweepError("readback_mismatch");
        }
      });
    },
    async report(run: {
      id: string;
      startedAt: string;
      endedAt: string | null;
      outcome: string;
      processed: number;
      failed: number;
      checkpoint: unknown;
    }, context: StoreContext) {
      return transaction(context, async (client) => {
        await client.query(`INSERT INTO app.refresh_runs(id,job_name,started_at,ended_at,outcome,processed_count,failed_count,checkpoint,diagnostic_summary)
        VALUES($1,'availability_sweeps_v1',$2,$3,$4,$5,$6,$7,'availability_counts_v1') ON CONFLICT(id) DO UPDATE SET
        ended_at=excluded.ended_at,outcome=excluded.outcome,processed_count=excluded.processed_count,
        failed_count=excluded.failed_count,checkpoint=excluded.checkpoint`,
          [run.id, run.startedAt, run.endedAt, run.outcome, run.processed, run.failed, JSON.stringify(run.checkpoint)]);
      });
    },
    async readback(ids: readonly string[], context: StoreContext) {
      return transaction(context, async (client) => {
        const sweeps = (await client.query(`SELECT s.id,s.source_id,e.outcome,e.code,e.observed_at AS completed_at,
          (SELECT count(*)::int FROM app.watchmode_pages p WHERE p.sweep_id=s.id) AS pages,
          (SELECT coalesce(sum(excluded_count),0)::int FROM app.watchmode_pages p WHERE p.sweep_id=s.id) AS excluded,
          (SELECT count(*)::int FROM app.watchmode_memberships m WHERE m.sweep_id=s.id) AS memberships
          FROM app.watchmode_sweeps s LEFT JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id WHERE s.id=ANY($1::uuid[]) ORDER BY s.source_id`, [ids])).rows;
        return sweeps;
      });
    }
  };
}
export type WatchmodeStore = ReturnType<typeof createWatchmodeStore>;
