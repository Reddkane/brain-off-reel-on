import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { pathToFileURL, fileURLToPath } from "node:url";
import pg from "pg";
import { boundedText, catalogCode, decodePassword, privateDirectory, privateJson } from "./catalog-config.ts";
import { migrationFiles } from "../src/server/db/migration-files.ts";
import { repositorySha } from "./repository-sha.ts";
import { catalogSchemaState, currentMigrationCount, migrationTargetGuard } from "./catalog-schema.ts";
import { localCatalogGuard } from "../src/server/db/local-catalog-target.ts";
export const retained = Object.freeze({
  container: "bor-catalog-local",
  volume: "bor-catalog-local-pg17",
  network: "bor-catalog-local-net",
  port: 55432,
  label: "bor.catalog.local=v1"
});
export type CatalogResources = typeof retained | {
  container: string;
  volume: string;
  network: string;
  port: number;
  label: string;
};
export type Docker = (args: string[], input?: string, signal?: AbortSignal) => Promise<string>;
export const docker: Docker = (args, input = "", signal = AbortSignal.timeout(30000)) => new Promise((resolve, reject) => {
  const child = spawn("docker", args, {
    shell: false,
    windowsHide: true,
    signal,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (s: string) => { output += s; });
  child.stderr.resume(); // Docker/SQL errors can echo private input. Never forward them.
  child.stdin.on("error", () => { });
  child.on("error", () => reject(new Error("docker_failed")));
  child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error("docker_failed")));
  child.stdin.end(input);
});
export async function imagePin(): Promise<string> {
  const image = (await readFile(new URL("../tooling/db-image.txt", import.meta.url), "utf8")).trim();
  if (!/^postgres:17@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("image_pin");
  return image;
}
export function verifyCatalogContainer(c: Record<string, unknown>, r: CatalogResources, id?: string) {
  const config = c.Config as {
    Labels: Record<string, string>;
    Image: string;
  }, host = c.HostConfig as {
    NetworkMode: string;
    PortBindings: Record<string, {
      HostIp: string;
      HostPort: string;
    }[]>;
    AutoRemove: boolean;
    Tmpfs: Record<string, string> | null;
    Privileged: boolean;
    Mounts?: unknown[];
    Binds?: string[];
  }, mounts = c.Mounts as {
    Type: string;
    Name: string;
    Destination: string;
    RW: boolean;
  }[];
  const [key, value] = r.label.split("=");
  if (!/^[a-f0-9]{64}$/.test(String(c.Id)) ||
    (id &&
      c.Id !== id) ||
    c.Name !== `/${r.container}` ||
    config.Labels?.[key] !== value ||
    host.NetworkMode !== r.network ||
    host.AutoRemove ||
    host.Privileged ||
    Object.keys(host.Tmpfs ?? {}).length ||
    mounts.length !== 1 ||
    mounts[0].Type !== "volume" ||
    mounts[0].Name !== r.volume ||
    mounts[0].Destination !== "/var/lib/postgresql/data" ||
    !mounts[0].RW)
    throw new Error("container_identity");
  const bindings = host.PortBindings;
  if (Object.keys(bindings).length !== 1 ||
    bindings["5432/tcp"]?.length !== 1 ||
    bindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
    bindings["5432/tcp"][0].HostPort !== String(r.port))
    throw new Error("container_binding");
  const networks = (c.NetworkSettings as {
    Networks: Record<string, unknown>;
    Ports: Record<string, {
      HostIp: string;
      HostPort: string;
    }[] | null>;
  }).Networks;
  if (Object.keys(networks).length &&
    (Object.keys(networks).length !== 1 ||
      !Object.hasOwn(networks, r.network)))
    throw new Error("container_network");
  if ((c.State as {
    Running: boolean;
  }).Running) {
    const ports = (c.NetworkSettings as {
      Ports: Record<string, {
        HostIp: string;
        HostPort: string;
      }[]>;
    }).Ports;
    if (Object.keys(networks).length !== 1 ||
      Object.keys(ports).length !== 1 ||
      ports["5432/tcp"]?.length !== 1 ||
      ports["5432/tcp"][0].HostIp !== "127.0.0.1" ||
      ports["5432/tcp"][0].HostPort !== String(r.port))
      throw new Error("container_binding");
  }
  return String(c.Id);
}
export async function inspectCatalog(r: CatalogResources = retained, io: Docker = docker, id?: string) {
  // Select fields explicitly; never retrieve Config.Env.
  const c = JSON.parse(await io(["inspect", id ?? r.container, "--format", '{"Id":{{json .Id}},"Name":{{json .Name}},"State":{"Running":{{json .State.Running}}},"Config":{"Labels":{{json .Config.Labels}},"Image":{{json .Config.Image}}},"HostConfig":{"NetworkMode":{{json .HostConfig.NetworkMode}},"PortBindings":{{json .HostConfig.PortBindings}},"AutoRemove":{{json .HostConfig.AutoRemove}},"Tmpfs":{{json (index .HostConfig "Tmpfs")}},"Privileged":{{json .HostConfig.Privileged}}},"Mounts":{{json .Mounts}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}},"Ports":{{json .NetworkSettings.Ports}}}}'])) as Record<string, unknown>;
  verifyCatalogContainer(c, r, id);
  if ((c.Config as {
    Image: string;
  }).Image !== await imagePin())
    throw new Error("container_image");
  for (const kind of ["volume", "network"] as const) {
    const resource = JSON.parse(await io([kind, "inspect", r[kind], "--format", '{"Name":{{json .Name}},"Labels":{{json .Labels}}}'])) as {
      Name: string;
      Labels: Record<string, string>;
    };
    const [key, value] = r.label.split("=");
    if (resource.Name !== r[kind] ||
      resource.Labels?.[key] !== value)
      throw new Error("resource_identity");
  }
  return String(c.Id);
}
export async function freePort(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("port_occupied")));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(new Error("port_occupied")) : resolve()));
  });
}
export async function refuseCollisions(r: CatalogResources, io: Docker = docker) {
  if (await io(["ps", "-a", "--filter", `name=^/${r.container}$`, "--format", "{{.ID}}", "--no-trunc"]) ||
    (await io(["volume", "ls", "--format", "{{.Name}}"])).split(/\r?\n/).includes(r.volume) ||
    (await io(["network", "ls", "--format", "{{.Name}}"])).split(/\r?\n/).includes(r.network))
    throw new Error("resource_occupied");
  await freePort(r.port);
}
export async function createCatalogContainer(r: CatalogResources, password: string, io: Docker = docker) {
  const id = await io(["run", "--pull=never", "--detach", "--name", r.container, "--network", r.network, "--label", r.label,
    "--mount", `type=volume,src=${r.volume},dst=/var/lib/postgresql/data`, "--publish", `127.0.0.1:${r.port}:5432`,
    "-e", "POSTGRES_DB=bor_catalog_local", "-e", "POSTGRES_PASSWORD_FILE=/tmp/bor-password", "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", await imagePin(),
    "sh", "-c", "while [ ! -f /tmp/bor-password ]; do sleep 0.1; done; exec docker-entrypoint.sh postgres"]);
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new Error("container_id");
  await inspectCatalog(r, io, id);
  await io(["exec", "-i", id, "sh", "-c", "umask 077; cat > /tmp/bor-password.tmp && mv /tmp/bor-password.tmp /tmp/bor-password"], password);
  return id;
}
export function catalogPool(password: string, port: number = retained.port, admin = false) {
  const pool = new pg.Pool({
    host: "127.0.0.1",
    port,
    database: "bor_catalog_local",
    user: admin ? "postgres" : "bor_catalog_ingest",
    password,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    query_timeout: 5000,
    statement_timeout: 5000,
    options: "",
    ssl: false,
    application_name: "bor-catalog-local",
    allowExitOnIdle: true
  });
  pool.on("error", () => { });
  return pool;
}
export async function ready(pool: pg.Pool) {
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      await pool.query("SELECT 1");
      return;
    }
    catch {
      if (Date.now() >= deadline)
        throw new Error("startup_failed");
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
export async function setupSchema(pool: pg.Pool, runtimePassword: string) {
  if (!/^[a-f0-9]{64}$/.test(runtimePassword))
    throw new Error("credential_invalid");
  const client = await pool.connect();
  try {
    const unexpected = await client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'");
    const objects = await client.query("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace");
    const roles = await client.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','bor_catalog_ingest')");
    if (unexpected.rows.length ||
      objects.rows[0].count ||
      roles.rows[0].count)
      throw new Error("setup_nonempty");
    await client.query("BEGIN");
    await client.query(await readFile(new URL("./catalog-prerequisites.sql", import.meta.url), "utf8"));
    await client.query("COMMIT");
    for (const file of await migrationFiles()) {
      await client.query("BEGIN");
      await client.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
      await client.query("COMMIT");
    }
    // A single final transaction makes marker + enabled runtime login atomic.
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA local_support; REVOKE ALL ON SCHEMA local_support FROM PUBLIC; CREATE TABLE local_support.marker(name text PRIMARY KEY); INSERT INTO local_support.marker VALUES ('bor-catalog-local-v1'); CREATE ROLE bor_catalog_ingest LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT CONNECT ON DATABASE bor_catalog_local TO bor_catalog_ingest; GRANT service_role TO bor_catalog_ingest WITH SET TRUE, INHERIT FALSE, ADMIN FALSE; GRANT USAGE ON SCHEMA local_support TO bor_catalog_ingest; GRANT SELECT ON local_support.marker TO bor_catalog_ingest;");
    await client.query("SELECT set_config('bor.runtime_password',$1,true)", [runtimePassword]);
    await client.query("DO $$ BEGIN EXECUTE format('ALTER ROLE bor_catalog_ingest PASSWORD %L', current_setting('bor.runtime_password')); END $$");
    await client.query("COMMIT");
  }
  catch (error) {
    await client.query("ROLLBACK").catch(() => { });
    throw new Error(catalogCode(error, "setup_failed_inspect_required"));
  }
  finally {
    client.release();
  }
}
export async function upgradeSchema(pool: pg.Pool) {
  if (pool.options.host !== "127.0.0.1" || pool.options.database !== "bor_catalog_local" ||
    pool.options.user !== "postgres")
    throw new Error("target_guard");
  const client = await pool.connect();
  let applied = 0, locked = false;
  try {
    await migrationTargetGuard(client);
    const lock = await client.query("SELECT pg_try_advisory_lock(1112494674,1) AS locked");
    if (!lock.rows[0]?.locked)
      throw new Error("refresh_overlap");
    locked = true;
    const state = await catalogSchemaState(client);
    const files = await migrationFiles();
    for (const file of files.slice(state)) {
      await client.query("BEGIN");
      await migrationTargetGuard(client);
      await client.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
      await client.query("COMMIT");
      applied++;
    }
    if (await catalogSchemaState(client) !== files.length)
      throw new Error("upgrade_state_unknown");
    return { applied, current: true };
  }
  catch (error) {
    await client.query("ROLLBACK").catch(() => { });
    throw new Error(catalogCode(error, "upgrade_failed_inspect_required"));
  }
  finally {
    if (locked)
      await client.query("SELECT pg_advisory_unlock(1112494674,1)").catch(() => { });
    client.release();
  }
}
export async function completedSetup(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await localCatalogGuard(client);
    const role = (await client.query("SELECT rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=session_user")).rows[0];
    if (!role?.rolcanlogin ||
      role.rolinherit ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolreplication ||
      role.rolbypassrls)
      throw new Error("runtime_role_invalid");
    const membership = (await client.query("SELECT r.rolname,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname=session_user)")).rows;
    if (membership.length !== 1 ||
      membership[0].rolname !== "service_role" ||
      membership[0].admin_option ||
      membership[0].inherit_option ||
      !membership[0].set_option)
      throw new Error("runtime_membership_invalid");
    await client.query("BEGIN READ ONLY; SET LOCAL ROLE service_role");
    // Inspect all released application relations and named immutable validators.
    if (await catalogSchemaState(client) !== currentMigrationCount)
      throw new Error("upgrade_required");
    await client.query("SELECT app.text_array_nonblank(ARRAY[]::text[]),app.profile_content_policy_valid('{}'::jsonb)");
    await client.query("COMMIT");
  }
  catch (error) {
    await client.query("ROLLBACK").catch(() => { });
    throw new Error(catalogCode(error, "setup_incomplete"));
  }
  finally {
    client.release();
  }
}
export async function localCommand(action: string, resources: CatalogResources = retained, directory = privateDirectory, io: Docker = docker,
  backup?: { phase: import("./catalog-backup.ts").BackupPhase; root: string; signal: AbortSignal }) {
  if (!["inspect", "setup", "upgrade", "start", "stop", "backup"].includes(action))
    throw new Error("invalid_action");
  if (action === "backup" && !backup) throw new Error("invalid_arguments");
  if (action === "backup") {
    const { backupCatalog } = await import("./catalog-backup.ts");
    let password: string;
    try { password = decodePassword(privateJson(await boundedText(`${directory}/setup.json`, 4096))); }
    catch { throw new Error("setup_credential_failed"); }
    const pool = catalogPool(password, resources.port, true);
    try {
      return await backupCatalog(backup!.phase, {
        root: backup!.root, signal: backup!.signal, pool, sha: repositorySha,
        inspect: signal => inspectCatalog(resources, (args, input) => io(args, input, signal)),
      });
    }
    finally { await pool.end(); }
  }
  await io(["version", "--format", "{{.Server.Version}}"]);
  const present = await io(["ps", "-a", "--filter", `name=^/${resources.container}$`, "--format", "{{.ID}}", "--no-trunc"]);
  if (!present &&
    action === "setup") {
    await refuseCollisions(resources, io);
    // Never start an implicit pull after reserving fixed names/private files.
    try {
      await io(["image", "inspect", await imagePin(), "--format", "{{.Id}}"]);
    }
    catch {
      throw new Error("image_not_cached");
    }
    await mkdir(directory, {
      recursive: true,
      mode: 0o700
    });
    const adminPassword = randomBytes(32).toString("hex"), runtimePassword = randomBytes(32).toString("hex");
    try {
      await writeFile(`${directory}/setup.json`, JSON.stringify({
        password: adminPassword
      }), {
        flag: "wx",
        mode: 0o600
      });
      await writeFile(`${directory}/runtime.json`, JSON.stringify({
        password: runtimePassword
      }), {
        flag: "wx",
        mode: 0o600
      });
    }
    catch (error) {
      if (error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST")
        throw new Error("credential_file_exists");
      throw error;
    }
    await io(["volume", "create", "--label", resources.label, resources.volume]);
    await io(["network", "create", "--driver", "bridge", "--label", resources.label, resources.network]);
    await createCatalogContainer(resources, adminPassword, io);
    const pool = catalogPool(adminPassword, resources.port, true);
    try {
      await ready(pool);
      await setupSchema(pool, runtimePassword);
    }
    finally {
      await pool.end();
    }
  }
  else {
    const id = await inspectCatalog(resources, io);
    if (action === "start") {
      const running = await io(["inspect", id, "--format", "{{.State.Running}}"]);
      if (running !== "true") {
        await freePort(resources.port);
        await io(["start", id]);
      }
    }
    if (action === "stop") {
      await io(["stop", "--time", "10", id]);
      return;
    }
  }
  await inspectCatalog(resources, io);
  let upgradeResult;
  if (action === "upgrade") {
    let adminPassword: string;
    try {
      adminPassword = decodePassword(privateJson(await boundedText(`${directory}/setup.json`, 4096)));
    }
    catch {
      throw new Error("setup_credential_failed");
    }
    const admin = catalogPool(adminPassword, resources.port, true);
    try {
      upgradeResult = await upgradeSchema(admin);
    }
    finally {
      await admin.end();
    }
  }
  let password: string;
  try {
    password = decodePassword(privateJson(await boundedText(`${directory}/runtime.json`, 4096)));
  }
  catch (error) {
    throw new Error(catalogCode(error, "runtime_credential_failed"));
  }
  const pool = catalogPool(password, resources.port);
  try {
    if (action === "start")
      await ready(pool);
    await completedSetup(pool);
    return upgradeResult;
  }
  finally {
    await pool.end();
  }
}
export async function catalogLocalDiagnostic(action: string, error: unknown) {
  const { backupCode } = await import("./catalog-backup.ts");
  return catalogCode(error, action === "backup" ? backupCode(error) : "catalog_local_failed_inspect_required");
}
if (process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const args = process.argv.slice(2), action = args[0];
    const isBackup = action === "backup";
    if (isBackup ? args.length !== 3 || args[1] !== "--phase" || !["before-upgrade", "after-upgrade"].includes(args[2]) : args.length !== 1)
      throw new Error("invalid_arguments");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const result = await localCommand(action, retained, `${root}/.cache/real-catalog/private`, docker,
      isBackup ? { phase: args[2] as import("./catalog-backup.ts").BackupPhase, root, signal: controller.signal } : undefined);
    if (result && "code" in result) {
      console.log(JSON.stringify({ code: result.code, manifest: result.manifest, dump: result.dump, digest: result.digest, schemaState: result.schemaState }));
    }
    else console.log(result ? (result.applied ? "catalog_upgrade_applied" : "catalog_upgrade_current") : "catalog_local_ok");
  }
  catch (error) {
    console.error(await catalogLocalDiagnostic(process.argv[2], error));
    process.exitCode = 1;
  }
  finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
