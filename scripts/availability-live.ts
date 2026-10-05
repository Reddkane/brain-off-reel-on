import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { boundedText, decodePassword, decodeTokenFile, privateJson } from "./catalog-config.ts";
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

/** Prepared operator composition; the CLI's retained --live refusal remains closed. */
export async function liveSweepComposition(config: SweepConfig, signal: AbortSignal, io = defaultLiveSweepIO()) {
  if (!config.terms.accepted)
    throw new Error("terms_required");
  signal.throwIfAborted();
  const key = await io.watchmodeKey(), token = await io.tmdbToken(), password = await io.password();
  const pool = io.pool(password);
  try {
    return await runSweeps(config, {
      pool, guard: io.guard, signal, now: io.now,
      watchmode: createWatchmode(key, io.transport),
      metadata: createTmdb(token, await productionMapping(), io.transport),
      expirePrivateFiles: (now, cleanupSignal) => expirePrivateEvidence(io.root, now, cleanupSignal),
      writeReport: async (report, reportSignal) => {
        const directory = join(io.root, ".cache/availability/private");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const runId = (report as { runId: string }).runId;
        await writeFile(join(directory, `evidence-report-${runId}.json`), JSON.stringify(report, null, 2), {
          flag: "wx", mode: 0o600, signal: reportSignal,
        });
      },
    });
  }
  finally {
    await pool.end();
  }
}
