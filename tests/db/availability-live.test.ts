// Operator composition with test-owned files and an inspected disposable target only.
import { operatorCopy } from "./operator-process.ts";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import pg from "pg";
import { withDisposable } from "../../tooling/metadata-disposable.ts";
import { sweepCommand } from "../../scripts/availability-sweeps.ts";
import { liveSweepComposition } from "../../scripts/availability-live.ts";
import { fixtures } from "../../tooling/metadata-fixtures.ts";
import { batchDecision } from "../../scripts/availability-batch.ts";
import { decodeSweepConfig } from "../../src/server/ingestion/sweep-config.ts";

async function operatorRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".cache/availability/private"), { recursive: true });
  await writeFile(join(root, ".cache/availability/private/synthetic.json"), "{}");
  return root;
}
test("live operator composition expires files under lock before providers and refuses cleanup failure", { timeout: 120000 }, async t => {
  await withDisposable(async db => {
    const root = await operatorRoot("bor-availability-operator-");
    const oldFiles: string[] = [], freshFiles: string[] = [];
    const now = Date.now();
    const id = "10000000-0000-4000-8000-000000000001";
    const inventory = [
      ["watchmode-verification", "probe.json", "title-probe.json"],
      ["availability/private", `source-cache-${id}.json`, `evidence-report-${id}.json`],
      ["real-catalog/private", `provider-list-${id}.json`, `run-report-${id}.json`],
    ];
    try {
      for (const [directory, old, fresh] of inventory) {
        const path = join(root, ".cache", directory);
        await mkdir(path, { recursive: true });
        const expired = join(path, old), current = join(path, fresh);
        await writeFile(expired, JSON.stringify({ checkedAt: "2020-01-01T00:00:00Z" }));
        await writeFile(current, JSON.stringify({ checkedAt: new Date(now).toISOString() }));
        oldFiles.push(expired);
        freshFiles.push(current);
      }
      // Backup names must remain outside all cleanup inventories, including size/JSON parsing.
      const backupDirectory = join(root, ".cache/real-catalog/private");
      const backups = [join(backupDirectory, `catalog-backup-${id}.dump`), join(backupDirectory, `catalog-backup-${id}.manifest.json`)];
      await writeFile(backups[0], Buffer.alloc(2097153, 7));
      await writeFile(backups[1], JSON.stringify({ createdAt: "2020-01-01T00:00:00Z", synthetic: true }));
      freshFiles.push(...backups);
      const raw = JSON.parse(await readFile("config/availability-evidence.example.json", "utf8"));
      const config = decodeSweepConfig({ ...raw, generation: "synthetic-operator", terms: { ...raw.terms, accepted: true } });
      let calls = 0;
      const pools: pg.Pool[] = [];
      const io = {
        root, watchmodeKey: async () => "synthetic-watchmode-key", tmdbToken: async () => "synthetic-tmdb-token",
        password: async () => "synthetic-unused-password",
        pool: () => { const pool = new pg.Pool(db.pool.options); pools.push(pool); return pool; },
        guard: db.guard, now: () => now,
        transport: {
          sleep: async () => { },
          fetch: async () => {
            calls++;
            for (const file of oldFiles)
              await assert.rejects(access(file));
            for (const file of freshFiles)
              await access(file);
            // The real PostgreSQL lock must still be held when the provider is called.
            const lock = await db.admin.query("SELECT pg_try_advisory_lock(1112494674,1) AS held");
            assert.equal(lock.rows[0].held, false);
            // Fixed synthetic refusal ends this run after the ordering assertion.
            return new Response("", { status: 401 });
          },
        },
      };
      await t.test("deletion precedes the first provider request and exclusive report counts agree", async () => {
        let result!: Awaited<ReturnType<typeof liveSweepComposition>>;
        const exit = await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], {
          root, read: async () => JSON.stringify({ ...raw, ...config }), output: () => {}, signal: db.signal,
          live: async (c, signal) => { result = await liveSweepComposition(c, signal, io); return result; },
        });
        assert.equal(exit, result.exitCode);
        assert.equal(calls, 1);
        assert.deepEqual(result.report.privateCleanup, { inspected: 6, deleted: 3, bounded: false });
        const reports = (await readdir(join(root, ".cache/availability/private"))).filter(name => name.startsWith("evidence-report-") && name !== `evidence-report-${id}.json`);
        assert.equal(reports.length, 1);
        const report = JSON.parse(await readFile(join(root, ".cache/availability/private", reports[0]), "utf8"));
        assert.deepEqual(report.privateCleanup, result.report.privateCleanup);
        assert.equal(report.code, "provider_auth");
        assert(pools.every(pool => pool.ended));
      });
      await t.test("known older and unknown schemas refuse before cleanup/provider work; overlap refuses", async () => {
        const originalCalls = calls;
        // An inconsistent inventory must never reach cleanup.
        await writeFile(oldFiles[0], "untouched synthetic malformed file");
        const run = async (effects: typeof io) => {
          let result!: Awaited<ReturnType<typeof liveSweepComposition>>;
          const exit = await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], {
            root, read: async () => JSON.stringify({ ...raw, ...config }), output: () => {}, signal: db.signal,
            live: async (c, signal) => { result = await liveSweepComposition(c, signal, effects); return result; },
          });
          assert.equal(exit, 1);
          return result;
        };
        await db.admin.query("CREATE TABLE app.synthetic_unknown(id integer)");
        try { assert.equal((await run(io)).report.code, "upgrade_state_unknown"); }
        finally { await db.admin.query("DROP TABLE app.synthetic_unknown"); }
        assert.equal(await readFile(oldFiles[0], "utf8"), "untouched synthetic malformed file");
        const held = await db.admin.connect();
        try {
          await held.query("SELECT pg_advisory_lock(1112494674,1)");
          assert.equal((await run(io)).report.code, "refresh_overlap");
        }
        finally { await held.query("SELECT pg_advisory_unlock(1112494674,1)"); held.release(); }
        assert.equal(calls, originalCalls);
        assert(pools.every(pool => pool.ended));
      });
      await t.test("database preflight failures do not claim an unknown schema", async () => {
        calls = 0;
        let result!: Awaited<ReturnType<typeof liveSweepComposition>>;
        const effects = { ...io, pool: () => {
          const pool = new pg.Pool(db.pool.options); pools.push(pool);
          pool.on("connect", client => {
            const query = client.query.bind(client);
            Object.defineProperty(client, "query", { value: (...parameters: unknown[]) => {
              if (typeof parameters[0] === "string" && parameters[0].includes("FROM pg_tables"))
                return Promise.reject(Object.assign(new Error("invented_database_sentinel"), { code: "57014" }));
              return Reflect.apply(query, client, parameters);
            }});
          });
          return pool;
        }};
        const exit = await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], {
          root, read: async () => JSON.stringify({ ...raw, ...config }), output: () => {},
          live: async (c, signal) => { result = await liveSweepComposition(c, signal, effects); return result; },
        });
        assert.equal(exit, 1);
        assert.equal(result.report.code, "schema_preflight_failed");
        assert.equal(result.report.privateCleanup, "not_configured");
        assert.equal(calls, 0);
        assert(pools.every(pool => pool.ended));
      });
      await t.test("cleanup failure records a fixed code and makes zero provider requests", async () => {
        await writeFile(oldFiles[0], "synthetic malformed JSON");
        calls = 0;
        let result!: Awaited<ReturnType<typeof liveSweepComposition>>;
        const exit = await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], {
          root, read: async () => JSON.stringify({ ...raw, ...config }), output: () => {}, signal: db.signal,
          live: async (c, signal) => { result = await liveSweepComposition(c, signal, io); return result; },
        });
        assert.equal(exit, result.exitCode);
        assert.equal(result.exitCode, 1);
        assert.equal(result.report.code, "private_cleanup_failed");
        assert.equal(calls, 0);
        assert(pools.every(pool => pool.ended));
      });
    }
    finally {
      const owned = relative(tmpdir(), root);
      assert(!isAbsolute(owned) && !owned.startsWith(".."));
      assert(root.includes("bor-availability-operator-"));
      await rm(root, { recursive: true, force: true });
      await assert.rejects(access(root));
    }
  });
});


