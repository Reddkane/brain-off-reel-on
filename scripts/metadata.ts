import { argumentsFor } from "./arguments.ts";
import { decodeConfig, productionMapping, readJson } from "../src/server/ingestion/config.ts";
import { planBatches } from "../src/server/ingestion/discovery.ts";

try {
  const args = argumentsFor(process.argv.slice(2), ["--config", "--as-of"]);

  if (!args["--config"] || !args["--as-of"])
    throw new Error("invalid_input");

  const config = decodeConfig(await readJson(args["--config"], 262144), args["--as-of"]), mapping = await productionMapping();

  console.log(JSON.stringify({
    mode: "offline_dry_run",
    bounds: config.limits,
    batches: planBatches(config, mapping),
    notConfigured: mapping.missingCategories,
    availability: "not_measured"
  }));
} catch {
  console.error("metadata_dry_run_invalid");
  process.exitCode = 1;
}
