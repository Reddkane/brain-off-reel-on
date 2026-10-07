// Isolated synthetic resources only. This file alone owns destructive cleanup.
import { operatorCopy } from "./operator-process.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { readFile, writeFile, mkdtemp, unlink, rmdir, access, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backupCatalog, identityDigestSql, sameIdentity, verifyBackup } from "../../scripts/catalog-backup.ts";
import { expirePrivateEvidence } from "../../src/server/ingestion/private-evidence-cleanup.ts";
import { withDisposable, docker as disposableDocker } from "../../tooling/metadata-disposable.ts";
import { catalogPool, completedSetup, createCatalogContainer, docker, inspectCatalog, localCommand, ready, refuseCollisions, setupSchema, upgradeSchema } from "../../scripts/catalog-local.ts";
import { catalogCommand } from "../../scripts/catalog-import.ts";
import type { CatalogIO } from "../../scripts/catalog-import.ts";
import { decodePassword, privateJson, firstImportLimits, subscriptions } from "../../scripts/catalog-config.ts";
import { localCatalogGuard, readCatalog } from "../../src/server/db/local-catalog-target.ts";
import { acquireRefreshLock } from "../../src/server/db/refresh-lock.ts";
import { createPgStore } from "../../src/server/db/pg-store.ts";
import { fixtures } from "../../tooling/metadata-fixtures.ts";
import { catalogSchemaState, currentMigrationCount, currentTables } from "../../scripts/catalog-schema.ts";
import { migrationFiles } from "../../src/server/db/migration-files.ts";
test("catalog schema detection covers every migration", async () => {
  assert.equal(currentMigrationCount, (await migrationFiles()).length,
    "A migration was added; update catalogSchemaState detection and currentMigrationCount.");
});

async function unusedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address &&
    typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
