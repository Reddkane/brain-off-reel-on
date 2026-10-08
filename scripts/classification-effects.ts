import type { createClassificationStore } from "../src/server/db/classification-store.ts";
import type { RunConfig } from "../src/server/classification/orchestrator.ts";
import type { classifyBounded } from "../src/server/classification/orchestrator.ts";
export interface ClassificationEffects {
  store?: ReturnType<typeof createClassificationStore>;
  capability?: object;
  modelId?: string;
  close?: () => Promise<void>;
  run?: (config: RunConfig, startingBalance: number, signal: AbortSignal, startingUnknown: number) => ReturnType<typeof classifyBounded>;
}
/** A trusted composition supplies guarded pools/capabilities, never CLI credentials.
 * Phase A deliberately ships no credential reader or live classifier adapter. */
export async function classificationEffects(): Promise<ClassificationEffects> { return {}; }
