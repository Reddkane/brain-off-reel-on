// Independent disposable fixture for review regressions; never retained data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { withDisposable } from "../../tooling/metadata-disposable.ts";
import { fixtures } from "../../tooling/metadata-fixtures.ts";
import { createWatchmode, decodeWatchmodePage, SweepError } from "../../src/server/providers/watchmode.ts";
import { decodeSweepConfig } from "../../src/server/ingestion/sweep-config.ts";
import { runSweeps } from "../../src/server/ingestion/availability-sweeps.ts";
import type { MetadataProvider } from "../../src/server/providers/metadata-provider.ts";
import { tmdbId } from "../../src/server/providers/tmdb-validation.ts";
import { createWatchmodeStore } from "../../src/server/db/watchmode-store.ts";

test("review regressions: isolated service failures, transient enrichment and concurrent personal writes", { timeout: 240000 }, async t => {
  await withDisposable(async db => {
    await db.admin.query(await readFile("supabase/migrations/20261005000001_availability_sweeps.sql", "utf8"));
    const f = await fixtures(), raw = JSON.parse(await readFile("config/availability-sweeps.example.json", "utf8"));
    let now = Date.parse("2026-10-05T00:00:00.000Z"), serial = 0;
    function config() { return decodeSweepConfig({ ...raw, generation: `correction-${++serial}`, terms: { ...raw.terms, accepted: true } }); }
    function setup(totals: number | readonly number[] = 1, base = 1100000,
      fault?: (source: number, page: number) => number | undefined) {
      const calls: number[] = [], reports: unknown[] = [], details: string[] = [];
      const watchmode = createWatchmode("synthetic-watchmode-key", {
        sleep: async ms => { now += ms; }, fetch: async input => {
          const url = new URL(String(input));
          if (url.pathname.includes("status")) return Response.json({ quota: 2500, quotaUsed: calls.length });
          const source = Number(url.searchParams.get("source_ids")), page = Number(url.searchParams.get("page")), index = [203, 387, 372, 157].indexOf(source);
          calls.push(source);
          const failure = fault?.(source, page);
          if (failure) return new Response(null, { status: failure });
          const total = typeof totals === "number" ? totals : totals[index];
          return Response.json({ page, total_pages: Math.ceil(total / 250), total_results: total, titles: Array.from({ length: Math.min(250, total - (page - 1) * 250) }, (_, i) => ({ id: base + index * 1000 + (page - 1) * 250 + i, tmdb_id: String(base + index * 1000 + (page - 1) * 250 + i), tmdb_type: "movie", type: "movie", popularity_percentile: 80 })) });
        }
      });
      const metadata: MetadataProvider = {
        discover: async () => { throw new Error("discovery must remain unused"); }, getMovie: async key => {
          details.push(key.externalId);
          return { status: "ok", value: { ...f.movie, keys: [{ source: "tmdb", externalId: tmdbId(key.externalId) }], checkedAt: new Date(now).toISOString() }, issues: [] };
        }
      };
      return { calls, reports, details, options: { pool: db.pool, guard: db.guard, watchmode, metadata, now: () => now, signal: db.signal, writeReport: async (report: unknown) => { reports.push(report); } } };
    }
    await t.test("a malformed service fails locally while the other three promote and enrich", async () => {
      const c = config(), p = setup(), original = p.options.watchmode;
      const result = await runSweeps(c, {
        ...p.options, watchmode: {
          ...original, page: async (source, page, context) => {
            if (source === 387) throw new SweepError("totals_changed"); return original.page(source, page, context);
          }
        }
      });
      assert.equal(result.exitCode, 2); assert.equal(result.report.persisted, 3);
      const events = (await db.admin.query("SELECT s.source_id,e.outcome FROM app.watchmode_sweeps s JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id WHERE s.generation=$1", [c.generation])).rows;
      assert.equal(events.filter(e => e.outcome === "complete").length, 3);
      assert.equal(events.find(e => e.source_id === 387)?.outcome, "failed");
    });
    await t.test("one transient detail failure is partial and successful peers persist", async () => {
      const c = config(), p = setup(1, 1110000), original = p.options.metadata; let first = true;
      const result = await runSweeps(c, {
        ...p.options, metadata: {
          ...original, getMovie: async (key, context) => {
            if (first) { first = false; return { status: "failed", code: "http", retryable: true }; } return original.getMovie(key, context);
          }
        }
      });
      assert.equal(result.exitCode, 2); assert.equal(result.report.persisted, 3); assert.equal(result.report.failed, 1);
    });
    await t.test("a real concurrent rating insert does not fail the refresh", async () => {
      const c = config(), p = setup(1, 1120000), original = p.options.metadata; let written = false;
      const result = await runSweeps(c, {
        ...p.options, metadata: {
          ...original, getMovie: async (key, context) => {
            if (!written) { written = true; await db.admin.query("INSERT INTO app.profile_movies(profile_id,movie_id) VALUES('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002')"); }
            return original.getMovie(key, context);
          }
        }
      });
      assert.equal(result.exitCode, 0); assert.equal(result.report.persisted, 4);
    });
    await t.test("not-found titles back off across fresh daily sweep memberships", async () => {
      const c = config(), p = setup(1, 1130000); let attempts = 0;
      const options = { ...p.options, metadata: { ...p.options.metadata, getMovie: async () => { attempts++; return { status: "not_found" as const }; } } };
      await runSweeps(c, options); assert.equal(attempts, 4);
      now += 86400000; await runSweeps(c, options); assert.equal(attempts, 4);
      now += 7 * 86400000; await runSweeps(c, options); assert.equal(attempts, 8);
    });
    await t.test("combined overflow does not cache a service-level capacity block", async () => {
      const c = config(), p = setup(4000, 1140000);
      const first = await runSweeps(c, p.options); assert.equal(first.exitCode, 2);
      const spent = p.calls.length;
      await runSweeps(c, p.options);
      assert.ok(p.calls.length > spent, "aggregate overflow must allow a fresh run");
    });
    await t.test("asymmetric aggregate overflow never freezes all services for a month", async () => {
      const c = config(), p = setup([12500, 1500, 1000, 1250], 1300000);
      const result = await runSweeps(c, p.options);
      assert.equal(result.exitCode, 2);
      assert.equal(result.report.code, "combined_page_limit");
      const store = createWatchmodeStore(db.pool, db.guard);
      assert.deepEqual(await store.capacityBlocked(c.generation, new Date(now).toISOString(),
        { signal: db.signal, deadline: Date.now() + 10000 }), []);
      const spent = p.calls.length;
      await runSweeps(c, p.options);
      assert.ok(p.calls.length > spent);
    });
    await t.test("a single service over 60 pages blocks only itself while peers continue", async () => {
      const c = config(), p = setup([15001, 1, 1, 1], 1320000);
      const first = await runSweeps(c, p.options);
      assert.equal(first.exitCode, 2); assert.equal(first.report.persisted, 3);
      const spent = p.calls.filter(source => source === 203).length;
      await runSweeps(c, p.options);
      assert.equal(p.calls.filter(source => source === 203).length, spent);
      assert.equal(p.calls.filter(source => source === 157).length, 2);
      now += 31 * 86400000;
      await runSweeps(c, p.options);
      assert.ok(p.calls.filter(source => source === 203).length > spent,
        "cached refusals must not renew a single-service finding");
    });
    await t.test("a 503 burst at page eleven preserves ten pages and resumes at eleven", async () => {
      let broken = true;
      const c = config(), p = setup([3750, 0, 0, 0], 1340000,
        (source, page) => broken && source === 203 && page === 11 ? 503 : undefined);
      const first = await runSweeps(c, p.options);
      assert.equal(first.exitCode, 2);
      assert.equal(p.calls.filter(source => source === 203).length, 13);
      const saved = (await db.admin.query(`SELECT s.id,e.outcome,
        (SELECT count(*)::int FROM app.watchmode_pages p WHERE p.sweep_id=s.id) AS pages
        FROM app.watchmode_sweeps s LEFT JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id
        WHERE s.generation=$1 AND s.source_id=203`, [c.generation])).rows[0];
      assert.equal(saved.outcome, null); assert.equal(saved.pages, 10);
      broken = false;
      const spent = p.calls.length;
      await runSweeps({ ...c, limits: { ...c.limits, details: 1 } }, p.options);
      assert.equal(p.calls.length - spent, 5);
      assert.equal((await db.admin.query("SELECT outcome FROM app.watchmode_sweep_events WHERE sweep_id=$1", [saved.id])).rows[0].outcome, "complete");
    });
    await t.test("throttling stops on one service without sealing or calling peers", async () => {
      const c = config(), p = setup(1, 1360000, () => 429);
      const result = await runSweeps(c, p.options);
      assert.equal(result.exitCode, 2);
      assert.equal(p.calls.length, 1);
      assert.equal((await db.admin.query(`SELECT count(*)::int AS n FROM app.watchmode_sweep_events e
        JOIN app.watchmode_sweeps s ON s.id=e.sweep_id WHERE s.generation=$1`, [c.generation])).rows[0].n, 0);
    });
    await t.test("a due catalog title absent from all services backs off after a TMDB 404", async () => {
      const c = config(), p = setup(0, 1380000);
      await db.admin.query(`INSERT INTO app.movie_external_ids(movie_id,source,external_id)
        VALUES('30000000-0000-4000-8000-000000000005','tmdb','1389999')`);
      await db.admin.query(`UPDATE app.movies SET metadata_refreshed_at=$1
        WHERE id='30000000-0000-4000-8000-000000000005'`, [new Date(now - 200 * 86400000).toISOString()]);
      const attempted: string[] = [];
      const options = {
        ...p.options, metadata: {
          ...p.options.metadata, getMovie: async (key: { externalId: string }) => {
            attempted.push(key.externalId); return { status: "not_found" as const };
          }
        }
      };
      await runSweeps(c, options);
      assert.equal(attempted.filter(id => id === "1389999").length, 1);
      now += 86400000;
      await runSweeps(c, options);
      assert.equal(attempted.filter(id => id === "1389999").length, 1);
      now += 7 * 86400000;
      await runSweeps(c, options);
      assert.equal(attempted.filter(id => id === "1389999").length, 2);
    });
    await t.test("an identified non-movie is excluded while Hulu still promotes its movies", async () => {
      const c = config(), p = setup(1, 1400000), original = p.options.watchmode;
      const result = await runSweeps(c, {
        ...p.options, watchmode: {
          ...original, page: async (source, page, context) => source !== 157 ? original.page(source, page, context) :
            decodeWatchmodePage({
              page: 1, total_pages: 1, total_results: 2, titles: [
                { id: 1403000, type: "movie", tmdb_type: "movie", tmdb_id: "1403000" },
                { id: 1403001, type: "tv_series", tmdb_type: "tv", tmdb_id: "1403001" },
              ]
            }, 1, new Date(now).toISOString()),
        }
      });
      assert.equal(result.exitCode, 0); assert.equal(result.report.persisted, 4);
      assert.equal((await db.admin.query(`SELECT e.outcome FROM app.watchmode_sweep_events e
        JOIN app.watchmode_sweeps s ON s.id=e.sweep_id WHERE s.generation=$1 AND source_id=157`, [c.generation])).rows[0].outcome, "complete");
      const hulu = result.report.checkpoint.sweeps.find(s => s.source === 157);
      assert.equal((await db.admin.query("SELECT excluded_count FROM app.watchmode_pages WHERE sweep_id=$1", [hulu?.id])).rows[0].excluded_count, 1);
    });
    await t.test("successive pages containing only identified non-movies are not mistaken for stalled pages", async () => {
      const c = config(), p = setup(0, 1420000), original = p.options.watchmode;
      const result = await runSweeps(c, {
        ...p.options, watchmode: {
          ...original, page: async (source, page, context) => source !== 203 ? original.page(source, page, context) :
            decodeWatchmodePage({
              page, total_pages: 2, total_results: 251,
              titles: Array.from({ length: page === 1 ? 250 : 1 }, (_, index) => ({
                id: 1420000 + (page - 1) * 250 + index, type: "tv_series",
              })),
            }, page, new Date(now).toISOString()),
        }
      });
      assert.equal(result.exitCode, 0);
      const netflix = result.report.checkpoint.sweeps.find(s => s.source === 203);
      assert.ok(netflix?.complete);
    });
    for (const [index, code] of (["page_conflict", "page_nonadvancing"] as const).entries()) {
      await t.test(`${code} seals only the offending service`, async () => {
        const c = config(), p = setup(1, 1430000 + index * 10000), original = p.options.watchmode;
        const result = await runSweeps(c, {
          ...p.options, watchmode: {
            ...original, page: async (source, page, context) => {
              if (source === 387) throw new SweepError(code);
              return original.page(source, page, context);
            },
          }
        });
        assert.equal(result.exitCode, 2);
        assert.equal(result.report.persisted, 3);
      });
    }
    await t.test("page membership insertion is one bounded SQL statement per page", async () => {
      const c = config(), p = setup(250, 1150000), seen = new WeakSet<PoolClient>(); let inserts = 0;
      const guard = async (client: PoolClient) => {
        await db.guard(client);
        if (seen.has(client)) return; seen.add(client);
        const original = client.query.bind(client);
        client.query = ((...args: Parameters<PoolClient["query"]>) => {
          if (typeof args[0] === "string" && args[0].startsWith("INSERT INTO app.watchmode_memberships")) inserts++;
          return original(...args);
        }) as PoolClient["query"];
      };
      const result = await runSweeps({ ...c, limits: { ...c.limits, details: 1 } }, { ...p.options, guard });
      assert.notEqual(result.exitCode, 1); assert.equal(inserts, 4);
    });
    await t.test("superseded live batches have an explicit interruption reason", async () => {
      const store = createWatchmodeStore(db.pool, db.guard), c = config(), context = { signal: db.signal, deadline: Date.now() + 10000 };
      const old = await store.resume(203, c.generation, new Date(now).toISOString(), context); now++;
      await store.resume(387, c.generation, new Date(now).toISOString(), context);
      await store.batch(c.generation, new Date(now).toISOString(), context);
      assert.equal((await db.admin.query("SELECT outcome FROM app.watchmode_sweep_events WHERE sweep_id=$1", [old.id])).rows[0].outcome, "superseded");
    });
    await t.test("an unidentified membership preserves valid rows but cannot promote absence evidence", async () => {
      const c = config(), p = setup(1, 1170000), original = p.options.watchmode;
      const result = await runSweeps(c, {
        ...p.options, watchmode: {
          ...original, page: async (source, page, context) => {
            if (source !== 387) return original.page(source, page, context);
            return decodeWatchmodePage({
              page: 1, total_pages: 1, total_results: 2, titles: [
                { id: 1171000, tmdb_id: "1171000", tmdb_type: "movie", type: "movie", popularity_percentile: 80 },
                { id: null, type: "movie" },
              ]
            }, 1, new Date(now).toISOString());
          }
        }
      });
      assert.equal(result.exitCode, 2); assert.equal(result.report.persisted, 3);
      const rows = (await db.admin.query(`SELECT e.outcome,e.code,
        (SELECT count(*)::int FROM app.watchmode_memberships m WHERE m.sweep_id=s.id) AS members
        FROM app.watchmode_sweeps s JOIN app.watchmode_sweep_events e ON e.sweep_id=s.id
        WHERE s.generation=$1 AND s.source_id=387`, [c.generation])).rows;
      assert.deepEqual(rows, [{ outcome: "failed", code: "membership_incomplete", members: 1 }]);
      await assert.rejects(db.admin.query(`INSERT INTO app.watchmode_sweep_events(sweep_id,outcome,code,observed_at)
        SELECT id,'complete','complete',$2 FROM app.watchmode_sweeps WHERE generation=$1 AND source_id=387`, [c.generation, new Date(now).toISOString()]), /Incomplete sweep/);
    });
    await t.test("authentication remains a global failure before any peer requests", async () => {
      const c = config(), p = setup(1, 1180000);
      const result = await runSweeps(c, { ...p.options, watchmode: { ...p.options.watchmode, page: async () => { throw new SweepError("provider_auth"); } } });
      assert.equal(result.exitCode, 1); assert.equal(p.calls.length, 0); assert.equal(result.report.persisted, 0);
    });
    await t.test("a detail authentication error is fatal even without a provider stop flag", async () => {
      const c = config(), p = setup(1, 1190000);
      const result = await runSweeps(c, {
        ...p.options, metadata: {
          ...p.options.metadata, getMovie: async () => ({ status: "failed", code: "auth", retryable: false }),
        }
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.report.code, "provider_auth");
      assert.equal(result.report.details, 1);
    });
    await t.test("overdue refreshes respect retained not-found backoff", async () => {
      const c = config(), p = setup(1, 1200000);
      await runSweeps(c, p.options);
      await db.admin.query(`UPDATE app.movies SET metadata_refreshed_at=$1
        WHERE id IN (SELECT movie_id FROM app.movie_external_ids
        WHERE source='tmdb' AND external_id IN ('1200000','1201000','1202000','1203000'))`,
        ["2026-05-01T00:00:00.000Z"]);
      let attempts = 0;
      const options = {
        ...p.options, metadata: {
          ...p.options.metadata, getMovie: async () => { attempts++; return { status: "not_found" as const }; },
        }
      };
      await runSweeps(c, options);
      assert.equal(attempts, 4);
      now += 86400000;
      await runSweeps(c, options);
      assert.equal(attempts, 4);
    });
    const pagingCases = ["provider_transient", "provider_throttled", "credit_budget", "combined_page_limit", "provider_auth"] as const;
    for (const [index, code] of pagingCases.entries()) {
      const globalFailure = code === "provider_auth";
      await t.test(`${code}: ${globalFailure ? "skips" : "preserves"} enrichment from a previously promoted title`, async () => {
        const c = config(), base = 1500000 + index * 20000;
        const p = setup(code === "combined_page_limit" ? [12500, 1500, 1000, 1250] : 1, base);
        const store = createWatchmodeStore(db.pool, db.guard);
        const context = { signal: db.signal, deadline: Date.now() + 10000 };
        const observed = new Date(now).toISOString(), externalId = String(base + 18000);
        const prior = await store.resume(203, c.generation, observed, context);
        await store.page(prior, decodeWatchmodePage({
          page: 1, total_pages: 1, total_results: 1,
          titles: [{ id: base + 18000, tmdb_id: externalId, type: "movie", tmdb_type: "movie" }],
        }, 1, observed), observed, context);
        const options = code === "combined_page_limit" ? p.options : {
          ...p.options,
          watchmode: { ...p.options.watchmode, page: async () => { throw new SweepError(code); } },
        };
        const result = await runSweeps(c, options);
        assert.equal(result.exitCode, globalFailure ? 1 : 2);
        assert.equal(result.report.code, code);
        assert.equal(result.report.persisted, globalFailure ? 0 : 1);
        assert.deepEqual(p.details, globalFailure ? [] : [externalId]);
        if (code === "provider_transient") {
          // The original paging cause must remain recognizable to hosting even
          // when independent TMDB work also ends partially.
          const failedOptions = {
            ...options, metadata: {
              ...options.metadata,
              getMovie: async () => ({ status: "failed" as const, code: "network" as const, retryable: true }),
            }
          };
          const failed = await runSweeps({ ...c, refreshIds: [externalId] }, failedOptions);
          assert.equal(failed.exitCode, 2);
          assert.equal(failed.report.failed, 1);
          assert.equal(failed.report.code, "provider_transient");
        }
      });
    }
  });
});
