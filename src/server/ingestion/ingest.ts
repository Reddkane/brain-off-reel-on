import { randomUUID } from "node:crypto";
import type { ExternalMovieKey, MovieMetadata, ProviderResult } from "../../domain/metadata.ts";
import type { OriginMapping } from "../../domain/production-origin.ts";
import type { MovieId } from "../../domain/ids.ts";
import type { MetadataStore, OperatorContext, StoreContext } from "../db/metadata-store.ts";
import type { MetadataProvider, ProviderContext } from "../providers/metadata-provider.ts";
import type { DiscoveryConfig } from "./config.ts";
import { planBatches } from "./discovery.ts";
import { countIssues, countMetadata, diagnostics } from "./diagnostics.ts";
import { importRatings } from "./ratings.ts";
import type { RatingsSeed } from "./ratings.ts";

export async function ingest(
  options: {
    provider: MetadataProvider;
    store: MetadataStore;
    capability: object;
    config: DiscoveryConfig;
    mapping: OriginMapping;
    context: ProviderContext;
    ratings?: {
      operator: OperatorContext;
      seed: RatingsSeed;
    };
  }
) {
  const {
    provider,
    store,
    capability,
    config,
    mapping,
    context
  } = options;

  const batches = planBatches(config, mapping);

  const disabled = [
    ["streamer", "streamer_produced_financed"],
    ["studio", "traditional_studio"],
    ["independent", "independent"]
  ].filter(([probe]) => !batches.some(b => b.originProbe === probe)).map(([, group]) => group);

  const report = diagnostics([...new Set([...mapping.missingCategories, ...disabled])]);
  const start = context.now(), workDeadline = Math.min(context.budget.deadline, start + config.limits.durationMs) - Math.min(30000, config.limits.durationMs / 10);

  const providerContext: ProviderContext = {
    ...context,

    budget: {
      get attempts() {
        return context.budget.attempts;
      },

      set attempts(value: number) {
        context.budget.attempts = value;
      },

      maxAttempts: Math.min(context.budget.maxAttempts, config.limits.attempts),
      deadline: workDeadline,

      get stopped() {
        return context.budget.stopped;
      },

      set stopped(value: boolean) {
        context.budget.stopped = value;
      }
    }
  };

  const bound = (code: string) => {
    if (!report.bounds.includes(code))
      report.bounds.push(code);
  };

  let dbMs = 0;
  const runId = randomUUID();
  const startedAt = new Date(start).toISOString();

  const storeContext = (): StoreContext => ({
    signal: context.signal,
    deadline: Date.now() + Math.max(1, Math.min(10000, workDeadline - context.now(), config.limits.databaseMs - dbMs))
  });

  async function database<T>(work: () => Promise<T>): Promise<T> {
    if (dbMs >= config.limits.databaseMs) {
      bound("database_budget");
      throw new Error("database_budget");
    }

    const before = performance.now();

    try {
      return await work();
    } finally {
      dbMs += performance.now() - before;
    }
  }

  const active = () => !context.signal.aborted &&
    !context.budget.stopped &&
    context.now() < workDeadline &&
    context.budget.attempts < providerContext.budget.maxAttempts &&
    dbMs < config.limits.databaseMs;
  const details = new Map<string, Promise<MovieId | null>>();

  const inspection: Record<string, Extract<ProviderResult<MovieMetadata>, {
    status: "ok";
  }>["inspection"]> = {};

  const resolve = (key: ExternalMovieKey): Promise<MovieId | null> => {
    const cacheKey = `${key.source}/${key.externalId}`;
    const prior = details.get(cacheKey);

    if (prior)
      return prior;

    const work = (async () => {
      if (!active())
        return null;

      if (report.details >= config.limits.details) {
        bound("detail_budget");
        return null;
      }

      report.details++;
      const result = await provider.getMovie(key, providerContext);

      if (result.status !== "ok") {
        report.failed++;

        if (result.status === "invalid")
          countIssues(report, result.issues);

        return null;
      }

      if (result.inspection)
        inspection[cacheKey] = result.inspection;

      countIssues(report, result.issues);
      countMetadata(report, result.value, config.asOf);
      const saved = await database(() => store.persistMovie(capability, result.value, config.limits.catalog, storeContext()));

      if ("movieId" in saved) {
        report.resolved++;

        if (saved.status === "created" || saved.status === "updated")
          report.persisted++;

        countIssues(report, saved.issues);
        return saved.movieId;
      }

      report.failed++;

      if (saved.status === "catalog_limit")
        bound("catalog_limit");

      return null;
    })();

    details.set(cacheKey, work);
    return work;
  };

  let ratings;

  if (!(await database(() => store.recordRun(capability, {
    id: runId,
    startedAt,
    endedAt: null,
    outcome: "running",
    processed: 0,
    failed: 0,

    checkpoint: {
      policy: config.version,
      asOf: config.asOf,
      mappingVersion: mapping.version
    }
  }, storeContext())))) {
    report.failed++;

    return {
      outcome: "failed",
      report,
      ratings,
      inspection,
      attempts: context.budget.attempts,
      databaseMs: Math.ceil(dbMs)
    };
  }

  // Resolve the independent ratings reservation before discovery can exhaust shared detail capacity.
  if (options.ratings) {
    try {
      const ratingsStore: MetadataStore = {
        ...store,
        authorizeProfile: op => database(() => store.authorizeProfile(op, storeContext())),
        applyRatings: (op, rows) => database(() => store.applyRatings(op, rows, storeContext()))
      };

      ratings = await importRatings(ratingsStore, options.ratings.operator, options.ratings.seed, async key => {
        if (!active())
          return null;

        const existing = await database(() => store.resolveMovie(key, storeContext()));
        return existing ?? resolve(key);
      }, storeContext());
    } catch {
      report.failed++;

      ratings = {
        status: "failed" as const,
        changed: 0,
        indices: []
      };
    }
  }

  const stopped = new Set<string>(), seen = new Set<string>(), previousPages = new Map<string, string>(), totals = new Map<string, string>();

  try {
    for (let page = 1;page <= config.limits.pages &&
      active();page++) for (const batch of batches) {
        if (stopped.has(batch.id))
          continue;

        if (!active() || report.operations >= config.limits.operations) {
          if (!report.bounds.includes("discovery_budget"))
            bound("discovery_budget");

          report.batches[batch.id] ??= {
            pages: 0,
            status: "truncated",
            candidates: 0
          };

          report.batches[batch.id].status = "truncated";
          stopped.add(batch.id);
          continue;
        }

        if (batch.cohort === "undated_probe" && page > 1)
          continue;

        report.operations++;

        const state = report.batches[batch.id] ??= {
          pages: 0,
          status: "requested",
          candidates: 0
        };

        state.pages++;

        const result = await provider.discover({
          ...batch,
          page
        }, providerContext);

        if (result.status !== "ok") {
          state.status = "failed";
          report.failed++;
          stopped.add(batch.id);
          continue;
        }

        const keys = result.value.candidateKeys.slice().sort((a, b) => Number(a.externalId) - Number(b.externalId));
        state.candidates += keys.length;
        report.sourceCohorts[batch.cohort] = (report.sourceCohorts[batch.cohort] ?? 0) + keys.length;
        const fingerprint = keys.map(k => k.externalId).join(","), total = `${result.value.totalPages}/${result.value.totalResults}`;

        if (totals.has(batch.id) && totals.get(batch.id) !== total) countIssues(report, [{
          code: "totals_changed",
          severity: "warning"
        }]);

        totals.set(batch.id, total);
        let added = 0;

        for (const key of keys) {
          const k = `${key.source}/${key.externalId}`;
          const memberships = report.memberships[k] ??= [];

          if (!memberships.includes(batch.id))
            memberships.push(batch.id);

          if (seen.has(k)) {
            report.duplicates++;
            continue;
          }

          seen.add(k);
          report.unique++;
          added++;

          if (report.selected < config.limits.titles) {
            report.selected++;
            await resolve(key);
          } else if (!report.bounds.includes("title_budget"))
            bound("title_budget");
        }

        if (!added && previousPages.get(batch.id) === fingerprint && keys.length) {
          countIssues(report, [{
            code: "page_stalled",
            severity: "warning"
          }]);

          stopped.add(batch.id);
          state.status = "truncated";
        }

        previousPages.set(batch.id, fingerprint);

        if (!keys.length || page >= result.value.totalPages || batch.cohort === "undated_probe") {
          stopped.add(batch.id);

          if (state.status !== "truncated")
            state.status = keys.length ? "complete" : "empty";
        } else if (page === config.limits.pages) {
          state.status = "truncated";
          bound("page_budget");
        }
      }
  } catch {
    report.failed++;
    bound("operation_failed");
  }

  if (!active()) {
    bound(
      context.signal.aborted ? "cancelled" : context.budget.stopped ? "provider_stopped" : context.budget.attempts >= providerContext.budget.maxAttempts ? "request_budget" : dbMs >= config.limits.databaseMs ? "database_budget" : "deadline"
    );

    for (const batch of batches) {
      const state = report.batches[batch.id] ??= {
        pages: 0,
        status: "truncated",
        candidates: 0
      };

      if (state.status === "requested")
        state.status = "truncated";
    }
  }

  const outcome = report.failed ||
    report.bounds.length ||
    (ratings &&
      !["applied", "unchanged"].includes(ratings.status)) ? "partial" : "success";

  const finalCtx = {
    signal: AbortSignal.timeout(10000),
    deadline: Date.now() + 10000
  };

  if (!(await store.recordRun(capability, {
    id: runId,
    startedAt,
    endedAt: new Date(context.now()).toISOString(),
    outcome,
    processed: report.persisted,
    failed: report.failed,

    checkpoint: {
      policy: config.version,
      asOf: config.asOf,
      mappingVersion: mapping.version,
      report
    }
  }, finalCtx)))
    report.failed++;

  return {
    outcome: report.failed ? "partial" : outcome,
    report,
    ratings,
    inspection,
    attempts: context.budget.attempts,
    databaseMs: Math.ceil(dbMs)
  };
}
