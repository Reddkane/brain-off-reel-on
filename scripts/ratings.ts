import { argumentsFor } from "./arguments.ts";
import { readJson } from "../src/server/ingestion/config.ts";
import { decodeSeed, SeedConflict } from "../src/server/ingestion/ratings.ts";

try {
  const args = argumentsFor(process.argv.slice(2), ["--input", "--as-of"]);

  if (!args["--input"] || !args["--as-of"])
    throw new Error("invalid_input");

  const seed = decodeSeed(await readJson(args["--input"], 262144), args["--as-of"]);

  console.log(JSON.stringify({
    mode: "offline_dry_run",
    rows: seed.rows.length,
    identityState: "requires_disposable_composition",
    applied: 0
  }));
} catch (error) {
  if (error instanceof SeedConflict) console.error(JSON.stringify({
    status: "conflict",
    indices: error.indices,
    count: error.indices.length
  }));
  else
    console.error("ratings_dry_run_invalid");

  process.exitCode = 1;
}
