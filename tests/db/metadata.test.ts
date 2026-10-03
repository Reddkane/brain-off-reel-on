import { beforeAll, afterAll, expect, it } from "vitest";
import { target, capability, context, barrier } from "./metadata-context.ts";
import { movie } from "../metadata/helpers.ts";
import { tmdbId } from "../../src/server/providers/tmdb-validation.ts";
import type { MovieMetadata } from "../../src/domain/metadata.ts";
let db: ReturnType<typeof target>;

beforeAll(() => {
  db = target();
});

afterAll(async () => {
  await db.close();
});

async function aggregate(id: string): Promise<MovieMetadata> {
  return {
    ...(await movie()),

    keys: [{
      source: "tmdb",
      externalId: tmdbId(id)
    }]
  };
}

it("actual service DML commits, exact repeats, freshness and equal time conflict", async () => {
  const m = await aggregate("910001"), store = db.store();
  const created = await store.persistMovie(capability, m, 1000, context());
  expect(created.status).toBe("created");
  expect((await store.persistMovie(capability, m, 1000, context())).status).toBe("unchanged");

  expect((await store.persistMovie(capability, {
    ...m,
    title: "Different"
  }, 1000, context())).status).toBe("identity_conflict");

  expect((await store.persistMovie(capability, {
    ...m,
    checkedAt: "2025-01-01T00:00:00.000Z"
  }, 1000, context())).status).toBe("stale");

  const newer = {
    ...m,
    title: "Newer",
    runtimeMinutes: null,
    checkedAt: "2026-10-04T00:00:00.000Z"
  };

  const updated = await store.persistMovie(capability, newer, 1000, context());
  expect(updated.status).toBe("updated");

  if ("issues" in updated)
    expect(updated.issues[0].code).toBe("changed_to_unknown");

  expect((await db.admin.query(
    "SELECT count(*)::int AS n FROM app.movie_external_ids WHERE source=$1 AND external_id=$2",
    ["tmdb", "910001"]
  )).rows[0].n).toBe(1);
});

it(
  "actual application client enters service_role and bounded local settings before COMMIT",
  async () => {
    let checked = false;

    const store = db.store({
      beforeCommit: async client => {
        const r = (await client.query(
          "SELECT current_user AS role,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock"
        )).rows[0];

        expect(r.role).toBe("service_role");
        expect(r.statement).toBe("5s");
        expect(r.lock).toBe("2s");
        checked = true;
      }
    });

    expect((await store.persistMovie(capability, await aggregate("910014"), 1000, context())).status).toBe("created");
    expect(checked).toBe(true);
  }
);

it("parameterized malicious text remains data and neighboring history survives", async () => {
  const title = "Synthetic ' \\ \n Unicode Ω ` $(echo secret); DROP TABLE app.movies; --";

  const saved = await db.store().persistMovie(capability, {
    ...(await aggregate("910002")),
    title,

    credits: [{
      source: "tmdb",
      personExternalId: "999001",
      name: title,
      role: "Director",
      billingOrder: null
    }]
  }, 1000, context());

  expect(saved.status).toBe("created");

  if (!("movieId" in saved))
    throw new Error("missing_movie");

  expect((await db.admin.query("SELECT title FROM app.movies WHERE id=$1", [saved.movieId])).rows[0].title).toBe(title);
  expect((await db.admin.query("SELECT count(*)::int AS n FROM app.movie_classifications")).rows[0].n).toBe(2);
  expect((await db.admin.query("SELECT count(*)::int AS n FROM app.availability_snapshots")).rows[0].n).toBeGreaterThan(0);
});

it("fail after movie insert, invalid credit and commit failure roll back aggregate", async () => {
  for (const [id, mode] of [["910003", "insert"], ["910004", "credit"], ["910005", "commit"]] as const) {
    const before = (await db.admin.query(
      "SELECT (SELECT count(*) FROM app.movies) AS movies,(SELECT count(*) FROM app.movie_external_ids) AS mappings,(SELECT count(*) FROM app.movie_credits) AS credits"
    )).rows[0];

    const m = await aggregate(id);

    const store = db.store(mode === "insert" ? {
      afterMovieWrite: async () => {
        throw new Error("private");
      }
    } : mode === "commit" ? {
      beforeCommit: async c => {
        const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await db.admin.query("SELECT pg_terminate_backend($1)", [pid]);
      }
    } : undefined);

    const r = await store.persistMovie(capability, mode === "credit" ? {
      ...m,

      credits: [{
        source: "tmdb",
        personExternalId: "1",
        name: "",
        role: "cast",
        billingOrder: null
      }]
    } : m, 1000, context());

    expect(r.status).toBe("failed");

    expect((await db.admin.query(
      "SELECT (SELECT count(*) FROM app.movies) AS movies,(SELECT count(*) FROM app.movie_external_ids) AS mappings,(SELECT count(*) FROM app.movie_credits) AS credits"
    )).rows[0]).toEqual(before);

    expect(await db.store().resolveMovie(m.keys[0], context())).toBeNull();
  }
});

