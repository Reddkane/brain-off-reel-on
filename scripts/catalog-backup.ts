import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, unlink, lstat, writeFile, type FileHandle } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool, PoolClient } from "pg";
import { catalogSchemaState, migrationTargetGuard } from "./catalog-schema.ts";
import { boundedText, privateJson } from "./catalog-config.ts";
import { safePrivateDirectory } from "./private-directory.ts";
import { calendarMonths } from "../src/domain/availability-evidence.ts";

export const identityDigestSql = `SELECT
  (SELECT count(*) FROM app.movies) AS movies,
  (SELECT count(*) FROM app.movie_external_ids) AS external_ids,
  (SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id::text,
    to_char(metadata_refreshed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    ORDER BY id)::text, '[]')) FROM app.movies) AS movies_md5,
  (SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(movie_id::text, source, external_id)
    ORDER BY movie_id, source COLLATE "C", external_id COLLATE "C")::text, '[]'))
    FROM app.movie_external_ids) AS external_ids_md5,
  (SELECT to_char(min(metadata_refreshed_at) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM app.movies) AS oldest_metadata_refreshed_at,
  (SELECT count(*) FROM app.profiles) AS profiles,
  (SELECT count(*) FROM app.profile_subscriptions) AS profile_subscriptions,
  (SELECT count(*) FROM app.profile_movies) AS profile_movies,
  (SELECT count(*) FROM app.selection_sessions) AS selection_sessions,
  (SELECT count(*) FROM app.recommendations) AS recommendations,
  (SELECT count(*) FROM app.feedback_events) AS feedback_events`;
export const acquisitionSql = `SELECT
  (SELECT count(*) FROM app.movie_external_ids e JOIN app.movies m ON m.id=e.movie_id
    WHERE (SELECT count(*) FROM app.movie_external_id_acquisitions a
      WHERE a.movie_id=e.movie_id AND a.source=e.source AND a.acquisition_path='tmdb_metadata'
        AND a.acquired_at=m.metadata_refreshed_at) <> 1) AS acquisition_mismatches,
  (SELECT count(*) FROM app.movie_external_id_acquisitions a JOIN app.movies m ON m.id=a.movie_id
    WHERE a.acquisition_path<>'tmdb_metadata' OR a.acquired_at<>m.metadata_refreshed_at) AS unexpected_acquisitions`;
export type BackupPhase = "before-upgrade" | "after-upgrade";
export interface BackupIO {
  readonly root: string;
  readonly containerId?: string;
  readonly pool: Pool;
  readonly signal: AbortSignal;
  readonly sha: (signal: AbortSignal) => Promise<string>;
  readonly inspect: (signal: AbortSignal) => Promise<string>;
  readonly now?: () => number;
  readonly id?: () => string;
  readonly stream?: (file: FileHandle) => Writable;
  readonly spawn?: (args: string[], signal: AbortSignal) => ChildProcessWithoutNullStreams;
  // Tests may lower ceilings, never enlarge them.
  readonly durationMs?: number;
  readonly maxBytes?: number;
}
export function sameIdentity(before: unknown, after: unknown): boolean {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
  const keys = ["movies", "external_ids", "movies_md5", "external_ids_md5", "oldest_metadata_refreshed_at",
    "profiles", "profile_subscriptions", "profile_movies", "selection_sessions", "recommendations", "feedback_events"];
  return keys.every(key => Object.hasOwn(before, key) && Object.hasOwn(after, key) &&
    Reflect.get(before, key) === Reflect.get(after, key));
}
const backupCodes = new Set(["backup_phase_invalid", "backup_phase_mismatch", "backup_deadline", "backup_cancelled",
  "backup_size_limit", "backup_dump_failed", "backup_archive_invalid", "backup_manifest_invalid", "backup_lock_lost", "backup_file_exists",
  "backup_retention_expired", "backup_acquisition_failed", "backup_cleanup_failed", "backup_failed",
  "refresh_overlap", "target_guard", "upgrade_state_unknown", "private_path_required", "repository_sha_failed"]);
