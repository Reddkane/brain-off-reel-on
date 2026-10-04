import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { boundedText, catalogCode, decodeCatalog, decodePassword, decodeProviderListing, decodeTokenFile, listingFilename, privateDirectory, privatePath, privateJson } from "./catalog-config.ts";
import { catalogPool } from "./catalog-local.ts";
import { localCatalogGuard, readCatalog } from "../src/server/db/local-catalog-target.ts";
import { createPgStore } from "../src/server/db/pg-store.ts";
import { canonicalValues } from "../src/server/db/metadata-sql.ts";
import { productionMapping } from "../src/server/ingestion/config.ts";
import { planBatches } from "../src/server/ingestion/discovery.ts";
import { ingest } from "../src/server/ingestion/ingest.ts";
import { createTmdb, transport } from "../src/server/providers/tmdb.ts";
import type { Transport } from "../src/server/providers/tmdb.ts";
import type { ProviderContext } from "../src/server/providers/metadata-provider.ts";
import { array, object, providerId, text } from "../src/server/providers/tmdb-validation.ts";
export function catalogArguments(args: readonly string[]) {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--config", "--as-of", "--live", "--list-providers"].includes(flag) ||
      Object.hasOwn(result, flag))
      throw new Error("invalid_arguments");
    if (["--live", "--list-providers"].includes(flag))
      result[flag] = true;
    else {
      if (!args[i + 1] ||
        args[i + 1].startsWith("--"))
        throw new Error("invalid_arguments");
      result[flag] = args[++i];
    }
  }
  if (typeof result["--config"] !== "string" ||
    typeof result["--as-of"] !== "string" ||
    (result["--list-providers"] &&
      !result["--live"]))
    throw new Error("invalid_arguments");
  return {
    config: result["--config"],
    asOf: result["--as-of"],
    live: result["--live"] === true,
    listing: result["--list-providers"] === true
  };
}
// One optional operation, no retries. It shares the import's attempt/deadline ledger.
export async function listProviders(token: string, context: ProviderContext, io: Transport, deadline = context.budget.deadline) {
  if (context.signal.aborted ||
    context.now() >= deadline ||
    context.budget.attempts >= context.budget.maxAttempts ||
    context.budget.stopped)
    throw new Error("listing_refused");
  context.budget.attempts++;
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - context.now())))]);
  const response = await io.fetch("https://api.themoviedb.org/3/watch/providers/movie?watch_region=US&language=en-US", {
    headers: {
      Authorization: `Bearer ${token}`
    },
    redirect: "error",
    signal
  });
  if (response.status === 401 ||
    response.status === 403)
    context.budget.stopped = true;
  if (!response.ok ||
    !response.body) {
    await response.body?.cancel();
    throw new Error("listing_unverified");
  }
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done)
        break;
      size += part.value.length;
      if (size > 2097152) {
        await reader.cancel();
        throw new Error("listing_limit");
      }
      parts.push(part.value);
    }
  }
  finally {
    reader.releaseLock();
  }
  const payload = object(JSON.parse(new TextDecoder("utf-8", {
    fatal: true
  }).decode(Buffer.concat(parts))));
  return array(payload.results, 1000).map(value => {
    const p = object(value);
    return {
      id: providerId(String(p.provider_id)),
      name: text(p.provider_name, 200)
    };
  });
}
export interface CatalogIO {
  readonly read: (path: string) => Promise<string>;
  readonly token: () => Promise<string>;
  readonly password: () => Promise<string>;
  readonly pool: (password: string) => Pool;
  readonly transport: Transport;
  readonly now: () => number;
  readonly writeReport: (report: unknown, signal?: AbortSignal) => Promise<void>;
  readonly output: (message: string) => void;
  readonly signal: AbortSignal;
}
export async function writeCatalogReport(report: unknown, directory = privateDirectory, signal?: AbortSignal): Promise<void> {
  const value = object(report), listing = value.action === "provider_listing";
  const id = listing ? value.executionId : value.runId;
  if (typeof id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw new Error("report_invalid");
  try {
    await writeFile(`${directory}/${listing ? "provider-list" : "run-report"}-${id}.json`, JSON.stringify(report, null, 2), {
      flag: "wx",
      mode: 0o600,
      signal
    });
  }
  catch (error) {
    if (error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST")
      throw new Error("report_exists");
    throw new Error("catalog_report_failed");
  }
}
export function defaultCatalogIO(signal: AbortSignal): CatalogIO {
  return {
    read: async (path) => {
      const listing = listingFilename.test(basename(path));
      try {
        return await boundedText(path, listing ? 262144 : 65536);
      }
      catch (error) {
        throw new Error(catalogCode(error, listing ? "provider_listing_file_failed" : "config_file_failed"));
      }
    },
    token: async () => {
      try {
        return decodeTokenFile(await boundedText(".env.local"), process.env.TMDB_READ_ACCESS_TOKEN);
      }
      catch (error) {
        throw new Error(catalogCode(error, "token_file_failed"));
      }
    },
    password: async () => {
      try {
        return decodePassword(privateJson(await boundedText(`${privateDirectory}/runtime.json`, 4096)));
      }
      catch (error) {
        throw new Error(catalogCode(error, "runtime_credential_failed"));
      }
    },
    pool: password => catalogPool(password),
    transport,
    now: Date.now,
    signal,
    writeReport: (report, reportSignal) => writeCatalogReport(report, privateDirectory, reportSignal ?? signal),
    output: message => console.log(message)
  };
}
export async function catalogCommand(args: readonly string[], io: CatalogIO): Promise<number> {
  let pool: Pool | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0, reportAttempted = false;
  let pendingReport: Record<string, unknown> | undefined;
  const executionId = randomUUID();
  const start = io.now();
  try {
    const flags = catalogArguments(args);
    const supplied = decodeCatalog(privateJson(await io.read(flags.live ? privatePath(flags.config) : flags.config)), flags.asOf, flags.listing);
    const mapping = await productionMapping();
    if (mapping.version !== "origin-v1")
      throw new Error("mapping_invalid");
    const scope = {
      subscriptions: supplied.subscriptions,
      included: supplied.services.filter(s => s.providerId !== null),
      omitted: supplied.services.filter(s => s.providerId === null)
    };
    if (!flags.live) {
      io.output(JSON.stringify({
        mode: "offline_dry_run",
        ...scope,
        limits: supplied.limits,
        batches: supplied.config ? planBatches(supplied.config, mapping) : [],
        availability: "not_measured"
      }));
      return 0;
    }
    if (supplied.terms.accepted !== true)
      throw new Error("terms_required");
    deadline = Date.now() + Math.max(0, supplied.limits.durationMs - (io.now() - start));
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    const signal = AbortSignal.any([controller.signal, io.signal]);
    // PR 3 subtracts its own reserve. Lowered operator durations still reserve 30s.
    const providerDeadline = start + supplied.limits.durationMs - 30000 + Math.min(30000, supplied.limits.durationMs / 10);
    const context: ProviderContext = {
      signal,
      now: io.now,
      budget: {
        attempts: 0,
        maxAttempts: supplied.limits.attempts,
        deadline: providerDeadline,
        stopped: false
      }
    };
    signal.throwIfAborted();
    const repository = await repositorySha();
    const token = await io.token();
    let checkedListing: ReturnType<typeof decodeProviderListing> | undefined;
    if (flags.listing) {
      const providers = await listProviders(token, context, io.transport, start + supplied.limits.durationMs - 30000);
      const checkedAt = new Date(io.now()).toISOString().slice(0, 10);
      await io.writeReport({
        action: "provider_listing",
        executionId,
        region: "US",
        checkedAt,
        providers,
        attempts: 1,
        terms: supplied.terms
      }, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      if (!supplied.config) {
        io.output(JSON.stringify({
          action: "provider_listing",
          checkedAt,
          file: `provider-list-${executionId}.json`,
          mapping: "unverified"
        }));
        return 0;
      }
      checkedListing = decodeProviderListing({
        checkedAt,
        region: "US",
        providers
      });
      // Listing precedes the existing serialized lane; preserve its 2/s ceiling.
      await io.transport.sleep(500, signal);
    }
    if (!supplied.config)
      throw new Error("providers_required");
    if (!checkedListing &&
      !supplied.providerListing)
      throw new Error("provider_listing_required");
    const listing = checkedListing ?? decodeProviderListing(privateJson(await io.read(`${privateDirectory}/${supplied.providerListing}`)));
    if (listing.checkedAt > new Date(io.now()).toISOString().slice(0, 10) ||
      scope.included.some(s => (!checkedListing &&
        s.checkedAt !== listing.checkedAt) ||
        !listing.providers.some(p => p.id === s.providerId &&
          p.name === s.providerName)))
      throw new Error("provider_mapping_unverified");
    if (checkedListing)
      scope.included = scope.included.map(s => ({
        ...s,
        checkedAt: listing.checkedAt
      }));
    io.output(JSON.stringify({
      mode: "live",
      included: scope.included.map(s => ({
        service: s.service,
        providerId: s.providerId
      })),
      omitted: scope.omitted.map(s => s.service)
    }));
    const password = await io.password();
    pool = io.pool(password);
    const preflightStart = performance.now();
    const before = await readCatalog(pool, Math.min(Date.now() + 10000, deadline - 30000));
    const preflightDatabaseMs = Math.ceil(performance.now() - preflightStart);
    if (preflightDatabaseMs >= supplied.limits.databaseMs)
      throw new Error("database_budget");
    const capability = Object.freeze({});
    const base = createPgStore({
      pool,
      catalogCapability: capability,
      operators: [],
      checkoutGuard: localCatalogGuard
    });
    const saved: {
      id: string;
      source: string;
      externalId: string;
      changed: boolean;
    }[] = [];
    const expectedAggregates = new Map<string, {
      aggregate: unknown[];
      credits: Parameters<typeof base.persistMovie>[1]["credits"];
    }>();
    let runId = "", recordingFailed = false, operationFailed = false;
    const store = {
      ...base,
      async persistMovie(...parameters: Parameters<typeof base.persistMovie>) {
        const result = await base.persistMovie(...parameters);
        if (result.status === "failed")
          operationFailed = true;
        if ("movieId" in result &&
          result.status !== "stale")
          expectedAggregates.set(result.movieId, {
            aggregate: canonicalValues(parameters[1]),
            credits: parameters[1].credits
          });
        if ("movieId" in result)
          for (const key of parameters[1].keys)
            saved.push({
              id: result.movieId,
              source: key.source,
              externalId: key.externalId,
              changed: ["created", "updated"].includes(result.status)
            });
        return result;
      },
      async recordRun(...parameters: Parameters<typeof base.recordRun>) {
        runId = parameters[1].id;
        const remaining = Math.max(1, Math.min(10000, deadline - Date.now()));
        const result = await base.recordRun(parameters[0], parameters[1], {
          signal: parameters[1].endedAt === null ? signal : AbortSignal.timeout(remaining),
          deadline: Math.min(parameters[2].deadline, Date.now() + remaining)
        });
        if (!result)
          recordingFailed = true;
        return result;
      }
    };
    const result = await ingest({
      store,
      capability,
      config: {
        ...supplied.config,
        limits: {
          ...supplied.config.limits,
          databaseMs: supplied.limits.databaseMs - preflightDatabaseMs
        }
      },
      mapping,
      context,
      provider: createTmdb(token, mapping, io.transport)
    });
    // Capture committed progress before any post-ingest readback can fail.
    pendingReport = {
      executionId,
      runId,
      repositorySha: repository,
      region: "US",
      asOf: flags.asOf,
      mappingVersion: mapping.version,
      ...scope,
      terms: supplied.terms,
      limits: supplied.limits,
      ...result,
      ingestOutcome: result.outcome,
      databaseMs: result.databaseMs + preflightDatabaseMs,
      preflightDatabaseMs,
      before,
      readback: "pending",
      arrivalFreshness: "not_measured"
    };
    const after = await readCatalog(pool, Math.min(Date.now() + 10000, deadline));
    const run = after.runs.find(r => r.id === runId);
    for (const [id, expected] of expectedAggregates) {
      const credits = after.credits.filter(c => c.movie_id === id &&
        c.source === "tmdb").map(c => ({
        source: c.source,
        personExternalId: c.person_external_id,
        name: c.name,
        role: c.role,
        billingOrder: c.billing_order
      })).sort((a, b) => a.role.localeCompare(b.role) ||
        a.personExternalId.localeCompare(b.personExternalId));
      if (!isDeepStrictEqual(after.aggregates.find(m => m.id === id)?.aggregate, expected.aggregate) ||
        !isDeepStrictEqual(credits, expected.credits))
        throw new Error("aggregate_readback_mismatch");
    }
    if (recordingFailed ||
      !run ||
      !run.ended_at ||
      run.processed_count !== result.report.persisted ||
      new Set(saved.filter(s => s.changed).map(s => s.id)).size !== result.report.persisted ||
      saved.some(s => !after.mappings.some(m => m.movie_id === s.id &&
        m.source === s.source &&
        m.external_id === s.externalId)) ||
      !isDeepStrictEqual(before.excluded, after.excluded) ||
      after.movies.length > supplied.limits.catalog)
      throw new Error("readback_mismatch");
    const report = {
      ...pendingReport,
      after,
      elapsedMs: io.now() - start,
      readback: "verified"
    };
    if (Date.now() >= deadline)
      throw new Error("finalization_deadline");
    reportAttempted = true;
    await io.writeReport(report, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
    const { memberships: _memberships, ...counts } = result.report;
    void _memberships;
    io.output(JSON.stringify({
      outcome: result.outcome,
      counts,
      attempts: result.attempts,
      databaseMs: result.databaseMs + preflightDatabaseMs,
      elapsedMs: io.now() - start,
      movies: after.movies.length,
      credits: after.credits.length
    }));
    return operationFailed ||
      result.report.bounds.includes("operation_failed") ||
      context.budget.stopped ||
      result.outcome === "failed" ? 1 : result.outcome === "success" ? 0 : 2;
  }
  catch (error) {
    const code = catalogCode(error, "catalog_command_failed");
    if (pendingReport &&
      !reportAttempted) {
      reportAttempted = true;
      try {
        await io.writeReport({
          ...pendingReport,
          outcome: "failed",
          readback: "failed",
          failureCode: code,
          elapsedMs: io.now() - start
        }, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      }
      catch {
        io.output("catalog_report_failed");
      }
    }
    io.output(code);
    return 1;
  }
  finally {
    try {
      if (pool)
        await pool.end();
    }
    finally {
      if (timer)
        clearTimeout(timer);
    }
  }
}
async function repositorySha() {
  // The SHA is public repository metadata; no shell or inherited git output.
  const { execFile } = await import("node:child_process");
  return new Promise<string>((resolve, reject) => execFile("git", ["rev-parse", "HEAD"], {
    windowsHide: true,
    timeout: 5000
  }, (error, stdout) => error ? reject(new Error("repository_sha_failed")) : resolve(stdout.trim())));
}
if (process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cancelled = new AbortController(), interrupt = () => cancelled.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    process.exitCode = await catalogCommand(process.argv.slice(2), defaultCatalogIO(cancelled.signal));
  }
  catch (error) {
    console.error(catalogCode(error, "catalog_command_failed"));
    process.exitCode = 1;
  }
  finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