test("actual CLI completes, repeats, resumes and cancels synthetic provider work", { timeout: 120000 }, async t => {
  await withDisposable(async db => {
    const root = await operatorRoot("bor-cli-complete-");
    const f = await fixtures();
    const raw = JSON.parse(await readFile("config/availability-evidence.example.json", "utf8"));
    raw.terms.accepted = true;
    raw.generation = "synthetic-cli-complete";
    let now = Date.now(), calls = 0, cancelAtFetch = false;
    const pools: pg.Pool[] = [], output: string[] = [];
    const effects = {
      root, watchmodeKey: async () => "synthetic-watchmode-key", tmdbToken: async () => "synthetic-tmdb-token", password: async () => "synthetic-unused",
      pool: () => { const pool = new pg.Pool(db.pool.options); pools.push(pool); return pool; }, guard: db.guard, now: () => now,
      transport: {
        sleep: async (ms: number) => { now += ms; },
        fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          calls++;
          if (cancelAtFetch) {
            // Exercise the CLI SIGINT listener through the provider's actual abort signal.
            process.emit("SIGINT");
            assert(init?.signal?.aborted);
            throw new Error("invented cancellation sentinel");
          }
          const u = new URL(String(input));
          if (u.hostname === "api.watchmode.com") {
            if (u.pathname.includes("status")) return Response.json({ quota: 2500, quotaUsed: calls });
            if (u.pathname.includes("/sources/")) return Response.json([
              { source_id: 203, type: "sub", region: "US", web_url: "https://www.netflix.com/watch/synthetic" },
              { source_id: 372, type: "sub", region: "US", web_url: "Paid plan required" },
            ]);
            const page = Number(u.searchParams.get("page")), total = raw.generation === "synthetic-cli-partial" ? 251 : 1;
            return Response.json({ page, total_pages: Math.ceil(total / 250), total_results: total,
              titles: Array.from({ length: Math.min(250, total - (page - 1) * 250) }, (_, i) => ({
                id: 1998100 + (page - 1) * 250 + i, tmdb_id: String(998100 + (page - 1) * 250 + i), tmdb_type: "movie", type: "movie", popularity_percentile: 80,
              })) });
          }
          assert.equal(u.hostname, "api.themoviedb.org");
          const id = Number(u.pathname.split("/").at(-1));
          return Response.json({ ...f.raw, id, release_dates: { ...f.raw.release_dates as object, id }, keywords: { ...f.raw.keywords as object, id }, credits: { ...f.raw.credits as object, id }, external_ids: { id, imdb_id: null } });
        },
      },
    };
    async function run() {
      let result!: Awaited<ReturnType<typeof liveSweepComposition>>;
      const exit = await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], {
        root, read: async () => JSON.stringify(raw), output: text => output.push(text), signal: db.signal,
        live: async (config, signal) => { result = await liveSweepComposition(config, signal, effects); return result; },
      });
      assert.equal(exit, result.exitCode);
      assert(pools.every(pool => pool.ended));
      const report = JSON.parse(await readFile(join(root, ".cache/availability/private", `evidence-report-${result.report.runId}.json`), "utf8"));
      assert.equal(report.code, result.report.code);
      assert.equal(report.persisted, result.report.persisted);
      return { ...result, saved: report };
    }
    try {
      await t.test("four-service scan enriches canonical identities and derives uncertain offers/links; repeat has no additions", async () => {
        const before = (await db.admin.query("SELECT count(*)::int n FROM app.movies")).rows[0].n;
        const first = await run();
        assert.equal(first.exitCode, 0, JSON.stringify(first.saved));
        assert.equal(first.saved.readback, "verified");
        assert.equal(first.saved.pages, 4);
        assert.equal(first.saved.persisted, 1);
        assert.equal(first.saved.services.filter((s: { outcome: string }) => s.outcome === "complete").length, 4);
        assert.equal(first.saved.evidenceReadback.active + first.saved.evidenceReadback.retired, before + 1);
        assert.equal((await db.admin.query("SELECT count(*)::int n FROM app.movies")).rows[0].n, before + 1);
        assert(first.saved.evidence.offers > 0);
        assert(first.saved.evidence.links > 0);
        const identity = (await db.admin.query("SELECT movie_id FROM app.movie_external_ids WHERE source='tmdb' AND external_id='998100'")).rows[0].movie_id;
        const second = await run();
        assert.equal(second.exitCode, 0);
        assert.equal(second.saved.persisted, 0);
        assert.equal((await db.admin.query("SELECT movie_id FROM app.movie_external_ids WHERE source='tmdb' AND external_id='998100'")).rows[0].movie_id, identity);
        assert.equal(batchDecision(0, second.saved, first.saved, { runs: 2, attemptedCredits: first.saved.attemptedCredits + second.saved.attemptedCredits, details: first.saved.details + second.saved.details, tmdbAttempts: first.saved.tmdbAttempts + second.saved.tmdbAttempts }).decision, "stop");
        assert(output.at(-1)?.includes("exit=0 code=complete"));
      });
      await t.test("partial scan retains unfinished sweep IDs and committed pages on resume", async () => {
        raw.generation = "synthetic-cli-partial";
        raw.limits.pages = 1;
        const first = await run(), second = await run();
        assert.equal(first.exitCode, 2, JSON.stringify(first.saved));
        assert.equal(first.saved.code, "page_budget");
        assert.deepEqual(second.saved.checkpoint.sweeps.map((s: { id: string }) => s.id), first.saved.checkpoint.sweeps.map((s: { id: string }) => s.id));
        assert.equal(second.saved.services.reduce((n: number, s: { pages: number }) => n + s.pages, 0), 2);
        assert.equal(second.saved.services.filter((s: { outcome: unknown }) => s.outcome === "complete").length, 0);
        assert(output.at(-1)?.includes("exit=2 code=page_budget"));
      });
      await t.test("SIGINT stops the provider signal, reports failure, releases lock and closes owned pools", async () => {
        cancelAtFetch = true;
        const beforeCalls = calls;
        const cancelled = await run();
        assert.equal(cancelled.exitCode, 1);
        assert.equal(cancelled.saved.code, "cancelled");
        assert.equal(calls, beforeCalls + 1);
        assert(!output.join("\n").includes("sentinel"));
        const lock = (await db.admin.query("SELECT pg_try_advisory_lock(1112494674,1) AS held")).rows[0].held;
        assert.equal(lock, true);
        await db.admin.query("SELECT pg_advisory_unlock(1112494674,1)");
      });
    }
    finally { await rm(root, { recursive: true, force: true }); await assert.rejects(access(root)); }
  });
});

