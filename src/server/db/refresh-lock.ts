import type { Pool, PoolClient } from "pg";
import { SweepError } from "../providers/watchmode.ts";
export interface RefreshLock {
  readonly signal: AbortSignal;
  check(): Promise<void>;
  release(): Promise<void>;
}
/** One application-wide key shared by manual ingestion and availability work. */
export async function acquireRefreshLock(pool: Pool, guard: (client: PoolClient) => Promise<void>, signal: AbortSignal): Promise<RefreshLock> {
  signal.throwIfAborted();
  const client = await pool.connect(), lost = new AbortController();
  let held = false, released = false;
  const abort = () => {
    lost.abort();
    if (!released) {
      released = true;
      client.release(true);
    }
  };
  client.on("error", abort);
  client.on("end", abort);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try {
    try {
      await guard(client);
    }
    catch {
      throw new SweepError("target_guard");
    }
    signal.throwIfAborted();
    const result = await client.query("SELECT pg_try_advisory_lock(1112494674,1) AS locked");
    if (lost.signal.aborted)
      throw new SweepError("refresh_lock_lost");
    if (result.rows[0]?.locked !== true)
      throw new SweepError("refresh_overlap");
    held = true;
  }
  catch (error) {
    abort();
    client.off("error", abort);
    client.off("end", abort);
    signal.removeEventListener("abort", abort);
    if (error instanceof SweepError)
      throw error;
    throw new SweepError("refresh_lock_failed");
  }
  finally {
    clearTimeout(timer);
  }
  return {
    signal: AbortSignal.any([signal, lost.signal]),
    async check() {
      if (released || lost.signal.aborted)
        throw new SweepError("refresh_lock_lost");
      const timeout = setTimeout(abort, 5000);
      try {
        await client.query("SELECT 1");
        if (lost.signal.aborted)
          throw new Error();
      }
      catch {
        abort();
        throw new SweepError("refresh_lock_lost");
      }
      finally {
        clearTimeout(timeout);
      }
    },
    async release() {
      const timeout = setTimeout(abort, 5000);
      try {
        if (!released && held)
          await client.query("SELECT pg_advisory_unlock(1112494674,1)");
      }
      catch {
        abort();
      }
      finally {
        clearTimeout(timeout);
        client.off("error", abort);
        client.off("end", abort);
        signal.removeEventListener("abort", abort);
        if (!released) {
          released = true;
          client.release();
        }
      }
    }
  };
}
