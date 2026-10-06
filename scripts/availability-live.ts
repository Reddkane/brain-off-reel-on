import { writeFile } from "node:fs/promises";
import { safePrivateDirectory } from "./private-directory.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { boundedText, decodePassword, decodeTokenFile, privateJson } from "./catalog-config.ts";
import { catalogSchemaState, currentMigrationCount } from "./catalog-schema.ts";
import { SweepError } from "../src/server/providers/sweep-error.ts";
import { catalogPool } from "./catalog-local.ts";
import { readWatchmodeKey } from "./watchmode-key.ts";
import { localCatalogGuard } from "../src/server/db/local-catalog-target.ts";
import { productionMapping } from "../src/server/ingestion/config.ts";
import { runSweeps } from "../src/server/ingestion/availability-sweeps.ts";
import { expirePrivateEvidence } from "../src/server/ingestion/private-evidence-cleanup.ts";
import type { SweepConfig } from "../src/server/ingestion/sweep-config.ts";
import { createWatchmode } from "../src/server/providers/watchmode.ts";
import { createTmdb, transport, type Transport } from "../src/server/providers/tmdb.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export interface LiveSweepIO {
  readonly root: string;
  readonly watchmodeKey: () => Promise<string>;
  readonly tmdbToken: () => Promise<string>;
  readonly password: () => Promise<string>;
  readonly pool: (password: string) => Pool;
  readonly guard: (client: PoolClient) => Promise<void>;
  readonly transport: Transport;
  readonly now: () => number;
}
export function defaultLiveSweepIO(): LiveSweepIO {
  return {
    root: repositoryRoot,
    watchmodeKey: readWatchmodeKey,
    tmdbToken: async () => decodeTokenFile(await boundedText(join(repositoryRoot, ".env.local")), undefined),
    password: async () => decodePassword(privateJson(await boundedText(
      join(repositoryRoot, ".cache/real-catalog/private/runtime.json"), 4096))),
    pool: password => catalogPool(password),
    guard: localCatalogGuard,
    transport,
    now: Date.now,
  };
}

export async function writeLiveSweepReport(root: string, report: { runId: string }, signal: AbortSignal) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(report.runId)) throw new SweepError("report_failed");
  const directory = await safePrivateDirectory(root, [".cache", "availability", "private"]);
  await writeFile(join(directory, `evidence-report-${report.runId}.json`), JSON.stringify(report, null, 2), {
    flag: "wx", mode: 0o600, signal,
  });
}
/** Explicit operator composition, with locked schema preflight before cleanup. */
export async function liveSweepComposition(config: SweepConfig, signal: AbortSignal, io = defaultLiveSweepIO()) {
  if (!config.terms.accepted)
    throw new Error("terms_required");
  signal.throwIfAborted();
  const key = await io.watchmodeKey(), token = await io.tmdbToken(), password = await io.password();
  const pool = io.pool(password);
  try {
    return await runSweeps(config, {
      pool, guard: io.guard, signal, now: io.now,
      preflight: async client => {
        try {
          await client.query("BEGIN READ ONLY; SET LOCAL ROLE service_role");
          if (await catalogSchemaState(client) !== currentMigrationCount) throw new SweepError("upgrade_required");
          await client.query("COMMIT");
        }
        catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          if (error instanceof SweepError) throw error;
          if (error instanceof Error && error.message === "upgrade_state_unknown" && !("code" in error))
            throw new SweepError("upgrade_state_unknown");
          throw new SweepError("schema_preflight_failed");
        }
      },
      watchmode: createWatchmode(key, io.transport),
      metadata: createTmdb(token, await productionMapping(), io.transport),
      expirePrivateFiles: (now, cleanupSignal) => expirePrivateEvidence(io.root, now, cleanupSignal),
      writeReport: (report, reportSignal) => writeLiveSweepReport(io.root, report as { runId: string }, reportSignal),
    });
  }
  finally {
    await pool.end();
  }
}
