import { expect, it, vi } from "vitest";
import { ingest } from "../../src/server/ingestion/ingest.ts";
import { decodeConfig } from "../../src/server/ingestion/config.ts";
import type { MetadataStore } from "../../src/server/db/metadata-store.ts";
import { movieId } from "../../src/server/providers/tmdb-validation.ts";
import { at, fixture, mapping, movie } from "./helpers.ts";
import { createTmdb } from "../../src/server/providers/tmdb.ts";
import { object } from "../../src/server/providers/tmdb-validation.ts";
import { decodeSeed } from "../../src/server/ingestion/ratings.ts";
import { tmdbId } from "../../src/server/providers/tmdb-validation.ts";

it.each(["details", "deadline", "cancelled", "database", "requests"])("bounds are unique and identify the actual %s limit", async limit => {
  const m = await movie(), abort = new AbortController();
  let now = Date.parse(at);

  const config = decodeConfig({
    version: "discovery-v1",
    region: "US",
    providerIds: ["900101", "900102"],
    mappingVersion: mapping.version,

    limits: {
      pages: 1,
      details: 1,
      databaseMs: 1000
    }
  }, "2026-10-03");

  const budget = {
    attempts: 0,
    maxAttempts: 20,
    deadline: now + 60000,
    stopped: false
  };

  const timer = limit === "database" ? vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1001) : undefined;

  try {
    const result = await ingest({
      store: {
        persistMovie: async () => ({
          status: "created",
          movieId: movieId("30000000-0000-4000-8000-000000000001"),
          issues: []
        }),

        resolveMovie: async () => null,
        authorizeProfile: async () => false,

        applyRatings: async () => ({
          status: "unauthorized",
          changed: 0,
          indices: []
        }),

        recordRun: async () => true
      },

      capability: {},
      config,
      mapping,

      context: {
        signal: abort.signal,
        now: () => now,
        budget
      },

      provider: {
        getMovie: async () => ({
          status: "ok",
          value: m,
          issues: []
        }),

        discover: async b => {
          if (limit === "deadline")
            now += 60000;

          if (limit === "cancelled")
            abort.abort();

          if (limit === "requests")
            budget.attempts = budget.maxAttempts;

          return {
            status: "ok",

            value: {
              batchId: b.id,
              page: 1,
              totalPages: 2,
              totalResults: 3,

              candidateKeys: ["900001", "900002", "900003"].map(id => ({
                source: "tmdb",
                externalId: tmdbId(id)
              })),

              issues: []
            },

            issues: []
          };
        }
      }
    });

    expect(new Set(result.report.bounds).size).toBe(result.report.bounds.length);

    const expected = {
      details: "detail_budget",
      deadline: "deadline",
      cancelled: "cancelled",
      database: "database_budget",
      requests: "request_budget"
    }[limit];

    expect(result.report.bounds).toContain(expected);

    if (limit !== "details")
      expect(result.report.bounds).not.toContain("detail_budget");
    else
      expect(result.report.bounds.filter(code => code === "page_budget")).toHaveLength(1);
  } finally {
    timer?.mockRestore();
  }
});

it("round pagination dedupes, stalls, counts committed titles and N2 ambiguity", async () => {
  const m = await movie(), id = movieId("30000000-0000-4000-8000-000000000001");
  let writes = 0, now = Date.parse(at);

  const store: MetadataStore = {
    persistMovie: async () => {
      writes++;

      return {
        status: "created",
        movieId: id,
        issues: []
      };
    },

    resolveMovie: async () => null,
    authorizeProfile: async () => false,

    applyRatings: async () => ({
      status: "unauthorized",
      changed: 0,
      indices: []
    }),

    recordRun: async () => true
  };

  const calls: string[] = [];

  const config = decodeConfig({
    version: "discovery-v1",
    region: "US",
    providerIds: ["900101", "900102"],
    mappingVersion: "origin-v1",

    limits: {
      pages: 3,
      operations: 16,
      titles: 10,
      details: 10
    }
  }, "2026-10-03");

  const result = await ingest({
    store,
    capability: {},
    config,
    mapping,

    context: {
      signal: AbortSignal.timeout(1000),
      now: () => now,

      budget: {
        attempts: 0,
        maxAttempts: 20,
        deadline: now + 60000,
        stopped: false
      }
    },

    provider: {
      getMovie: async () => ({
        status: "ok",

        value: {
          ...m,
          release: null
        },

        issues: [{
          code: "release_ambiguous",
          severity: "warning"
        }]
      }),

      discover: async b => {
        now++;
        calls.push(`${b.page}:${b.providerKey}`);

        return {
          status: "ok",

          value: {
            batchId: b.id,
            page: b.page,
            totalPages: 4,
            totalResults: b.page === 1 ? 10 : 11,
            candidateKeys: m.keys,
            issues: []
          },

          issues: []
        };
      }
    }
  });

  expect(writes).toBe(1);
  expect(result.report.persisted).toBe(1);
  expect(result.report.issues.release_ambiguous).toBe(1);
  expect(result.report.issues.page_stalled).toBeGreaterThan(0);
  expect(result.report.issues.totals_changed).toBeGreaterThan(0);
  expect(result.report.cohorts.unknown).toBe(1);
  expect(calls.slice(0, 10).every(s => s.startsWith("1:"))).toBe(true);
  expect(result.report.operations).toBeLessThanOrEqual(16);
  expect(result.report.availability).toBe("not_measured");
});