test("catalog focused SQL/composition and A1 persistence acceptance", {
  timeout: 240000
}, async (t) => {
  const token = randomBytes(12).toString("hex"), label = `bor.catalog.test=${token}`;
  const resources = {
    container: `bor-catalog-test-${token}`,
    volume: `bor-catalog-test-${token}-data`,
    network: `bor-catalog-test-${token}-net`,
    port: await unusedPort(),
    label
  };
  const adminPassword = randomBytes(32).toString("hex"), runtimePassword = randomBytes(32).toString("hex");
  let id = "", volumeCreated = false, networkCreated = false;
  const trackedDocker = async (args: string[], input?: string) => {
    const result = await docker(args, input);
    if (args[0] === "run" &&
      /^[a-f0-9]{64}$/.test(result))
      id = result;
    return result;
  };
  const pools: pg.Pool[] = [];
  const pool = (admin = false) => { const p = catalogPool(admin ? adminPassword : runtimePassword, resources.port, admin); pools.push(p); return p; };
  try {
    console.log(`Synthetic catalog acceptance resources: ${resources.container} ${resources.volume}`);
    await docker(["version", "--format", "{{.Server.Version}}"]);
    await refuseCollisions(resources);
    await docker(["volume", "create", "--label", label, resources.volume]);
    volumeCreated = true;
    await docker(["network", "create", "--driver", "bridge", "--label", label, resources.network]);
    networkCreated = true;
    id = await createCatalogContainer(resources, adminPassword, trackedDocker);
    const admin = pool(true);
    await ready(admin);
    console.log((await admin.query("SHOW server_version")).rows[0].server_version);
    await t.test("incomplete setup cannot enable ingestion", async () => {
      const missing = pool();
      await assert.rejects(missing.query("SELECT 1"));
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='bor_catalog_ingest'")).rows[0].n, 0);
      // Simulate interruption after the actual committed prerequisite step.
      await admin.query(await readFile(new URL("../../scripts/catalog-prerequisites.sql", import.meta.url), "utf8"));
      try {
        await assert.rejects(setupSchema(admin, runtimePassword), /setup_nonempty/);
        await assert.rejects(missing.query("SELECT 1"));
        assert.equal((await admin.query("SELECT to_regclass('local_support.marker') AS marker")).rows[0].marker, null);
      }
      finally {
        // This empty synthetic test cluster alone owns this restoration.
        await admin.query("DROP SCHEMA auth CASCADE; DROP ROLE anon,authenticated,service_role");
      }
    });
    await setupSchema(admin, runtimePassword);
    await t.test("fresh setup reaches the evidence inventory", async () => {
      const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename")).rows;
      assert.deepEqual(tables.map(row => row.tablename), currentTables);
      const client = await admin.connect();
      try { assert.equal(await catalogSchemaState(client), 6); }
      finally { client.release(); }
      assert.deepEqual((await admin.query(`SELECT p.display_name,e.external_id FROM app.streaming_providers p
        JOIN app.streaming_provider_external_ids e ON e.provider_id=p.id WHERE e.source='watchmode' ORDER BY e.external_id`)).rows,
        [{ display_name: "Hulu", external_id: "157" }, { display_name: "Netflix", external_id: "203" },
          { display_name: "Disney+", external_id: "372" }, { display_name: "HBO Max", external_id: "387" }]);
      assert.deepEqual(await upgradeSchema(admin), { applied: 0, current: true });
    });
    await t.test("seed mappings deny update, delete and provider cascade for owner and service role", async () => {
      for (const role of ["postgres", "service_role"]) {
        const client = await admin.connect();
        try {
          for (const sql of [
            "UPDATE app.streaming_provider_external_ids SET external_id='999' WHERE source='watchmode' AND external_id='203'",
            "DELETE FROM app.streaming_provider_external_ids WHERE source='watchmode' AND external_id='203'",
            "DELETE FROM app.streaming_providers WHERE id=(SELECT provider_id FROM app.streaming_provider_external_ids WHERE source='watchmode' AND external_id='203')",
          ]) {
            await client.query(`BEGIN; SET LOCAL ROLE ${role}`);
            await assert.rejects(client.query(sql), { code: "23514" });
            await client.query("ROLLBACK");
          }
          // A non-Watchmode mapping cannot be rewritten into the Watchmode namespace either.
          // A provider with no Watchmode mapping: without the guard this UPDATE would succeed.
          await client.query(`BEGIN; INSERT INTO app.streaming_providers(id,display_name) VALUES('10000000-0000-4000-8000-0000000000ac','Synthetic unmapped provider');
            INSERT INTO app.streaming_provider_external_ids VALUES('10000000-0000-4000-8000-0000000000ac','synthetic_source','8');
            SET LOCAL ROLE ${role}`);
          await assert.rejects(client.query("UPDATE app.streaming_provider_external_ids SET source='watchmode',external_id='440' WHERE source='synthetic_source'"), { code: "23514" });
          await client.query("ROLLBACK");
          assert.equal((await client.query(`SELECT has_function_privilege('anon','app.guard_watchmode_provider_mapping()','EXECUTE') OR
            has_function_privilege('authenticated','app.guard_watchmode_provider_mapping()','EXECUTE') OR
            has_function_privilege('service_role','app.guard_watchmode_provider_mapping()','EXECUTE') AS allowed`)).rows[0].allowed, false);
        }
        finally { await client.query("ROLLBACK"); client.release(); }
      }
    });
    const runtime = pool();
    await completedSetup(runtime);
    await t.test("loopback binding/named mount, collision refusal and repeat inspection", async () => {
      assert.equal(await inspectCatalog(resources, docker, id), id);
      await assert.rejects(refuseCollisions(resources), /resource_occupied/);
      const before = await readCatalog(runtime, Date.now() + 10000);
      await completedSetup(runtime);
      assert.deepEqual(await readCatalog(runtime, Date.now() + 10000), before);
      await assert.rejects(setupSchema(admin, runtimePassword), /setup_nonempty/);
    });
    await t.test("actual operator path: image gate, exclusive credentials, setup/repeat/inspect/stop/delayed start/running start", async () => {
      const directory = await mkdtemp(join(tmpdir(), "bor-catalog-operator-test-"));
      const operatorResources = {
        ...resources,
        container: `${resources.container}-operator`,
        volume: `${resources.volume}-operator`,
        network: `${resources.network}-operator`,
        port: await unusedPort()
      };
      let operatorId = "", operatorVolume = false, operatorNetwork = false;
      const calls: string[][] = [];
      const operatorDocker = async (args: string[], input?: string) => {
        calls.push(args);
        if (args[0] === "exec")
          assert(args.at(-1)?.includes("/tmp/bor-password.tmp && mv /tmp/bor-password.tmp /tmp/bor-password"));
        // Delay this test-owned container's startup on every restart, so the real
        // operator path must wait for TCP readiness rather than racing PostgreSQL.
        const delayed = args[0] === "run" ? [...args.slice(0, -1), `sleep 1; ${args.at(-1)}`] : args;
        const result = await docker(delayed, input);
        if (args[0] === "run")
          operatorId = result;
        if (args[0] === "volume" &&
          args[1] === "create")
          operatorVolume = true;
        if (args[0] === "network" &&
          args[1] === "create")
          operatorNetwork = true;
        return result;
      };
      try {
        const uncachedDirectory = `${directory}/never-created`;
        await assert.rejects(localCommand("setup", operatorResources, uncachedDirectory, async (args) => {
          if (args[0] === "image")
            throw new Error("invented_raw_docker_error");
          return operatorDocker(args);
        }), /image_not_cached/);
        await assert.rejects(access(uncachedDirectory));
        assert(!calls.some(args => args.includes("create") ||
          args[0] === "run"));
        await writeFile(`${directory}/runtime.json`, "invented-existing-file");
        await assert.rejects(localCommand("setup", operatorResources, directory, operatorDocker), /credential_file_exists/);
        assert.equal(await readFile(`${directory}/runtime.json`, "utf8"), "invented-existing-file");
        assert(!operatorId &&
          !operatorVolume &&
          !operatorNetwork);
        await unlink(`${directory}/setup.json`);
        await unlink(`${directory}/runtime.json`);
        await localCommand("setup", operatorResources, directory, operatorDocker);
        const setupFile = await readFile(`${directory}/setup.json`, "utf8"), runtimeFile = await readFile(`${directory}/runtime.json`, "utf8");
        assert(decodePassword(privateJson(setupFile)) !== decodePassword(privateJson(runtimeFile)));
        const mutations = calls.filter(args => args[0] === "run" ||
          args.includes("create")).length;
        await localCommand("setup", operatorResources, directory, operatorDocker);
        await localCommand("inspect", operatorResources, directory, operatorDocker);
        assert.deepEqual(await localCommand("upgrade", operatorResources, directory, operatorDocker), { applied: 0, current: true });
        assert.equal(calls.filter(args => args[0] === "run" ||
          args.includes("create")).length, mutations);
        assert(await readFile(`${directory}/setup.json`, "utf8") === setupFile);
        assert(await readFile(`${directory}/runtime.json`, "utf8") === runtimeFile);
        await localCommand("stop", operatorResources, directory, operatorDocker);
        assert.equal(await operatorDocker(["inspect", operatorId, "--format", "{{.State.Running}}"]), "false");
        await localCommand("start", operatorResources, directory, operatorDocker);
        const starts = calls.filter(args => args[0] === "start").length;
        await localCommand("start", operatorResources, directory, operatorDocker);
        assert.equal(calls.filter(args => args[0] === "start").length, starts);
        assert.equal(await inspectCatalog(operatorResources, operatorDocker, operatorId), operatorId);
        assert(calls.findIndex(args => args[0] === "image") < calls.findIndex(args => args.includes("create")));
      }
      finally {
        if (operatorId) {
          await inspectCatalog(operatorResources, docker, operatorId);
          await docker(["rm", "--force", operatorId]);
          assert.equal(await docker(["ps", "-a", "--filter", `id=${operatorId}`, "--format", "{{.ID}}"]), "");
        }
        for (const [kind, created] of [["network", operatorNetwork], ["volume", operatorVolume]] as const)
          if (created) {
            const inspected = JSON.parse(await docker([kind, "inspect", operatorResources[kind], "--format", '{"Name":{{json .Name}},"Labels":{{json .Labels}}}']));
            assert.equal(inspected.Name, operatorResources[kind]);
            assert.equal(inspected.Labels["bor.catalog.test"], token);
            await docker([kind, "rm", operatorResources[kind]]);
            assert(!(await docker([kind, "ls", "--format", "{{.Name}}"])).split(/\r?\n/).includes(operatorResources[kind]));
          }
        for (const file of ["setup.json", "runtime.json"])
          await unlink(`${directory}/${file}`).catch(error => {
            if (error.code !== "ENOENT")
              throw error;
          });
        await rmdir(directory);
      }
    });
    await t.test("runtime SET service_role works; administrator/DDL/marker writes refuse", async () => {
      const wrongPassword = catalogPool(randomBytes(32).toString("hex"), resources.port);
      pools.push(wrongPassword);
      await assert.rejects(wrongPassword.query("SELECT 1"), (e: unknown) => !!e &&
        typeof e === "object" &&
        "code" in e &&
        e.code === "28P01");
      const client = await runtime.connect();
      try {
        await localCatalogGuard(client);
        const role = (await client.query("SELECT rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=session_user")).rows[0];
        assert.deepEqual(role, {
          rolcanlogin: true,
          rolinherit: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false
        });
        const memberships = (await client.query("SELECT r.rolname,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname=session_user)")).rows;
        assert.deepEqual(memberships, [{
            rolname: "service_role",
            admin_option: false,
            inherit_option: false,
            set_option: true
          }]);
        for (const sql of ["SET ROLE postgres", "SET ROLE authenticated", "CREATE ROLE synthetic_should_not_exist", "CREATE DATABASE synthetic_should_not_exist", "UPDATE local_support.marker SET name='wrong'"])
          await assert.rejects(client.query(sql), (e: unknown) => !!e &&
            typeof e === "object" &&
            "code" in e &&
            e.code === "42501");
        await client.query("BEGIN; SET LOCAL ROLE service_role");
        assert.equal((await client.query("SELECT has_table_privilege(current_user,'app.movies','INSERT,UPDATE,DELETE') AS allowed")).rows[0].allowed, true);
        await assert.rejects(client.query("UPDATE local_support.marker SET name='wrong'"));
        await client.query("ROLLBACK");
      }
      finally {
        client.release();
      }
    });
    await t.test("guard runs on reused pool connection; all marker/login/database refusals leave data unchanged", async () => {
      const guarded = pool(), cap = Object.freeze({}), store = createPgStore({
        pool: guarded,
        catalogCapability: cap,
        operators: [],
        checkoutGuard: localCatalogGuard
      });
      const fixture = await fixtures(), ctx = () => ({
        signal: AbortSignal.timeout(10000),
        deadline: Date.now() + 10000
      });
      const first = await guarded.connect();
      const pid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      first.release();
      assert("movieId" in await store.persistMovie(cap, fixture.movie, 1000, ctx()));
      const reused = await guarded.connect();
      assert.equal((await reused.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, pid);
      reused.release();
      const before = await readCatalog(runtime, Date.now() + 10000);
      for (const marker of ["wrong", "bor-pr02-disposable", "bor-pr03-disposable"]) {
        await admin.query("UPDATE local_support.marker SET name=$1", [marker]);
        assert.deepEqual(await store.persistMovie(cap, fixture.movie, 1000, ctx()), {
          status: "failed",
          code: "target_guard"
        });
      }
      await admin.query("DELETE FROM local_support.marker");
      assert.deepEqual(await store.persistMovie(cap, fixture.movie, 1000, ctx()), {
        status: "failed",
        code: "target_guard"
      });
      await admin.query("INSERT INTO local_support.marker VALUES ('bor-catalog-local-v1')");
      assert.deepEqual(await readCatalog(runtime, Date.now() + 10000), before);
      const wrongLogin = createPgStore({
        pool: admin,
        catalogCapability: cap,
        operators: [],
        checkoutGuard: localCatalogGuard
      });
      assert.deepEqual(await wrongLogin.persistMovie(cap, fixture.movie, 1000, ctx()), {
        status: "failed",
        code: "target_guard"
      });
      await admin.query("CREATE DATABASE bor_pr02_test");
      const wrongAdmin = new pg.Pool({
        host: "127.0.0.1",
        port: resources.port,
        user: "postgres",
        database: "bor_pr02_test",
        password: adminPassword,
        connectionTimeoutMillis: 5000
      });
      pools.push(wrongAdmin);
      await wrongAdmin.query("CREATE SCHEMA local_support; CREATE TABLE local_support.marker(name text); INSERT INTO local_support.marker VALUES ('bor-catalog-local-v1'); GRANT USAGE ON SCHEMA local_support TO bor_catalog_ingest; GRANT SELECT ON local_support.marker TO bor_catalog_ingest");
      const wrong = new pg.Pool({
        host: "127.0.0.1",
        port: resources.port,
        user: "bor_catalog_ingest",
        database: "bor_pr02_test",
        password: runtimePassword,
        connectionTimeoutMillis: 5000
      });
      pools.push(wrong);
      const c = await wrong.connect();
      try {
        await assert.rejects(localCatalogGuard(c));
      }
      finally {
        c.release();
      }
    });
    const fixture = await fixtures(), reports: unknown[] = [], output: string[] = [];
    const config = {
      providerListing: "provider-list-10000000-0000-4000-8000-000000000001.json",
      version: "catalog-local-v1",
      region: "US",
      mappingVersion: "origin-v1",
      services: Object.keys(subscriptions).map((service, i) => ({
        service,
        providerId: i === 0 ? "900101" : null,
        providerName: i === 0 ? "Invented synthetic provider" : null,
        checkedAt: i === 0 ? "2026-10-03" : null,
        qualification: i === 0 ? "Synthetic injected listing for test only" : null,
        omission: i === 0 ? null : "Unresolved synthetic mapping"
      })),
      limits: {
        ...firstImportLimits
      },
      terms: {
        accepted: true,
        checkedAt: "2026-10-03",
        source: "https://example.test/synthetic-terms",
        decision: "Synthetic acceptance only"
      }
    };
    const controller = new AbortController();
    let fetchCalls = 0, status = 200;
    const io: CatalogIO = {
      read: async (path) => JSON.stringify(path.includes("provider-list-") ? {
        checkedAt: "2026-10-03",
        region: "US",
        providers: [{
            id: "900101",
            name: "Invented synthetic provider"
          }]
      } : config),
      token: async () => "invented-token-sentinel-0123456789",
      password: async () => runtimePassword,
      pool: () => pool(),
      now: Date.now,
      signal: controller.signal,
      writeReport: async (report) => { reports.push(report); },
      output: s => output.push(s),
      transport: {
        sleep: async () => { },
        fetch: async (url) => {
          fetchCalls++;
          const u = new URL(String(url));
          if (status !== 200)
            return new Response("invented-token-sentinel-0123456789", {
              status
            });
          if (u.pathname.includes("watch/providers/movie"))
            return new Response(JSON.stringify({
              results: [{
                  provider_id: 900101,
                  provider_name: "Invented synthetic provider"
                }]
            }));
          return new Response(JSON.stringify(u.pathname.includes("discover") ? {
            page: Number(u.searchParams.get("page")),
            total_pages: 1,
            total_results: 1,
            results: [{
                id: 900001
              }]
          } : fixture.raw));
        }
      }
    };
    const args = ["--config", ".cache/real-catalog/private/synthetic.json", "--as-of", "2026-10-03", "--live"];
    await t.test("conflicting Watchmode identity rolls migration back to complete state 5", async () => {
      await admin.query("DROP SCHEMA app CASCADE");
      for (const file of (await migrationFiles()).slice(0, 5))
        await admin.query(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
      await admin.query(`INSERT INTO app.streaming_providers(id,display_name) VALUES('10000000-0000-4000-8000-000000000088','Synthetic conflicting provider');
        INSERT INTO app.streaming_provider_external_ids VALUES('10000000-0000-4000-8000-000000000088','watchmode','203')`);
      await assert.rejects(upgradeSchema(admin), /upgrade_failed_inspect_required/);
      const client = await admin.connect();
      try { assert.equal(await catalogSchemaState(client), 5); }
      finally { client.release(); }
      assert.equal((await admin.query("SELECT count(*)::int n FROM app.streaming_providers")).rows[0].n, 1);
      assert.equal((await admin.query("SELECT count(*)::int n FROM pg_proc WHERE proname='guard_watchmode_provider_mapping'")).rows[0].n, 0);
    });
    await t.test("original and sweeps upgrades refuse import, backfill, and repeat without replay", async upgradeTest => {
      for (const baseline of [3, 4, 5]) await upgradeTest.test(`${baseline}-migration starting state`, async baselineTest => {
        await admin.query("DROP SCHEMA app CASCADE");
        for (const file of (await migrationFiles()).slice(0, Math.min(baseline, 4)))
          await admin.query(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
        await admin.query(`INSERT INTO app.movies(id,title,metadata_source,metadata_refreshed_at)
          VALUES ('10000000-0000-4000-8000-000000000099','Invented legacy movie','tmdb','2026-09-01T12:00:00Z');
          INSERT INTO app.movie_external_ids
          VALUES ('10000000-0000-4000-8000-000000000099','tmdb','999099')`);
        if (baseline === 5) await admin.query(await readFile(new URL(`../../supabase/migrations/${(await migrationFiles())[4]}`, import.meta.url), "utf8"));
        if (baseline === 5) await baselineTest.test("real backup, upgrade and inspect processes transition 5 to 6", async () => {
          const copy = await operatorCopy();
          try {
            const entry = join(copy.root, "scripts/catalog-local.ts");
            const source = (await readFile(entry, "utf8")).replaceAll("\r\n", "\n");
            // Redirect fixed names only in this credential-free test copy, never production.
            const target = /export const retained = Object.freeze\(\{[\s\S]*?\}\);/;
            assert(target.test(source), "test target redirection must match before launching any process");
            await writeFile(entry, source.replace(target,
              `export const retained = Object.freeze(${JSON.stringify(resources)});`));
            const directory = join(copy.root, ".cache/real-catalog/private");
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, "setup.json"), JSON.stringify({ password: adminPassword }));
            await writeFile(join(directory, "runtime.json"), JSON.stringify({ password: runtimePassword }));
            const before = await copy.run("catalog-local.ts", ["backup", "--phase", "before-upgrade"]);
            assert.equal(before.code, 0, before.stderr);
            const digest = JSON.parse(before.stdout).digest;
            assert.equal(JSON.parse(before.stdout).schemaState, 5);
            assert.equal((await copy.run("catalog-local.ts", ["backup", "--phase", "after-upgrade"])).stderr.trim(), "backup_phase_mismatch");
            const upgrade = await copy.run("catalog-local.ts", ["upgrade"]);
            assert.equal(upgrade.code, 0, upgrade.stderr);
            assert.equal(upgrade.stdout.trim(), "catalog_upgrade_applied");
            const inspect = await copy.run("catalog-local.ts", ["inspect"]);
            assert.equal(inspect.code, 0, inspect.stderr);
            const after = await copy.run("catalog-local.ts", ["backup", "--phase", "after-upgrade"]);
            assert.equal(after.code, 0, after.stderr);
            assert.equal(JSON.parse(after.stdout).schemaState, 6);
            assert(sameIdentity(digest, JSON.parse(after.stdout).digest));
            const mismatch = await copy.run("catalog-local.ts", ["backup", "--phase", "before-upgrade"]);
            assert.equal(mismatch.code, 1);
            assert.equal(mismatch.stderr.trim(), "backup_phase_mismatch");
            assert.equal((await copy.run("catalog-local.ts", ["upgrade"])).stdout.trim(), "catalog_upgrade_current");
          }
          finally { await copy.cleanup(); }
          // Restore the same owned state 5 so the imported operator acceptance runs too.
          await admin.query("DROP SCHEMA app CASCADE");
          for (const file of (await migrationFiles()).slice(0, 4))
            await admin.query(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
          await admin.query(`INSERT INTO app.movies(id,title,metadata_source,metadata_refreshed_at)
            VALUES ('10000000-0000-4000-8000-000000000099','Invented legacy movie','tmdb','2026-09-01T12:00:00Z');
            INSERT INTO app.movie_external_ids VALUES ('10000000-0000-4000-8000-000000000099','tmdb','999099')`);
          await admin.query(await readFile(new URL(`../../supabase/migrations/${(await migrationFiles())[4]}`, import.meta.url), "utf8"));
        });
        fetchCalls = 0;
        await assert.rejects(completedSetup(runtime), /^Error: upgrade_required$/);
        if (baseline < 5) {
          assert.equal(await catalogCommand(args, io), 1);
          assert.equal(fetchCalls, 0);
        }
        await admin.query("CREATE TABLE app.unknown_state(id integer)");
        await assert.rejects(upgradeSchema(admin), /upgrade_state_unknown/);
        await admin.query("DROP TABLE app.unknown_state");
        const root = await mkdtemp(join(tmpdir(), "bor-backup-acceptance-"));
        try {
          const directory = join(root, ".cache/real-catalog/private");
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, "setup.json"), JSON.stringify({ password: adminPassword }));
          const runBackup = (phase: "before-upgrade" | "after-upgrade") => localCommand("backup", resources, directory, docker, { phase, root, signal: controller.signal });
          {
            await admin.query("CREATE TABLE app.synthetic_backup_unknown(id integer)");
            try { await assert.rejects(runBackup("before-upgrade"), /upgrade_state_unknown/); }
            finally { await admin.query("DROP TABLE app.synthetic_backup_unknown"); }
            assert.deepEqual(await readdir(directory), ["setup.json"]);
            await assert.rejects(backupCatalog("before-upgrade", {
              root, containerId: id, pool: runtime, signal: controller.signal,
              sha: async () => "446f78f05f53ce08f296766c5c66b5d52065d296", inspect: () => inspectCatalog(resources, docker, id),
            }), /target_guard/);
            assert.deepEqual(await readdir(directory), ["setup.json"]);
            if (baseline === 4) await baselineTest.test("state-4 backup refuses any provider-cache row without a retention policy before dump creation", async () => {
              // A sweep row, and a detail attempt that exists independently of any sweep.
              for (const [table, insert, key] of [
                ["watchmode_sweeps", "INSERT INTO app.watchmode_sweeps VALUES('10000000-0000-4000-8000-0000000000aa','10000000-0000-4000-8000-0000000000ab',203,'us-direct-v1',statement_timestamp())", "id='10000000-0000-4000-8000-0000000000aa'"],
                ["metadata_detail_attempts", "INSERT INTO app.metadata_detail_attempts VALUES('987654','failed','2020-01-01T00:00:00Z')", "tmdb_id='987654'"],
              ]) {
                const names = await readdir(directory);
                await admin.query(insert);
                try {
                  await assert.rejects(runBackup("before-upgrade"), /backup_retention_unknown/, table);
                  assert.deepEqual(await readdir(directory), names);
                }
                finally {
                  await admin.query(`ALTER TABLE app.${table} DISABLE TRIGGER USER; DELETE FROM app.${table} WHERE ${key};
                    ALTER TABLE app.${table} ENABLE TRIGGER USER`);
                }
              }
            });
            if (baseline === 5) await baselineTest.test("state-5 backup refuses an identity mapping without acquisition provenance before dump creation", async () => {
              const names = await readdir(directory);
              await admin.query("INSERT INTO app.movie_external_ids VALUES('10000000-0000-4000-8000-000000000099','synthetic_unprovenanced','x')");
              try {
                await assert.rejects(runBackup("before-upgrade"), /backup_acquisition_failed/);
                assert.deepEqual(await readdir(directory), names);
              }
              finally { await admin.query("DELETE FROM app.movie_external_ids WHERE source='synthetic_unprovenanced'"); }
            });
            const before = await runBackup("before-upgrade");
            assert(before && "digest" in before);
            const archive = await readFile(before.dump);
            assert.equal(archive.subarray(0, 5).toString(), "PGDMP");
            assert.equal(archive.length, before.bytes);
            assert.equal(createHash("sha256").update(archive).digest("hex"), before.sha256);
            assert.equal(JSON.parse(await readFile(before.manifest, "utf8")).success, true);
            await assert.rejects(runBackup("after-upgrade"), /backup_phase_mismatch/);
            assert.equal((await readdir(directory)).length, 3);
            // Actual restore into another inspected tmpfs cluster with explicit platform prerequisites.
            await withDisposable(async restore => {
              const created = await disposableDocker(["exec", "-i", restore.containerId, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
                "CREATE ROLE bor_catalog_ingest NOLOGIN; CREATE DATABASE bor_backup_restore;");
              assert.equal(created.code, 0);
              const child = spawn("docker", ["exec", "-i", restore.containerId, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges",
                "--host=/var/run/postgresql", "--username=postgres", "--dbname=bor_backup_restore"], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(30000) });
              child.stdout.resume(); child.stderr.resume();
              const exit = new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve(code ?? 1)); });
              await pipeline(createReadStream(before.dump), child.stdin);
              assert.equal(await exit, 0);
              const restored = await disposableDocker(["exec", "-i", restore.containerId, "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "bor_backup_restore"],
                `SELECT row_to_json(d) FROM (${identityDigestSql}) d;`);
              assert.equal(restored.code, 0);
              // psql JSON emits numeric counts; normalize only its count serialization.
              const digest = JSON.parse(restored.output);
              for (const key of Object.keys(digest)) if (typeof digest[key] === "number") digest[key] = String(digest[key]);
              assert(sameIdentity(before.digest, digest));
            });
            const backupIO = { root, containerId: id, pool: admin, signal: controller.signal,
              sha: async () => "446f78f05f53ce08f296766c5c66b5d52065d296", inspect: () => inspectCatalog(resources, docker, id) };
            const collision = { ...backupIO, id: () => before.id };
            await assert.rejects(backupCatalog("before-upgrade", collision), /backup_file_exists/);
            assert.deepEqual(await readFile(before.dump), archive, "existing restore point must remain byte-identical");
            await baselineTest.test("snapshot/socket authentication and contender exclusion throughout streaming", async () => {
              let commands = 0;
              const contenders: Promise<void>[] = [];
              const copy = await backupCatalog("before-upgrade", { ...backupIO,
                spawn: (args, signal) => {
                  commands++;
                  contenders.push((async () => {
                    const client = await admin.connect();
                    try {
                      const held = (await client.query("SELECT pg_try_advisory_lock(1112494674,1) AS held")).rows[0].held;
                      if (held) await client.query("SELECT pg_advisory_unlock(1112494674,1)");
                      assert.equal(held, false, "contender must refuse during both dump and archive validation");
                    }
                    finally { client.release(); }
                  })());
                  if (args.includes("pg_dump")) {
                    assert(args.includes("--no-password") && args.includes("--host=/var/run/postgresql"));
                    assert(args.some(arg => arg.startsWith("--snapshot=")));
                    assert(!args.some(arg => /password=/.test(arg)));
                  }
                  // Query a separate session while the snapshot coordinator remains checked out.
                  const child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal });
                  return child;
                },
              });
              await Promise.all(contenders);
              assert.equal(commands, 2);
              await verifyBackup(copy.dump, copy.manifest, controller.signal);
              const manifest = JSON.parse(await readFile(copy.manifest, "utf8"));
              await writeFile(copy.manifest, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
              await assert.rejects(verifyBackup(copy.dump, copy.manifest, controller.signal), /backup_manifest_invalid/);
              await writeFile(copy.manifest, JSON.stringify({ ...manifest, schemaState: currentMigrationCount }));
              await assert.rejects(verifyBackup(copy.dump, copy.manifest, controller.signal), /backup_manifest_invalid/);
              // States without the retention policy record no Watchmode age; state 5 records the policy window.
              const policyAge = { oldest: null, windowSeconds: 30 * 86400 };
              assert.deepEqual(manifest.watchmodeSourceAge, manifest.schemaState >= 5 ? policyAge : null);
              for (const tampered of [{ ...manifest, retentionDeadline: "2099-01-01T00:00:00.000Z" },
                { ...manifest, watchmodeSourceAge: manifest.schemaState >= 5 ? null : policyAge }]) {
                await writeFile(copy.manifest, JSON.stringify(tampered));
                await assert.rejects(verifyBackup(copy.dump, copy.manifest, controller.signal), /backup_manifest_invalid/);
              }
              await writeFile(copy.manifest, JSON.stringify(manifest));
              await unlink(copy.dump); await unlink(copy.manifest);
            });
            await baselineTest.test("authentication/archive/timeout/cancellation/lock-loss failures invalidate only owned partial files", async () => {
              const original = await readdir(directory);
              const syntheticChild = (source: string, signal: AbortSignal) => spawn(process.execPath, ["-e", source], {
                shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal,
              });
              await assert.rejects(backupCatalog("before-upgrade", { ...backupIO,
                spawn: (_args, signal) => syntheticChild("process.stderr.write('invented_secret_sentinel'); process.exit(1)", signal),
              }), /backup_dump_failed/);
              await assert.rejects(backupCatalog("before-upgrade", { ...backupIO,
                spawn: (args, signal) => args.includes("pg_dump") ? syntheticChild("process.stdout.write('synthetic invalid archive')", signal) :
                  spawn("docker", args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal }),
              }), /backup_archive_invalid/);
              await assert.rejects(backupCatalog("before-upgrade", { ...backupIO,
                stream: () => new Writable({ write(_chunk, _encoding, callback) { callback(new Error("synthetic disk failure sentinel")); } }),
              }), /backup_dump_failed/);
              await assert.rejects(backupCatalog("before-upgrade", { ...backupIO, durationMs: 1000,
                spawn: (_args, signal) => syntheticChild("process.stdout.write('PGDMP'); setInterval(()=>{},1000)", signal),
              }), /backup_deadline/);
              const cancelled = new AbortController();
              await assert.rejects(backupCatalog("before-upgrade", { ...backupIO, signal: cancelled.signal,
                spawn: (_args, signal) => { const child = syntheticChild("process.stdout.write('PGDMP'); setInterval(()=>{},1000)", signal); setTimeout(() => cancelled.abort(), 50); return child; },
              }), /backup_cancelled/);
              await assert.rejects(backupCatalog("before-upgrade", { ...backupIO,
                spawn: (_args, signal) => {
                  const child = syntheticChild("process.stdout.write('PGDMP'); setInterval(()=>{},1000)", signal);
                  void admin.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory'
                    AND classid=1112494674 AND objid=1 AND objsubid=2 AND granted`).catch(() => {});
                  return child;
                },
              }), /backup_lock_lost/);
              assert.deepEqual(await readdir(directory), original);
              const contender = await admin.connect();
              try { assert.equal((await contender.query("SELECT pg_try_advisory_lock(1112494674,1) AS held")).rows[0].held, true); await contender.query("SELECT pg_advisory_unlock(1112494674,1)"); }
              finally { contender.release(); }
            });
            await assert.rejects(backupCatalog("before-upgrade", {
              root, containerId: id, pool: admin, signal: controller.signal, sha: async () => "446f78f05f53ce08f296766c5c66b5d52065d296", inspect: () => inspectCatalog(resources, docker, id), maxBytes: 1,
            }), /backup_size_limit/);
            assert.equal((await readdir(directory)).length, 3, "failed streaming must remove only its partial file");
            await admin.query("UPDATE app.movies SET metadata_refreshed_at=metadata_refreshed_at+interval '1 microsecond'");
            try {
              const changed = (await admin.query(identityDigestSql)).rows[0];
              assert.equal(sameIdentity(before.digest, changed), false, "timestamp mutation must change the identity digest");
            }
            finally { await admin.query("UPDATE app.movies SET metadata_refreshed_at=metadata_refreshed_at-interval '1 microsecond'"); }
            await upgradeSchema(admin);
            const after = await runBackup("after-upgrade");
            assert(after && "digest" in after);
            assert(sameIdentity(before.digest, after.digest));
            assert.deepEqual(after.acquisition, { mappings_without_acquisition: "0" });
            const sweptRows = (acquiredAt: string) => admin.query(`INSERT INTO app.movie_external_ids VALUES('10000000-0000-4000-8000-000000000099','watchmode','9999999');
              INSERT INTO app.movie_external_id_acquisitions VALUES
                ('10000000-0000-4000-8000-000000000099','watchmode','watchmode_membership',${acquiredAt}),
                ('10000000-0000-4000-8000-000000000099','tmdb','watchmode_membership',${acquiredAt})`);
            // Retained provenance cannot be deleted through the guard; the disposable owner bypasses it for teardown.
            const removeSweptRows = () => admin.query(`ALTER TABLE app.movie_external_id_acquisitions DISABLE TRIGGER USER;
              DELETE FROM app.movie_external_id_acquisitions WHERE acquisition_path='watchmode_membership';
              ALTER TABLE app.movie_external_id_acquisitions ENABLE TRIGGER USER;
              DELETE FROM app.movie_external_ids WHERE source='watchmode' AND external_id='9999999'`);
            await baselineTest.test("state-6 backup accepts live-sweep identities and dates its deadline by the Watchmode window", async () => {
              await sweptRows("date_trunc('second', statement_timestamp()) - interval '1 day'");
              try {
                const expected = (await admin.query(`SELECT to_char((min(acquired_at) + interval '30 days') AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deadline FROM app.movie_external_id_acquisitions WHERE acquisition_path='watchmode_membership'`)).rows[0].deadline;
                const swept = await runBackup("after-upgrade");
                assert(swept && "acquisition" in swept);
                assert.deepEqual(swept.acquisition, { mappings_without_acquisition: "0" });
                assert.equal(swept.watchmodeSourceAge?.windowSeconds, 30 * 86400);
                assert.equal(swept.retentionDeadline, expected, "Watchmode data must set the earlier 30-day deadline");
                assert(Date.parse(String(swept.retentionDeadline)) < Date.parse(String(after.retentionDeadline)));
                await verifyBackup(swept.dump, swept.manifest, controller.signal);
                const manifest = JSON.parse(await readFile(swept.manifest, "utf8"));
                for (const tampered of [{ ...manifest, retentionDeadline: after.retentionDeadline },
                  { ...manifest, watchmodeSourceAge: { ...manifest.watchmodeSourceAge, windowSeconds: 86400 } },
                  { ...manifest, watchmodeSourceAge: null }]) {
                  await writeFile(swept.manifest, JSON.stringify(tampered));
                  await assert.rejects(verifyBackup(swept.dump, swept.manifest, controller.signal), /backup_manifest_invalid/);
                }
                await writeFile(swept.manifest, JSON.stringify(manifest));
              }
              finally { await removeSweptRows(); }
            });
            await baselineTest.test("state-6 deadline follows an older trigger-bound cache row over newer acquisitions", async () => {
              await sweptRows("date_trunc('second', statement_timestamp()) - interval '1 day'");
              await admin.query("INSERT INTO app.metadata_detail_attempts VALUES('987654','failed',date_trunc('second', statement_timestamp()) - interval '2 days')");
              try {
                const expected = (await admin.query(`SELECT to_char((checked_at + interval '30 days') AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deadline FROM app.metadata_detail_attempts WHERE tmdb_id='987654'`)).rows[0].deadline;
                const swept = await runBackup("after-upgrade");
                assert(swept && "retentionDeadline" in swept);
                assert.equal(swept.retentionDeadline, expected, "the oldest guarded cache row sets the deadline");
                await verifyBackup(swept.dump, swept.manifest, controller.signal);
              }
              finally {
                await removeSweptRows();
                await admin.query(`ALTER TABLE app.metadata_detail_attempts DISABLE TRIGGER USER;
                  DELETE FROM app.metadata_detail_attempts WHERE tmdb_id='987654';
                  ALTER TABLE app.metadata_detail_attempts ENABLE TRIGGER USER`);
              }
            });
            await baselineTest.test("state-6 backup refuses Watchmode data already past its window before dump creation", async () => {
              const names = await readdir(directory);
              await sweptRows("'2020-01-01T00:00:00Z'");
              try {
                await assert.rejects(runBackup("after-upgrade"), /backup_retention_expired/);
                assert.deepEqual(await readdir(directory), names);
              }
              finally { await removeSweptRows(); }
            });
            await baselineTest.test("state-6 backup refuses an identity mapping without acquisition provenance before dump creation", async () => {
              const names = await readdir(directory);
              await admin.query("INSERT INTO app.movie_external_ids VALUES('10000000-0000-4000-8000-000000000099','synthetic_unprovenanced','x')");
              try {
                await assert.rejects(runBackup("after-upgrade"), /backup_acquisition_failed/);
                assert.deepEqual(await readdir(directory), names);
              }
              finally { await admin.query("DELETE FROM app.movie_external_ids WHERE source='synthetic_unprovenanced'"); }
            });
            await assert.rejects(runBackup("before-upgrade"), /backup_phase_mismatch/);
            const names = await readdir(directory);
            for (const name of names.filter(n => n.startsWith("catalog-backup-")))
              assert(!/^(?:provider-list|run-report)-[a-f0-9-]{36}\.json$/.test(name));
            await expirePrivateEvidence(root, Date.now(), controller.signal);
            assert.deepEqual(await readdir(directory), names);
          }
        }
        finally { await rm(root, { recursive: true, force: true }); await assert.rejects(access(root)); }
        assert.deepEqual(await upgradeSchema(admin), { applied: 0, current: true });
        await completedSetup(runtime);
        const acquisitions = (await admin.query("SELECT acquisition_path, acquired_at FROM app.movie_external_id_acquisitions")).rows;
        assert.equal(acquisitions.length, 1);
        assert.equal(acquisitions[0].acquisition_path, "tmdb_metadata");
        assert.equal(acquisitions[0].acquired_at.toISOString(), "2026-09-01T12:00:00.000Z");
        assert.deepEqual(await upgradeSchema(admin), { applied: 0, current: true });
        assert.equal(await catalogCommand(args, io), 0);
      });
      reports.length = 0;
    });
    await t.test("migration failure preserves the previous complete state and rolls back partial evidence DDL", async () => {
      await admin.query("DROP SCHEMA app CASCADE");
      for (const file of (await migrationFiles()).slice(0, 3))
        await admin.query(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
      await admin.query(`INSERT INTO app.movies(id,title,metadata_source,metadata_refreshed_at)
        VALUES ('10000000-0000-4000-8000-000000000099','Invented legacy movie','tmdb','2026-09-01T12:00:00Z');
        INSERT INTO app.movie_external_ids
        VALUES ('10000000-0000-4000-8000-000000000099','tmdb','999099')`);

      await admin.query(`CREATE FUNCTION public.synthetic_migration_failure() RETURNS event_trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF position('provider_retention_policy' in current_query()) > 0 THEN
            RAISE EXCEPTION 'synthetic private failure';
          END IF;
        END $$;
        CREATE EVENT TRIGGER synthetic_upgrade_failure ON ddl_command_start
        EXECUTE FUNCTION public.synthetic_migration_failure()`);
      try {
        await assert.rejects(upgradeSchema(admin), /^Error: upgrade_failed_inspect_required$/);
        const client = await admin.connect();
        try { assert.equal(await catalogSchemaState(client), 4); }
        finally { client.release(); }
        // The evidence migration creates this index before its first table.
        assert.equal((await admin.query("SELECT to_regclass('app.watchmode_memberships_page') AS value")).rows[0].value, null);
        assert.equal((await admin.query("SELECT title FROM app.movies WHERE id='10000000-0000-4000-8000-000000000099'")).rows[0].title, "Invented legacy movie");
      }
      finally {
        await admin.query("DROP EVENT TRIGGER synthetic_upgrade_failure; DROP FUNCTION public.synthetic_migration_failure()");
      }
      assert.deepEqual(await upgradeSchema(admin), { applied: currentMigrationCount - 4, current: true });
      await completedSetup(runtime);
      assert.equal(await catalogCommand(args, io), 0);
      reports.length = 0;
    });
    await t.test("legacy importer shares availability lock and refuses overlap before provider calls",async()=>{
      const held=await acquireRefreshLock(runtime,localCatalogGuard,controller.signal);
      const beforeCalls=fetchCalls;
      try {
        assert.equal(await catalogCommand(args,io),1);
        assert.equal(output.at(-1),"refresh_overlap");
        assert.equal(fetchCalls,beforeCalls);
        assert.equal(await catalogCommand([...args,"--list-providers"],io),1);
        assert.equal(fetchCalls,beforeCalls);
      }finally{await held.release();}
    });
    await t.test("actual CLI composition repeats identity/credits with no personal/availability/classification writes", async () => {
      assert.equal(await catalogCommand(args, io), 0);
      const before = await readCatalog(runtime, Date.now() + 10000);
      assert.equal(await catalogCommand(args, io), 0);
      const after = await readCatalog(runtime, Date.now() + 10000);
      assert.deepEqual(after.mappings, before.mappings);
      assert.deepEqual(after.credits, before.credits);
      assert.equal(after.movies[0].id, before.movies[0].id);
      assert.deepEqual(after.excluded, before.excluded);
      assert.equal(after.excluded.providers, 4);
      assert.equal(after.excluded.provider_mappings, 4);
      assert(Object.entries(after.excluded).every(([key, n]) => ["providers", "provider_mappings"].includes(key) || n === 0));
      assert.equal(reports.length, 2);
      assert(fetchCalls > 0);
      assert(!output.join("\n").includes("invented-token-sentinel"));
      assert(!output.join("\n").includes(runtimePassword));
    });
    await t.test("failed/retried operations share attempts; authentication stops without retry", async () => {
      status = 503;
      fetchCalls = 0;
      assert.equal(await catalogCommand(args, io), 2);
      const report = reports.at(-1) as {
        attempts: number;
        report: {
          operations: number;
        };
      };
      assert.equal(report.attempts, fetchCalls);
      assert.equal(fetchCalls, report.report.operations * 3);
      status = 401;
      fetchCalls = 0;
      assert.equal(await catalogCommand(args, io), 1);
      assert.equal(fetchCalls, 1);
      status = 200;
    });
    await t.test("inline listing shares attempts and its bound with the actual importer", async () => {
      fetchCalls = 0;
      assert.equal(await catalogCommand([...args, "--list-providers"], io), 0);
      assert.equal((reports.at(-1) as {
        attempts: number;
      }).attempts, fetchCalls);
      const exhausted = {
        ...io,
        read: async (path: string) => path.includes("provider-list-") ? io.read(path) : JSON.stringify({
          ...config,
          limits: {
            ...config.limits,
            attempts: 1
          }
        })
      };
      fetchCalls = 0;
      assert.equal(await catalogCommand([...args, "--list-providers"], exhausted), 2);
      assert.equal(fetchCalls, 1);
      assert.equal((reports.at(-1) as {
        attempts: number;
      }).attempts, 1);
    });
    await t.test("listing checked date comes from the clock, independently of as-of", async () => {
      const listingOnly = {
        ...io,
        read: async () => JSON.stringify({
          ...config,
          services: config.services.map(s => ({
            ...s,
            providerId: null,
            providerName: null,
            checkedAt: null,
            qualification: null,
            omission: "Unresolved synthetic mapping"
          }))
        }),
        now: () => Date.parse("2026-10-04T12:00:00Z")
      };
      assert.equal(await catalogCommand([...args, "--list-providers"], listingOnly), 0);
      assert.equal((reports.at(-1) as {
        checkedAt: string;
      }).checkedAt, "2026-10-04");
    });
    await t.test("preflight is charged to ordinary DB budget; mapping mismatch refuses before provider work", async () => {
      const tinyDatabase = {
        ...io,
        read: async (path: string) => path.includes("provider-list-") ? io.read(path) : JSON.stringify({
          ...config,
          limits: {
            ...config.limits,
            databaseMs: 1
          }
        })
      };
      fetchCalls = 0;
      assert.equal(await catalogCommand(args, tinyDatabase), 1);
      assert.equal(fetchCalls, 0);
      const wrongMapping = {
        ...io,
        read: async (path: string) => path.includes("provider-list-") ? JSON.stringify({
          checkedAt: "2026-10-03",
          region: "US",
          providers: [{
              id: "900102",
              name: "Different synthetic provider"
            }]
        }) : io.read(path)
      };
      assert.equal(await catalogCommand(args, wrongMapping), 1);
      assert.equal(fetchCalls, 0);
    });
    await t.test("lowered deadline through actual CLI reserves finalization and stops new calls", async () => {
      let offset = 0, calls = 0;
      const timed = {
        ...io,
        now: () => Date.now() + offset,
        read: async (path: string) => path.includes("provider-list-") ? io.read(path) : JSON.stringify({
          ...config,
          limits: {
            ...config.limits,
            durationMs: 40000
          }
        }),
        transport: {
          ...io.transport,
          fetch: async (...parameters: Parameters<typeof fetch>) => { calls++; const response = await io.transport.fetch(...parameters); offset = 11000; return response; }
        }
      };
      assert.equal(await catalogCommand(args, timed), 2);
      assert.equal(calls, 1);
      assert((reports.at(-1) as {
        report: {
          bounds: string[];
        };
      }).report.bounds.includes("deadline"));
    });
    await t.test("readback/report failures redact secrets and return operational failure", async () => {
      const failing = {
        ...io,
        writeReport: async () => { throw new Error(`invented-token-sentinel-0123456789 ${runtimePassword}`); }
      };
      assert.equal(await catalogCommand(args, failing), 1);
      assert.equal(output.at(-1), "catalog_command_failed");
      assert(!output.join("\n").includes(runtimePassword));
    });
    await t.test("expired finalization deadline still permits a local failure report", async () => {
      const realNow = Date.now;
      const failing: CatalogIO = {
        ...io,
        now: realNow,
        pool: () => {
          const created = pool();
          let readbacks = 0, reading = false;
          created.on("connect", client => {
            const query = client.query.bind(client);
            Object.defineProperty(client, "query", {
              value: async (...parameters: unknown[]) => {
                const sql = parameters[0];
                if (typeof sql === "string" && sql.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ")) {
                  readbacks++;
                  reading = true;
                }
                const result = await Reflect.apply(query, client, parameters);
                if (sql === "COMMIT" && reading) {
                  reading = false;
                  if (readbacks === 2) Date.now = () => realNow() + 600001;
                }
                return result;
              }
            });
          });
          return created;
        },
        writeReport: async (report, signal) => {
          Date.now = realNow;
          await new Promise(resolve => setTimeout(resolve, 25));
          signal?.throwIfAborted();
          reports.push(report);
        }
      };
      try {
        const before = reports.length;
        assert.equal(await catalogCommand(args, failing), 1);
        assert.equal(reports.length, before + 1);
        assert.equal((reports.at(-1) as { failureCode: string }).failureCode, "finalization_deadline");
        assert.equal(output.at(-1), "finalization_deadline");
      } finally {
        Date.now = realNow;
      }
    });
    await t.test("post-commit readback failure preserves titles and writes a failure report with committed progress", async () => {
      const failing = {
        ...io,
        pool: () => {
          const created = pool();
          let readbacks = 0;
          created.on("connect", client => {
            const query = client.query.bind(client);
            Object.defineProperty(client, "query", {
              value: (...parameters: unknown[]) => {
                if (typeof parameters[0] === "string" &&
                  parameters[0].startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ")) {
                  readbacks++;
                  if (readbacks === 2)
                    return Promise.reject(new Error(`invented-token-sentinel-0123456789 ${runtimePassword}`));
                }
                return Reflect.apply(query, client, parameters);
              }
            });
          });
          return created;
        },
        transport: {
          ...io.transport,
          fetch: async (url: Parameters<typeof fetch>[0]) => {
            if (String(url).includes("discover"))
              return new Response(JSON.stringify({
                page: 1,
                total_pages: 1,
                total_results: 1,
                results: [{
                    id: 900005
                  }]
              }));
            const raw = {
              ...fixture.raw,
              id: 900005
            };
            for (const key of ["release_dates", "keywords", "credits", "external_ids"])
              Object.assign(raw, {
                [key]: {
                  ...fixture.raw[key] as Record<string, unknown>,
                  id: 900005
                }
              });
            return new Response(JSON.stringify(raw));
          }
        }
      };
      assert.equal(await catalogCommand(args, failing), 1);
      const report = reports.at(-1) as {
        outcome: string;
        ingestOutcome: string;
        readback: string;
        failureCode: string;
        report: {
          persisted: number;
        };
      };
      assert.equal(report.outcome, "failed");
      assert.equal(report.ingestOutcome, "success");
      assert.equal(report.readback, "failed");
      assert.equal(report.failureCode, "catalog_readback_failed");
      assert.equal(report.report.persisted, 1);
      assert.equal(output.at(-1), "catalog_readback_failed");
      assert((await readCatalog(runtime, Date.now() + 10000)).mappings.some(m => m.source === "tmdb" &&
        m.external_id === "900005"));
      assert(!JSON.stringify(report).includes(runtimePassword));
      assert(!output.join("\n").includes("invented-token-sentinel"));
    });
    await t.test("cancellation closes pools and keeps existing committed catalog", async () => {
      const before = await readCatalog(runtime, Date.now() + 10000);
      const cancelled = new AbortController();
      const cancelledIO = {
        ...io,
        signal: cancelled.signal,
        transport: {
          ...io.transport,
          fetch: async (...parameters: Parameters<typeof fetch>) => { const response = await io.transport.fetch(...parameters); cancelled.abort(); return response; }
        }
      };
      assert.equal(await catalogCommand(args, cancelledIO), 2);
      const after = await readCatalog(runtime, Date.now() + 10000);
      assert.deepEqual(after.movies, before.movies);
      assert.deepEqual(after.mappings, before.mappings);
      assert.deepEqual(after.credits, before.credits);
      await inspectCatalog(resources, docker, id);
    });
    await t.test("A1: different container ID on inspected SAME named volume preserves data/UUIDs/counts", async () => {
      const before = await readCatalog(runtime, Date.now() + 10000);
      assert(before.movies.length > 0 &&
        before.credits.length > 0);
      await Promise.all(pools.splice(0).filter(p => !p.ended).map(p => p.end()));
      const oldId = await inspectCatalog(resources, docker, id);
      await docker(["rm", "--force", oldId]);
      id = "";
      assert.equal(await docker(["ps", "-a", "--no-trunc", "--filter", `id=${oldId}`, "--format", "{{.ID}}"]), "");
      id = await createCatalogContainer(resources, adminPassword, trackedDocker);
      assert.notEqual(id, oldId);
      await inspectCatalog(resources, docker, id);
      const recreatedAdmin = pool(true);
      await ready(recreatedAdmin);
      const recreatedRuntime = pool();
      assert.deepEqual(await readCatalog(recreatedRuntime, Date.now() + 10000), before);
      console.log(`A1 verified volume=${resources.volume} old=${oldId} new=${id} movies=${before.movies.length} mappings=${before.mappings.length} credits=${before.credits.length}`);
    });
  }
  finally {
    await Promise.all(pools.filter(p => !p.ended).map(p => p.end()));
    if (id) {
      await inspectCatalog(resources, docker, id);
      await docker(["rm", "--force", id]);
      assert.equal(await docker(["ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]), "");
    }
    for (const [kind, created] of [["network", networkCreated], ["volume", volumeCreated]] as const)
      if (created) {
        const result = JSON.parse(await docker([kind, "inspect", resources[kind], "--format", '{"Name":{{json .Name}},"Labels":{{json .Labels}}}'])) as {
          Name: string;
          Labels: Record<string, string>;
        };
        assert.equal(result.Name, resources[kind]);
        assert.equal(result.Labels["bor.catalog.test"], token);
        await docker([kind, "rm", resources[kind]]);
        assert(!(await docker([kind, "ls", "--format", "{{.Name}}"])).split(/\r?\n/).includes(resources[kind]));
      }
    console.log("Verified test-owned catalog container/network/volume teardown");
  }
});
