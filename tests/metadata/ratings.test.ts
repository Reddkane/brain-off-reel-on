import { expect, it } from "vitest";
import { fillAbsent } from "../../src/domain/ratings-import.ts";
import { decodeSeed, importRatings, SeedConflict } from "../../src/server/ingestion/ratings.ts";
import { createPgStore } from "../../src/server/db/pg-store.ts";
import pg from "pg";

const seed = (rows: unknown[]) => ({
  version: "ratings-v1",
  synthetic: true,
  rows
});

const row = {
  source: "tmdb",
  external_id: "900001",
  taste_rating: "liked"
};

it("strict TMDB seed with independent signals and identical coalescing", () => {
  expect(decodeSeed(seed([row, row]), "2026-10-03").rows[0].indices).toEqual([0, 1]);

  expect(fillAbsent({
    taste_rating: "liked"
  }, null)).toEqual({
    status: "changed",

    value: {
      watched: false,
      watched_on: null,
      taste_rating: "liked",
      tired_viewing_rating: null
    }
  });
});

it.each([{
  ...row,
  source: "imdb"
}, {
  ...row,
  external_id: "01"
}, {
  ...row,
  profile_id: "x"
}, {
  ...row,
  watched: false,
  watched_on: "2025-01-01"
}, {
  ...row,
  watched_on: "2099-01-01"
}, {
  ...row,
  taste_rating: null
}, {
  ...row,
  tired_viewing_rating: 5
}, {
  ...row,
  permanent_exclusion: true
}])("rejects malformed seed %j", r => expect(() => decodeSeed(seed([r]), "2026-10-03")).toThrow());

it("rejects conflicting duplicates with safe row indices and >100 rows", () => {
  try {
    decodeSeed(seed([row, {
      ...row,
      taste_rating: "loved"
    }]), "2026-10-03");

    throw new Error("unexpected_success");
  } catch (error) {
    expect(error).toBeInstanceOf(SeedConflict);

    if (error instanceof SeedConflict)
      expect(error.indices).toEqual([0, 1]);
  }

  expect(() => decodeSeed(seed(Array(101).fill(row)), "2026-10-03")).toThrow();
});

it("fill absent/equal only and meaningful false watched", () => {
  const old = {
    watched: false,
    watched_on: null,
    taste_rating: "liked" as const,
    tired_viewing_rating: 0
  };

  expect(fillAbsent({
    watched: true
  }, old).status).toBe("conflict");

  expect(fillAbsent({
    taste_rating: "loved"
  }, old).status).toBe("conflict");

  expect(fillAbsent({
    watched_on: "2025-01-01"
  }, old).status).toBe("conflict");

  expect(fillAbsent({
    taste_rating: "liked",
    tired_viewing_rating: 0
  }, old).status).toBe("unchanged");

  expect(() => expect(fillAbsent({
    taste_rating: "loved"
  }, null).status).toBe("conflict")).toThrow();
});

it("forged capability rejects before checkout or resolver; expected-red no-call control", async () => {
  const pool = new pg.Pool({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMillis: 1
  });

  let calls = 0;

  const store = createPgStore({
    pool,
    catalogCapability: {},
    operators: []
  });

  expect((await importRatings(store, {
    profileId: "forged",
    accountId: "forged"
  }, decodeSeed(seed([row]), "2026-10-03"), async () => {
    calls++;
    return null;
  }, {
    signal: AbortSignal.timeout(1000),
    deadline: Date.now() + 1000
  })).status).toBe("unauthorized");

  expect(calls).toBe(0);
  const assertNoCalls = () => expect(calls).toBe(0);
  calls++;
  expect(assertNoCalls).toThrow();
  await pool.end();
});
