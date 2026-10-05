// Every SQL mutation targets the inspected disposable metadata harness, never retained data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { withDisposable } from "../../tooling/metadata-disposable.ts";
import { fixtures } from "../../tooling/metadata-fixtures.ts";
import { createWatchmode } from "../../src/server/providers/watchmode.ts";
import { createTmdb } from "../../src/server/providers/tmdb.ts";
import { createWatchmodeStore } from "../../src/server/db/watchmode-store.ts";
import { acquireRefreshLock } from "../../src/server/db/refresh-lock.ts";
import { localCatalogGuard } from "../../src/server/db/local-catalog-target.ts";
import { decodeSweepConfig } from "../../src/server/ingestion/sweep-config.ts";
import { runSweeps } from "../../src/server/ingestion/availability-sweeps.ts";
import type { StoreContext } from "../../src/server/db/metadata-store.ts";
import type { WatchmodePage } from "../../src/server/providers/watchmode.ts";
test("Availability: sweeps synthetic transport and disposable PostgreSQL acceptance", { timeout: 240000 }, async (t) => {
  await withDisposable(async (db) => {
    await db.admin.query(await readFile(new URL("../../supabase/migrations/20261005000001_availability_sweeps.sql", import.meta.url), "utf8"));
    const f = await fixtures(), store = createWatchmodeStore(db.pool, db.guard);
    let now = Date.parse("2026-10-05T00:00:00.000Z"), generation = 0;
    const ctx = (): StoreContext => ({ signal: db.signal, deadline: Date.now() + 10000 });
    const stamp = () => new Date(now).toISOString();
    const raw = JSON.parse(await readFile("config/availability-sweeps.example.json", "utf8"));
    function config(limits: Record<string, number> = {}) { return decodeSweepConfig({ ...raw, generation: `synthetic-${++generation}`, limits: { ...raw.limits, ...limits }, terms: { ...raw.terms, accepted: true } }); }
    function providerFixture(totals = [501, 2, 2, 2], base = 910000) {
      const pageOrder: number[] = [], detailOrder: string[] = [], reports: unknown[] = [];
      let charges = 0, statusCalls = 0;
      const io = {
        sleep: async (ms: number) => { now += ms; },
        fetch: async (input: string | URL | Request) => {
          const u = new URL(String(input));
          if (u.hostname === "api.watchmode.com") {
            if (u.pathname.includes("status")) {
              statusCalls++;
              return Response.json({ quota: 2500, quotaUsed: charges });
            }
            const source = Number(u.searchParams.get("source_ids")), index = [203, 387, 372, 157].indexOf(source), page = Number(u.searchParams.get("page")), total = totals[index];
            pageOrder.push(source);
            charges++;
            return Response.json({
              page, total_pages: Math.ceil(total / 250), total_results: total, titles: Array.from({ length: Math.min(250, Math.max(0, total - (page - 1) * 250)) }, (_, j) => {
                const offset = (page - 1) * 250 + j, id = base + index * 1000 + offset;
                return { id: id + 1000000, tmdb_id: String(id), tmdb_type: "movie", type: "movie", popularity_percentile: offset % 101 };
              })
            });
          }
          assert.equal(u.hostname, "api.themoviedb.org");
          const id = Number(u.pathname.split("/").at(-1));
          detailOrder.push(String(id));
          return Response.json({ ...f.raw, id, release_dates: { ...f.raw.release_dates as object, id }, keywords: { ...f.raw.keywords as object, id }, credits: { ...f.raw.credits as object, id }, external_ids: { id, imdb_id: null } });
        }
      };
      return {
        pageOrder, detailOrder, reports, get charges() { return charges; }, get statusCalls() { return statusCalls; },
        options: { pool: db.pool, guard: db.guard, watchmode: createWatchmode("synthetic-watchmode-key", io), metadata: createTmdb("synthetic-tmdb-token", f.mapping, io), now: () => now, signal: db.signal, writeReport: async (report: unknown) => { reports.push(report); } }
      };
    }
    await t.test("actual provider composition completes independently, balances enrichment and confirms SQL readback", async () => {
      const personalTables = ["profiles", "profile_movies", "profile_subscriptions", "movie_classifications",
        "availability_snapshots", "movie_availability", "availability_observations", "availability_tracks",
        "selection_sessions", "recommendations", "feedback_events"];
      const personalRows = async () => Promise.all(personalTables.map(async table =>
        (await db.admin.query(`SELECT to_jsonb(t) AS row FROM app.${table} t ORDER BY to_jsonb(t)::text`)).rows));
      const personalBefore = await personalRows();
      const initial = (await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n;
      const p = providerFixture(), c = config({ details: 4 });
      const result = await runSweeps(c, p.options);
      assert.equal(result.exitCode, 2);
      assert.equal(result.report.code, "detail_budget");
      assert.deepEqual(p.pageOrder, [203, 387, 372, 157, 203, 203]);
      assert.deepEqual(result.report.selectedByService, [1, 1, 1, 1]);
      assert.deepEqual(p.detailOrder, ["910100", "911001", "912001", "913001"]);
      assert.equal(result.report.persisted, 4);
      assert.equal(result.report.observedSpend.credits, 6);
      assert.equal((p.reports[0] as {
        readback: string;
      }).readback, "verified");
      const promoted = await store.promoted(c.generation, stamp(), ctx());
      assert.equal(promoted.sweeps.length, 4);
      assert.equal(promoted.sweeps.find(s => s.source === 203)?.candidates.length, 501);
      assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n, initial + 4);
      // A new sweep does not enrich those fresh rows again or duplicate internal IDs.
      p.pageOrder.length = 0;
      p.detailOrder.length = 0;
      const repeated = await runSweeps(c, p.options);
      assert.equal(repeated.report.persisted, 4);
      assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n, initial + 8);
      assert.deepEqual(await personalRows(), personalBefore);
    });
    await t.test("one-detail runs rotate enrichment across all services instead of restarting Netflix", async () => {
      const c = config({ details: 1 }), p = providerFixture([2, 2, 2, 2], 1000001), services: number[] = [];
      for (let run = 0; run < 4; run++) {
        const result = await runSweeps(c, p.options);
        assert.equal(result.report.persisted, 1);
        services.push(result.report.selectedByService.findIndex(n => n === 1));
      }
      assert.equal(new Set(services).size, 4);
      for (let i = 1; i < services.length; i++)
        assert.equal(services[i], (services[i - 1] + 1) % 4);
    });
    await t.test("worker reports unmapped identities and omits both directions of a conflict", async () => {
      const c = config(), p = providerFixture([1, 1, 1, 1], 1010001), original = p.options.watchmode;
      const result = await runSweeps(c, {
        ...p.options, watchmode: {
          ...original, page: async (source, number, context) => {
            const value = await original.page(source, number, context);
            return { ...value, titles: value.titles.map(row => source === 203 ? { ...row, tmdbId: null } : source === 387 || source === 372 ? { ...row, watchmodeId: 3000000 } : row) };
          }
        }
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.report.persisted, 1);
      assert.deepEqual(result.report.selectedByService, [0, 0, 0, 1]);
      assert.equal(result.report.coverage[0].missingTmdbIds, 1);
      assert.equal(result.report.coverage[1].quarantined, 1);
      assert.equal(result.report.coverage[2].quarantined, 1);
    });
    await t.test("bounded page runs preserve timestamps, resume and rotate first service", async () => {
      const p = providerFixture([251, 2, 2, 2], 930000), c = config({ pages: 1, details: 1 });
      const first = await runSweeps(c, p.options);
      assert.equal(first.exitCode, 2);
      assert.equal(first.report.code, "page_budget");
      const ids = first.report.checkpoint.sweeps.map(s => s.id);
      const firstIndex = [203, 387, 372, 157].indexOf(p.pageOrder[0]);
      const observed = (await db.admin.query("SELECT observed_at FROM app.watchmode_pages WHERE sweep_id=$1", [ids[firstIndex]])).rows[0].observed_at.toISOString();
      now += 3600000;
      const second = await runSweeps(c, p.options);
      assert.equal(p.pageOrder[1], [203, 387, 372, 157][(firstIndex + 1) % 4]);
      assert.deepEqual(second.report.checkpoint.sweeps.map(s => s.id), ids);
      assert.equal((await db.admin.query("SELECT observed_at FROM app.watchmode_pages WHERE sweep_id=$1", [ids[firstIndex]])).rows[0].observed_at.toISOString(), observed);
      const promoted = await store.promoted(c.generation, stamp(), ctx());
      assert.ok(promoted.sweeps.some(s => s.source === p.pageOrder[1]));
      assert.equal(second.report.selected, 1);
    });
    await t.test("six-hour boundary resumes; expiry and generation change append interruptions", async () => {
      const source = 372, c = config(), start = now;
      const old = await store.resume(source, c.generation, stamp(), ctx());
      now = start + 21600000;
      assert.equal((await store.resume(source, c.generation, stamp(), ctx())).id, old.id);
      now++;
      const fresh = await store.resume(source, c.generation, stamp(), ctx());
      assert.notEqual(fresh.id, old.id);
      assert.equal((await db.admin.query("SELECT outcome FROM app.watchmode_sweep_events WHERE sweep_id=$1", [old.id])).rows[0].outcome, "expired");
      const changed = await store.resume(source, "synthetic-new-generation", stamp(), ctx());
      assert.notEqual(changed.id, fresh.id);
      assert.equal((await db.admin.query("SELECT outcome FROM app.watchmode_sweep_events WHERE sweep_id=$1", [fresh.id])).rows[0].outcome, "generation_changed");
    });
    function page(titles: readonly {
      watchmodeId: number;
      tmdbId: string | null;
      popularity: number | null;
    }[], page = 1, totalResults = titles.length): WatchmodePage {
      return { page, totalPages: Math.ceil(totalResults / 250), totalResults, titles, observedAt: stamp() };
    }
    await t.test("page commit is atomic; replay idempotent; duplicate, stalled and changed totals never promote", async () => {
      const c = config(), s = await store.resume(157, c.generation, stamp(), ctx());
      const rows = Array.from({ length: 250 }, (_, i) => ({ watchmodeId: 2000000 + i, tmdbId: String(950000 + i), popularity: 50 }));
      // A real insertion fault after the page write proves rollback of both checkpoint and rows.
      await db.admin.query(`CREATE FUNCTION app.synthetic_page_failure() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN RAISE EXCEPTION 'synthetic insert refusal'; END $$;
        REVOKE ALL ON FUNCTION app.synthetic_page_failure() FROM PUBLIC,anon,authenticated,service_role;
        CREATE TRIGGER synthetic_page_failure BEFORE INSERT ON app.watchmode_memberships FOR EACH ROW EXECUTE FUNCTION app.synthetic_page_failure()`);
      try {
        await assert.rejects(store.page(s, page(rows, 1, 251), stamp(), ctx()), /checkpoint_failed/);
      }
      finally {
        await db.admin.query("DROP TRIGGER synthetic_page_failure ON app.watchmode_memberships; DROP FUNCTION app.synthetic_page_failure()");
      }
      assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM app.watchmode_pages WHERE sweep_id=$1", [s.id])).rows[0].n, 0);
      await store.page(s, page(rows, 1, 251), stamp(), ctx());
      await store.page(s, page(rows, 1, 251), stamp(), ctx());
      const next = { ...s, nextPage: 2, totalPages: 2 };
      await assert.rejects(store.page(next, page([rows[0]], 2, 251), stamp(), ctx()), /pagination_drift/);
      await assert.rejects(store.page(next, page([{ watchmodeId: 2100000, tmdbId: "960000", popularity: 50 }], 2, 252), stamp(), ctx()), /page_incomplete/);
      const changed = page([{ watchmodeId: 2100000, tmdbId: "960000", popularity: 50 }, { watchmodeId: 2100001, tmdbId: "960001", popularity: 50 }], 2, 252);
      await assert.rejects(store.page(next, changed, stamp(), ctx()), /totals_changed/);
      assert.equal((await store.promoted(c.generation, stamp(), ctx())).sweeps.length, 0);
      await store.fail(s.id, "pagination_drift", stamp(), ctx());
      assert.equal((await db.admin.query("SELECT outcome FROM app.watchmode_sweep_events WHERE sweep_id=$1", [s.id])).rows[0].outcome, "failed");
    });
    await t.test("successful empty sweeps promote; missing and conflicting mappings remain quarantined", async () => {
      const c = config(), empty = await store.resume(203, c.generation, stamp(), ctx());
      await store.page(empty, page([]), stamp(), ctx());
      const a = await store.resume(387, c.generation, stamp(), ctx()), b = await store.resume(157, c.generation, stamp(), ctx());
      await store.page(a, page([{ watchmodeId: 2200000, tmdbId: "970001", popularity: null }, { watchmodeId: 2200001, tmdbId: null, popularity: 50 }]), stamp(), ctx());
      await store.page(b, page([{ watchmodeId: 2200000, tmdbId: "970002", popularity: 50 }]), stamp(), ctx());
      const promoted = await store.promoted(c.generation, stamp(), ctx());
      assert.equal(promoted.sweeps.find(s => s.source === 203)?.candidates.length, 0);
      assert.ok(promoted.conflicts.includes(2200000));
      assert.equal(promoted.sweeps.find(s => s.source === 387)?.candidates.find(r => r.watchmodeId === 2200001)?.tmdbId, null);
    });
    await t.test("promotion input retains original membership timestamps for later evidence/enrichment", async () => {
      const c = config(), s = await store.resume(203, c.generation, stamp(), ctx()), observed = stamp();
      await store.page(s, page([{ watchmodeId: 2300000, tmdbId: "980001", popularity: 50 }]), stamp(), ctx());
      now += 3 * 86400000;
      const promoted = await store.promoted(c.generation, stamp(), ctx());
      assert.equal(promoted.sweeps[0].candidates[0].observedAt, observed);
      assert.equal(promoted.sweeps[0].completedAt, observed);
      await store.advance("980001", [{ sweepId: s.id, watchmodeId: 2300000 }], "not_found", stamp(), ctx());
      assert.equal((await store.promoted(c.generation, stamp(), ctx())).sweeps[0].candidates[0].coolingDown, true);
      assert.equal((await store.promoted(c.generation, stamp(), ctx())).sweeps[0].candidates[0].observedAt, observed);
    });
    await t.test("real quota preflight below/equal/above cap, status outage and unknown final spend", async () => {
      for (const remaining of [99, 100, 101]) {
        const p = providerFixture([0, 0, 0, 0]), c = config();
        let calls = 0;
        const result = await runSweeps(c, { ...p.options, watchmode: { ...p.options.watchmode, status: async () => { calls++; return { quota: 2500, used: 2500 - remaining }; } } });
        assert.equal(result.exitCode, remaining < 100 ? 1 : 0);
        assert.equal(p.pageOrder.length, remaining < 100 ? 0 : 4);
        if (remaining < 100)
          assert.equal(result.report.code, "quota_insufficient");
        assert.equal(calls, remaining < 100 ? 1 : 2);
      }
      const p = providerFixture([0, 0, 0, 0]), c = config();
      const failed = await runSweeps(c, { ...p.options, watchmode: { ...p.options.watchmode, status: async () => { throw new Error("synthetic-secret-sentinel"); } } });
      assert.equal(failed.exitCode, 1);
      assert.equal(p.pageOrder.length, 0);
      assert.equal(failed.report.code, "sweep_failed");
      let statuses = 0;
      const final = await runSweeps(config(), {
        ...p.options, watchmode: {
          ...p.options.watchmode, status: async () => {
            if (++statuses > 1)
              throw new Error();
            return { quota: 2500, used: 10 };
          }
        }
      });
      assert.equal(final.exitCode, 0);
      assert.equal(final.report.observedSpend.credits, null);
    });
    await t.test("all new provider cache tables remain append-only; API roles have no grants", async () => {
      for (const table of ["watchmode_sweeps", "watchmode_pages", "watchmode_memberships", "watchmode_sweep_events", "watchmode_enrichment_checks", "metadata_detail_attempts"]) {
        const timestamp = table === "metadata_detail_attempts" ? "checked_at" : "observed_at";
        await assert.rejects(db.admin.query(`UPDATE app.${table} SET ${timestamp}=now()`), /Append-only/);
        await assert.rejects(db.admin.query(`DELETE FROM app.${table}`), /Append-only/);
        const grants = (await db.admin.query("SELECT has_table_privilege('authenticated',$1,'SELECT') AS browser,has_table_privilege('anon',$1,'INSERT') AS anonymous", [`app.${table}`])).rows[0];
        assert.equal(grants.browser, false);
        assert.equal(grants.anonymous, false);
      }
    });
    await t.test("SQL sealing prevents late membership, incomplete promotion and acquisition-age renewal", async () => {
      const c = config(), s = await store.resume(203, c.generation, stamp(), ctx()), observed = stamp();
      await store.page(s, page([{ watchmodeId: 2400000, tmdbId: "981001", popularity: 50 }]), stamp(), ctx());
      await assert.rejects(db.admin.query("INSERT INTO app.watchmode_memberships(sweep_id,page,watchmode_id,tmdb_id,popularity,observed_at) VALUES($1,1,2400001,'981002',50,now())", [s.id]), /Page membership sealed/);
      await assert.rejects(db.admin.query("INSERT INTO app.watchmode_pages(sweep_id,page,total_pages,total_results,row_count,unresolved_count,signature,observed_at) VALUES($1,2,2,251,1,0,$2,now())", [s.id, "0".repeat(64)]), /Sweep sealed/);
      now += 86400000;
      await store.advance("981001", [{ sweepId: s.id, watchmodeId: 2400000 }], "not_found", stamp(), ctx());
      const check = (await db.admin.query("SELECT observed_at,checked_at FROM app.watchmode_enrichment_checks WHERE sweep_id=$1", [s.id])).rows[0];
      assert.equal(check.observed_at.toISOString(), observed);
      assert.equal(check.checked_at.toISOString(), stamp());
      const incomplete = await store.resume(387, c.generation, stamp(), ctx());
      await assert.rejects(db.admin.query("INSERT INTO app.watchmode_sweep_events(sweep_id,outcome,code,observed_at) VALUES($1,'complete','complete',$2)", [incomplete.id, stamp()]), /Incomplete sweep/);
      const permissions = (await db.admin.query("SELECT has_function_privilege('anon','app.check_watchmode_evidence()','EXECUTE') AS anonymous,has_function_privilege('service_role','app.check_watchmode_evidence()','EXECUTE') AS runtime")).rows[0];
      assert.equal(permissions.anonymous, false);
      assert.equal(permissions.runtime, false);
    });
    await t.test("catalog cap stops new enrichment; flagged refresh precedes new candidates without changing UUID", async () => {
      const count = (await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n;
      const capped = providerFixture([1, 1, 1, 1], 990000), c = config({ catalog: count });
      const stopped = await runSweeps(c, capped.options);
      assert.equal(stopped.exitCode, 2);
      assert.equal(stopped.report.code, "catalog_limit");
      assert.equal(capped.detailOrder.length, 0);
      const prior = (await db.admin.query("SELECT m.id,e.external_id FROM app.movies m JOIN app.movie_external_ids e ON e.movie_id=m.id WHERE e.source='tmdb' ORDER BY e.external_id LIMIT 1")).rows[0];
      const refresh = providerFixture([1, 1, 1, 1], 991000);
      const result = await runSweeps({ ...config({ details: 1 }), refreshIds: [prior.external_id] }, refresh.options);
      assert.equal(result.report.persisted, 1);
      assert.deepEqual(refresh.detailOrder, [prior.external_id]);
      const after = (await db.admin.query("SELECT m.id FROM app.movies m JOIN app.movie_external_ids e ON e.movie_id=m.id WHERE e.source='tmdb' AND e.external_id=$1", [prior.external_id])).rows[0];
      assert.equal(after.id, prior.id);
    });
    await t.test("terminal provider failure preserves earlier promoted sets and seals open services", async () => {
      const c = config(), p = providerFixture([0, 0, 0, 0]);
      assert.equal((await runSweeps(c, p.options)).exitCode, 0);
      const original = await store.promoted(c.generation, stamp(), ctx());
      const failed = await runSweeps(c, { ...p.options, watchmode: { ...p.options.watchmode, page: async () => { throw new Error("synthetic-secret-sentinel"); } } });
      assert.equal(failed.exitCode, 1);
      const after = await store.promoted(c.generation, stamp(), ctx());
      assert.deepEqual(after, original);
      const events = (await db.admin.query("SELECT outcome FROM app.watchmode_sweep_events WHERE sweep_id=ANY($1::uuid[])", [failed.report.checkpoint.sweeps.map(s => s.id)])).rows;
      assert.equal(events.length, 4);
      assert.ok(events.every(e => e.outcome === "failed"));
      assert.ok(!JSON.stringify(p.reports).includes("synthetic-secret-sentinel"));
    });
    await t.test("readback catches a real post-write aggregate mismatch and reports committed progress", async () => {
      await db.admin.query(`CREATE FUNCTION app.synthetic_metadata_corruption() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN UPDATE app.movies SET title='Invented corrupted title' WHERE id=NEW.id; RETURN NEW; END $$;
        REVOKE ALL ON FUNCTION app.synthetic_metadata_corruption() FROM PUBLIC,anon,authenticated,service_role;
        CREATE TRIGGER synthetic_metadata_corruption AFTER INSERT ON app.movies FOR EACH ROW EXECUTE FUNCTION app.synthetic_metadata_corruption()`);
      try {
        const p = providerFixture([1, 1, 1, 1], 992000), result = await runSweeps(config({ details: 1 }), p.options);
        assert.equal(result.exitCode, 1);
        assert.equal(result.report.code, "readback_mismatch");
        assert.equal(result.report.persisted, 1);
        assert.equal((p.reports.at(-1) as {
          readback: string;
        }).readback, "failed");
      }
      finally {
        await db.admin.query("DROP TRIGGER synthetic_metadata_corruption ON app.movies; DROP FUNCTION app.synthetic_metadata_corruption()");
      }
    });
    await t.test("crashed running checkpoints become ordered interruptions before a new batch", async () => {
      const c = config(), s = await store.resume(203, c.generation, stamp(), ctx()), id = "10000000-0000-4000-8000-000000000099";
      await store.report({ id, startedAt: stamp(), endedAt: null, outcome: "running", processed: 0, failed: 0, checkpoint: { sweeps: [{ id: s.id }] } }, ctx());
      now++;
      await store.recoverInterrupted(stamp(), ctx());
      assert.equal((await db.admin.query("SELECT code FROM app.watchmode_sweep_events WHERE sweep_id=$1", [s.id])).rows[0].code, "sweep_interrupted");
      assert.equal((await db.admin.query("SELECT outcome FROM app.refresh_runs WHERE id=$1", [id])).rows[0].outcome, "failed");
      assert.notEqual((await store.resume(203, c.generation, stamp(), ctx())).id, s.id);
    });
    await t.test("two-client overlap refuses before status and lock loss/crash releases the session lock", async () => {
      const held = await acquireRefreshLock(db.pool, db.guard, db.signal), p = providerFixture([0, 0, 0, 0]);
      try {
        const result = await runSweeps(config(), p.options);
        assert.equal(result.report.code, "refresh_overlap");
        assert.equal(p.statusCalls, 0);
        assert.equal(p.pageOrder.length, 0);
      }
      finally {
        await held.release();
      }
      let pid = 0;
      const dying = await acquireRefreshLock(db.pool, async (client) => { await db.guard(client); pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; }, db.signal);
      await db.admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await assert.rejects(dying.check(), /refresh_lock_lost/);
      assert.equal(dying.signal.aborted, true);
      await dying.release();
      const recovered = await acquireRefreshLock(db.pool, db.guard, db.signal);
      await recovered.release();
      const wrong = await runSweeps(config(), { ...p.options, guard: localCatalogGuard });
      assert.equal(wrong.report.code, "target_guard");
      assert.equal(p.statusCalls, 0);
    });
  });
});