test("real older schema refuses live CLI before cleanup and providers", { timeout: 120000 }, async () => {
  await withDisposable(async db => {
    const root = await operatorRoot("bor-cli-older-");
    const raw = JSON.parse(await readFile("config/availability-evidence.example.json", "utf8"));
    raw.terms.accepted = true;
    let calls = 0, result!: Awaited<ReturnType<typeof liveSweepComposition>>;
    const pool = new pg.Pool(db.pool.options);
    try {
      const exit = await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], {
        root, read: async () => JSON.stringify(raw), output: () => {},
        live: async (config, signal) => {
          result = await liveSweepComposition(config, signal, {
            root, pool: () => pool, guard: db.guard, now: Date.now, password: async () => "synthetic",
            watchmodeKey: async () => "synthetic-watchmode-key", tmdbToken: async () => "synthetic-tmdb-token",
            transport: { sleep: async () => {}, fetch: async () => { calls++; throw new Error("must not call"); } },
          });
          return result;
        },
      });
      assert.equal(exit, 1);
      assert.equal(result.report.code, "upgrade_required");
      assert.equal(result.report.privateCleanup, "not_configured");
      assert.equal(calls, 0);
      assert(pool.ended);
    }
    finally { if (!pool.ended) await pool.end(); await rm(root, { recursive: true, force: true }); }
  }, { baseline: "sweeps" });
});


