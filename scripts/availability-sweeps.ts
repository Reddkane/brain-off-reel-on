import { pathToFileURL } from "node:url";
import { boundedText, privateJson } from "./catalog-config.ts";
import { decodeSweepConfig } from "../src/server/ingestion/sweep-config.ts";
export interface SweepCLIIO {
  readonly read: (path: string) => Promise<string>;
  readonly output: (text: string) => void;
}
/** Retained composition is intentionally unavailable until evidence cleanup is accepted. */
export async function sweepCommand(args: readonly string[], io: SweepCLIIO): Promise<number> {
  try {
    if (args.length !== 2 && args.length !== 3)
      throw new Error("arguments_invalid");
    if (args[0] !== "--config" || !args[1] || args[1].startsWith("--") || (args.length === 3 && args[2] !== "--live"))
      throw new Error("arguments_invalid");
    const config = decodeSweepConfig(privateJson(await io.read(args[1])));
    if (args[2] === "--live") {
      io.output(config.terms.accepted ? "evidence_retention_required" : "terms_required");
      return 1;
    }
    io.output(JSON.stringify({
      mode: "offline_dry_run", generation: config.generation, sources: [203, 387, 372, 157], sortBy: "title_asc", limits: config.limits,
      adTierPolicy: "allow_unverified_with_label_and_correction", availability: "candidates_only", liveGate: "evidence_retention_required"
    }));
    return 0;
  }
  catch {
    io.output("sweep_config_or_arguments_invalid");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await sweepCommand(process.argv.slice(2), { read: path => boundedText(path, 65536), output: message => console.log(message) });
}
