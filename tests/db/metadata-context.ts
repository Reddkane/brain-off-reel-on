import pg from "pg";
import { inject } from "vitest";
import type { PoolConfig } from "pg";
import { disposableGuard } from "../../tooling/metadata-disposable.ts";
import { createPgStore } from "../../src/server/db/pg-store.ts";
import type { PgStoreOptions } from "../../src/server/db/pg-store.ts";
import type { OperatorContext } from "../../src/server/db/metadata-store.ts";

declare module "vitest" {
  export interface ProvidedContext {
    metadataTarget: PoolConfig;
  }
}

export const capability = Object.freeze({});

export const operator = Object.freeze({
  profileId: "20000000-0000-4000-8000-000000000001",
  accountId: "10000000-0000-4000-8000-000000000001"
});

export function context() {
  return {
    signal: AbortSignal.timeout(15000),
    deadline: Date.now() + 10000
  };
}

export function target() {
  const config = inject("metadataTarget");

  if (!config ||
    config.host !== "127.0.0.1" ||
    config.database !== "bor_pr02_test" ||
    config.user !== "bor_migrator" ||
    !config.password)
    throw new Error("missing_inspected_harness");

  const pool = new pg.Pool({
    ...config,
    max: 2
  }),
    admin = new pg.Pool({
      ...config,
      max: 2
    });

  return {
    pool,
    admin,

    store: (hooks?: PgStoreOptions["hooks"], operators: readonly OperatorContext[] = [operator]) => createPgStore({
      pool,
      catalogCapability: capability,
      operators,
      checkoutGuard: disposableGuard,
      hooks
    }),

    close: async () => {
      await pool.end();
      await admin.end();
    }
  };
}

export function barrier() {
  let release!: () => void;

  const promise = new Promise<void>(r => {
    release = r;
  });

  return {
    promise,
    release
  };
}

export async function waitForLock(admin: pg.Pool, pid: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 1500;

  while (Date.now() < deadline) {
    const result = await admin.query<{
      waiting: boolean;
    }>(
      "SELECT wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid)) AS waiting FROM pg_stat_activity WHERE pid=$1",
      [pid, blocker]
    );

    if (result.rows[0]?.waiting)
      return;

    await new Promise(resolve => setTimeout(resolve, 10));
  }

  throw new Error("expected_backend_lock_wait");
}
