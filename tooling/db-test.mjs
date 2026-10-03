import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const database = "bor_pr02_test";
/** @typedef {{code:number, stdout:string, stderr:string}} Result */
/** @typedef {(args:string[], input?:string, signal?:AbortSignal)=>Promise<Result>} Docker */

/** @param {string} executable @param {string[]} args @param {string} [input] @param {AbortSignal} [signal] @returns {Promise<Result>} */
export function subprocess(executable, args, input = "", signal) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: root, shell: false, windowsHide: true, signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.on("error", (error) => { if (!("code" in error) || error.code !== "EPIPE") reject(error); });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}
/** @param {string[]} args */
export function validateArguments(args) {
  if (args.length) throw new Error("test:db accepts no arguments or external database targets");
}
/** @param {unknown} value @param {string} id @param {string} token */
export function verifyContainer(value, id, token) {
  // Runtime validation before any SQL or destruction; no pre-existing name is a target.
  if (!value || typeof value !== "object") throw new Error("Invalid container inspection");
  const container = /** @type {{Id?:string, Name?:string, Config?:{Labels?:Record<string,string>}, HostConfig?:{NetworkMode?:string, PortBindings?:object, Binds?:unknown[], Tmpfs?:Record<string,string>}, Mounts?:{Type:string,Destination:string}[], NetworkSettings?:{Ports?:object}}} */ (value);
  if (container.Id !== id || container.Name !== `/bor-pr02-${token}` ||
      container.Config?.Labels?.["bor.pr02.disposable"] !== "true" || container.Config?.Labels?.["bor.pr02.run"] !== token ||
      container.HostConfig?.NetworkMode !== "none" || Object.keys(container.HostConfig?.PortBindings ?? {}).length ||
      Object.keys(container.NetworkSettings?.Ports ?? {}).some((key) => /** @type {Record<string,unknown>} */ (container.NetworkSettings?.Ports)[key] !== null) ||
      (container.HostConfig?.Binds?.length ?? 0) || Object.keys(container.HostConfig?.Tmpfs ?? {}).length !== 1 || !Object.hasOwn(container.HostConfig?.Tmpfs ?? {}, "/var/lib/postgresql/data") ||
      (container.Mounts ?? []).some((mount) => mount.Type !== "tmpfs" || mount.Destination !== "/var/lib/postgresql/data")) {
    throw new Error("Container identity/isolation mismatch; refusing SQL/removal");
  }
}

/** @param {{docker:Docker,image:string,token?:string,signal?:AbortSignal,now?:()=>number,pause?:()=>Promise<void>,execute:(sql:(text:string,role?:string)=>Promise<string>)=>Promise<void>}} options */
export async function disposable(options) {
  const { docker, image, signal } = options;
  const token = options.token ?? randomBytes(12).toString("hex");
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (() => new Promise((done) => setTimeout(done, 250)));
  let id = "";
  /** @param {string[]} args @param {string} [input] @param {AbortSignal} [commandSignal] */
  async function checked(args, input, commandSignal = signal) {
    const result = await docker(args, input, commandSignal);
    if (result.code) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
  }
  async function inspect() {
    const response = await checked(["inspect", id], undefined, AbortSignal.timeout(10000));
    verifyContainer(JSON.parse(response)[0], id, token);
  }
  try {
    await checked(["version"]);
    const created = (await checked(["run", "--detach", "--name", `bor-pr02-${token}`, "--network", "none",
      "--label", "bor.pr02.disposable=true", "--label", `bor.pr02.run=${token}`, "--tmpfs", "/var/lib/postgresql/data",
      "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", `POSTGRES_DB=${database}`, image], undefined, AbortSignal.timeout(60000))).trim();
    if (!/^[a-f0-9]{64}$/.test(created)) throw new Error("Docker returned invalid created container ID");
    id = created;
    console.log(`Created disposable ${id} run=${token}`);
    await inspect();
    const deadline = now() + 30000;
    while (true) {
      signal?.throwIfAborted();
      const ready = await docker(["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", database], undefined, signal);
      if (ready.code === 0) break;
      if (now() >= deadline) throw new Error("Postgres loopback readiness exceeded 30 seconds");
      await pause();
    }
    await inspect();
    console.log(await checked(["exec", id, "postgres", "--version"]));
    console.log(await checked(["image", "inspect", image, "--format", "{{.Id}} {{.Os}}/{{.Architecture}} {{json .RepoDigests}}"]));
    /** @param {string} text @param {string} [role] */
    async function sql(text, role = "bor_migrator") {
      signal?.throwIfAborted();
      await inspect();
      const marker = role === "bor_migrator" ? "DO $$ BEGIN IF current_database()<>'bor_pr02_test' OR NOT EXISTS (SELECT 1 FROM test_support.marker WHERE name='bor-pr02-disposable') THEN RAISE EXCEPTION 'Disposable marker mismatch'; END IF; END $$;\n" : "";
      const result = await docker(["exec", "-i", id, "psql", "-h", "127.0.0.1", "-X", "--set=ON_ERROR_STOP=1", "--single-transaction", "-U", role, "-d", database], marker + text, signal);
      // SQL logs contain only synthetic assertion names and fixed fixture identities.
      process.stdout.write(result.stdout); process.stdout.write(result.stderr);
      if (result.code) throw new Error("Database SQL acceptance failed");
      return result.stdout;
    }
    await options.execute(sql);
  } finally {
    if (id) {
      await inspect();
      await checked(["rm", "--force", id], undefined, AbortSignal.timeout(10000));
      const remaining = await checked(["ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"], undefined, AbortSignal.timeout(10000));
      if (remaining.trim()) throw new Error(`Disposable teardown failed: ${id}`);
      console.log(`Verified teardown ${id}`);
    }
  }
}

