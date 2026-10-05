// Operator composition with test-owned files and an inspected disposable target only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import pg from "pg";
import { withDisposable } from "../../tooling/metadata-disposable.ts";
import { liveSweepComposition } from "../../scripts/availability-live.ts";
import { decodeSweepConfig } from "../../src/server/ingestion/sweep-config.ts";

test("live operator composition expires files under lock before providers and refuses cleanup failure", { timeout: 120000 }, async t => {
  await withDisposable(async db => {
    const root = await mkdtemp(join(tmpdir(), "bor-availability-operator-"));
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
        const result = await liveSweepComposition(config, db.signal, io);
        assert.equal(calls, 1);
        assert.deepEqual(result.report.privateCleanup, { inspected: 6, deleted: 3, bounded: false });
        const reports = (await readdir(join(root, ".cache/availability/private"))).filter(name => name !== `evidence-report-${id}.json`);
        assert.equal(reports.length, 1);
        const report = JSON.parse(await readFile(join(root, ".cache/availability/private", reports[0]), "utf8"));
        assert.deepEqual(report.privateCleanup, result.report.privateCleanup);
        assert.equal(report.code, "provider_auth");
        assert(pools.every(pool => pool.ended));
      });
      await t.test("cleanup failure records a fixed code and makes zero provider requests", async () => {
        await writeFile(oldFiles[0], "synthetic malformed JSON");
        calls = 0;
        const result = await liveSweepComposition(config, db.signal, io);
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
