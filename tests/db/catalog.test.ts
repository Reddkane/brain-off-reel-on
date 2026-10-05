// Isolated synthetic resources only. This file alone owns destructive cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { readFile, writeFile, mkdtemp, unlink, rmdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { catalogPool, completedSetup, createCatalogContainer, docker, inspectCatalog, localCommand, ready, refuseCollisions, setupSchema } from "../../scripts/catalog-local.ts";
import { catalogCommand } from "../../scripts/catalog-import.ts";
import type { CatalogIO } from "../../scripts/catalog-import.ts";
import { decodePassword, privateJson, firstImportLimits, subscriptions } from "../../scripts/catalog-config.ts";
import { localCatalogGuard, readCatalog } from "../../src/server/db/local-catalog-target.ts";
import { acquireRefreshLock } from "../../src/server/db/refresh-lock.ts";
import { createPgStore } from "../../src/server/db/pg-store.ts";
import { fixtures } from "../../tooling/metadata-fixtures.ts";
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
      assert(Object.values(after.excluded).every(n => n === 0));
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
