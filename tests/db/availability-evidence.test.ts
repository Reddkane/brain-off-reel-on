// All data and mutations use the inspected disposable harness only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withDisposable } from "../../tooling/metadata-disposable.ts";
import { createWatchmodeStore } from "../../src/server/db/watchmode-store.ts";
import { deriveArrival } from "../../src/domain/availability-evidence.ts";
import { createEvidenceStore } from "../../src/server/db/availability-evidence-store.ts";
import { createPgStore } from "../../src/server/db/pg-store.ts";
import { fixtures } from "../../tooling/metadata-fixtures.ts";
import { tmdbId, movieId } from "../../src/server/providers/tmdb-validation.ts";
import { createWatchmode } from "../../src/server/providers/watchmode.ts";
import { runSweeps } from "../../src/server/ingestion/availability-sweeps.ts";
import { decodeSweepConfig } from "../../src/server/ingestion/sweep-config.ts";
import { readFile } from "node:fs/promises";
import { runEvidence } from "../../src/server/ingestion/availability-evidence.ts";
import { acquireRefreshLock } from "../../src/server/db/refresh-lock.ts";
test("evidence fresh replay: guard inventory, own-age cascades and acquisition protection", { timeout: 240000 }, async (t) => {
    await withDisposable(async (db) => {
        const movie = '30000000-0000-4000-8000-000000000001';
        const ctx = () => ({ signal: db.signal, deadline: Date.now() + 10000 });
        const store = createWatchmodeStore(db.pool, db.guard);
        const evidenceStore = createEvidenceStore(store);
        await t.test("all thirteen cache guards and the separate acquisition guard retain insertion seals", async () => {
            const rows = (await db.admin.query(`SELECT c.relname,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname IN ('guard_provider_cache','guard_external_id_acquisition')`)).rows;
            assert.equal(rows.filter(r => r.proname === 'guard_provider_cache').length, 13);
            assert.equal(rows.filter(r => r.proname === 'guard_external_id_acquisition').length, 1);
            assert.equal((await db.admin.query("SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname='check_watchmode_evidence'")).rows[0].n, 4);
            await assert.rejects(db.admin.query("UPDATE app.provider_retention_policy SET watchmode_window=interval '1 second'"), { code: '23514' });
            await assert.rejects(db.admin.query("UPDATE app.movie_classifications SET input_fingerprint='changed'"), { code: '23514' });
            const functions = (await db.admin.query(`SELECT p.proname,p.prosecdef,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS service
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app'
        AND p.proname IN ('guard_retention_policy','stamp_availability_age','guard_external_id_acquisition','stamp_watchmode_cache_age','guard_provider_cache')`)).rows;
            assert.equal(functions.length, 5);
            assert(functions.every(f => !f.prosecdef && !f.anon && !f.authenticated && !f.service));
            const fk = (await db.admin.query("SELECT confdeltype FROM pg_constraint WHERE conrelid='app.movie_external_id_acquisitions'::regclass AND contype='f'")).rows;
            assert.deepEqual(fk, [{ confdeltype: 'r' }]);
            for (const table of ['movie_external_id_acquisitions', 'watchmode_offer_variants', 'watchmode_links', 'watchmode_arrivals', 'provider_retention_policy']) {
                const privileges = (await db.admin.query("SELECT has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE') a,has_table_privilege('anon',$1,'SELECT,INSERT,UPDATE,DELETE') b", [`app.${table}`])).rows[0];
                assert.deepEqual(privileges, { a: false, b: false });
                assert.equal((await db.admin.query("SELECT has_table_privilege('service_role',$1,'UPDATE') AS allowed", [`app.${table}`])).rows[0].allowed, false);
            }
        });
        await t.test("mixed-age cascade rolls back visited expired children; all expired succeeds", async () => {
            const id = randomUUID();
            await db.admin.query(`INSERT INTO app.watchmode_sweeps VALUES($1,$1,203,'age',statement_timestamp()-interval '32 days')`, [id]);
            await db.admin.query(`INSERT INTO app.watchmode_pages(sweep_id,page,total_pages,total_results,row_count,unresolved_count,signature,observed_at) VALUES
        ($1,1,2,251,0,250,repeat('a',64),statement_timestamp()-interval '31 days'),
        ($1,2,2,251,0,1,repeat('b',64),statement_timestamp()-interval '1 day')`, [id]);
            await db.admin.query(`INSERT INTO app.watchmode_sweep_events VALUES($1,'failed','synthetic',statement_timestamp())`, [id]);
            await assert.rejects(db.admin.query("DELETE FROM app.watchmode_sweeps WHERE id=$1", [id]), { code: '23514' });
            assert.equal((await db.admin.query("SELECT count(*)::int n FROM app.watchmode_sweep_events WHERE sweep_id=$1", [id])).rows[0].n, 1);
            assert.equal((await db.admin.query("SELECT count(*)::int n FROM app.watchmode_pages WHERE sweep_id=$1", [id])).rows[0].n, 2);
            await assert.rejects(db.admin.query("UPDATE app.watchmode_pages SET observed_at=statement_timestamp()-interval '40 days' WHERE sweep_id=$1", [id]), { code: '23514' });
            const expired = randomUUID();
            await db.admin.query(`INSERT INTO app.watchmode_sweeps VALUES($1,$1,203,'age',statement_timestamp()-interval '32 days');`, [expired]);
            await db.admin.query(`INSERT INTO app.watchmode_sweep_events VALUES($1,'failed','synthetic',statement_timestamp()-interval '31 days')`, [expired]);
            assert.equal((await db.admin.query("DELETE FROM app.watchmode_sweeps WHERE id=$1", [expired])).rowCount, 1);
            await db.admin.query(`DO $$ DECLARE sweep_key uuid:=gen_random_uuid(); denied boolean:=false; BEGIN
              INSERT INTO app.watchmode_sweeps VALUES(sweep_key,sweep_key,203,'mixed_exact',statement_timestamp()-interval '32 days');
              INSERT INTO app.watchmode_pages(sweep_id,page,total_pages,total_results,row_count,unresolved_count,signature,observed_at) VALUES
                (sweep_key,1,2,251,0,250,repeat('a',64),statement_timestamp()-interval '31 days'),
                (sweep_key,2,2,251,0,1,repeat('b',64),statement_timestamp()-interval '30 days');
              INSERT INTO app.watchmode_sweep_events VALUES(sweep_key,'failed','synthetic',statement_timestamp()-interval '30 days');
              BEGIN DELETE FROM app.watchmode_sweeps WHERE watchmode_sweeps.id=sweep_key;
              EXCEPTION WHEN check_violation THEN denied:=true; END;
              IF NOT denied OR (SELECT count(*) FROM app.watchmode_pages WHERE sweep_id=sweep_key)<>2 OR
                NOT EXISTS(SELECT 1 FROM app.watchmode_sweep_events WHERE sweep_id=sweep_key) THEN RAISE EXCEPTION 'Exact-age cascade rollback failed'; END IF;
            END $$`);
        });
        await t.test("snapshot children age is insertion-stamped and remains available after parent deletion", async () => {
            const id = randomUUID(), provider = '40000000-0000-4000-8000-000000000001';
            const client = await db.admin.connect();
            try {
                await client.query('BEGIN');
                await client.query(`INSERT INTO app.availability_snapshots(id,movie_id,region,source,checked_at,refresh_deadline,outcome) VALUES($1,$2,'US','age-test',statement_timestamp()-interval '31 days',statement_timestamp(),'success')`, [id, movie]);
                await client.query(`INSERT INTO app.movie_availability(snapshot_id,provider_id,offer_type,retention_at) VALUES($1,$2,'subscription',statement_timestamp()-interval '80 days')`, [id, provider]);
                assert.equal((await client.query("SELECT retention_at=(SELECT checked_at FROM app.availability_snapshots WHERE id=$1) same FROM app.movie_availability WHERE snapshot_id=$1", [id])).rows[0].same, true);
                await client.query('COMMIT');
                assert.equal((await client.query("DELETE FROM app.availability_snapshots WHERE id=$1", [id])).rowCount, 1);
            }
            finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });
        await t.test("restrictive identity FK and first-party permanent evidence; provider exact boundaries", async () => {
            await db.admin.query("INSERT INTO app.movie_external_ids VALUES($1,'tmdb','998811')", [movie]);
            await db.admin.query("INSERT INTO app.movie_external_id_acquisitions VALUES($1,'tmdb','first_party_ratings','2000-01-01Z')", [movie]);
            await assert.rejects(db.admin.query("DELETE FROM app.movie_external_ids WHERE movie_id=$1 AND source='tmdb'", [movie]), { code: '23503' });
            await assert.rejects(db.admin.query("DELETE FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND source='tmdb'", [movie]), { code: '23514' });
            for (const [path, window] of [['watchmode_membership', '30 days'], ['tmdb_metadata', '6 months']]) {
                for (const offset of ['0 seconds', '1 day']) {
                    const c = await db.admin.connect();
                    try {
                        // Code-owned constants only; one DO statement keeps the boundary clock fixed.
                        await assert.rejects(c.query(`DO $$ BEGIN
              INSERT INTO app.movie_external_id_acquisitions VALUES('${movie}','tmdb','${path}',statement_timestamp()-interval '${window}'+interval '${offset}');
              DELETE FROM app.movie_external_id_acquisitions WHERE movie_id='${movie}' AND acquisition_path='${path}';
            END $$`), { code: '23514' });
                    }
                    finally {
                        c.release();
                    }
                }
                await db.admin.query(`INSERT INTO app.movie_external_id_acquisitions VALUES($1,'tmdb',$2,statement_timestamp()-$3::interval-interval '1 day')`, [movie, path, window]);
                assert.equal((await db.admin.query("DELETE FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND acquisition_path=$2", [movie, path])).rowCount, 1);
            }
            await assert.rejects(db.admin.query("UPDATE app.movie_external_id_acquisitions SET acquired_at='2001-01-01Z' WHERE movie_id=$1", [movie]), { code: '23514' });
        });
        await t.test("complete history omission supports late enrichment without changing observation times", async () => {
            const now = Date.now(), stamp = (offset: number) => new Date(now + offset).toISOString();
            const empty = await store.resume(203, 'history', stamp(-2 * 86400000), ctx());
            await store.page(empty, { page: 1, totalPages: 0, totalResults: 0, titles: [], observedAt: stamp(-2 * 86400000) }, stamp(-2 * 86400000), ctx());
            const present = await store.resume(203, 'history', stamp(-86400000), ctx());
            await store.page(present, { page: 1, totalPages: 1, totalResults: 1, titles: [{ watchmodeId: 999, tmdbId: '998811', popularity: 80 }], observedAt: stamp(-86400000) }, stamp(-86400000), ctx());
            const history = await store.history(203, 'history', 999, stamp(0), ctx());
            assert.equal(deriveArrival(history, 'history', now).reason, 'interval');
            const snapshotsBefore = (await db.admin.query('SELECT count(*)::int n FROM app.availability_snapshots')).rows[0].n;
            await evidenceStore.derive(movie, 999, 'history', stamp(3 * 86400000), ctx());
            const interval = (await db.admin.query("SELECT absence_at,presence_at,retention_at FROM app.watchmode_arrivals WHERE generation='history'")).rows[0];
            assert.equal(interval.presence_at.toISOString(), stamp(-86400000));
            assert.equal(interval.absence_at.toISOString(), stamp(-2 * 86400000));
            assert.equal(interval.retention_at.toISOString(), stamp(-2 * 86400000));
            assert.equal((await db.admin.query('SELECT count(*)::int n FROM app.availability_snapshots')).rows[0].n, snapshotsBefore);
        });
        await t.test("deleting an aged membership invalidates complete absence evidence", async () => {
            const now = Date.now(), stamp = (days: number) => new Date(now + days * 86400000).toISOString();
            const sweep = await store.resume(203, 'partial-cleanup', stamp(-31), ctx());
            const client = await db.admin.connect();
            try {
                await client.query('BEGIN');
                await client.query(`INSERT INTO app.watchmode_pages(sweep_id,page,total_pages,total_results,row_count,unresolved_count,signature,observed_at)
                    VALUES($1,1,1,1,1,0,repeat('a',64),$2)`, [sweep.id, stamp(-31)]);
                await client.query("INSERT INTO app.watchmode_memberships VALUES($1,1,811001,'998811',80,$2)", [sweep.id, stamp(-31)]);
                await client.query("INSERT INTO app.watchmode_sweep_events VALUES($1,'complete','complete',$2)", [sweep.id, stamp(-29)]);
                await client.query('COMMIT');
            }
            finally {
                await client.query('ROLLBACK');
                client.release();
            }
            // The late terminal event is retained, but the original membership is deletable.
            const before = await store.history(203, 'partial-cleanup', 811002, stamp(0), ctx());
            assert.equal(before[0].outcome, 'complete');
            assert.equal((await db.admin.query('DELETE FROM app.watchmode_memberships WHERE sweep_id=$1', [sweep.id])).rowCount, 1);
            const after = await store.history(203, 'partial-cleanup', 811002, stamp(0), ctx());
            assert.equal(after[0].outcome, 'interrupted');
            // An as-of replay still cannot use the now-incomplete set to supply absence.
            const replay = await store.history(203, 'partial-cleanup', 811002, stamp(-28), ctx());
            assert.equal(deriveArrival(replay, 'partial-cleanup', Date.parse(stamp(-28))).state, 'unknown');
        });
        await t.test("drift remains separate from the retained arrival interval in persistence and readback", async () => {
            const now = Date.now(), stamp = (days: number) => new Date(now + days * 86400000).toISOString();
            const sweeps = [];
            for (const [days, present] of [[-4, false], [-3, true], [-2, false], [-1, true]] as const) {
                const sweep = await store.resume(203, 'drift-interval', stamp(days), ctx());
                await store.page(sweep, { page: 1, totalPages: present ? 1 : 0, totalResults: present ? 1 : 0, titles: present ? [{ watchmodeId: 811005, tmdbId: '998811', popularity: 80 }] : [], observedAt: stamp(days) }, stamp(days), ctx());
                sweeps.push(sweep);
            }
            await evidenceStore.derive(movie, 811005, 'drift-interval', stamp(0), ctx());
            const row = (await db.admin.query("SELECT reason,drift_sweep,absence_at,presence_at FROM app.watchmode_arrivals WHERE generation='drift-interval' AND source_id=203")).rows[0];
            assert.equal(row.reason, 'interval');
            assert.equal(row.drift_sweep, sweeps[2].id);
            assert.equal(row.absence_at.toISOString(), stamp(-4));
            assert.equal(row.presence_at.toISOString(), stamp(-3));
            const readback = await evidenceStore.readback(stamp(0), ctx());
            assert(readback.intervals > 0);
            assert(readback.services.some((s: {
                source_id: number;
                reason: string;
                drift: boolean;
            }) => s.source_id === 203 && s.reason === 'interval' && s.drift));
        });
        await t.test("ordinary retirement of a referenced movie preserves UUID and first-party identity, then valid refresh restores it", async () => {
            const f = await fixtures(), cap = Object.freeze({}), op = { profileId: '20000000-0000-4000-8000-000000000001', accountId: '10000000-0000-4000-8000-000000000001' };
            const metadata = createPgStore({ pool: db.pool, checkoutGuard: db.guard, catalogCapability: cap, operators: [op] });
            const key = { source: 'tmdb' as const, externalId: tmdbId('998811') };
            // Existing mapping/history already references movie UUID; actual persistence uses that mapping.
            const refreshed = { ...f.movie, keys: [key], checkedAt: new Date(Date.now() - 7 * 31 * 86400000).toISOString() };
            const saved = await metadata.persistMovie(cap, refreshed, 1000, ctx());
            assert.equal(saved.status, 'updated');
            const applied = await metadata.applyRatings(op, [{ movieId: movieId(movie), key, fields: { watched: false }, indices: [0] }], ctx());
            assert.equal(applied.status, 'unchanged');
            const before = (await db.admin.query("SELECT metadata_refreshed_at FROM app.movies WHERE id=$1", [movie])).rows[0].metadata_refreshed_at;
            const activeBefore = (await store.catalog(ctx())).count;
            assert.equal(await evidenceStore.retire(key.externalId, new Date().toISOString(), true, ctx()), true);
            assert.equal((await store.catalog(ctx())).count, activeBefore - 1);
            const shell = (await db.admin.query("SELECT title,metadata_state,metadata_refreshed_at,overview FROM app.movies WHERE id=$1", [movie])).rows[0];
            assert.equal(shell.metadata_state, 'retired');
            assert.equal(shell.overview, null);
            assert.deepEqual(shell.metadata_refreshed_at, before);
            await evidenceStore.cleanup(ctx());
            assert.equal(await metadata.resolveMovie(key, ctx()), movie);
            assert.equal((await metadata.persistMovie(cap, { ...refreshed, checkedAt: new Date().toISOString() }, activeBefore - 1, ctx())).status, 'catalog_limit');
            const restored = await metadata.persistMovie(cap, { ...refreshed, checkedAt: new Date().toISOString() }, 1000, ctx());
            assert.equal(restored.status, 'updated');
            assert('movieId' in restored);
            assert.equal(restored.movieId, movie);
            assert.equal((await db.admin.query("SELECT metadata_state FROM app.movies WHERE id=$1", [movie])).rows[0].metadata_state, 'active');
            assert((await db.admin.query("SELECT count(*)::int n FROM app.movie_classifications WHERE movie_id=$1", [movie])).rows[0].n > 0);
            assert((await db.admin.query("SELECT count(*)::int n FROM app.recommendations WHERE movie_id=$1", [movie])).rows[0].n > 0);
        });
        await t.test("actual provider repeat composition persists uncertainty and background links under shared budgets", async () => {
            const f = await fixtures();
            for (const source of [203, 387, 372, 157]) {
                const id = randomUUID();
                await db.admin.query("INSERT INTO app.streaming_providers(id,display_name) VALUES($1,'Synthetic service')", [id]);
                await db.admin.query("INSERT INTO app.streaming_provider_external_ids VALUES($1,'watchmode',$2)", [id, String(source)]);
            }
            const raw = JSON.parse(await readFile('config/availability-sweeps.example.json', 'utf8'));
            const config = decodeSweepConfig({ ...raw, generation: 'evidence-repeat', terms: { ...raw.terms, accepted: true }, evidence: { enabled: true, movies: 10, sourceChecks: 1, flaggedWatchmodeIds: [] } });
            let now = Date.now() - 86400000, present = false, charges = 0, checks = 0;
            const provider = createWatchmode('synthetic-evidence-key', { sleep: async (ms) => { now += ms; }, fetch: async (input) => {
                    const url = new URL(String(input));
                    if (url.pathname.includes('status'))
                        return Response.json({ quota: 2500, quotaUsed: charges });
                    charges++;
                    if (url.pathname.includes('/sources/')) {
                        checks++;
                        return Response.json([
                            { source_id: 372, type: 'sub', region: 'US', web_url: 'https://www.disneyplus.com/watch/synthetic', format: 'HD' },
                            { source_id: 372, type: 'sub', region: 'US', web_url: 'Paid plan required', format: '4K' },
                            { source_id: 157, type: 'rent', region: 'US', web_url: 'https://www.hulu.com/watch/synthetic' },
                            { source_id: 634, type: 'sub', region: 'US', web_url: 'https://www.disneyplus.com/watch/synthetic' },
                            { source_id: 203, type: 'future_type', region: 'US' }
                        ]);
                    }
                    return Response.json({ page: 1, total_pages: present ? 1 : 0, total_results: present ? 1 : 0, titles: present ? [{ id: 700001, tmdb_id: '990011', tmdb_type: 'movie', type: 'movie', popularity_percentile: 80 }] : [] });
                } });
            const reports: unknown[] = [];
            const io = { pool: db.pool, guard: db.guard, watchmode: provider, metadata: { discover: async () => { throw new Error('unused'); }, getMovie: async () => ({ status: 'ok' as const, value: { ...f.movie, keys: [{ source: 'tmdb' as const, externalId: tmdbId('990011') }], checkedAt: new Date(now).toISOString() }, issues: [] }) }, now: () => now, signal: db.signal, writeReport: async (r: unknown) => { reports.push(r); }, expirePrivateFiles: async () => ({ inspected: 0, deleted: 0, bounded: false }) };
            const emptyResult = await runSweeps(config, io);
            assert.equal(emptyResult.exitCode, 0, JSON.stringify(emptyResult.report));
            present = true;
            now += 86400000;
            const result = await runSweeps(config, io);
            assert.equal(result.exitCode, 0, JSON.stringify(result.report));
            assert.equal(result.report.evidence?.sourceChecks, 1);
            assert.equal(checks, 1);
            assert.equal(result.report.evidence?.offers, 2);
            assert.equal(result.report.evidence?.links, 3);
            assert.equal(result.report.evidence?.unknownSourceTypes, 1);
            assert.equal((await db.admin.query("SELECT count(*)::int n FROM app.watchmode_offer_variants WHERE tier_inclusion='unknown' AND requested_variant='bundle_with_ads'")).rows[0].n, 2);
            assert.equal((await db.admin.query("SELECT count(*)::int n FROM app.watchmode_arrivals WHERE reason='interval' AND generation='evidence-repeat'")).rows[0].n, 4);
            now += 86400000;
            const repeated = await runSweeps(config, io);
            assert.equal(repeated.exitCode, 0);
            assert.equal(repeated.report.evidence?.sourceChecks, 1);
            const sourceMovie = (await db.admin.query("SELECT movie_id FROM app.movie_external_ids WHERE source='tmdb' AND external_id='990011'")).rows[0].movie_id;
            const beforeFailure = await evidenceStore.readback(new Date(now).toISOString(), ctx());
            await evidenceStore.sourceFailure(sourceMovie, new Date(now + 1).toISOString(), ctx());
            const afterFailure = await evidenceStore.readback(new Date(now + 2).toISOString(), ctx());
            assert.equal(afterFailure.preClassification.cached_subscription_links_ready, beforeFailure.preClassification.cached_subscription_links_ready);
            const later = now + 3 * 86400000;
            assert.equal((await evidenceStore.readback(new Date(later).toISOString(), ctx())).preClassification.cached_subscription_links_ready, 0);
            // Fresh membership can use a still-retained older link without restamping it.
            const state = await store.resume(372, 'evidence-repeat', new Date(later).toISOString(), ctx());
            await store.page(state, { page: 1, totalPages: 1, totalResults: 1, titles: [{ watchmodeId: 700001, tmdbId: '990011', popularity: 80 }], observedAt: new Date(later).toISOString() }, new Date(later).toISOString(), ctx());
            assert.equal((await evidenceStore.readback(new Date(later).toISOString(), ctx())).preClassification.cached_subscription_links_ready, 1);
            const clocks = (await db.admin.query("SELECT source_id,count(DISTINCT presence_at)::int n FROM app.watchmode_arrivals WHERE generation='evidence-repeat' GROUP BY source_id")).rows;
            assert(clocks.every(r => r.n === 1));
            assert.equal(reports.length, 3);
            const snapshots = (await db.admin.query("SELECT id FROM app.availability_snapshots WHERE source='watchmode' ORDER BY checked_at DESC")).rows;
            await assert.rejects(db.admin.query("INSERT INTO app.movie_availability(snapshot_id,provider_id,offer_type) SELECT $1,provider_id,'purchase' FROM app.watchmode_offer_variants LIMIT 1", [snapshots[0].id]), { code: '23514' });
            // These young rows are retained; expired mixed-age progress has a separate case.
            await evidenceStore.cleanup(ctx());
            await evidenceStore.cleanup(ctx());
        });
        await t.test("all thirteen actual tables deny younger/exact deletes and every UPDATE; old rows delete as owner and service", async () => {
            const sql = await readFile('tests/db/availability-evidence-ages.sql', 'utf8');
            for (const role of ['owner', 'service_role']) {
                const client = await db.admin.connect();
                try {
                    await client.query('BEGIN');
                    if (role === 'service_role')
                        await client.query('SET LOCAL ROLE service_role');
                    await client.query(sql);
                }
                finally {
                    await client.query('ROLLBACK');
                    client.release();
                }
            }
        });
        await t.test("all-expired snapshot cascade traverses offers, variants, links and observations", async () => {
            const observedAt = new Date(Date.now() - 31 * 86400000).toISOString();
            await evidenceStore.sourceCheck(movie, { observedAt, offers: [{ sourceId: 203, offerType: 'subscription', format: 'HD', webUrl: 'https://www.netflix.com/title/synthetic', missingReason: null, tierInclusion: 'unknown' }] }, ctx());
            const snapshot = (await db.admin.query("SELECT id FROM app.availability_snapshots WHERE movie_id=$1 AND source='watchmode' AND checked_at=$2", [movie, observedAt])).rows[0].id;
            assert.equal((await db.admin.query("DELETE FROM app.availability_snapshots WHERE id=$1", [snapshot])).rowCount, 1);
            for (const table of ['movie_availability', 'availability_observations', 'watchmode_offer_variants', 'watchmode_links'])
                assert.equal((await db.admin.query(`SELECT count(*)::int n FROM app.${table} WHERE snapshot_id=$1`, [snapshot])).rows[0].n, 0);
        });
        await t.test("cleanup makes repeatable progress through explicit mixed-age graphs", async () => {
            const mixed = randomUUID(), expired = randomUUID(), now = Date.now();
            await db.admin.query(`INSERT INTO app.watchmode_sweeps VALUES($1,$1,203,'cleanup_graph',statement_timestamp()-interval '32 days'),($2,$2,203,'cleanup_graph',statement_timestamp()-interval '32 days')`, [mixed, expired]);
            const client = await db.admin.connect();
            try {
                await client.query('BEGIN');
                await client.query(`INSERT INTO app.watchmode_pages(sweep_id,page,total_pages,total_results,row_count,unresolved_count,signature,observed_at) VALUES
              ($1,1,2,251,0,250,repeat('a',64),statement_timestamp()-interval '31 days'),
              ($1,2,2,251,1,0,repeat('b',64),statement_timestamp()-interval '1 day')`, [mixed]);
                await client.query(`INSERT INTO app.watchmode_memberships VALUES($1,2,811003,'998811',80,statement_timestamp())`, [mixed]);
                await client.query('COMMIT');
            }
            finally {
                await client.query('ROLLBACK');
                client.release();
            }
            await db.admin.query(`INSERT INTO app.watchmode_sweep_events VALUES($1,'failed','synthetic',statement_timestamp()-interval '1 day'),($2,'failed','synthetic',statement_timestamp()-interval '31 days')`, [mixed, expired]);
            const observedAt = new Date(now - 31 * 86400000).toISOString();
            await evidenceStore.sourceCheck(movie, { observedAt, offers: [{ sourceId: 203, offerType: 'subscription', format: 'HD', webUrl: 'https://www.netflix.com/title/cleanup', missingReason: null, tierInclusion: 'unknown' }] }, ctx());
            const snapshot = (await db.admin.query("SELECT id FROM app.availability_snapshots WHERE movie_id=$1 AND source='watchmode' AND checked_at=$2", [movie, observedAt])).rows[0].id;
            assert((await evidenceStore.cleanup(ctx())) > 0);
            assert.equal((await db.admin.query('SELECT count(*)::int n FROM app.watchmode_sweeps WHERE id=$1', [expired])).rows[0].n, 0);
            assert.equal((await db.admin.query('SELECT page FROM app.watchmode_pages WHERE sweep_id=$1', [mixed])).rows[0].page, 2);
            assert.equal((await db.admin.query('SELECT count(*)::int n FROM app.watchmode_sweeps s JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id WHERE s.id=$1', [mixed])).rows[0].n, 1);
            for (const table of ['availability_snapshots', 'movie_availability', 'availability_observations', 'watchmode_offer_variants', 'watchmode_links']) {
                const column = table === 'availability_snapshots' ? 'id' : 'snapshot_id';
                assert.equal((await db.admin.query(`SELECT count(*)::int n FROM app.${table} WHERE ${column}=$1`, [snapshot])).rows[0].n, 0);
            }
            await evidenceStore.cleanup(ctx());
            assert.equal((await db.admin.query('SELECT count(*)::int n FROM app.watchmode_pages WHERE sweep_id=$1', [mixed])).rows[0].n, 1);
            assert.equal((await db.admin.query('SELECT count(*)::int n FROM app.watchmode_sweep_events WHERE sweep_id=$1', [mixed])).rows[0].n, 1);
            assert.equal((await db.admin.query('SELECT count(*)::int n FROM app.watchmode_memberships WHERE sweep_id=$1', [mixed])).rows[0].n, 1);
        });
        await t.test("fresh Watchmode membership independently preserves retired TMDB identity without first-party acquisition", async () => {
            const f = await fixtures(), cap = Object.freeze({}), metadata = createPgStore({ pool: db.pool, checkoutGuard: db.guard, catalogCapability: cap, operators: [] });
            const now = Date.now(), stamp = (days: number) => new Date(now + days * 86400000).toISOString(), key = { source: 'tmdb' as const, externalId: tmdbId('998814') };
            const saved = await metadata.persistMovie(cap, { ...f.movie, keys: [key], checkedAt: stamp(-220) }, 1000, ctx());
            assert('movieId' in saved);
            const sweep = await store.resume(203, 'watchmode-identity', stamp(-1), ctx());
            await store.page(sweep, { page: 1, totalPages: 1, totalResults: 1, titles: [{ watchmodeId: 811004, tmdbId: key.externalId, popularity: 80 }], observedAt: stamp(-1) }, stamp(-1), ctx());
            assert.equal(await evidenceStore.acquireMemberships('watchmode-identity', stamp(0), ctx()), 2);
            assert.equal(await evidenceStore.acquireMemberships('watchmode-identity', stamp(0), ctx()), 0);
            const acquisitions = (await db.admin.query("SELECT source,acquired_at FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND acquisition_path='watchmode_membership' ORDER BY source", [saved.movieId])).rows;
            assert.deepEqual(acquisitions.map(a => a.source), ['tmdb', 'watchmode']);
            assert(acquisitions.every(a => a.acquired_at.toISOString() === stamp(-1)));
            assert.equal((await db.admin.query("SELECT count(*)::int n FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND acquisition_path='first_party_ratings'", [saved.movieId])).rows[0].n, 0);
            assert.equal(await evidenceStore.retire(key.externalId, stamp(0), true, ctx()), true);
            await evidenceStore.cleanup(ctx());
            assert.equal(await metadata.resolveMovie(key, ctx()), saved.movieId);
            assert.equal((await db.admin.query("SELECT count(*)::int n FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND acquisition_path='tmdb_metadata'", [saved.movieId])).rows[0].n, 0);
            const restored = await metadata.persistMovie(cap, { ...f.movie, keys: [key], checkedAt: stamp(0) }, 1000, ctx());
            assert('movieId' in restored);
            assert.equal(restored.movieId, saved.movieId);
        });
        await t.test("actual first-party acquisition is appended on an already mapped unchanged movie and repeat is idempotent", async () => {
            const cap = Object.freeze({}), op = { profileId: '20000000-0000-4000-8000-000000000001', accountId: '10000000-0000-4000-8000-000000000001' };
            const metadata = createPgStore({ pool: db.pool, checkoutGuard: db.guard, catalogCapability: cap, operators: [op] });
            const key = { source: 'tmdb' as const, externalId: tmdbId('990011') }, id = await metadata.resolveMovie(key, ctx());
            assert(id);
            await db.admin.query("INSERT INTO app.profile_movies(profile_id,movie_id) VALUES($1,$2)", [op.profileId, id]);
            const row = { movieId: id, key, fields: { watched: false }, indices: [0] };
            assert.equal((await metadata.applyRatings(op, [row], ctx())).status, 'unchanged');
            const before = (await db.admin.query("SELECT acquired_at FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND source='tmdb' AND acquisition_path='first_party_ratings'", [id])).rows;
            assert.equal(before.length, 1);
            assert.equal((await metadata.applyRatings(op, [row], ctx())).status, 'unchanged');
            assert.deepEqual((await db.admin.query("SELECT acquired_at FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND source='tmdb' AND acquisition_path='first_party_ratings'", [id])).rows, before);
        });
        await t.test("a boundary outage cannot retire; distributed failed attempts after expiry can, without renewing metadata", async () => {
            const f = await fixtures(), cap = Object.freeze({}), metadata = createPgStore({ pool: db.pool, checkoutGuard: db.guard, catalogCapability: cap, operators: [] });
            const now = Date.now(), key = { source: 'tmdb' as const, externalId: tmdbId('998813') };
            const saved = await metadata.persistMovie(cap, { ...f.movie, keys: [key], checkedAt: new Date(now - 220 * 86400000).toISOString() }, 1000, ctx());
            assert('movieId' in saved);
            await db.admin.query("INSERT INTO app.metadata_detail_attempts VALUES($1,'failed',$2)", [key.externalId, new Date(now).toISOString()]);
            assert.equal(await evidenceStore.retire(key.externalId, new Date(now).toISOString(), false, ctx()), false);
            for (const days of [7, 14])
                await db.admin.query("INSERT INTO app.metadata_detail_attempts VALUES($1,'failed',$2)", [key.externalId, new Date(now - days * 86400000).toISOString()]);
            assert.equal(await evidenceStore.retire(key.externalId, new Date(now).toISOString(), false, ctx()), true);
            assert.equal((await db.admin.query("SELECT metadata_refreshed_at FROM app.movies WHERE id=$1", [saved.movieId])).rows[0].metadata_refreshed_at.toISOString(), new Date(now - 220 * 86400000).toISOString());
            await evidenceStore.cleanup(ctx());
            assert.equal(await metadata.resolveMovie(key, ctx()), null);
            assert.equal((await db.admin.query("SELECT metadata_state FROM app.movies WHERE id=$1", [saved.movieId])).rows[0].metadata_state, 'retired');
        });
        await t.test("acquisition guard denies nested first-party and young provider deletion; an unprotected mapping can delete", async () => {
            const client = await db.admin.connect();
            try {
                await client.query('BEGIN');
                await client.query(`CREATE TEMP TABLE nested_acquisition(path text PRIMARY KEY);
          CREATE FUNCTION pg_temp.delete_acquisition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            DELETE FROM app.movie_external_id_acquisitions WHERE movie_id='30000000-0000-4000-8000-000000000001' AND source='tmdb' AND acquisition_path=OLD.path;
            RETURN OLD;
          END $$;
          CREATE TRIGGER nested_delete BEFORE DELETE ON nested_acquisition FOR EACH ROW EXECUTE FUNCTION pg_temp.delete_acquisition()`);
                for (const path of ['first_party_ratings', 'tmdb_metadata', 'watchmode_membership']) {
                    if (path !== 'first_party_ratings')
                        await client.query("INSERT INTO app.movie_external_id_acquisitions VALUES($1,'tmdb',$2,statement_timestamp())", [movie, path]);
                    await client.query("INSERT INTO nested_acquisition VALUES($1)", [path]);
                    await client.query('SAVEPOINT denied');
                    await assert.rejects(client.query("DELETE FROM nested_acquisition WHERE path=$1", [path]), { code: '23514' });
                    await client.query('ROLLBACK TO denied');
                }
                await client.query("INSERT INTO app.movie_external_ids VALUES($1,'positive_control','synthetic-identity')", [movie]);
                for (const path of ['tmdb_metadata', 'watchmode_membership'])
                    await client.query("INSERT INTO app.movie_external_id_acquisitions VALUES($1,'positive_control',$2,statement_timestamp()-interval '7 months')", [movie, path]);
                assert.equal((await client.query("DELETE FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND source='positive_control'", [movie])).rowCount, 2);
                assert.equal((await client.query("DELETE FROM app.movie_external_ids WHERE movie_id=$1 AND source='positive_control'", [movie])).rowCount, 1);
            }
            finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });
    }, { signal: AbortSignal.timeout(220000) });
});
test("explicit sweeps-baseline upgrade backfills legacy mapping acquisition at metadata refresh time", { timeout: 240000 }, async () => {
    await withDisposable(async (db) => {
        await db.admin.query("INSERT INTO app.movie_external_ids VALUES('30000000-0000-4000-8000-000000000003','tmdb','881177')");
        await db.upgrade();
        await db.upgrade(); // No migration is replayed.
        const row = (await db.admin.query("SELECT acquisition_path,acquired_at=metadata_refreshed_at same FROM app.movie_external_id_acquisitions a JOIN app.movies m ON m.id=a.movie_id WHERE a.source='tmdb'")).rows[0];
        assert.deepEqual(row, { acquisition_path: 'tmdb_metadata', same: true });
        const totals = (await db.admin.query(`SELECT
          (SELECT count(*)::int FROM app.movie_external_ids) AS mappings,
          (SELECT count(*)::int FROM app.movie_external_id_acquisitions WHERE acquisition_path='tmdb_metadata') AS acquisitions,
          (SELECT count(*)::int FROM app.movie_external_id_acquisitions WHERE acquisition_path<>'tmdb_metadata') AS invented_paths`)).rows[0];
        assert(totals.mappings > 0);
        assert.equal(totals.mappings, totals.acquisitions);
        assert.equal(totals.invented_paths, 0);
        assert.equal((await db.admin.query("SELECT count(*)::int n FROM app.movie_availability WHERE retention_at IS NULL")).rows[0].n, 0);
        assert.equal((await db.admin.query(`SELECT count(*)::int n FROM app.movie_availability o JOIN app.availability_snapshots s ON s.id=o.snapshot_id WHERE o.retention_at<>s.checked_at`)).rows[0].n, 0);
    }, { baseline: 'sweeps' });
});
test("realistic retained Netflix history prepares completeness four times for 100 candidates within the shared database budget", { timeout: 240000 }, async (t) => {
    await withDisposable(async (db) => {
        const now = Date.now(), stamp = new Date(now).toISOString(), f = await fixtures(), cap = Object.freeze({});
        const ctx = () => ({ signal: db.signal, deadline: Date.now() + 10000 });
        const metadata = createPgStore({ pool: db.pool, checkoutGuard: db.guard, catalogCapability: cap, operators: [] });
        for (let n = 1; n <= 100; n++)
            await metadata.persistMovie(cap, { ...f.movie, keys: [{ source: 'tmdb', externalId: tmdbId(String(3000000 + n)) }], checkedAt: stamp }, 1000, ctx());
        // Synthetic 30 daily sweeps, 15 complete pages each, 250 memberships per page.
        // All insertions use actual seals; no triggers/guards are disabled for scale setup.
        await db.admin.query(`DO $$ DECLARE s uuid; d integer; p integer; observed timestamptz; BEGIN
          FOR d IN 0..29 LOOP
            s:=gen_random_uuid(); observed:=statement_timestamp()-interval '1 hour'-(29-d)*interval '1 day';
            INSERT INTO app.watchmode_sweeps VALUES(s,s,203,'scale_history',observed);
            FOR p IN 1..15 LOOP
              INSERT INTO app.watchmode_pages(sweep_id,page,total_pages,total_results,row_count,unresolved_count,signature,observed_at)
                VALUES(s,p,15,3750,250,0,repeat('a',64),observed);
              INSERT INTO app.watchmode_memberships
                SELECT s,p,900000+n,(3000000+n)::text,80,observed FROM generate_series((p-1)*250+1,p*250) n;
            END LOOP;
            INSERT INTO app.watchmode_sweep_events VALUES(s,'complete','complete',observed);
          END LOOP;
        END $$`);
        await db.admin.query('ANALYZE app.watchmode_memberships; ANALYZE app.watchmode_pages; ANALYZE app.watchmode_sweeps');
        assert.equal((await db.admin.query('SELECT count(*)::int n FROM app.watchmode_memberships')).rows[0].n, 112500);
        const store = createWatchmodeStore(db.pool, db.guard);
        let prepares = 0, databaseMs = 0;
        const measured = createEvidenceStore({ ...store, prepareHistory: async (...params: Parameters<typeof store.prepareHistory>) => {
                prepares++;
                const prepared = await store.prepareHistory(...params);
                if (params[0] === 203)
                    assert.equal(prepared.sweeps.length, 30);
                return prepared;
            } });
        const raw = JSON.parse(await readFile('config/availability-evidence.example.json', 'utf8'));
        const config = decodeSweepConfig({ ...raw, generation: 'scale_history', evidence: { ...raw.evidence, movies: 100, sourceChecks: 0 } });
        const lock = await acquireRefreshLock(db.pool, db.guard, db.signal);
        try {
            const start = performance.now();
            const report = await runEvidence(config, { store: measured, database: async (work) => {
                    const begin = performance.now();
                    try {
                        return await work(ctx());
                    }
                    finally {
                        databaseMs += performance.now() - begin;
                    }
                }, watchmode: { status: async () => { throw new Error('no_provider_call'); }, page: async () => { throw new Error('no_provider_call'); } },
                context: { signal: db.signal, now: () => now, deadline: now + 600000, creditCap: 100, charges: 0, attempts: 0, stopped: false }, now: () => now });
            assert.equal(report.candidates, 100);
            assert.equal(report.derived, 100);
            assert.equal(prepares, 4);
            assert.equal(report.sourceChecks, 0);
            assert(databaseMs < config.limits.databaseMs, `database budget exceeded: ${databaseMs}ms`);
            t.diagnostic(`Synthetic 112500 memberships, 450 pages, 30 sweeps, 100 candidates, 4 completeness preparations: database=${Math.ceil(databaseMs)}ms / ${config.limits.databaseMs}ms; wall=${Math.ceil(performance.now() - start)}ms`);
        }
        finally {
            await lock.release();
        }
    });
});