/** @param {(text:string,role?:string)=>Promise<string>} sql @param {boolean} controls */
async function databaseChecks(sql, controls) {
  await sql("DO $$ BEGIN IF current_database()<>'bor_pr02_test' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'Wrong disposable target/version'; END IF; END $$;", "postgres");
  await sql(await readFile(resolve(root, "tests/db/bootstrap.sql"), "utf8"), "postgres");
  await sql(`DO $$ BEGIN
    BEGIN CREATE TABLE test_support.reference_probe(id uuid REFERENCES auth.users(id));
      RAISE EXCEPTION 'Missing REFERENCES unexpectedly passed';
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS REFERENCES prerequisite denied 42501'; END;
  END $$;`);
  await sql("GRANT REFERENCES(id) ON auth.users TO bor_migrator;", "postgres");
  await sql("CREATE TABLE test_support.reference_probe(id uuid REFERENCES auth.users(id)); DROP TABLE test_support.reference_probe; SELECT name FROM test_support.marker; SELECT current_user,version();");
  for (const file of ["20261002000001_catalog.sql", "20261002000002_personal.sql", "20261002000003_access.sql"]) {
    await sql(await readFile(resolve(root, "supabase/migrations", file), "utf8"));
  }
  await sql(await readFile(resolve(root, "tests/fixtures/pr-02-synthetic.sql"), "utf8"));
  await sql(await readFile(resolve(root, "tests/db/assertions.sql"), "utf8"));
  /** @param {string} phase */
  async function green(phase) {
    console.log(`GREEN ${phase}`);
    for (const file of ["schema.sql", "access.sql"]) await sql(await readFile(resolve(root, "tests/db", file), "utf8"));
  }
  await green("baseline");
  if (controls) {
    await sql(await readFile(resolve(root, "tests/db/mutations.sql"), "utf8"));
    await green("final after rollback controls");
  }
}

async function main() {
  validateArguments(process.argv.slice(2));
  const tests = await subprocess(process.execPath, ["--test", "tests/db/runner.test.mjs"]);
  process.stdout.write(tests.stdout); process.stderr.write(tests.stderr);
  if (tests.code) throw new Error("Docker-independent runner tests failed");
  const image = (await readFile(resolve(root, "tooling/db-image.txt"), "utf8")).trim();
  if (!/^postgres:17@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Invalid PostgreSQL 17 image pin");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("Database runner exceeded five minutes")), 300000);
  const interrupt = () => abort.abort(new Error("Database runner interrupted"));
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    /** @type {Docker} */ const docker = (args, input, signal) => subprocess("docker", args, input, signal);
    await disposable({ docker, image, signal: abort.signal, execute: (sql) => databaseChecks(sql, true) });
    console.log("RESET fresh container replay");
    await disposable({ docker, image, signal: abort.signal, execute: (sql) => databaseChecks(sql, false) });
    console.log("PASS final green, fresh reset and verified teardown");
  } finally {
    clearTimeout(timeout); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
