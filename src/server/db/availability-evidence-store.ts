import { randomUUID } from "node:crypto";
import { deriveArrival, metadataAction } from "../../domain/availability-evidence.ts";
import type { WatchmodeStore, PreparedHistory } from "./watchmode-store.ts";
import type { StoreContext } from "./metadata-store.ts";
import { instant, integer } from "../providers/tmdb-validation.ts";
import { decodeSourceCheck, type SourceCheck, type SourceOffer } from "../providers/watchmode-sources.ts";
import { SweepError, watchmodeSources } from "../providers/watchmode.ts";
export function createEvidenceStore(store: WatchmodeStore) {
    const transaction = store.transaction;
    return {
        async candidates(generation: string, now: string, limit: number, flagged: readonly number[], context: StoreContext) {
            integer(limit, 1, 100);
            const promoted = await store.promoted(generation, now, context);
            const conflicts = new Set(promoted.conflicts);
            return transaction(context, async (client) => {
                const rows = (await client.query(`SELECT m.id,e.external_id AS tmdb_id,w.external_id AS watchmode_id,
          (SELECT max(a.acquired_at) FROM app.movie_external_id_acquisitions a WHERE a.movie_id=m.id AND a.source='watchmode'
            AND a.acquisition_path='watchmode_membership' AND a.acquired_at+(SELECT watchmode_window FROM app.provider_retention_policy)>$1::timestamptz) AS watchmode_acquired
          FROM app.movies m
          JOIN app.movie_external_ids e ON e.movie_id=m.id AND e.source='tmdb'
          LEFT JOIN app.movie_external_ids w ON w.movie_id=m.id AND w.source='watchmode'
          WHERE m.metadata_state='active' ORDER BY m.id`, [now])).rows;
                const byTmdb = new Map<string, (typeof promoted.sweeps)[number]['candidates'][number]>();
                for (const sweep of promoted.sweeps)
                    for (const member of sweep.candidates)
                        if (member.tmdbId !== null && !conflicts.has(member.watchmodeId) && !byTmdb.has(member.tmdbId))
                            byTmdb.set(member.tmdbId, member);
                const candidates = rows.flatMap(r => {
                    const member = byTmdb.get(r.tmdb_id);
                    const retainedId = Number(r.watchmode_id);
                    const fallback = r.watchmode_acquired && Number.isInteger(retainedId) && retainedId > 0 && retainedId <= 2147483647 && !conflicts.has(retainedId);
                    return member || fallback ? [{ movieId: r.id as string, tmdbId: r.tmdb_id as string,
                            watchmodeId: member?.watchmodeId ?? retainedId, observedAt: member?.observedAt ?? r.watchmode_acquired.toISOString() }] : [];
                });
                const latest = (await client.query(`SELECT movie_id,max(time) AS derived FROM (
                  SELECT movie_id,derived_at AS time FROM app.watchmode_arrivals UNION ALL
                  SELECT movie_id,checked_at AS time FROM app.availability_snapshots WHERE source='watchmode'
                ) checks GROUP BY movie_id`)).rows;
                const checkedAt = new Map(latest.map(r => [r.movie_id, r.derived?.getTime() ?? 0]));
                const priority = new Set(flagged);
                candidates.sort((a, b) => Number(priority.has(b.watchmodeId)) - Number(priority.has(a.watchmodeId)) ||
                    (checkedAt.get(a.movieId) ?? 0) - (checkedAt.get(b.movieId) ?? 0) || a.movieId.localeCompare(b.movieId));
                return candidates.slice(0, limit);
            });
        },
        async prepareHistory(generation: string, now: string, context: StoreContext) {
            const histories = new Map<number, PreparedHistory>();
            for (const source of watchmodeSources)
                histories.set(source, await store.prepareHistory(source, generation, now, context));
            return histories;
        },
        async derive(movieId: string, watchmodeId: number, generation: string, now: string, context: StoreContext, prepared?: ReadonlyMap<number, PreparedHistory>) {
            const reasons: string[] = [];
            for (const source of watchmodeSources) {
                const history = await store.history(source, generation, watchmodeId, now, context, prepared?.get(source));
                if (!history.length) {
                    reasons.push('first_sweep');
                    continue;
                }
                const evidence = deriveArrival(history, generation, Date.parse(now));
                const current = history.at(-1)!;
                const absence = evidence.absenceAt === null ? null : history.find(s => s.completedAt === evidence.absenceAt && s.presenceAt === null)?.id ?? null;
                const presence = evidence.presenceAt === null ? null : history.find(s => s.presenceAt === evidence.presenceAt)?.id ?? null;
                const drift = evidence.driftSweep;
                await transaction(context, async (client) => {
                    await client.query(`INSERT INTO app.watchmode_arrivals(movie_id,source_id,generation,current_sweep,absence_sweep,presence_sweep,drift_sweep,state,reason,episode,absence_at,presence_at,retention_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`, [movieId, source, generation, current.id, absence, presence, drift, evidence.state, evidence.reason, evidence.episode,
                        evidence.absenceAt === null ? null : new Date(evidence.absenceAt).toISOString(), evidence.presenceAt === null ? null : new Date(evidence.presenceAt).toISOString(), now]);
                });
                reasons.push(evidence.reason);
            }
            return reasons;
        },
        async acquireMemberships(generation: string, now: string, context: StoreContext) {
            const promoted = await store.promoted(generation, now, context), blocked = promoted.conflicts;
            return transaction(context, async (client) => {
                await client.query("SELECT pg_advisory_xact_lock(730003)");
                let count = 0;
                for (const sweep of promoted.sweeps) {
                    // Exactly namespaced resolution, including unchanged metadata. Original page age.
                    await client.query(`INSERT INTO app.movie_external_ids(movie_id,source,external_id)
            SELECT e.movie_id,'watchmode',m.watchmode_id::text FROM app.watchmode_memberships m
            JOIN app.movie_external_ids e ON e.source='tmdb' AND e.external_id=m.tmdb_id
            WHERE m.sweep_id=$1 AND NOT(m.watchmode_id=ANY($2::integer[])) AND NOT EXISTS(
              SELECT 1 FROM app.movie_external_ids w WHERE w.source='watchmode' AND
              ((w.movie_id=e.movie_id AND w.external_id<>m.watchmode_id::text) OR (w.external_id=m.watchmode_id::text AND w.movie_id<>e.movie_id)))
            ON CONFLICT DO NOTHING`, [sweep.id, blocked]);
                    count += (await client.query(`INSERT INTO app.movie_external_id_acquisitions
            SELECT e.movie_id,namespace.source,'watchmode_membership',m.observed_at FROM app.watchmode_memberships m
            JOIN app.movie_external_ids e ON e.source='tmdb' AND e.external_id=m.tmdb_id
            JOIN app.movie_external_ids w ON w.movie_id=e.movie_id AND w.source='watchmode' AND w.external_id=m.watchmode_id::text
            CROSS JOIN (VALUES('tmdb'),('watchmode')) namespace(source)
            WHERE m.sweep_id=$1 AND NOT(m.watchmode_id=ANY($2::integer[])) ON CONFLICT DO NOTHING`, [sweep.id, blocked])).rowCount ?? 0;
                }
                return count;
            });
        },
        async sourceCheck(movieId: string, check: SourceCheck, context: StoreContext) {
            instant(check.observedAt);
            // Revalidate injected effect inputs through the same decoder before persistence.
            const wireTypes: Record<SourceOffer['offerType'], string> = { subscription: 'sub', rental: 'rent', purchase: 'buy', live_tv: 'tve', free: 'free' };
            const checked = decodeSourceCheck(check.offers.map(o => ({ source_id: o.sourceId, region: 'US', type: wireTypes[o.offerType], format: o.format, web_url: o.webUrl })), check.observedAt);
            return transaction(context, async (client) => {
                const providers = (await client.query("SELECT provider_id,external_id FROM app.streaming_provider_external_ids WHERE source='watchmode'")).rows;
                if (watchmodeSources.some(source => providers.filter(p => p.external_id === String(source)).length !== 1))
                    throw new SweepError('request_invalid');
                const existing = (await client.query("SELECT id FROM app.availability_snapshots WHERE movie_id=$1 AND region='US' AND source='watchmode' AND checked_at=$2", [movieId, check.observedAt])).rows;
                if (existing.length)
                    return { offers: 0, links: 0 };
                const id = randomUUID();
                await client.query(`INSERT INTO app.availability_snapshots(id,movie_id,region,source,checked_at,refresh_deadline,outcome)
          VALUES($1,$2,'US','watchmode',$3,$3::timestamptz+interval '48 hours','success')`, [id, movieId, check.observedAt]);
                let offers = 0, links = 0;
                for (const source of watchmodeSources) {
                    const provider = providers.find(p => p.external_id === String(source))!.provider_id;
                    const selected = checked.offers.filter(o => o.sourceId === source && o.offerType !== 'live_tv');
                    const types = [...new Set(selected.map(o => o.offerType))];
                    const variant = source === 203 ? 'without_ads' : source === 387 ? 'standard' : 'bundle_with_ads';
                    for (const type of types) {
                        await client.query("INSERT INTO app.movie_availability(snapshot_id,provider_id,offer_type) VALUES($1,$2,$3)", [id, provider, type]);
                        await client.query("INSERT INTO app.watchmode_offer_variants(snapshot_id,provider_id,offer_type,requested_variant,source_id,retention_at) VALUES($1,$2,$3,$4,$5,$6)", [id, provider, type, variant, source, check.observedAt]);
                        offers++;
                        for (const [index, o] of checked.offers.entries())
                            if (o.sourceId === source && o.offerType === type) {
                                const original = check.offers[index];
                                await client.query(`INSERT INTO app.watchmode_links(snapshot_id,provider_id,offer_type,requested_variant,web_url,missing_reason,observed_at,expires_at,format)
                VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '30 days',$8)`, [id, provider, type, variant, o.webUrl, o.webUrl === null ? original.missingReason ?? 'missing' : null, check.observedAt, o.format]);
                                links++;
                            }
                    }
                }
                // All offers precede all observations; successful empty checks remain explicit.
                for (const source of watchmodeSources) {
                    const provider = providers.find(p => p.external_id === String(source))!.provider_id;
                    const hasSubscription = checked.offers.some(o => o.sourceId === source && o.offerType === 'subscription');
                    await client.query(`INSERT INTO app.availability_tracks VALUES($1,$2,'US','watchmode','subscription',$3) ON CONFLICT DO NOTHING`, [movieId, provider, check.observedAt]);
                    await client.query(`INSERT INTO app.availability_observations(snapshot_id,movie_id,provider_id,region,source,offer_type,state)
            VALUES($1,$2,$3,'US','watchmode','subscription',$4)`, [id, movieId, provider, hasSubscription ? 'present' : 'absent']);
                }
                const actual = (await client.query(`SELECT
          (SELECT count(*)::int FROM app.watchmode_offer_variants WHERE snapshot_id=$1) AS offers,
          (SELECT count(*)::int FROM app.watchmode_links WHERE snapshot_id=$1) AS links`, [id])).rows[0];
                if (actual.offers !== offers || actual.links !== links)
                    throw new SweepError('readback_mismatch');
                return { offers, links };
            });
        },
        async sourceFailure(movieId: string, now: string, context: StoreContext) {
            return transaction(context, async (client) => {
                await client.query(`INSERT INTO app.availability_snapshots(movie_id,region,source,checked_at,refresh_deadline,outcome,diagnostic_code)
          VALUES($1,'US','watchmode',$2,$2,'failed','source_check_failed') ON CONFLICT DO NOTHING`, [movieId, now]);
            });
        },
        async cleanup(context: StoreContext) {
            return transaction(context, async (client) => {
                let deleted = 0;
                const leaves: readonly [
                    string,
                    string
                ][] = [['watchmode_links', 'observed_at'], ['watchmode_offer_variants', 'retention_at'], ['watchmode_arrivals', 'retention_at'], ['availability_observations', 'retention_at'], ['movie_availability', 'retention_at'], ['watchmode_enrichment_checks', 'observed_at'], ['watchmode_memberships', 'observed_at'], ['metadata_detail_attempts', 'checked_at']];
                for (const [table, age] of leaves)
                    deleted += (await client.query(`DELETE FROM app.${table} WHERE ctid IN
          (SELECT ctid FROM app.${table} WHERE ${age}+(SELECT watchmode_window FROM app.provider_retention_policy)<statement_timestamp() LIMIT 1000)`)).rowCount ?? 0;
                // Safe progress: parents with younger descendants are left for later runs.
                deleted += (await client.query(`DELETE FROM app.availability_snapshots WHERE id IN (SELECT s.id FROM app.availability_snapshots s WHERE s.checked_at+(SELECT watchmode_window FROM app.provider_retention_policy)<statement_timestamp()
          AND NOT EXISTS(SELECT 1 FROM app.movie_availability o WHERE o.snapshot_id=s.id)
          AND NOT EXISTS(SELECT 1 FROM app.availability_observations o WHERE o.snapshot_id=s.id) LIMIT 1000)`)).rowCount ?? 0;
                deleted += (await client.query(`DELETE FROM app.availability_tracks WHERE ctid IN (SELECT t.ctid FROM app.availability_tracks t WHERE t.tracked_since+(SELECT watchmode_window FROM app.provider_retention_policy)<statement_timestamp()
          AND NOT EXISTS(SELECT 1 FROM app.availability_observations o WHERE (o.movie_id,o.provider_id,o.region,o.source,o.offer_type)=(t.movie_id,t.provider_id,t.region,t.source,t.offer_type)) LIMIT 1000)`)).rowCount ?? 0;
                deleted += (await client.query(`DELETE FROM app.watchmode_pages WHERE ctid IN (SELECT p.ctid FROM app.watchmode_pages p WHERE p.observed_at+(SELECT watchmode_window FROM app.provider_retention_policy)<statement_timestamp()
          AND NOT EXISTS(SELECT 1 FROM app.watchmode_memberships m WHERE m.sweep_id=p.sweep_id AND m.page=p.page) LIMIT 1000)`)).rowCount ?? 0;
                deleted += (await client.query(`DELETE FROM app.watchmode_sweeps WHERE id IN (SELECT s.id FROM app.watchmode_sweeps s WHERE s.observed_at+(SELECT watchmode_window FROM app.provider_retention_policy)<statement_timestamp()
          AND NOT EXISTS(SELECT 1 FROM app.watchmode_pages p WHERE p.sweep_id=s.id)
          AND NOT EXISTS(SELECT 1 FROM app.watchmode_sweep_events e WHERE e.sweep_id=s.id AND e.observed_at+(SELECT watchmode_window FROM app.provider_retention_policy)>=statement_timestamp()) LIMIT 1000)`)).rowCount ?? 0;
                deleted += (await client.query(`DELETE FROM app.movie_external_id_acquisitions WHERE ctid IN (SELECT ctid FROM app.movie_external_id_acquisitions WHERE
          (acquisition_path='watchmode_membership' AND acquired_at+(SELECT watchmode_window FROM app.provider_retention_policy)<statement_timestamp())
          OR (acquisition_path='tmdb_metadata' AND acquired_at+interval '6 months'<statement_timestamp()) LIMIT 1000)`)).rowCount ?? 0;
                await client.query(`DELETE FROM app.movie_external_ids WHERE ctid IN (SELECT e.ctid FROM app.movie_external_ids e JOIN app.movies m ON e.movie_id=m.id WHERE
          (m.metadata_state='retired' OR e.source='watchmode') AND NOT EXISTS(SELECT 1 FROM app.movie_external_id_acquisitions a WHERE a.movie_id=e.movie_id AND a.source=e.source) LIMIT 1000)`);
                return deleted;
            });
        },
        async retire(externalId: string, now: string, gone: boolean, context: StoreContext) {
            return transaction(context, async (client) => {
                await client.query("SELECT pg_advisory_xact_lock(730003)");
                const row = (await client.query(`SELECT m.id,m.metadata_refreshed_at,m.metadata_state FROM app.movies m JOIN app.movie_external_ids e ON e.movie_id=m.id WHERE e.source='tmdb' AND e.external_id=$1 FOR UPDATE OF m`, [externalId])).rows[0];
                if (!row || row.metadata_state === 'retired')
                    return false;
                const attempts = (await client.query(`SELECT checked_at,outcome FROM app.metadata_detail_attempts WHERE tmdb_id=$1 AND checked_at>=$2::timestamptz+interval '5 months' ORDER BY checked_at DESC LIMIT 1000`, [externalId, row.metadata_refreshed_at])).rows;
                // Require failures across three weekly windows, never a brief boundary outage.
                const latest = attempts[0];
                const middle = latest ? attempts.find(a => a.checked_at.getTime() <= latest.checked_at.getTime() - 7 * 86400000) : undefined;
                const earliest = middle ? attempts.find(a => a.checked_at.getTime() <= middle.checked_at.getTime() - 7 * 86400000) : undefined;
                const exhausted = Boolean(latest && middle && earliest && attempts.length < 1000 &&
                    [latest, middle, earliest].every(a => ['failed', 'not_found'].includes(a.outcome)) && latest.checked_at.getTime() >= Date.parse(now) - 86400000);
                if (metadataAction(row.metadata_refreshed_at.getTime(), Date.parse(now), gone, exhausted) !== 'retire')
                    return false;
                await client.query(`UPDATE app.movies SET title='Unavailable movie',release_date=NULL,release_date_source=NULL,release_date_semantics=NULL,release_date_checked_at=NULL,
          runtime_minutes=NULL,original_language=NULL,us_certification=NULL,certification_source=NULL,certification_checked_at=NULL,
          overview=NULL,poster_path=NULL,genres='{}',keywords='{}',production_company_evidence='[]',origin_group='unknown',origin_evidence='[]',origin_mapping_version=NULL,origin_checked_at=NULL,
          rating=NULL,vote_count=NULL,metadata_source='local_retired',metadata_state='retired' WHERE id=$1`, [row.id]);
                await client.query("DELETE FROM app.movie_credits WHERE movie_id=$1 AND source='tmdb'", [row.id]);
                return true;
            });
        },
        async readback(now: string, context: StoreContext) {
            return transaction(context, async (client) => {
                const counts = (await client.query(`SELECT
        (SELECT count(*)::int FROM app.movies WHERE metadata_state='active') AS active,
        (SELECT count(*)::int FROM app.movies WHERE metadata_state='retired') AS retired,
        (SELECT count(*)::int FROM app.watchmode_offer_variants) AS offers,
        (SELECT count(*)::int FROM app.watchmode_links WHERE web_url IS NOT NULL AND expires_at>$1::timestamptz) AS links,
        (SELECT count(*)::int FROM app.watchmode_links WHERE web_url IS NULL) AS missing_links,
        (SELECT count(*)::int FROM app.watchmode_arrivals WHERE reason='interval' AND retention_at+(SELECT watchmode_window FROM app.provider_retention_policy)>$1::timestamptz) AS intervals,
        (SELECT count(*)::int FROM app.movie_classifications) AS classified`, [now])).rows[0];
                const preClassification = (await client.query(`WITH latest AS (
          SELECT DISTINCT ON(movie_id) id,movie_id,checked_at FROM app.availability_snapshots
          WHERE source='watchmode' AND outcome='success' ORDER BY movie_id,checked_at DESC,id DESC
        ), promoted AS (
          SELECT DISTINCT ON(s.source_id) s.id,s.source_id,e.observed_at AS completed
          FROM app.watchmode_sweeps s JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id
          WHERE e.outcome='complete' AND s.observed_at+(SELECT watchmode_window FROM app.provider_retention_policy)>$1::timestamptz
          ORDER BY s.source_id,e.observed_at DESC,s.id DESC
        ), ready AS (
          SELECT DISTINCT s.movie_id FROM latest s JOIN app.watchmode_offer_variants v ON v.snapshot_id=s.id
          LEFT JOIN promoted p ON p.source_id=v.source_id
          LEFT JOIN app.movie_external_ids identity ON identity.movie_id=s.movie_id AND identity.source='watchmode'
          LEFT JOIN app.watchmode_memberships member ON member.sweep_id=p.id AND member.watchmode_id::text=identity.external_id
          WHERE v.offer_type='subscription' AND v.tier_inclusion<>'excluded'
          AND ((s.checked_at>=$1::timestamptz-interval '48 hours' AND (p.id IS NULL OR p.completed<=s.checked_at))
            OR (p.completed>=s.checked_at AND member.observed_at>=$1::timestamptz-interval '48 hours'))
          AND EXISTS(SELECT 1 FROM app.watchmode_links l WHERE (l.snapshot_id,l.provider_id,l.offer_type,l.requested_variant)=(v.snapshot_id,v.provider_id,v.offer_type,v.requested_variant)
            AND l.web_url IS NOT NULL AND l.expires_at>$1::timestamptz)
        ) SELECT count(*)::int AS active,
          count(*) FILTER(WHERE m.runtime_minutes IS NULL)::int AS missing_runtime,
          count(*) FILTER(WHERE m.original_language IS NULL)::int AS missing_language,
          count(*) FILTER(WHERE m.us_certification IS NULL)::int AS missing_certification,
          count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM app.movie_classifications c WHERE c.movie_id=m.id))::int AS unclassified,
          count(*) FILTER(WHERE EXISTS(SELECT 1 FROM ready r WHERE r.movie_id=m.id))::int AS cached_subscription_links_ready
          FROM app.movies m WHERE m.metadata_state='active'`, [now])).rows[0];
                const services = (await client.query(`SELECT source_id,state,reason,drift_sweep IS NOT NULL AS drift,count(*)::int AS count FROM app.watchmode_arrivals
          WHERE retention_at+(SELECT watchmode_window FROM app.provider_retention_policy)>$1::timestamptz GROUP BY source_id,state,reason,drift_sweep IS NOT NULL ORDER BY source_id,state,reason,drift`, [now])).rows;
                return { ...counts, preClassification, services };
            });
        }
    };
}
