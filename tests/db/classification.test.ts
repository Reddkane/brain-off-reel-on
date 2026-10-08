import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withDisposable } from "../../tooling/metadata-disposable.ts";
import { createClassificationStore } from "../../src/server/db/classification-store.ts";
import { decodeHuman } from "../../src/server/classification/files.ts";
import { decodeSnapshot } from "../../src/server/classification/files.ts";
import { createPgStore } from "../../src/server/db/pg-store.ts";
import { ingestAnchorIds } from "../../src/server/ingestion/anchor-metadata.ts";
import { fixtures } from "../../tooling/metadata-fixtures.ts";
import { movieId } from "../../src/server/providers/tmdb-validation.ts";
import { fields } from "../../src/domain/classification.ts";
import { coverage } from "../../src/domain/classification-reports.ts";
import { catalogSchemaState } from "../../scripts/catalog-schema.ts";
import { operatorCopy } from "./operator-process.ts";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createWatchmodeStore } from "../../src/server/db/watchmode-store.ts";
import { createEvidenceStore } from "../../src/server/db/availability-evidence-store.ts";
test("classification migration: real same-movie parents and operator-only human labels", { timeout: 240000 }, async t => {
  await withDisposable(async db => {
    const movie = "30000000-0000-4000-8000-000000000001";
    async function insert(kind: string, parent: string | null = null, version: unknown = "classification-evidence-v1") {
      const id = randomUUID();
      await db.admin.query(`INSERT INTO app.movie_classifications(id,movie_id,rubric_version,field_provenance,field_uncertainty,input_evidence,input_fingerprint,review_status,subject_classification_id)
        VALUES($1,$2,'low-brain-v1','{}','{}',$3,'synthetic','unreviewed',$4)`, [id, movie, JSON.stringify({ version, kind }), parent]);
      return id;
    }
    await t.test("model insert succeeds; missing parent for review fails", async () => {
      await insert("model");
      await assert.rejects(insert("human_review"), { code: "23514" });
    });
    await t.test("nonexistent model parent fails with FK", async () => {
      await assert.rejects(insert("human_review", randomUUID()), { code: "23503" });
    });
    await t.test("null/unknown envelope version is denied", async () => {
      await assert.rejects(insert("model", null, null), { code: "23514" });
      await assert.rejects(insert("model", null, "invented"), { code: "23514" });
    });
    await t.test("authenticated identities see model but no anchor or review rows", async () => {
      const model = await insert("model"), anchor = await insert("human_anchor"), review = await insert("human_review", model);
      const client = await db.admin.connect();
      try {
        for (const account of [randomUUID(), randomUUID()]) {
          await client.query("BEGIN; SET LOCAL ROLE authenticated");
          await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [account]);
          const ids = (await client.query("SELECT id FROM app.movie_classifications WHERE id=ANY($1::uuid[])", [[model, anchor, review]])).rows.map(r => r.id);
          assert.deepEqual(ids, [model]); await client.query("ROLLBACK");
        }
      } finally { await client.query("ROLLBACK"); client.release(); }
    });
    await t.test("production anchor import appends and identical reimport is inert", async () => {
      const capability = Object.freeze({});
      const store = createClassificationStore({ pool: db.pool, guard: db.guard, capability });
      const labels = { narrative_complexity: 1, attention_demand: 1, emotional_burden: 1, on_screen_text_dependence: 0 };
      const document = decodeHuman({ version: "classification-anchors-v1", rubric: "low-brain-v1", rows: [{ movie_id: movie, tmdb_id: null, scores: labels,
        uncertainty: Object.fromEntries(Object.keys(labels).map(f => [f, "low"])), note: "synthetic private note" }] }, "human_anchor");
      const context = { signal: db.signal, deadline: Date.now() + 10000 };
      assert.deepEqual(await store.appendHuman(capability, document, context), { inserted: 1, unchanged: 0 });
      assert.deepEqual(await store.appendHuman(capability, document, context), { inserted: 0, unchanged: 1 });
    });
  });
});
test("classification production paths: metadata-only creation, effective reviews and real CLI processes", { timeout: 240000 }, async t => {
  await withDisposable(async db => {
    const capability = Object.freeze({}), metadata = createPgStore({ pool: db.pool, checkoutGuard: db.guard, catalogCapability: capability, operators: [] });
    const store = createClassificationStore({ pool: db.pool, guard: db.guard, capability }), f = await fixtures();
    const personalBefore = (await db.admin.query("SELECT count(*)::int AS n FROM app.profile_movies")).rows[0].n;
    assert.equal(personalBefore, 0);
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n, 0);
    const ctx = () => ({ signal: db.signal, deadline: Date.now() + 10000 });
    const ids = { version: "classification-anchor-ids-v1", ids: ["990001"] };
    const provider = { discover: f.provider.discover, getMovie: async (key: Parameters<typeof f.provider.getMovie>[0], context: Parameters<typeof f.provider.getMovie>[1]) => {
      context.budget.attempts++; return { status: "ok" as const, value: { ...f.movie, title: "Synthetic anchor creation", keys: [key] }, issues: [] };
    } };
    const created = await ingestAnchorIds({ ids, provider, store: metadata, capability, storeContext: ctx(), context: { now: Date.now, signal: db.signal, budget: { attempts: 0, maxAttempts: 100, stopped: false, deadline: Date.now() + 60000 } } });
    assert.equal(created.inserted, 1); assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM app.profile_movies")).rows[0].n, personalBefore);
    const id = movieId(created.additions[0]), prepared = await store.input(capability, id, ctx());
    assert(!JSON.stringify(prepared).includes("rating"));
    const labels = { narrative_complexity: 1, attention_demand: 1, emotional_burden: 1, on_screen_text_dependence: 0 };
    const concurrentAnchor = decodeHuman({ version: "classification-anchors-v1", rubric: "low-brain-v1", rows: [{ movie_id: id, tmdb_id: null,
      scores: { ...labels, narrative_complexity: 2 }, uncertainty: Object.fromEntries(Object.keys(labels).map(k => [k, "low"])) }] }, "human_anchor");
    const holder = await db.admin.connect();
    const waiters: Promise<{ inserted: number; unchanged: number }>[] = [];
    try {
      await holder.query("SELECT pg_advisory_lock(730007)");
      waiters.push(store.appendHuman(capability, concurrentAnchor, ctx()), store.appendHuman(capability, concurrentAnchor, ctx()));
      const deadline = Date.now() + 1500;
      let waiting = 0;
      while (Date.now() < deadline) {
        waiting = (await db.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'")).rows[0].n;
        if (waiting === 2) break; await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(waiting, 2, "both real imports must wait at the serialization gate");
    } finally { await holder.query("SELECT pg_advisory_unlock(730007)"); holder.release(); }
    const writes = await Promise.all(waiters);
    assert.equal(writes.reduce((n, w) => n + w.inserted, 0), 1, "concurrent reimport must not append duplicate judgments");
    assert.equal(writes.reduce((n, w) => n + w.unchanged, 0), 1);
    const evidenceStore = createEvidenceStore(createWatchmodeStore(db.pool, db.guard));
    await t.test("availability readback agrees with human-only classification coverage", async () => {
      const at = new Date().toISOString();
      const report = coverage(await store.snapshot(capability, at, "synthetic", ctx()), at);
      const readback = await evidenceStore.readback(at, ctx());
      assert.equal(report.humanOnly, 1); assert.equal(report.unclassified, 1);
      assert.equal(readback.preClassification.unclassified, report.unclassified);
      assert.equal(readback.classified, 0);
    });
    const output = { ...labels, pacing: "moderate", tone: ["warm"], content_tags: [], field_provenance: Object.fromEntries(fields.map(k => [k, { basis: ["model_prior_knowledge"], evidence_refs: [] }])), field_uncertainty: Object.fromEntries(fields.map(k => [k, "medium"])) };
    const model = await store.appendModel(capability, id, output, "synthetic", prepared.fingerprint, ctx());
    await t.test("availability readback counts a model movie once, excluding its anchors", async () => {
      const readback = await evidenceStore.readback(new Date().toISOString(), ctx());
      assert.equal(readback.preClassification.unclassified, 0); assert.equal(readback.classified, 1);
    });
    const inspection = await db.admin.connect();
    try { assert.equal(await catalogSchemaState(inspection), 7); } finally { inspection.release(); }
    const copy = await operatorCopy();
    try {
      const privateRoot = join(copy.root, ".cache/classification/private"); await mkdir(privateRoot, { recursive: true });
      // Copied trusted composition: ephemeral test credentials never enter console output.
      const connection = { host: db.pool.options.host, port: db.pool.options.port, database: db.pool.options.database, user: db.pool.options.user,
        password: db.pool.options.password, max: 2, connectionTimeoutMillis: 5000, query_timeout: 10000, allowExitOnIdle: true };
      await writeFile(join(copy.root, "scripts/classification-effects.ts"), `
        import pg from 'pg'; import { createClassificationStore } from '../src/server/db/classification-store.ts';
        import { disposableGuard } from '../tooling/metadata-disposable.ts';
        export async function classificationEffects() { const pool = new pg.Pool(${JSON.stringify(connection)}); const capability = {};
          return { store:createClassificationStore({pool,guard:disposableGuard,capability}), capability, modelId:'synthetic', close:()=>pool.end() }; }
      `);
      const anchor = { version: "classification-anchors-v1", rubric: "low-brain-v1", rows: [{ movie_id: id, tmdb_id: null, scores: labels,
        uncertainty: Object.fromEntries(Object.keys(labels).map(k => [k, "low"])), note: "SYNTHETIC_PRIVATE_NOTE" }] };
      await writeFile(join(privateRoot, "anchors.json"), JSON.stringify(anchor));
      for (let i = 0; i < 2; i++) assert.equal((await copy.run("classification.ts", ["anchors-import", "--input", join(privateRoot, "anchors.json"), "--apply"])).code, 0);
      async function applyReview(action: "accept" | "defer") {
        const now = new Date().toISOString();
        await writeFile(join(privateRoot, "reviews.json"), JSON.stringify({ version: "classification-reviews-v1", rubric: "low-brain-v1", rows: [{ movie_id: id, tmdb_id: null, parent_id: model, action, scores: labels,
          uncertainty: Object.fromEntries(Object.keys(labels).map(k => [k, "low"])), evidence: Object.fromEntries(["narrative_complexity", "attention_demand"].map(k => [k, { type: "detailed_synopsis", reference: "synthetic:evidence", checkedAt: now, expiresAt: null }])) }] }));
        const result = await copy.run("classification.ts", ["reviews-import", "--input", join(privateRoot, "reviews.json"), "--apply"]);
        assert.equal(result.code, 0, result.stdout); assert.equal(result.stderr, "");
        const at = new Date().toISOString(), snapshot = decodeSnapshot(await store.snapshot(capability, at, "synthetic", ctx()));
        assert.equal(coverage(snapshot, at).effectivePassing, action === "accept" ? 1 : 0);
      }
      await applyReview("accept"); await applyReview("defer"); await applyReview("accept");
      await t.test("review import diagnoses legacy and malformed parents without appending", async parentTest => {
        for (const envelope of [{}, { version: "classification-evidence-v1", kind: "model", availablePaths: [], action: null, evidence: {}, evidenceExpiresAt: null }]) {
          await parentTest.test(Object.hasOwn(envelope, "version") ? "malformed model parent" : "legacy parent", async () => {
          const parent = randomUUID();
          await db.admin.query(`INSERT INTO app.movie_classifications(id,movie_id,rubric_version,field_provenance,field_uncertainty,input_evidence,input_fingerprint,review_status)
            VALUES($1,$2,'low-brain-v1','{}','{}',$3,'synthetic','unreviewed')`, [parent, id, JSON.stringify(envelope)]);
          const review = JSON.parse(await readFile(join(privateRoot, "reviews.json"), "utf8")); review.rows[0].parent_id = parent;
          await writeFile(join(privateRoot, "bad-parent.json"), JSON.stringify(review));
          const before = (await db.admin.query("SELECT count(*)::int AS n FROM app.movie_classifications")).rows[0].n;
          const result = await copy.run("classification.ts", ["reviews-import", "--input", join(privateRoot, "bad-parent.json"), "--apply"]);
          assert.equal(result.code, 1); assert.match(result.stdout, /code=review_parent_invalid/); assert.equal(result.stderr, "");
          assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM app.movie_classifications")).rows[0].n, before);
          });
        }
      });
      const at = new Date().toISOString();
      const result = await copy.run("classification.ts", ["export", "--as-of", at, "--read-local", "--output", join(privateRoot, "snapshot.json")]);
      assert.equal(result.code, 0, result.stdout);
      assert(!(await readFile(join(privateRoot, "snapshot.json"), "utf8")).includes("SYNTHETIC_PRIVATE_NOTE"));
      for (const action of ["agreement", "coverage"]) {
        const report = await copy.run("classification.ts", [action, "--input", join(privateRoot, "snapshot.json"), "--as-of", at, "--write-report", "--output", join(privateRoot, `${action}.json`)]);
        assert.equal(report.code, 0, report.stdout);
      }
      const invalid = structuredClone(anchor); invalid.rows.push({ ...invalid.rows[0], movie_id: movieId(randomUUID()) });
      invalid.rows[0].scores.narrative_complexity = 2;
      await writeFile(join(privateRoot, "invalid-import.json"), JSON.stringify(invalid));
      const before = (await db.admin.query("SELECT count(*)::int AS n FROM app.movie_classifications")).rows[0].n;
      assert.equal((await copy.run("classification.ts", ["anchors-import", "--input", join(privateRoot, "invalid-import.json"), "--apply"])).code, 1);
      assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM app.movie_classifications")).rows[0].n, before);
    } finally { await copy.cleanup(); }
  }, { fixtures: false });
});
test("six-to-seven classification upgrade preserves actual legacy rows", { timeout: 240000 }, async () => {
  await withDisposable(async db => {
    const before = (await db.admin.query("SELECT id,to_jsonb(c) AS row FROM app.movie_classifications c ORDER BY id")).rows;
    assert(before.length > 0); await db.upgrade();
    const after = (await db.admin.query("SELECT id,to_jsonb(c)-'subject_classification_id' AS row FROM app.movie_classifications c ORDER BY id")).rows;
    assert.deepEqual(after, before);
  }, { baseline: "classification" });
});