export function backupCode(error: unknown) {
  return error instanceof Error && backupCodes.has(error.message) ? error.message : "backup_failed";
}
const defaultSpawn = (args: string[], signal: AbortSignal) => spawn("docker", args, {
  shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal,
});
export async function verifyBackup(dump: string, manifestPath: string, signal: AbortSignal) {
  const name = basename(dump);
  if (!/^catalog-backup-[a-f0-9-]{36}\.dump$/.test(name) || dirname(dump) !== dirname(manifestPath) ||
    basename(manifestPath) !== name.replace(/\.dump$/, ".manifest.json")) throw new Error("backup_manifest_invalid");
  const stat = await lstat(dump), manifestStat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("backup_manifest_invalid");
  const manifest = privateJson(await boundedText(manifestPath, 65536));
  if (!manifest || typeof manifest !== "object" || !("success" in manifest) || manifest.success !== true ||
    !("bytes" in manifest) || manifest.bytes !== stat.size || stat.size < 5 || stat.size > 64 * 1024 * 1024 ||
    !("sha256" in manifest) || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("backup_manifest_invalid");
  const value = manifest as Record<string, unknown>;
  const expectedId = name.slice("catalog-backup-".length, -".dump".length);
  if (value.id !== expectedId || !["before-upgrade", "after-upgrade"].includes(String(value.phase)) ||
    value.schemaState !== (value.phase === "before-upgrade" ? 3 : 5) ||
    typeof value.sha !== "string" || !/^[a-f0-9]{40}$/.test(value.sha) ||
    typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) || !value.digest || typeof value.digest !== "object") throw new Error("backup_manifest_invalid");
  const digest = value.digest as Record<string, unknown>;
  for (const key of ["movies", "external_ids", "profiles", "profile_subscriptions", "profile_movies", "selection_sessions", "recommendations", "feedback_events"])
    if (typeof digest[key] !== "string" || !/^(?:0|[1-9]\d*)$/.test(digest[key])) throw new Error("backup_manifest_invalid");
  for (const key of ["movies_md5", "external_ids_md5"])
    if (typeof digest[key] !== "string" || !/^[a-f0-9]{32}$/.test(digest[key])) throw new Error("backup_manifest_invalid");
  const oldest = digest.oldest_metadata_refreshed_at;
  if (oldest !== null && (typeof oldest !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(oldest) ||
    !Number.isFinite(Date.parse(oldest)))) throw new Error("backup_manifest_invalid");
  if ((digest.movies === "0") !== (oldest === null) || value.retentionDeadline !== (oldest === null ? null :
    new Date(calendarMonths(Date.parse(String(oldest)), 6)).toISOString())) throw new Error("backup_manifest_invalid");
  if (value.phase === "before-upgrade") {
    if (value.acquisition !== null) throw new Error("backup_manifest_invalid");
  }
  else {
    if (!value.acquisition || typeof value.acquisition !== "object" ||
      Reflect.get(value.acquisition, "acquisition_mismatches") !== "0" || Reflect.get(value.acquisition, "unexpected_acquisitions") !== "0")
      throw new Error("backup_manifest_invalid");
  }
  const hash = createHash("sha256");
  await pipeline(createReadStream(dump), hash, { signal });
  if (hash.digest("hex") !== manifest.sha256) throw new Error("backup_manifest_invalid");
}
/** One dedicated lock/snapshot session; pg_dump imports its read-only snapshot. */
export async function backupCatalog(phase: BackupPhase, io: BackupIO) {
  if (!["before-upgrade", "after-upgrade"].includes(phase)) throw new Error("backup_phase_invalid");
  if ((io.containerId !== undefined && !/^[a-f0-9]{64}$/.test(io.containerId)) || io.pool.options.host !== "127.0.0.1" ||
    io.pool.options.database !== "bor_catalog_local" || io.pool.options.user !== "postgres") throw new Error("target_guard");
  const controller = new AbortController(), began = (io.now ?? Date.now)();
  let failure = "backup_cancelled";
  const duration = Math.max(1, Math.min(120000, io.durationMs ?? 120000));
  const timer = setTimeout(() => { failure = "backup_deadline"; controller.abort(); }, duration);
  const signal = AbortSignal.any([io.signal, controller.signal]);
  const launch = io.spawn ?? defaultSpawn;
  let dumpPath = "", manifestPath = "", dumpOwned = false, manifestOwned = false;
  let client: PoolClient | undefined, locked = false, success = false;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let health: Promise<void> = Promise.resolve();
  const lost = () => { if (!signal.aborted) { failure = "backup_lock_lost"; controller.abort(); } };
  const check = () => { if (signal.aborted) throw new Error(failure); };
  async function abortable<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error(failure));
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
      if (signal.aborted) abort();
    });
  }
  async function query(sql: string) {
    if (!client) throw new Error("backup_failed");
    return abortable(client.query(sql));
  }
  async function childWork(args: string[], work: (child: ChildProcessWithoutNullStreams) => Promise<void>, code: string) {
    check();
    const child = launch(args, signal);
    child.stderr.resume();
    child.stdin.on("error", () => {});
    const settled = new Promise<void>((resolve, reject) => {
      let errored = false;
      child.on("error", () => { errored = true; });
      child.on("close", exit => exit === 0 && !errored ? resolve() : reject(new Error(code)));
    });
    const streaming = work(child).catch(error => {
      child.kill();
      throw error instanceof Error && backupCodes.has(error.message) ? error : new Error(code);
    });
    const results = await Promise.allSettled([streaming, settled]);
    check();
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  try {
    check();
    const containerId = await abortable(io.inspect(signal));
    if (!/^[a-f0-9]{64}$/.test(containerId) || (io.containerId !== undefined && containerId !== io.containerId)) throw new Error("target_guard");
    check();
    client = await abortable<PoolClient>(io.pool.connect().then(acquired => {
      if (signal.aborted) { acquired.release(true); throw new Error(failure); }
      return acquired;
    }));
    client.on("error", lost);
    client.on("end", lost);
    await abortable(migrationTargetGuard(client));
    check();
    if (!(await query("SELECT pg_try_advisory_lock(1112494674,1) AS locked")).rows[0]?.locked)
      throw new Error("refresh_overlap");
    locked = true;
    healthTimer = setInterval(() => {
      health = health.then(async () => {
        if (!signal.aborted && client && locked) {
          const row = (await query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
            AND locktype='advisory' AND classid=1112494674 AND objid=1 AND objsubid=2 AND granted) AS held`)).rows[0];
          if (!row.held) lost();
        }
      }).catch(lost);
    }, 1000);
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL TIME ZONE 'UTC'; SET LOCAL statement_timeout='5s'");
    await abortable(migrationTargetGuard(client));
    const state = await abortable(catalogSchemaState(client));
    if (state !== (phase === "before-upgrade" ? 3 : 5)) throw new Error("backup_phase_mismatch");
    const snapshot = (await query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    if (!/^[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+$/.test(snapshot)) throw new Error("backup_failed");
    const digest = (await query(identityDigestSql)).rows[0];
    const acquisition = state === 5 ? (await query(acquisitionSql)).rows[0] : null;
    if (acquisition && (acquisition.acquisition_mismatches !== "0" || acquisition.unexpected_acquisitions !== "0"))
      throw new Error("backup_acquisition_failed");
    const oldest = digest.oldest_metadata_refreshed_at;
    const retentionDeadline = oldest ? new Date(calendarMonths(Date.parse(oldest), 6)).toISOString() : null;
    if (retentionDeadline && began > Date.parse(retentionDeadline)) throw new Error("backup_retention_expired");
    const sha = await abortable(io.sha(signal));
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("repository_sha_failed");
    check();
    const directory = await safePrivateDirectory(io.root, [".cache", "real-catalog", "private"]);
    const id = io.id ? io.id() : randomUUID();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error("backup_failed");
    dumpPath = join(directory, `catalog-backup-${id}.dump`);
    manifestPath = join(directory, `catalog-backup-${id}.manifest.json`);
    const file = await open(dumpPath, "wx", 0o600);
    dumpOwned = true;
    let bytes = 0;
    const limit = Math.max(1, Math.min(64 * 1024 * 1024, io.maxBytes ?? 64 * 1024 * 1024));
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new Error("backup_size_limit") : null, chunk);
    } });
    try {
      await childWork(["exec", containerId, "pg_dump", "--no-password", "--host=/var/run/postgresql",
        "--username=postgres", "--dbname=bor_catalog_local", "--format=custom", `--snapshot=${snapshot}`], async child => {
          child.stdin.end();
          await pipeline(child.stdout, counter, io.stream ? io.stream(file) : file.createWriteStream(), { signal });
        }, "backup_dump_failed");
    }
    finally { await file.close(); }
    check();
    await query("SELECT 1");
    if (!bytes) throw new Error("backup_archive_invalid");
    await childWork(["exec", "-i", containerId, "pg_restore", "--list"], async child => {
      child.stdout.resume();
      await pipeline(createReadStream(dumpPath), child.stdin, { signal });
    }, "backup_archive_invalid");
    const hash = createHash("sha256");
    await pipeline(createReadStream(dumpPath), hash, { signal });
    check();
    if (!(await query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
      AND locktype='advisory' AND classid=1112494674 AND objid=1 AND objsubid=2 AND granted) AS held`)).rows[0].held)
      throw new Error("backup_lock_lost");
    const manifest = { success: true, id, phase, schemaState: state, sha, createdAt: new Date(began).toISOString(),
      bytes, sha256: hash.digest("hex"), digest, acquisition, retentionDeadline };
    check();
    const output = await open(manifestPath, "wx", 0o600);
    manifestOwned = true;
    try { await output.writeFile(JSON.stringify(manifest, null, 2), { signal }); }
    finally { await output.close(); }
    check();
    await query("SELECT 1");
    check();
    await verifyBackup(dumpPath, manifestPath, signal);
    check();
    clearInterval(healthTimer);
    await health;
    check();
    await query("ROLLBACK");
    const unlocked = await query("SELECT pg_advisory_unlock(1112494674,1) AS unlocked");
    if (!unlocked.rows[0]?.unlocked) throw new Error("backup_lock_lost");
    locked = false;
    check();
    success = true;
    return { code: "catalog_backup_complete", dump: dumpPath, manifest: manifestPath, ...manifest };
  }
  catch (error) {
    const code = signal.aborted ? failure : error && typeof error === "object" && "code" in error && error.code === "EEXIST" ?
      "backup_file_exists" : backupCode(error);
    throw new Error(code);
  }
  finally {
    clearTimeout(timer);
    clearInterval(healthTimer);
    await health;
    let cleanupFailed = false;
    if (!success) {
      // A cancellation after manifest creation must not leave a success marker if unlink fails.
      if (manifestOwned) {
        try {
          const stat = await lstat(manifestPath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup_cleanup_failed");
          await writeFile(manifestPath, JSON.stringify({ success: false, code: "backup_failed" }), { flag: "w", mode: 0o600 });
        }
        catch { cleanupFailed = true; }
      }
      for (const [path, owned] of [[manifestPath, manifestOwned], [dumpPath, dumpOwned]] as const)
        if (owned) await unlink(path).catch(() => { cleanupFailed = true; });
    }
    if (client) {
      if (!signal.aborted) {
        await client.query("ROLLBACK").catch(() => { controller.abort(); });
        if (locked && !signal.aborted) await client.query("SELECT pg_advisory_unlock(1112494674,1)").catch(() => { controller.abort(); });
      }
      client.off("error", lost);
      client.off("end", lost);
      client.release(signal.aborted);
    }
    if (cleanupFailed) throw new Error("backup_cleanup_failed");
  }
}
