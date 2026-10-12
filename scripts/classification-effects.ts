import type { RunConfig } from "../src/server/classification/orchestrator.ts";
import type { classifyBounded } from "../src/server/classification/orchestrator.ts";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { createClassificationStore } from "../src/server/db/classification-store.ts";
import { localCatalogGuard } from "../src/server/db/local-catalog-target.ts";
import { acquireRefreshLock } from "../src/server/db/refresh-lock.ts";
import { createPgStore } from "../src/server/db/pg-store.ts";
import { createTmdb, transport } from "../src/server/providers/tmdb.ts";
import type { Transport } from "../src/server/providers/tmdb.ts";
import { ingestAnchorIds } from "../src/server/ingestion/anchor-metadata.ts";
import { productionMapping } from "../src/server/ingestion/config.ts";
import { ClassificationError } from "../src/domain/classification.ts";
import { catalogPool, inspectCatalog } from "./catalog-local.ts";
import { catalogSchemaState, currentMigrationCount } from "./catalog-schema.ts";
import { boundedText, decodePassword, privateJson, decodeTokenFile } from "./catalog-config.ts";
import { classificationPath, classificationJson, readAnthropicKey, checkPhaseHistory, writePhaseHead } from "./classification-private.ts";
import { createAnthropic } from "../src/server/classification/anthropic.ts";
import type { AnthropicIO } from "../src/server/classification/anthropic.ts";
import { decodeAnchorConfig, decodePhaseB, priorBalance } from "../src/server/classification/phase-b.ts";
import type { PhaseBConfig } from "../src/server/classification/phase-b.ts";
import { runPhaseB } from "../src/server/classification/phase-b-run.ts";
export interface ClassificationEffects {
  store?: ReturnType<typeof createClassificationStore>;
  capability?: object;
  modelId?: string;
  close?: () => Promise<void>;
  run?: (config: RunConfig, startingBalance: number, signal: AbortSignal, startingUnknown: number) => ReturnType<typeof classifyBounded>;
  phaseB?: (config: PhaseBConfig, prior: unknown, signal: AbortSignal) => ReturnType<typeof runPhaseB>;
  ingest?: (ids: unknown, config: unknown, signal: AbortSignal) => Promise<{ inserted: number; unchanged: number; additions: string[] }>;
}
export interface ClassificationIO {
  inspect: () => Promise<unknown>; password: () => Promise<string>; pool: (password: string) => Pool;
  guard: (client: PoolClient) => Promise<void>; key: () => Promise<string>; anthropic: AnthropicIO;
  tmdbToken: () => Promise<string>; metadata: Transport;
}
export const defaultClassificationIO: ClassificationIO = {
  inspect: inspectCatalog,
  password: async () => decodePassword(privateJson(await boundedText(resolve(".cache/real-catalog/private/runtime.json"), 4096))),
  pool: catalogPool, guard: localCatalogGuard, key: readAnthropicKey, anthropic: { fetch: (...args) => fetch(...args), now: Date.now },
  tmdbToken: async () => decodeTokenFile(await boundedText(resolve(".env.local"))), metadata: transport,
};
/** Only explicit effect actions construct guarded pools/capabilities. */
export async function classificationEffects(options?: { action: string; signal: AbortSignal; modelId?: string }, io = defaultClassificationIO): Promise<ClassificationEffects> {
  if (!options) return {};
  if (options.action === "export" && !options.modelId) return {};
  const { signal } = options;
  let pool: Pool | undefined;
  const capability = Object.freeze({});
  async function storage() {
    if (pool) return createClassificationStore({ pool, guard: io.guard, capability });
    signal.throwIfAborted();
    await io.inspect();
    pool = io.pool(await io.password());
    const client = await pool.connect();
    try {
      await io.guard(client);
      if (await catalogSchemaState(client) !== currentMigrationCount) throw new ClassificationError("upgrade_required");
    } finally { client.release(); }
    return createClassificationStore({ pool, guard: io.guard, capability });
  }
  const effects: ClassificationEffects = { capability, modelId: options.modelId, close: async () => { await pool?.end(); } };
  if (["anchors-import", "reviews-import", "export"].includes(options.action)) {
    try { effects.store = await storage(); } catch (e) { await pool?.end(); throw e; }
  }
  effects.phaseB = async (supplied, prior, runSignal) => {
    const config = decodePhaseB(supplied, io.anthropic.now());
    const pilot = config.pilotReport ? await classificationJson(config.pilotReport) : undefined;
    priorBalance(config, prior, pilot); // Terms, prices and balances precede credential/storage effects.
      const store = await storage();
      const lock = await acquireRefreshLock(pool!, io.guard, runSignal, [1112494674, 2]);
      try {
        await checkPhaseHistory(config, prior, await store.phaseHasModels(capability, config.phaseId, config.candidates.map(c => c.model), { signal: lock.signal, deadline: Date.now() + 10000 }));
        const items = await store.inputs(capability, config.movieIds, { signal: lock.signal, deadline: Date.now() + 10000 });
        const storedCompleted = await store.phaseCompleted(capability, config.phaseId, { signal: lock.signal, deadline: Date.now() + 10000 });
        const classifier = createAnthropic(await io.key(), config.candidates, io.anthropic, config.rejectionBilling.zeroCost);
        const reportPath = await classificationPath(config.report, true), reportFile = await open(reportPath, "wx", 0o600);
        try {
        await writePhaseHead(config); // Pending blocks every restart until the saved report is finalized.
        return await runPhaseB({ config, items, prior, pilot, classifier, storedCompleted, signal: lock.signal, check: async () => { try { await lock.check(); } catch { throw new ClassificationError("refresh_lock_lost"); } }, now: io.anthropic.now,
          persist: (output, fingerprint, index, model) => store.appendModel(capability, config.movieIds[index], output, model, fingerprint, { signal: lock.signal, deadline: Date.now() + 10000 }, config.phaseId).then(() => {}),
          save: async report => { await reportFile.writeFile(JSON.stringify(report, null, 2) + "\n"); await reportFile.sync(); await writePhaseHead(config, report); },
        });
        } finally { await reportFile.close(); }
      } finally { await lock.release(); }
  };
  effects.ingest = async (ids, supplied, runSignal) => {
    const config = decodeAnchorConfig(supplied);
    const file = await open(await classificationPath(config.report, true), "wx", 0o600);
    try {
      await storage(); const lock = await acquireRefreshLock(pool!, io.guard, runSignal);
      try {
        const metadata = createPgStore({ pool: pool!, checkoutGuard: io.guard, catalogCapability: capability, operators: [] });
        const provider = createTmdb(await io.tmdbToken(), await productionMapping(), io.metadata);
        const result = await ingestAnchorIds({ ids, provider, store: metadata, capability,
          storeContext: { signal: lock.signal, deadline: Date.now() + 600000 },
          context: { signal: lock.signal, now: Date.now, budget: { attempts: 0, maxAttempts: 100, deadline: Date.now() + 600000, stopped: false } } });
        await file.writeFile(JSON.stringify({ version: "classification-anchor-additions-v1", ...result }) + "\n"); await file.sync(); return result;
      } finally { await lock.release(); }
    } finally { await file.close(); }
  };
  return effects;
}
