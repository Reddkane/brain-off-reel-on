import { expect, it } from "vitest";
import { decodeMovie, instant, movieId, object, tmdbId } from "../../src/server/providers/tmdb-validation.ts";
import { at, fixture, key, mapping } from "./helpers.ts";

it("complete appended aggregate, absence and numeric normalization", async () => {
  const raw = object(await fixture("tmdb"));
  const result = decodeMovie(raw, key, at, mapping);
  expect(result.value.keys).toEqual([key]);
  expect(result.value.runtimeMinutes).toBe(90);
  expect(result.value.credits).toHaveLength(2);

  expect(result.inspection?.usCertifications).toEqual([{
    date: "2025-01-01",
    type: 3,
    value: "PG"
  }]);

  const zero = decodeMovie({
    ...raw,
    runtime: 0,
    vote_count: 0,
    vote_average: 0
  }, key, at, mapping);

  expect(zero.value.runtimeMinutes).toBeNull();
  expect(zero.value.rating).toBeNull();
});

it.each(["release_dates", "keywords", "credits", "external_ids"])("requires appended %s and crosschecks component IDs", async field => {
  const raw = object(await fixture("tmdb"));

  expect(() => decodeMovie({
    ...raw,
    [field]: undefined
  }, key, at, mapping)).toThrow();

  expect(() => decodeMovie({
    ...raw,

    [field]: {
      ...object(raw[field]),
      id: 900099
    }
  }, key, at, mapping)).toThrow("identity_conflict");
});

it("IMDb cross-check preserves leading zeros", async () => {
  const raw = object(await fixture("tmdb"));

  expect(decodeMovie({
    ...raw,
    imdb_id: "tt0000001",

    external_ids: {
      imdb_id: "tt0000001"
    }
  }, key, at, mapping).value.keys[1].externalId).toBe("tt0000001");

  expect(() => decodeMovie({
    ...raw,
    imdb_id: "tt0000001",

    external_ids: {
      imdb_id: "tt0000002"
    }
  }, key, at, mapping)).toThrow("identity_conflict");
});

it("empty or failed appended external IDs are not successful absence", async () => {
  const raw = object(await fixture("tmdb"));

  for (const external_ids of [{}, {
    success: false,
    status_code: 7
  }]) expect(() => decodeMovie({
    ...raw,
    external_ids
  }, key, at, mapping)).toThrow();
});

it.each([{
  title: ""
}, {
  title: "x".repeat(501)
}, {
  runtime: -1
}, {
  runtime: "90"
}, {
  vote_average: 11
}, {
  vote_count: 1.5
}, {
  genres: null
}, {
  production_companies: Array(101).fill({})
}, {
  overview: "x".repeat(20001)
}, {
  adult: true
}, {
  video: true
}, {
  release_date: "2025-02-29"
}, {
  poster_path: "/../secret.jpg"
}, {
  poster_path: "/x.jpg?token=secret"
}, {
  poster_path: "https://x.invalid/a.jpg"
}, {
  poster_path: "/x\\a.jpg"
}])("rejects malformed component %j", async change => {
  const raw = object(await fixture("tmdb"));

  expect(() => decodeMovie({
    ...raw,
    ...change
  }, key, at, mapping)).toThrow();
});

it.each(["0", "01", "-1", "1e3", "1.2", "2147483648", "https://example.invalid/1"])("canonical ID rejects %s", id => expect(() => tmdbId(id)).toThrow());

it("UUID and timestamp construction validates at runtime", () => {
  expect(() => movieId("900001")).toThrow();
  expect(movieId("30000000-0000-4000-8000-000000000001")).toBe("30000000-0000-4000-8000-000000000001");
  expect(() => instant("2026-02-30T00:00:00.000Z")).toThrow();
});

it("caps cast after order, deduplicates role and reports conflicting names", async () => {
  const raw = object(await fixture("tmdb"));

  const cast = Array.from({
    length: 25
  }, (_, i) => ({
    id: 901000 + i,
    name: `Synthetic ${i}`,
    order: 24 - i
  }));

  const result = decodeMovie({
    ...raw,

    credits: {
      cast: [...cast, {
        ...cast[0],
        name: "Different"
      }],

      crew: [{
        id: 901000,
        name: "Synthetic 0",
        job: "Writer"
      }]
    }
  }, key, at, mapping);

  expect(result.value.credits.filter(c => c.role === "cast")).toHaveLength(20);
  expect(result.value.credits.some(c => c.role === "Writer")).toBe(true);
  expect(result.issues.some(i => i.code === "credit_name_conflict")).toBe(true);
});
