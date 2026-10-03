import { beforeAll, afterAll, expect, it } from "vitest";
import { target, capability, operator, context, barrier, waitForLock } from "./metadata-context.ts";
import { movie } from "../metadata/helpers.ts";
import { tmdbId } from "../../src/server/providers/tmdb-validation.ts";
import { importRatings, decodeSeed } from "../../src/server/ingestion/ratings.ts";
import type { ResolvedRating } from "../../src/server/db/metadata-store.ts";
import { createPgStore } from "../../src/server/db/pg-store.ts";
import { disposableGuard } from "../../tooling/metadata-disposable.ts";
let db: ReturnType<typeof target>;

beforeAll(() => {
  db = target();
});

afterAll(async () => {
  await db.close();
});

async function row(id: string): Promise<ResolvedRating> {
  const key = {
    source: "tmdb" as const,
    externalId: tmdbId(id)
  };

  const saved = await db.store().persistMovie(capability, {
    ...(await movie()),
    keys: [key]
  }, 1000, context());

  if (!("movieId" in saved))
    throw new Error("setup");

  return {
    key,
    movieId: saved.movieId,

    fields: {
      taste_rating: "liked"
    },

    indices: [0]
  };
}

it(
  "ratings commit, identical rerun preserves timestamps, fill absent/exclusion and all-or-none conflicts",
  async () => {
    const r = await row("920001"), s = db.store();
    expect((await s.applyRatings(operator, [r], context())).status).toBe("applied");

    const read = () => db.admin.query(
      "SELECT * FROM app.profile_movies WHERE profile_id=$1 AND movie_id=$2",
      [operator.profileId, r.movieId]
    );

    const before = (await read()).rows[0];
    expect(before.watched).toBe(false);
    expect((await s.applyRatings(operator, [r], context())).status).toBe("unchanged");
    expect((await read()).rows[0]).toEqual(before);

    await db.admin.query(
      "UPDATE app.profile_movies SET permanent_exclusion=true WHERE profile_id=$1 AND movie_id=$2",
      [operator.profileId, r.movieId]
    );

    expect((await s.applyRatings(operator, [{
      ...r,

      fields: {
        tired_viewing_rating: 0
      }
    }], context())).status).toBe("applied");

    expect((await read()).rows[0].permanent_exclusion).toBe(true);
    const absent = await row("920002");

    expect((await s.applyRatings(operator, [{
      ...r,

      fields: {
        taste_rating: "loved"
      }
    }, absent], context())).status).toBe("conflict");

    expect(
      (await db.admin.query("SELECT count(*)::int AS n FROM app.profile_movies WHERE movie_id=$1", [absent.movieId])).rows[0].n
    ).toBe(0);

    expect((await read()).rows[0].taste_rating).toBe("liked");

    expect((await s.applyRatings(operator, [{
      ...r,

      fields: {
        watched: true
      }
    }], context())).status).toBe("conflict");
  }
);

it("foreign, forged, null owner and deleted profile deny before provider/personal state", async () => {
  const foreign = {
    ...operator,
    profileId: "20000000-0000-4000-8000-000000000002"
  },
    unowned = {
      ...operator,
      profileId: "20000000-0000-4000-8000-000000000003"
    },
    missing = {
      ...operator,
      profileId: "20000000-0000-4000-8000-000000000099"
    };

  for (const op of [{
    ...operator
  }, foreign, unowned, missing]) {
    let calls = 0;
    const s = db.store(undefined, op.profileId === operator.profileId ? [operator] : [op]);

    const result = await importRatings(s, op, decodeSeed({
      version: "ratings-v1",

      rows: [{
        source: "tmdb",
        external_id: "920001",
        taste_rating: "loved"
      }]
    }, "2026-10-03"), async () => {
      calls++;
      return null;
    }, context());

    expect(result.status).toBe("unauthorized");
    expect(calls).toBe(0);
  }
});

it("issued context cannot be retargeted by mutating its profile/account fields", async () => {
  const op = {
    profileId: operator.profileId as string,
    accountId: operator.accountId as string
  };

  const store = db.store(undefined, [op]);
  expect(await store.authorizeProfile(op, context())).toBe(true);
  op.profileId = "20000000-0000-4000-8000-000000000002";
  op.accountId = "10000000-0000-4000-8000-000000000002";
  expect(await store.authorizeProfile(op, context())).toBe(false);
  expect((await store.applyRatings(op, [], context())).status).toBe("unauthorized");
});