test("SIGINT during locked schema preflight reports cancellation before cleanup/providers", { timeout: 120000 }, async () => {
  await withDisposable(async db => {
    const root = await operatorRoot("bor-cli-preflight-cancel-");
    const raw = JSON.parse(await readFile("config/availability-evidence.example.json", "utf8"));
    raw.terms.accepted = true;
    const pool = new pg.Pool(db.pool.options);
    let calls = 0, signalled = false, result!: Awaited<ReturnType<typeof liveSweepComposition>>;
    pool.on("connect", client => {
      const query = client.query.bind(client);
      Object.defineProperty(client, "query", { value: (...parameters: unknown[]) => {
        if (!signalled && typeof parameters[0] === "string" && parameters[0].includes("FROM pg_tables")) {
          signalled = true;
          process.emit("SIGINT");
        }
        return Reflect.apply(query, client, parameters);
      }});
    });
    try {
      const exit = await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], {
        root, read: async () => JSON.stringify(raw), output: () => {},
        live: async (config, signal) => {
          result = await liveSweepComposition(config, signal, {
            root, pool: () => pool, guard: db.guard, now: Date.now, password: async () => "synthetic",
            watchmodeKey: async () => "synthetic-watchmode-key", tmdbToken: async () => "synthetic-tmdb-token",
            transport: { sleep: async () => {}, fetch: async () => { calls++; throw new Error("must not call"); } },
          });
          return result;
        },
      });
      assert(signalled);
      assert.equal(exit, 1);
      assert.equal(result.report.code, "cancelled");
      assert.equal(result.report.privateCleanup, "not_configured");
      assert.equal(calls, 0);
      assert(pool.ended);
      assert.equal((await db.admin.query("SELECT pg_try_advisory_lock(1112494674,1) AS held")).rows[0].held, true);
      await db.admin.query("SELECT pg_advisory_unlock(1112494674,1)");
    }
    finally { if (!pool.ended) await pool.end(); await rm(root, { recursive: true, force: true }); }
  });
});


