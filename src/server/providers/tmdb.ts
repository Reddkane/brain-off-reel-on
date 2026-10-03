import type { DiscoveryBatch, ExternalMovieKey, ProviderResult } from "../../domain/metadata.ts";
import type { OriginMapping } from "../../domain/production-origin.ts";
import type { MetadataProvider, ProviderContext } from "./metadata-provider.ts";
import { decodeMovie, decodePage, InvalidInput, providerId, tmdbId } from "./tmdb-validation.ts";
import { strictDate } from "../../domain/metadata-evidence.ts";

export interface Transport {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const transport: Transport = {
  fetch: (...args) => fetch(...args),

  sleep: (ms, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted();

    const abort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);

    signal.addEventListener("abort", abort, {
      once: true
    });
  })
};

export function createTmdb(token: string, mapping: OriginMapping, io: Transport = transport): MetadataProvider {
  if (!token || /[\r\n]/.test(token))
    throw new InvalidInput();

  // One serialized lane is deliberately below the concurrency maximum of two.
  let lane = Promise.resolve(), nextStart = 0;

  async function request(path: string, query: URLSearchParams, ctx: ProviderContext): Promise<ProviderResult<unknown>> {
    let unlock!: () => void;
    const previous = lane;

    lane = new Promise<void>(r => {
      unlock = r;
    });

    await previous;

    try {
      for (let retry = 0;retry <= 2;retry++) {
        if (ctx.signal.aborted || ctx.budget.stopped) return {
          status: "failed",
          code: "cancelled",
          retryable: false
        };

        if (ctx.now() >= ctx.budget.deadline) return {
          status: "failed",
          code: "deadline",
          retryable: false
        };

        if (ctx.budget.attempts >= ctx.budget.maxAttempts) return {
          status: "failed",
          code: "budget",
          retryable: false
        };

        const wait = Math.max(0, nextStart - ctx.now());

        if (ctx.now() + wait >= ctx.budget.deadline) return {
          status: "failed",
          code: "deadline",
          retryable: false
        };

        await io.sleep(wait, ctx.signal);

        if (ctx.signal.aborted || ctx.now() >= ctx.budget.deadline) return {
          status: "failed",
          code: "deadline",
          retryable: false
        };

        ctx.budget.attempts++;
        nextStart = ctx.now() + 500;
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, Math.min(10000, ctx.budget.deadline - ctx.now())))]);
        let delay = (retry + 1) * 1000;

        try {
          const response = await io.fetch(`https://api.themoviedb.org/3/${path}?${query}`, {
            headers: {
              Authorization: `Bearer ${token}`
            },

            redirect: "error",
            signal
          });

          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            ctx.budget.stopped = true;

            return {
              status: "failed",
              code: "auth",
              retryable: false
            };
          }

          if (response.status === 404) {
            await response.body?.cancel();

            return {
              status: "not_found"
            };
          }

          if (response.status === 429 || [502, 503, 504].includes(response.status)) {
            await response.body?.cancel();

            if (response.status === 429) {
              const h = response.headers.get("retry-after");
              const seconds = h !== null &&
                /^\d+$/.test(h) ? Number(h) : h === null ? NaN : (Date.parse(h) - ctx.now()) / 1000;

              if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) return {
                status: "failed",
                code: "throttled",
                retryable: false
              };

              delay = Math.max(delay, seconds * 1000);
            }

            if (retry === 2) return {
              status: "failed",
              code: response.status === 429 ? "throttled" : "http",
              retryable: true
            };
          } else if (!response.ok) {
            await response.body?.cancel();

            return {
              status: "failed",
              code: "http",
              retryable: false
            };
          } else {
            if (!response.body) return {
              status: "invalid",

              issues: [{
                code: "invalid_input",
                severity: "error"
              }]
            };

            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;

            try {
              while (true) {
                signal.throwIfAborted();
                const part = await reader.read();

                if (part.done)
                  break;

                size += part.value.byteLength;

                if (size > 2 * 1024 * 1024) {
                  await reader.cancel();

                  return {
                    status: "failed",
                    code: "body_limit",
                    retryable: false
                  };
                }

                chunks.push(part.value);
              }
            } finally {
              reader.releaseLock();
            }

            const bytes = new Uint8Array(size);
            let offset = 0;

            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }

            try {
              return {
                status: "ok",

                value: JSON.parse(new TextDecoder("utf-8", {
                  fatal: true
                }).decode(bytes)),

                issues: []
              };
            } catch {
              return {
                status: "invalid",

                issues: [{
                  code: "invalid_input",
                  severity: "error"
                }]
              };
            }
          }
        } catch {
          if (ctx.signal.aborted) return {
            status: "failed",
            code: "cancelled",
            retryable: false
          };

          if (retry === 2) return {
            status: "failed",
            code: "network",
            retryable: true
          };
        }

        if (ctx.now() + delay >= ctx.budget.deadline) return {
          status: "failed",
          code: "deadline",
          retryable: false
        };

        await io.sleep(delay, ctx.signal);
      }

      return {
        status: "failed",
        code: "network",
        retryable: true
      };
    } catch {
      return {
        status: "failed",
        code: "cancelled",
        retryable: false
      };
    } finally {
      unlock();
    }
  }

  function invalid(error: unknown): ProviderResult<never> {
    return {
      status: "invalid",

      issues: [{
        code: error instanceof InvalidInput ? error.code : "invalid_input",
        severity: "error"
      }]
    };
  }

  return {
    async getMovie(key: ExternalMovieKey, context) {
      try {
        if (key.source !== "tmdb")
          throw new InvalidInput();

        tmdbId(key.externalId);
      } catch (e) {
        return invalid(e);
      }

      const result = await request(`movie/${encodeURIComponent(key.externalId)}`, new URLSearchParams({
        language: "en-US",
        append_to_response: "release_dates,keywords,credits,external_ids"
      }), context);

      if (result.status !== "ok")
        return result;

      try {
        const decoded = decodeMovie(result.value, key, new Date(context.now()).toISOString(), mapping);

        return {
          status: "ok",
          ...decoded
        };
      } catch (e) {
        return invalid(e);
      }
    },

    async discover(batch: DiscoveryBatch, context) {
      try {
        providerId(batch.providerKey);

        if (!Number.isInteger(batch.page) ||
          batch.page < 1 ||
          batch.page > 5 ||
          batch.companyIds.length > 10 ||
          !["popularity.desc", "primary_release_date.desc", "vote_count.desc", "title.asc"].includes(batch.sort) ||
          Object.keys(batch.dateBounds).some(k => !["from", "through"].includes(k)) ||
          (batch.dateBounds.from !== undefined &&
            !strictDate(batch.dateBounds.from)) ||
          (batch.dateBounds.through !== undefined &&
            !strictDate(batch.dateBounds.through)))
          throw new InvalidInput();

        batch.companyIds.forEach(tmdbId);
      } catch (e) {
        return invalid(e);
      }

      const q = new URLSearchParams({
        watch_region: "US",
        with_watch_providers: batch.providerKey,
        with_watch_monetization_types: "flatrate|ads|free",
        language: "en-US",
        include_adult: "false",
        include_video: "false",
        sort_by: batch.sort,
        page: String(batch.page)
      });

      if (batch.dateBounds.from)
        q.set("primary_release_date.gte", batch.dateBounds.from);

      if (batch.dateBounds.through)
        q.set("primary_release_date.lte", batch.dateBounds.through);

      if (batch.companyIds.length)
        q.set("with_companies", batch.companyIds.join("|"));

      const result = await request("discover/movie", q, context);

      if (result.status !== "ok")
        return result;

      try {
        return {
          status: "ok",
          value: decodePage(result.value, batch),
          issues: []
        };
      } catch (e) {
        return invalid(e);
      }
    }
  };
}
