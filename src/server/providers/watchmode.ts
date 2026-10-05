import type { SweepCandidate } from "../../domain/availability-sweeps.ts";
import type { Transport } from "./tmdb.ts";
import { transport } from "./tmdb.ts";
import { array, integer, object, tmdbId } from "./tmdb-validation.ts";
import { SweepError } from "./sweep-error.ts";
export { SweepError } from "./sweep-error.ts";
export const watchmodeSources = [203, 387, 372, 157] as const;
export interface WatchmodePage {
  readonly page: number;
  readonly totalPages: number;
  readonly totalResults: number;
  readonly titles: readonly SweepCandidate[];
  readonly observedAt: string;
  /** Missing membership identities or unexpected media types forbid promotion. */
  readonly unresolvedRows?: number;
  readonly excludedRows?: number;
  readonly excludedIds?: readonly number[];
}
export interface WatchmodeQuota {
  readonly quota: number;
  readonly used: number;
}
export interface WatchmodeContext {
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly deadline: number;
  readonly creditCap: number;
  charges: number;
  attempts: number;
  stopped: boolean;
}
export function decodeWatchmodePage(input: unknown, page: number, observedAt: string): WatchmodePage {
  const value = object(input);
  if (integer(value.page, 1, 60) !== page)
    throw new SweepError("page_invalid");
  const totalPages = integer(value.total_pages, 0), totalResults = integer(value.total_results, 0);
  if (totalPages !== Math.ceil(totalResults / 250) || page > Math.max(1, totalPages))
    throw new SweepError("totals_invalid");
  if (totalPages > 60)
    throw new SweepError("sweep_too_large");
  const rawTitles = array(value.titles, 250);
  const expected = Math.min(250, Math.max(0, totalResults - (page - 1) * 250));
  if (rawTitles.length > expected)
    throw new SweepError("totals_invalid");
  let unresolvedRows = expected - rawTitles.length;
  let excludedRows = 0;
  const excludedIds: number[] = [];
  const titles: SweepCandidate[] = [];
  for (const input of rawTitles) {
    let title: Record<string, unknown>, id: number;
    try {
      title = object(input);
      id = integer(title.id, 1);
    } catch {
      unresolvedRows++;
      continue;
    }
    if (title.type !== "movie") {
      if (typeof title.type === "string" && title.type.length > 0) {
        excludedRows++;
        excludedIds.push(id);
      } else
        unresolvedRows++;
      continue;
    }
    let externalId: string | null = null;
    if (title.tmdb_type === "movie" && (typeof title.tmdb_id === "string" || typeof title.tmdb_id === "number")) {
      try { externalId = tmdbId(String(title.tmdb_id)); }
      catch { /* Preserve membership; an invalid mapping cannot be enriched. */ }
    }
    const rawPopularity = title.popularity_percentile;
    const popularity = typeof rawPopularity === "number" && Number.isFinite(rawPopularity) && rawPopularity >= 0 && rawPopularity <= 100 ? rawPopularity : null;
    titles.push({ watchmodeId: id, tmdbId: externalId, popularity });
  }
  return { page, totalPages, totalResults, titles, observedAt, unresolvedRows, excludedRows, excludedIds };
}
export function decodeQuota(input: unknown): WatchmodeQuota {
  const value = object(input);
  const quota = integer(value.quota, 1), used = integer(value.quotaUsed, 0);
  if (used > quota)
    throw new SweepError("status_invalid");
  return { quota, used };
}
export interface WatchmodeProvider {
  status(context: WatchmodeContext): Promise<WatchmodeQuota>;
  page(source: number, page: number, context: WatchmodeContext): Promise<WatchmodePage>;
}
export function createWatchmode(key: string, io: Transport = transport): WatchmodeProvider {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(key))
    throw new SweepError("credential_invalid");
  let lane = Promise.resolve(), nextStart = 0;
  async function request(path: string, charged: boolean, context: WatchmodeContext): Promise<unknown> {
    let release!: () => void;
    const previous = lane;
    lane = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      for (let retry = 0; retry <= 2; retry++) {
        const wait = Math.max(0, nextStart - context.now());
        if (context.signal.aborted || context.stopped)
          throw new SweepError("cancelled");
        if (context.now() + wait >= context.deadline)
          throw new SweepError("wall_budget");
        if (charged && context.charges >= context.creditCap)
          throw new SweepError("credit_budget");
        await io.sleep(wait, context.signal);
        context.signal.throwIfAborted();
        if (context.now() >= context.deadline)
          throw new SweepError("wall_budget");
        nextStart = context.now() + 600;
        context.attempts++;
        if (charged)
          context.charges++; // Reserve worst-case cost before dispatch, including uncertain failures.
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, Math.min(10000, context.deadline - context.now())))]);
        let delay = (retry + 1) * 1000;
        try {
          const response = await io.fetch(`https://api.watchmode.com/v1/${path}`, {
            headers: { "X-API-Key": key }, redirect: "error", signal
          });
          if (response.status === 401 || response.status === 403) {
            context.stopped = true;
            await response.body?.cancel();
            throw new SweepError("provider_auth");
          }
          if ([429, 502, 503, 504].includes(response.status)) {
            await response.body?.cancel();
            if (response.status === 429) {
              const header = response.headers.get("retry-after");
              const seconds = header !== null && /^\d+$/.test(header) ? Number(header) : header === null ? NaN : (Date.parse(header) - context.now()) / 1000;
              if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30)
                throw new SweepError("provider_throttled");
              delay = Math.max(delay, seconds * 1000);
            }
            if (retry === 2)
              throw new SweepError("provider_transient");
          }
          else {
            if (!response.ok) {
              await response.body?.cancel();
              throw new SweepError("provider_http");
            }
            if (!response.body)
              throw new SweepError("body_invalid");
            const reader = response.body.getReader(), chunks: Uint8Array[] = [];
            const abortReader = () => { void reader.cancel().catch(() => { }); };
            signal.addEventListener("abort", abortReader, { once: true });
            let size = 0;
            try {
              while (true) {
                signal.throwIfAborted();
                const part = await reader.read();
                signal.throwIfAborted();
                if (part.done)
                  break;
                size += part.value.length;
                if (size > 2097152)
                  throw new SweepError("body_limit");
                chunks.push(part.value);
              }
              try {
                return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
              }
              catch {
                throw new SweepError("body_invalid");
              }
            }
            finally {
              signal.removeEventListener("abort", abortReader);
              void reader.cancel().catch(() => { });
              reader.releaseLock();
            }
          }
        }
        catch (error) {
          if (error instanceof SweepError)
            throw error;
          if (context.signal.aborted)
            throw new SweepError("cancelled");
          if (retry === 2)
            throw new SweepError("provider_transient");
        }
        if (context.now() + delay >= context.deadline)
          throw new SweepError("wall_budget");
        await io.sleep(delay, context.signal);
      }
      throw new SweepError("provider_transient");
    }
    finally {
      release();
    }
  }
  return {
    async status(context) {
      try {
        return decodeQuota(await request("status/", false, context));
      }
      catch (error) {
        if (error instanceof SweepError)
          throw error;
        throw new SweepError("status_invalid");
      }
    },
    async page(source, page, context) {
      if (!watchmodeSources.some(id => id === source) || !Number.isInteger(page) || page < 1 || page > 60)
        throw new SweepError("request_invalid");
      const query = new URLSearchParams({ types: "movie", regions: "US", source_types: "sub", source_ids: String(source), limit: "250", sort_by: "title_asc", page: String(page) });
      const raw = await request(`list-titles/?${query}`, true, context);
      try {
        return decodeWatchmodePage(raw, page, new Date(context.now()).toISOString());
      }
      catch (error) {
        if (error instanceof SweepError)
          throw error;
        throw new SweepError("page_invalid");
      }
    }
  };
}
