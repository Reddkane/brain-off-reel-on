import { beforeAll, afterAll, expect, it } from "vitest";
import pg from "pg";
import { target, capability, operator, context } from "./metadata-context.ts";
import { movie } from "../metadata/helpers.ts";
import { tmdbId } from "../../src/server/providers/tmdb-validation.ts";
import { createPgStore } from "../../src/server/db/pg-store.ts";
import { docker, disposableGuard, verifyContainer, verifyContainerIdentity, verifyNetwork, withDisposable } from "../../tooling/metadata-disposable.ts";
import type { Docker } from "../../tooling/metadata-disposable.ts";
let db: ReturnType<typeof target>;

beforeAll(() => {
  db = target();
});

afterAll(async () => {
  await db.close();
});

it(
  "every checkout including reuse refuses wrong/missing marker, unchanged readback, restored positive",
  async () => {
    const m = {
      ...(await movie()),

      keys: [{
        source: "tmdb" as const,
        externalId: tmdbId("930001")
      }]
    };

    const pids: number[] = [];

    const store = createPgStore({
      pool: db.pool,
      catalogCapability: capability,
      operators: [operator],

      checkoutGuard: async client => {
        pids.push((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await disposableGuard(client);
      }
    });

    expect((await store.persistMovie(capability, m, 1000, context())).status).toBe("created");
    expect((await store.persistMovie(capability, m, 1000, context())).status).toBe("unchanged");
    expect(pids).toHaveLength(2);
    expect(pids[0]).toBe(pids[1]);
    const before = (await db.admin.query("SELECT row_to_json(m) AS value FROM app.movies m ORDER BY id")).rows;
    const personal = (await db.admin.query("SELECT row_to_json(p) AS value FROM app.profile_movies p ORDER BY profile_id,movie_id")).rows;

    for (const replacement of ["wrong", null]) {
      await db.admin.query("DELETE FROM test_support.marker");

      if (replacement)
        await db.admin.query("INSERT INTO test_support.marker VALUES($1)", [replacement]);

      expect(await store.persistMovie(capability, {
        ...m,
        title: "Must not write",
        checkedAt: "2026-10-04T00:00:00.000Z"
      }, 1000, context())).toEqual({
        status: "failed",
        code: "target_guard"
      });

      if (replacement === "wrong")
        expect(pids[2]).toBe(pids[1]);

      expect((await store.applyRatings(operator, [], context())).status).toBe("failed");
      expect((await db.admin.query("SELECT row_to_json(m) AS value FROM app.movies m ORDER BY id")).rows).toEqual(before);

      expect(
        (await db.admin.query("SELECT row_to_json(p) AS value FROM app.profile_movies p ORDER BY profile_id,movie_id")).rows
      ).toEqual(personal);
    }

    await db.admin.query("INSERT INTO test_support.marker VALUES('bor-pr02-disposable')");
    expect((await store.persistMovie(capability, m, 1000, context())).status).toBe("unchanged");
  }
);

it("wrong database guard query fails safely through actual store", async () => {
  await db.admin.query("CREATE DATABASE bor_pr03_wrong");

  const pool = new pg.Pool({
    ...db.pool.options,
    password: db.pool.options.password,
    database: "bor_pr03_wrong",
    max: 1
  });

  try {
    await pool.query(
      "CREATE SCHEMA test_support; CREATE TABLE test_support.marker(name text); INSERT INTO test_support.marker VALUES('bor-pr02-disposable')"
    );

    const store = createPgStore({
      pool,
      catalogCapability: capability,
      operators: [],
      checkoutGuard: disposableGuard
    });

    expect(await store.persistMovie(capability, await movie(), 1000, context())).toEqual({
      status: "failed",
      code: "target_guard"
    });

    expect((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='app'")).rows[0].n).toBe(0);
  } finally {
    await pool.end();
  }
});

it(
  "cancellation destroys active transaction, server rolls back, subsequent checkout works",
  async () => {
    const m = {
      ...(await movie()),

      keys: [{
        source: "tmdb" as const,
        externalId: tmdbId("930002")
      }]
    },
      abort = new AbortController();

    const store = db.store({
      afterMovieWrite: async () => {
        abort.abort();
      }
    });

    expect((await store.persistMovie(capability, m, 1000, {
      signal: abort.signal,
      deadline: Date.now() + 10000
    })).status).toBe("failed");

    expect(await db.store().resolveMovie(m.keys[0], context())).toBeNull();
    expect((await db.store().persistMovie(capability, m, 1000, context())).status).toBe("created");
  }
);

it("missing Docker fails loudly and malformed inspection refuses before SQL/destruction", async () => {
  await expect(withDisposable(async () => { }, {
    docker: async () => ({
      code: 1,
      output: ""
    })
  })).rejects.toThrow("docker_version_failed");

  expect(() => verifyContainer({}, "id", "token", "network")).toThrow();
});

function inspection(token: string) {
  return {
    Id: "a".repeat(64),
    Name: `/bor-pr03-${token}`,

    Config: {
      Labels: {
        "bor.pr03.disposable": "true",
        "bor.pr03.run": token
      }
    },

    HostConfig: {
      NetworkMode: `bor-pr03-${token}`,
      Binds: null,

      Tmpfs: {
        "/var/lib/postgresql/data": ""
      },

      PortBindings: {
        "5432/tcp": [{
          HostIp: "127.0.0.1",
          HostPort: ""
        }]
      }
    },

    Mounts: [{
      Type: "tmpfs",
      Destination: "/var/lib/postgresql/data"
    }],

    NetworkSettings: {
      Ports: {
        "5432/tcp": [{
          HostIp: "127.0.0.1",
          HostPort: "49152"
        }]
      },

      Networks: {
        [`bor-pr03-${token}`]: {}
      }
    }
  };
}

it(
  "isolation validator has valid control and rejects public binding, labels, mounts, extra ports/networks",
  () => {
    const good = inspection("synthetic");
    expect(verifyContainer(good, good.Id, "synthetic", "bor-pr03-synthetic")).toBe(49152);

    const bad = [{
      ...good,
      Name: "/other"
    }, {
      ...good,

      Config: {
        Labels: {}
      }
    }, {
      ...good,

      HostConfig: {
        ...good.HostConfig,
        Binds: ["C:/private:/data"]
      }
    }, {
      ...good,

      NetworkSettings: {
        ...good.NetworkSettings,

        Ports: {
          "5432/tcp": [{
            HostIp: "0.0.0.0",
            HostPort: "49152"
          }]
        }
      }
    }, {
      ...good,

      NetworkSettings: {
        ...good.NetworkSettings,

        Networks: {
          other: {}
        }
      }
    }, {
      ...good,

      Mounts: [{
        Type: "volume",
        Destination: "/var/lib/postgresql/data"
      }]
    }];

    for (const v of bad)
      expect(() => verifyContainer(v, good.Id, "synthetic", "bor-pr03-synthetic")).toThrow();

    expect(() => verifyNetwork({
      Id: "b".repeat(64),
      Name: "wrong",
      Driver: "bridge",
      Labels: {}
    }, "b".repeat(64), "synthetic")).toThrow();
  }
);

it("execution failure tears down only inspected IDs; removal failure is loud", async () => {
  for (const removalFailure of [false, true]) {
    const calls: string[][] = [];
    let token = "";

    const fake: Docker = async args => {
      calls.push(args);

      if (args[0] === "network" && args[1] === "create") {
        token = args.at(-1)!.slice("bor-pr03-".length);

        return {
          code: 0,
          output: "b".repeat(64)
        };
      }

      if (args[0] === "network" && args[1] === "inspect") return {
        code: 0,

        output: JSON.stringify([{
          Id: "b".repeat(64),
          Name: `bor-pr03-${token}`,
          Driver: "bridge",

          Labels: {
            "bor.pr03.disposable": "true",
            "bor.pr03.run": token
          }
        }])
      };

      if (args[0] === "run") return {
        code: 0,
        output: "a".repeat(64)
      };

      if (args[0] === "inspect") return {
        code: 0,
        output: JSON.stringify([inspection(token)])
      };

      if (args[0] === "rm" && removalFailure) return {
        code: 1,
        output: ""
      };

      return {
        code: 0,
        output: ""
      };
    };

    const original = new Error("synthetic_execution");

    if (removalFailure) {
      const error = await withDisposable(async () => {
        throw original;
      }, {
        docker: fake
      }).catch(error => error);

      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors[0]).toBe(original);
      expect(error.errors[1].message).toBe("docker_rm_failed");
    } else await expect(withDisposable(async () => {
      throw original;
    }, {
      docker: fake
    })).rejects.toBe(original);

    expect(calls.filter(c => c[0] === "rm")).toEqual([["rm", "--force", "a".repeat(64)]]);

    if (!removalFailure)
      expect(calls.filter(c => c[0] === "network" &&
        c[1] === "rm")).toEqual([["network", "rm", "b".repeat(64)]]);
  }
});

it(
  "stopped container identity accepts absent live ports but refuses altered requested isolation",
  () => {
    const good = inspection("synthetic");

    const stopped = {
      ...good,

      NetworkSettings: {
        ...good.NetworkSettings,
        Ports: {}
      }
    };

    expect(() => verifyContainerIdentity(stopped, good.Id, "synthetic", "bor-pr03-synthetic")).not.toThrow();
    expect(() => verifyContainer(stopped, good.Id, "synthetic", "bor-pr03-synthetic")).toThrow();

    for (const changed of [{
      ...stopped,

      Config: {
        Labels: {}
      }
    }, {
      ...stopped,

      HostConfig: {
        ...good.HostConfig,

        PortBindings: {
          "5432/tcp": [{
            HostIp: "0.0.0.0",
            HostPort: ""
          }]
        }
      }
    }, {
      ...stopped,

      HostConfig: {
        ...good.HostConfig,
        Tmpfs: {}
      }
    }, {
      ...stopped,

      NetworkSettings: {
        Ports: {},
        Networks: {}
      }
    }])
      expect(() => verifyContainerIdentity(changed, good.Id, "synthetic", "bor-pr03-synthetic")).toThrow();
  }
);

it(
  "actual container kill preserves original work error and removes container and network",
  async () => {
    const original = new Error("ORIGINAL_WORK_ERROR");
    let containerId = "", networkId = "";

    await expect(withDisposable(async target => {
      containerId = target.containerId;
      networkId = target.networkId;
      expect((await docker(["kill", containerId])).code).toBe(0);
      throw original;
    })).rejects.toBe(original);

    expect(containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(networkId).toMatch(/^[a-f0-9]{64}$/);

    expect(
      (await docker(["ps", "--all", "--no-trunc", "--filter", `id=${containerId}`, "--format", "{{.ID}}"])).output.trim()
    ).toBe("");

    expect(
      (await docker(["network", "ls", "--no-trunc", "--filter", `id=${networkId}`, "--format", "{{.ID}}"])).output.trim()
    ).toBe("");
  },
  60000
);