test("missing migration seed refuses before cleanup with zero credits and provider calls", { timeout: 120000 }, async () => {
  await withDisposable(async db => {
    const root = await operatorRoot("bor-cli-missing-seed-");
    const raw = JSON.parse(await readFile("config/availability-evidence.example.json", "utf8"));
    raw.terms.accepted = true;
    const expired = join(root, ".cache/availability/private", `source-cache-${randomUUID()}.json`);
    await writeFile(expired, JSON.stringify({ checkedAt: "2020-01-01T00:00:00Z" }));
    // Only this disposable migration owner bypasses guards, then restores all bindings.
    await db.admin.query("ALTER TABLE app.streaming_provider_external_ids DISABLE TRIGGER USER; DELETE FROM app.streaming_provider_external_ids WHERE source='watchmode' AND external_id='203'; ALTER TABLE app.streaming_provider_external_ids ENABLE TRIGGER USER");
    let calls = 0, result!: Awaited<ReturnType<typeof liveSweepComposition>>;
    const pool = new pg.Pool(db.pool.options);
    try {
      const exit = await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], {
        root, read: async () => JSON.stringify(raw), output: () => {}, signal: db.signal,
        live: async (config, signal) => {
          result = await liveSweepComposition(config, signal, {
            root, pool: () => pool, guard: db.guard, now: Date.now, password: async () => "synthetic",
            watchmodeKey: async () => "synthetic-watchmode-key", tmdbToken: async () => "synthetic-tmdb-token",
            transport: { sleep: async () => {}, fetch: async () => { calls++; return new Response("", { status: 401 }); } },
          });
          return result;
        },
      });
      assert.equal(exit, 1);
      assert.equal(result.report.code, "provider_mapping_missing");
      assert.equal(result.report.privateCleanup, "not_configured");
      assert.equal(result.report.attemptedCredits, 0);
      assert.equal(calls, 0);
      await access(expired);
      assert(pool.ended);
    }
    finally { if (!pool.ended) await pool.end(); await rm(root, { recursive: true, force: true }); }
  });
});