it(
  "ratings apply receives a fresh bounded transaction deadline after long provider resolution",
  async () => {
    let now = Date.parse(at);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      const m = await movie(), id = movieId("30000000-0000-4000-8000-000000000001");
      let applied = false;

      const store: MetadataStore = {
        persistMovie: async () => ({
          status: "created",
          movieId: id,
          issues: []
        }),

        resolveMovie: async () => null,
        authorizeProfile: async () => true,

        applyRatings: async (_op, _rows, ctx) => {
          expect(ctx.deadline).toBeGreaterThan(now);
          expect(ctx.deadline - now).toBeLessThanOrEqual(10000);
          applied = true;

          return {
            status: "applied",
            changed: 1,
            indices: []
          };
        },

        recordRun: async () => true
      };

      const config = decodeConfig({
        version: "discovery-v1",
        region: "US",
        providerIds: ["900101"],
        mappingVersion: mapping.version
      }, "2026-10-03");

      const result = await ingest({
        store,
        capability: {},
        config,
        mapping,

        ratings: {
          operator: {
            profileId: "synthetic",
            accountId: "synthetic"
          },

          seed: decodeSeed({
            version: "ratings-v1",

            rows: [{
              source: "tmdb",
              external_id: "900001",
              taste_rating: "liked"
            }]
          }, "2026-10-03")
        },

        context: {
          signal: AbortSignal.timeout(1000),
          now: () => now,

          budget: {
            attempts: 0,
            maxAttempts: 30,
            deadline: now + 60000,
            stopped: false
          }
        },

        provider: {
          getMovie: async () => {
            now += 15000;

            return {
              status: "ok",
              value: m,
              issues: []
            };
          },

          discover: async b => ({
            status: "ok",

            value: {
              batchId: b.id,
              page: b.page,
              totalPages: 0,
              totalResults: 0,
              candidateKeys: [],
              issues: []
            },

            issues: []
          })
        }
      });

      expect(applied).toBe(true);
      expect(result.ratings?.status).toBe("applied");
    } finally {
      clock.mockRestore();
    }
  }
);

it("actual appended decoder feeds N2 later-primary ambiguity into run counts", async () => {
  const raw = {
    ...object(await fixture("tmdb")),
    release_date: "2025-02-01"
  },
    m = await movie();

  let now = Date.parse(at);

  const provider = createTmdb("synthetic", mapping, {
    sleep: async ms => {
      now += ms;
    },

    fetch: async url => new Response(JSON.stringify(String(url).includes("/discover/") ? {
      page: 1,
      total_pages: 1,
      total_results: 1,

      results: [{
        id: 900001,
        release_date: "2000-01-01"
      }]
    } : raw))
  });

  const store: MetadataStore = {
    persistMovie: async (_c, movie) => {
      expect(movie.release).toBeNull();

      return {
        status: "created",
        movieId: movieId("30000000-0000-4000-8000-000000000001"),
        issues: []
      };
    },

    resolveMovie: async () => null,
    authorizeProfile: async () => false,

    applyRatings: async () => ({
      status: "unauthorized",
      changed: 0,
      indices: []
    }),

    recordRun: async () => true
  };

  const config = decodeConfig({
    version: "discovery-v1",
    region: "US",
    providerIds: ["900101"],
    mappingVersion: mapping.version,

    limits: {
      operations: 1
    }
  }, "2026-10-03");

  const result = await ingest({
    store,
    capability: {},
    config,
    mapping,
    provider,

    context: {
      signal: AbortSignal.timeout(1000),
      now: () => now,

      budget: {
        attempts: 0,
        maxAttempts: 10,
        deadline: now + 60000,
        stopped: false
      }
    }
  });

  expect(result.report.issues.release_ambiguous).toBe(1);
  expect(result.report.cohorts.unknown).toBe(1);
  expect(result.report.persisted).toBe(1);
  expect(m.release).not.toBeNull();
});
