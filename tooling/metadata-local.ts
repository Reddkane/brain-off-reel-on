import { argumentsFor } from "../scripts/arguments.ts";
import { createPgStore } from "../src/server/db/pg-store.ts";
import { ingest } from "../src/server/ingestion/ingest.ts";
import { fixtures } from "./metadata-fixtures.ts";
import { withDisposable } from "./metadata-disposable.ts";

try {
  const args = argumentsFor(process.argv.slice(2), ["--scenario"]);
  const scenario = args["--scenario"];

  if (!["metadata", "ratings", "repeat"].includes(scenario))
    throw new Error("invalid_scenario");

  await withDisposable(async target => {
    const fixture = await fixtures(),
      capability = Object.freeze({}),
      operator = Object.freeze({
        profileId: "20000000-0000-4000-8000-000000000001",
        accountId: "10000000-0000-4000-8000-000000000001"
      });

    const store = createPgStore({
      pool: target.pool,
      catalogCapability: capability,
      operators: [operator],
      checkoutGuard: target.guard
    });

    for (let pass = 0;pass < (scenario === "repeat" ? 2 : 1);pass++) {
      const result = await ingest({
        ...fixture,
        store,
        capability,

        context: {
          signal: target.signal,
          now: fixture.now,

          budget: {
            attempts: 0,
            maxAttempts: fixture.config.limits.attempts,
            deadline: fixture.now() + 60000,
            stopped: false
          }
        },

        ...(scenario !== "metadata" ? {
          ratings: {
            operator,
            seed: fixture.seed
          }
        } : {})
      });

      console.log(JSON.stringify({
        synthetic: true,
        pass,
        ...result
      }));

      if (result.report.failed ||
        (result.ratings &&
          !["applied", "unchanged"].includes(result.ratings.status)))
        throw new Error("synthetic_failed");
    }
  });
} catch {
  console.error("metadata_local_failed");
  process.exitCode = 1;
}
