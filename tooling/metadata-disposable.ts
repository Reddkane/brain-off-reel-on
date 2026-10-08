import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import type { PoolClient } from "pg";
import { array, object } from "../src/server/providers/tmdb-validation.ts";

import { migrationFiles } from "../src/server/db/migration-files.ts";
export { migrationFiles } from "../src/server/db/migration-files.ts";

export interface Disposable {
  readonly pool: pg.Pool;
  readonly admin: pg.Pool;
  readonly guard: (client: PoolClient) => Promise<void>;
  readonly signal: AbortSignal;
  readonly containerId: string;
  readonly networkId: string;
  readonly upgrade: () => Promise<void>;
}

export interface DockerResult {
  readonly code: number;
  readonly output: string;
}

export type Docker = (args: string[], input?: string, signal?: AbortSignal) => Promise<DockerResult>;

export const docker: Docker = (args, input = "", signal = AbortSignal.timeout(30000)) => new Promise((resolve, reject) => {
  const child = spawn("docker", args, {
    shell: false,
    windowsHide: true,
    signal,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let output = "";

  child.stdout.setEncoding("utf8").on("data", (v: string) => {
    output += v;
  });

  // Never forward Docker stderr (may echo bootstrap stdin or configuration).
  child.stderr.resume();

  // Abort (timeout/cancel) is distinct from Docker being absent.
  child.on("error", error => reject(new Error(error.name === "AbortError" ? "docker_timeout" : "docker_unavailable")));

  child.on("close", code => resolve({
    code: code ?? 1,
    output
  }));

  child.stdin.on("error", () => { });
  child.stdin.end(input);
});

export function verifyContainer(value: unknown, id: string, token: string, network: string): number {
  verifyContainerIdentity(value, id, token, network);
  const ports = object(object(object(value).NetworkSettings).Ports);
  const mappings = array(ports["5432/tcp"], 1), binding = object(mappings[0]);

  if (Object.keys(ports).length !== 1 ||
    mappings.length !== 1 ||
    binding.HostIp !== "127.0.0.1" ||
    !/^\d+$/.test(String(binding.HostPort)) ||
    Number(binding.HostPort) < 1024 ||
    Number(binding.HostPort) > 65535)
    throw new Error("container_binding");

  return Number(binding.HostPort);
}

export function verifyContainerIdentity(value: unknown, id: string, token: string, network: string): void {
  const c = object(value), labels = object(object(c.Config).Labels), host = object(c.HostConfig);
  const nets = object(object(c.NetworkSettings).Networks), tmpfs = object(host.Tmpfs), mounts = array(c.Mounts, 10);

  if (c.Id !== id ||
    c.Name !== `/bor-pr03-${token}` ||
    labels["bor.pr03.disposable"] !== "true" ||
    labels["bor.pr03.run"] !== token ||
    host.NetworkMode !== network ||
    Object.keys(nets).length !== 1 ||
    !Object.hasOwn(nets, network) ||
    (host.Binds !== null &&
      array(host.Binds, 0).length) ||
    Object.keys(tmpfs).length !== 1 ||
    !Object.hasOwn(tmpfs, "/var/lib/postgresql/data") ||
    mounts.some(v => {
      const m = object(v);
      return m.Type !== "tmpfs" || m.Destination !== "/var/lib/postgresql/data";
    }))
    throw new Error("container_isolation");

  const configured = object(host.PortBindings), requested = array(configured["5432/tcp"], 1);

  if (Object.keys(configured).length !== 1 ||
    requested.length !== 1 ||
    object(requested[0]).HostIp !== "127.0.0.1" ||
    object(requested[0]).HostPort !== "")
    throw new Error("container_binding");
}

export function verifyNetwork(value: unknown, id: string, token: string) {
  const n = object(value), labels = object(n.Labels);

  if (n.Id !== id ||
    n.Name !== `bor-pr03-${token}` ||
    n.Driver !== "bridge" ||
    labels["bor.pr03.run"] !== token ||
    labels["bor.pr03.disposable"] !== "true")
    throw new Error("network_isolation");
}

export async function disposableGuard(client: PoolClient): Promise<void> {
  const result = await client.query<{
    database: string;
    valid: boolean;
  }>(
    "SELECT current_database() AS database, (SELECT count(*)=1 AND bool_and(name='bor-pr02-disposable') FROM test_support.marker) AS valid"
  );

  if (result.rows[0]?.database !== "bor_pr02_test" || result.rows[0]?.valid !== true)
    throw new Error("target_guard");
}

export async function withDisposable<T>(
  execute: (target: Disposable) => Promise<T>,
  options: {
    readonly signal?: AbortSignal;
    readonly docker?: Docker;
    /** Upgrade tests alone seed the merged sweeps baseline before remaining migrations. */
    readonly baseline?: "sweeps" | "classification";
    /** Production-path acceptance can start from migrations without synthetic catalog rows. */
    readonly fixtures?: boolean;
  } = {}
): Promise<T> {
  const interrupt = new AbortController();
  const interrupted = () => interrupt.abort();
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  const signal = AbortSignal.any([options.signal ?? AbortSignal.timeout(120000), interrupt.signal]), runDocker = options.docker ?? docker, token = randomBytes(12).toString("hex"), network = `bor-pr03-${token}`;
  let id = "", networkId = "";
  const pools: pg.Pool[] = [];
  let phase = AbortSignal.any([signal, AbortSignal.timeout(30000)]);

  async function checked(args: string[], input?: string, s = phase) {
    const r = await runDocker(args, input, AbortSignal.any([s, AbortSignal.timeout(10000)]));

    if (r.code)
      throw new Error(`docker_${args[0]}_failed`);

    return r.output.trim();
  }

  async function inspect() {
    const data: unknown = JSON.parse(await checked(["inspect", id]));
    return verifyContainer(array(data, 1)[0], id, token, network);
  }

  async function inspectTeardown() {
    const data: unknown = JSON.parse(await checked(["inspect", id]));
    verifyContainerIdentity(array(data, 1)[0], id, token, network);
  }

  async function inspectNetwork() {
    const data: unknown = JSON.parse(await checked(["network", "inspect", networkId]));
    verifyNetwork(array(data, 1)[0], networkId, token);
  }

  let workFailed = false, workError: unknown;

  try {
    await checked(["version"]);

    networkId = await checked([
      "network",
      "create",
      "--driver",
      "bridge",
      "--label",
      "bor.pr03.disposable=true",
      "--label",
      `bor.pr03.run=${token}`,
      network
    ]);

    if (!/^[a-f0-9]{64}$/.test(networkId))
      throw new Error("network_id");

    await inspectNetwork();
    const image = (await readFile(new URL("./db-image.txt", import.meta.url), "utf8")).trim();

    if (!/^postgres:17@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("image_pin");

    const password = randomBytes(32).toString("hex"), postgresPassword = randomBytes(32).toString("hex");

    // Hold the entrypoint until its random secret arrives over stdin. Neither
    // published TCP nor startup ever uses trust authentication.
    id = await checked([
      "run",
      "--detach",
      "--name",
      `bor-pr03-${token}`,
      "--network",
      network,
      "--label",
      "bor.pr03.disposable=true",
      "--label",
      `bor.pr03.run=${token}`,
      "--tmpfs",
      "/var/lib/postgresql/data",
      "--publish",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_DB=bor_pr02_test",
      image,
      "sh",
      "-c",
      'while [ ! -f /tmp/bor-password ]; do sleep 0.1; done; export POSTGRES_PASSWORD="$(cat /tmp/bor-password)"; rm /tmp/bor-password; exec docker-entrypoint.sh postgres'
    ]);

    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error("container_id");

    console.log(`Created bor-pr03 container=${id} network=${networkId}`);
    const port = await inspect(), deadline = Date.now() + 30000;
    await checked(["exec", "-i", id, "sh", "-c", "umask 077; cat > /tmp/bor-password"], postgresPassword);

    while ((await runDocker(
      ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "bor_pr02_test"],
      undefined,
      phase
    )).code !== 0) {
      phase.throwIfAborted();

      if (Date.now() >= deadline)
        throw new Error("startup_timeout");

      await new Promise(r => setTimeout(r, 100));
    }

    await inspect();

    async function sql(source: string, role: string) {
      await inspect();

      await checked([
        "exec",
        "-i",
        id,
        "psql",
        "-X",
        "--set=ON_ERROR_STOP=1",
        "--single-transaction",
        "-U",
        role,
        "-d",
        "bor_pr02_test"
      ], source);
    }

    await sql(await readFile(new URL("../tests/db/bootstrap.sql", import.meta.url), "utf8"), "postgres");

    await sql(
      `GRANT REFERENCES(id) ON auth.users TO bor_migrator; ALTER ROLE bor_migrator PASSWORD '${password}'; ALTER ROLE postgres PASSWORD '${postgresPassword}';`,
      "postgres"
    );

    const migrations = await migrationFiles();
    let applied = 0;
    async function upgrade() {
      while (applied < migrations.length) {
        const file = migrations[applied];
        await sql(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"), "bor_migrator");
        applied++;
      }
    }
    for (const file of migrations) {
      if (options.baseline === "sweeps" && file > "20261005000001_availability_sweeps.sql") break;
      if (options.baseline === "classification" && file > "20261006000001_watchmode_providers.sql") break;
      await sql(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"), "bor_migrator");
      applied++;
    }

    if (options.fixtures !== false) await sql(
      await readFile(new URL("../tests/fixtures/pr-02-synthetic.sql", import.meta.url), "utf8"),
      "bor_migrator"
    );

    await checked(
      ["exec", "-i", id, "sh", "-c", "cat > /var/lib/postgresql/data/pg_hba.conf"],
      "local all all trust\nhost all all 0.0.0.0/0 scram-sha-256\nhost all all ::/0 scram-sha-256\n"
    );

    await sql("SELECT pg_reload_conf();", "postgres");
    await inspect();
    await inspectNetwork();

    const config = {
      host: "127.0.0.1",
      port,
      database: "bor_pr02_test",
      user: "bor_migrator",
      password,
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      ssl: false as const,
      application_name: "bor-pr03-synthetic",
      query_timeout: 10000,
      options: "",
      allowExitOnIdle: true
    };

    const pool = new pg.Pool(config),
      admin = new pg.Pool({
        ...config,
        max: 2
      });

    pools.push(pool, admin);
    console.log(await checked(["exec", id, "postgres", "--version"]));
    console.log(await checked(["image", "inspect", image, "--format", "{{.Id}} {{.Os}}/{{.Architecture}}"]));
    phase = signal;

    return await execute({
      pool,
      admin,
      guard: disposableGuard,
      signal,
      containerId: id,
      networkId,
      upgrade
    });
  } catch (error) {
    workFailed = true;
    workError = error;
    throw error;
  } finally {
    // Cleanup ignores the work cancellation but has its own 30-second budget.
    const cleanupDeadline = AbortSignal.timeout(30000);

    phase = cleanupDeadline;

    const expired = new Promise<never>(
      (_, reject) => cleanupDeadline.addEventListener("abort", () => reject(new Error("cleanup_timeout")), {
        once: true
      })
    );

    try {
      await Promise.race([Promise.all(pools.map(p => p.end())), expired]);

      if (id) {
        await inspectTeardown();
        await checked(["rm", "--force", id]);

        if (await checked(["ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]))
          throw new Error("container_teardown");

        console.log(`Verified container teardown=${id}`);
      }

      if (networkId) {
        await inspectNetwork();
        await checked(["network", "rm", networkId]);

        if (await checked(["network", "ls", "--no-trunc", "--filter", `id=${networkId}`, "--format", "{{.ID}}"]))
          throw new Error("network_teardown");

        console.log(`Verified network teardown=${networkId}`);
      }
    } catch (cleanupError) {
      if (workFailed)
        throw new AggregateError([workError, cleanupError], "disposable_work_and_cleanup_failed");

      throw cleanupError;
    } finally {
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
    }
  }
}