it(
  "COMMIT command must confirm success, not implicit rollback of an aborted transaction",
  async () => {
    const m = await aggregate("910013");

    const result = await db.store({
      beforeCommit: async client => {
        try {
          await client.query("SELECT 1/0");
        } catch { }
      }
    }).persistMovie(capability, m, 1000, context());

    expect(result).toEqual({
      status: "failed",
      code: "commit_failed"
    });

    expect(await db.store().resolveMovie(m.keys[0], context())).toBeNull();
  }
);

it("mapping conflicts produce no orphan and cap applies only to creation", async () => {
  const s = db.store(), a = await aggregate("910006"), b = await aggregate("910007");

  const first = await s.persistMovie(capability, {
    ...a,

    keys: [...a.keys, {
      source: "imdb",
      externalId: "tt0910006"
    }]
  }, 1000, context());

  expect(first.status).toBe("created");
  await s.persistMovie(capability, b, 1000, context());
  const before = (await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n;

  expect((await s.persistMovie(capability, {
    ...b,

    keys: [...b.keys, {
      source: "imdb",
      externalId: "tt0910006"
    }]
  }, 1000, context())).status).toBe("identity_conflict");

  expect((await s.persistMovie(capability, await aggregate("910008"), before, context())).status).toBe("catalog_limit");
  expect((await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n).toBe(before);
});

it("real two connections and JS barrier serialize same key to one UUID", async () => {
  const acquired = barrier(), release = barrier();
  let entered = false;

  const first = db.store({
    afterCatalogLock: async () => {
      acquired.release();
      await release.promise;
    }
  });

  const second = db.store({
    afterCatalogLock: async () => {
      entered = true;
    }
  });

  const m = await aggregate("910009");
  const a = first.persistMovie(capability, m, 1000, context());
  await acquired.promise;
  const b = second.persistMovie(capability, m, 1000, context());
  await new Promise(r => setTimeout(r, 50));
  expect(entered).toBe(false);
  release.release();
  const [x, y] = await Promise.all([a, b]);
  expect(x.status).toBe("created");
  expect(y.status).toBe("unchanged");

  if ("movieId" in x && "movieId" in y)
    expect(x.movieId).toBe(y.movieId);

  const z = await db.store().persistMovie(capability, await aggregate("910010"), 1000, context());

  if ("movieId" in x && "movieId" in z)
    expect(x.movieId).not.toBe(z.movieId);
});

it("external nonlocking writer causes 23505 rollback without reread/retry", async () => {
  const other = await db.store().persistMovie(capability, await aggregate("910011"), 1000, context());

  if (!("movieId" in other))
    throw new Error("setup");

  let calls = 0;
  const before = (await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n;

  const store = db.store({
    afterMovieWrite: async () => {
      calls++;

      await db.admin.query(
        "INSERT INTO app.movie_external_ids(movie_id,source,external_id) VALUES($1,$2,$3)",
        [other.movieId, "imdb", "tt0910012"]
      );
    }
  });

  expect(await store.persistMovie(capability, {
    ...(await aggregate("910012")),

    keys: [{
      source: "tmdb",
      externalId: tmdbId("910012")
    }, {
      source: "imdb",
      externalId: "tt0910012"
    }]
  }, 1000, context())).toEqual({
    status: "failed",
    code: "constraint_conflict"
  });

  expect(calls).toBe(1);

  expect(await db.store().resolveMovie({
    source: "tmdb",
    externalId: tmdbId("910012")
  }, context())).toBeNull();

  expect((await db.admin.query("SELECT count(*)::int AS n FROM app.movies")).rows[0].n).toBe(before);
});
