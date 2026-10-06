import { pathToFileURL, fileURLToPath } from "node:url";
import { lstat, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { boundedText, privateJson, catalogCode } from "./catalog-config.ts";
import { decodeSweepConfig, type SweepConfig } from "../src/server/ingestion/sweep-config.ts";
import { sweepCodes } from "../src/server/providers/sweep-error.ts";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export interface SweepCLIIO {
  readonly root?: string;
  readonly read: (path: string) => Promise<string>;
  readonly output: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly live?: (config: SweepConfig, signal: AbortSignal) => Promise<{
    exitCode: number;
    report: { runId: string; code: string; pages: number; persisted: number };
  }>;
}
export async function validateLiveConfigPath(path: string, root = repositoryRoot) {
  const expected = resolve(root, path), actualRoot = await realpath(root);
  let parent = dirname(expected);
  while (parent !== resolve(root)) {
    const rel = relative(resolve(root), parent);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("private_path_required");
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(parent)).toLowerCase() !== parent.toLowerCase())
      throw new Error("private_path_required");
    parent = dirname(parent);
  }
  const stat = await lstat(expected);
  if (!stat.isFile() || stat.isSymbolicLink() || resolve(actualRoot).toLowerCase() !== resolve(root).toLowerCase())
    throw new Error("private_path_required");
}
/** Imports and offline validation never construct effect capabilities. */
export async function sweepCommand(args: readonly string[], io: SweepCLIIO): Promise<number> {
  let config: SweepConfig;
  try {
    if ((args.length !== 2 && args.length !== 3) || args[0] !== "--config" ||
      !args[1] || args[1].startsWith("--") || (args.length === 3 && args[2] !== "--live"))
      throw new Error("arguments_invalid");
    const source = await io.read(args[1]);
    if (Buffer.byteLength(source, "utf8") > 65536) throw new Error("config_limit");
    config = decodeSweepConfig(privateJson(source));
    if (args[2] === "--live") {
      if (!config.terms.accepted) { io.output("terms_required"); return 1; }
      const rel = relative(resolve(io.root ?? repositoryRoot, ".cache/availability/private"), resolve(io.root ?? repositoryRoot, args[1]));
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("private_path_required");
      await validateLiveConfigPath(args[1], io.root ?? repositoryRoot);
    }
  }
  catch {
    io.output("sweep_config_or_arguments_invalid");
    return 1;
  }
  if (args[2] !== "--live") {
    io.output(JSON.stringify({
      mode: "offline_dry_run", generation: config.generation, sources: [203, 387, 372, 157], sortBy: "title_asc", limits: config.limits,
      evidence: config.evidence ?? null,
      adTierPolicy: "allow_unverified_with_label_and_correction", availability: "candidates_only", liveGate: "explicit_live_required"
    }));
    return 0;
  }
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const signal = io.signal ? AbortSignal.any([controller.signal, io.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    const live = io.live ?? (await import("./availability-live.ts")).liveSweepComposition;
    const result = await live(config, signal), r = result.report;
    if (![0, 1, 2].includes(result.exitCode) || !sweepCodes.some(code => code === r.code) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.runId) ||
      !Number.isSafeInteger(r.pages) || r.pages < 0 || !Number.isSafeInteger(r.persisted) || r.persisted < 0)
      throw new Error("sweep_failed");
    io.output(`exit=${result.exitCode} code=${r.code} run=${r.runId} pages=${r.pages} persisted=${r.persisted}`);
    return result.exitCode;
  }
  catch (error) {
    io.output(signal.aborted ? "cancelled" : catalogCode(error, "sweep_failed"));
    return 1;
  }
  finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await sweepCommand(process.argv.slice(2), {
    read: path => boundedText(resolve(repositoryRoot, path), 65536), output: message => console.log(message)
  });
}