it("two imports lock profile and reread state; direct writer locks are respected", async () => {
  const r = await row("920003"), acquired = barrier(), release = barrier();
  let blocker = 0;

  const a = createPgStore({
    pool: db.pool,
    catalogCapability: capability,
    operators: [operator],

    checkoutGuard: async client => {
      await disposableGuard(client);
      blocker = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    },

    hooks: {
      afterProfileLock: async () => {
        acquired.release();
        await release.promise;
      }
    }
  }).applyRatings(operator, [r], context());

  await acquired.promise;
  let entered = barrier();
  let pid = 0;

  const waitingStore = createPgStore({
    pool: db.pool,
    catalogCapability: capability,
    operators: [operator],

    checkoutGuard: async client => {
      await disposableGuard(client);
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      entered.release();
    }
  });

  const b = waitingStore.applyRatings(operator, [{
    ...r,

    fields: {
      taste_rating: "loved"
    }
  }], context());

  try {
    await entered.promise;
    await expect(waitForLock(db.admin, pid, blocker)).resolves.toBeUndefined();
  } finally {
    release.release();
    await Promise.all([a, b]);
  }

  expect((await a).status).toBe("applied");
  expect((await b).status).toBe("conflict");
  const client = await db.admin.connect();

  try {
    await client.query("BEGIN");
    const writer = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [operator.accountId]);

    await client.query(
      "UPDATE app.profile_movies SET taste_rating=$3 WHERE profile_id=$1 AND movie_id=$2",
      [operator.profileId, r.movieId, "meh"]
    );

    entered = barrier();
    const importing = waitingStore.applyRatings(operator, [r], context());

    try {
      await entered.promise;
      await expect(waitForLock(db.admin, pid, writer)).resolves.toBeUndefined();
    } finally {
      await client.query("COMMIT");
      await importing;
    }

    expect((await importing).status).toBe("conflict");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("profile deletion synchronizes through actual row lock and cascade", async () => {
  const op = {
    profileId: "20000000-0000-4000-8000-000000000088",
    accountId: operator.accountId
  };

  await db.admin.query("INSERT INTO app.profiles(id,account_id) VALUES($1,$2)", [op.profileId, op.accountId]);
  const r = await row("920004");
  const entered = barrier();
  let pid = 0;

  const store = createPgStore({
    pool: db.pool,
    catalogCapability: capability,
    operators: [op],

    checkoutGuard: async client => {
      await disposableGuard(client);
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      entered.release();
    }
  });

  const lock = await db.admin.connect();

  try {
    await lock.query("BEGIN");
    const blocker = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await lock.query("DELETE FROM app.profiles WHERE id=$1", [op.profileId]);
    const pending = store.applyRatings(op, [r], context());

    try {
      await entered.promise;
      await expect(waitForLock(db.admin, pid, blocker)).resolves.toBeUndefined();
    } finally {
      await lock.query("COMMIT");
      await pending;
    }

    expect((await pending).status).toBe("unauthorized");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
});

it("legitimately issued different profiles remain isolated on a shared movie", async () => {
  const other = Object.freeze({
    profileId: "20000000-0000-4000-8000-000000000002",
    accountId: "10000000-0000-4000-8000-000000000002"
  });

  const r = await row("920005"), store = db.store(undefined, [operator, other]);
  expect((await store.applyRatings(other, [r], context())).status).toBe("applied");

  expect((await db.admin.query(
    "SELECT count(*)::int AS n FROM app.profile_movies WHERE profile_id=$1 AND movie_id=$2",
    [operator.profileId, r.movieId]
  )).rows[0].n).toBe(0);

  expect((await store.applyRatings(operator, [{
    ...r,

    fields: {
      taste_rating: "disliked"
    }
  }], context())).status).toBe("applied");

  expect((await db.admin.query(
    "SELECT taste_rating FROM app.profile_movies WHERE profile_id=$1 AND movie_id=$2",
    [other.profileId, r.movieId]
  )).rows[0].taste_rating).toBe("liked");
});