test("real live CLI process uses migration seeds and refuses missing mapping without cleanup or spend", { timeout: 120000 }, async () => {
  await withDisposable(async db => {
    const copy = await operatorCopy();
    try {
      const entry = join(copy.root, "scripts/availability-live.ts");
      const source = (await readFile(entry, "utf8")).replaceAll("\r\n", "\n");
      // Replace only default effects in the test copy: invented keys, inspected disposable DB,
      // synthetic empty pages. The production CLI entry and locked preflight remain intact.
      const effects = `export function defaultLiveSweepIO(): LiveSweepIO {
        return { root: repositoryRoot, watchmodeKey: async () => 'synthetic-watchmode-key',
          tmdbToken: async () => 'synthetic-tmdb-token', password: async () => 'synthetic',
          pool: () => new TestPool(${JSON.stringify({ ...db.pool.options, password: db.pool.options.password })}), guard: disposableGuard, now: Date.now,
          transport: { sleep: async () => {}, fetch: async input => {
            await writeFile(join(repositoryRoot,'calls.txt'),'request\\n',{flag:'a'});
            const url = new URL(String(input));
            if (url.pathname.includes('status')) return Response.json({quota:2500,quotaUsed:0});
            return Response.json({page:1,total_pages:0,total_results:0,titles:[]});
          } } };
      }`;
      const composition = /export function defaultLiveSweepIO\(\): LiveSweepIO \{[\s\S]*?\n\}\n/;
      assert(composition.test(source), "synthetic composition must match before launching any process");
      await writeFile(entry, `import { Pool as TestPool } from 'pg';\nimport { disposableGuard } from '../tooling/metadata-disposable.ts';\n` +
        source.replace(composition, () => effects + "\n"));
      const raw = JSON.parse(await readFile("config/availability-evidence.example.json", "utf8"));
      raw.terms.accepted = true;
      const directory = join(copy.root, ".cache/availability/private");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "synthetic.json"), JSON.stringify(raw));
      const args = ["--config", ".cache/availability/private/synthetic.json", "--live"];
      const success = await copy.run("availability-sweeps.ts", args);
      assert.equal(success.code, 0, success.stdout + success.stderr);
      assert.match(success.stdout, /exit=0 code=complete/);
      const calls = await readFile(join(copy.root, "calls.txt"), "utf8");
      assert(calls.length > 0);
      const expired = join(directory, `source-cache-${randomUUID()}.json`);
      await writeFile(expired, JSON.stringify({ checkedAt: "2020-01-01T00:00:00Z" }));
      await db.admin.query("ALTER TABLE app.streaming_provider_external_ids DISABLE TRIGGER USER; DELETE FROM app.streaming_provider_external_ids WHERE source='watchmode' AND external_id='203'; ALTER TABLE app.streaming_provider_external_ids ENABLE TRIGGER USER");
      const refused = await copy.run("availability-sweeps.ts", args);
      assert.equal(refused.code, 1);
      assert.match(refused.stdout, /exit=1 code=provider_mapping_missing/);
      assert.equal(await readFile(join(copy.root, "calls.txt"), "utf8"), calls);
      await access(expired);
      const reports = (await readdir(directory)).filter(name => name.startsWith("evidence-report-"));
      const saved = await Promise.all(reports.map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
      const report = saved.find(value => value.code === "provider_mapping_missing");
      assert.equal(report.attemptedCredits, 0);
      assert.equal(report.privateCleanup, "not_configured");
    }
    finally { await copy.cleanup(); }
  });
});
