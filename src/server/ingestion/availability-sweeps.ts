import { randomUUID } from "node:crypto";
import type { MovieMetadata } from "../../domain/metadata.ts";
import type { Pool, PoolClient } from "pg";
import { nextCandidate, popularityOrder, type EnrichmentOutcome } from "../../domain/availability-sweeps.ts";
import type { MetadataProvider, ProviderContext } from "../providers/metadata-provider.ts";
import { SweepError, watchmodeSources } from "../providers/watchmode.ts";
import type { WatchmodeContext, WatchmodeProvider, WatchmodeQuota } from "../providers/watchmode.ts";
import { tmdbId } from "../providers/tmdb-validation.ts";
import { acquireRefreshLock } from "../db/refresh-lock.ts";
import { createWatchmodeStore } from "../db/watchmode-store.ts";
import { createEvidenceStore } from "../db/availability-evidence-store.ts";
import { runEvidence, type EvidenceReport } from "./availability-evidence.ts";
import { calendarMonths } from "../../domain/availability-evidence.ts";
import type { SweepState } from "../db/watchmode-store.ts";
import { createPgStore } from "../db/pg-store.ts";
import type { StoreContext } from "../db/metadata-store.ts";
import type { SweepConfig } from "./sweep-config.ts";
import { sweepCode, type SweepCode } from "../providers/sweep-error.ts";
export { sweepCode } from "../providers/sweep-error.ts";
export function observedSpend(before: WatchmodeQuota | null, after: WatchmodeQuota | null) {
  if (!before || !after)
    return { credits: null, reason: "status_unavailable" };
  if (before.quota !== after.quota || after.used < before.used)
    return { credits: null, reason: "quota_reset_or_changed" };
  return { credits: after.used - before.used, reason: "account_delta_includes_other_consumers" };
}
/** Clamp calendar-month arithmetic rather than treating a month as thirty days. */
export function refreshDue(refreshedAt: string, now: number): boolean {
  return now >= calendarMonths(Date.parse(refreshedAt),5);
}
export interface SweepIO {
  readonly pool: Pool;
  readonly preflight?: (client: PoolClient) => Promise<void>;
  readonly guard: (client: PoolClient) => Promise<void>;
  readonly watchmode: WatchmodeProvider;
  readonly metadata: MetadataProvider;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly writeReport: (report: unknown, signal: AbortSignal) => Promise<void>;
  readonly expirePrivateFiles?: (now: number,signal: AbortSignal)=>Promise<{inspected:number;deleted:number;bounded:boolean}>;
}
/** Trusted composition; operator execution requires explicit live dispatch. */
export async function runSweeps(config: SweepConfig, io: SweepIO) {
  const id = randomUUID(), start = io.now(), deadline = start + config.limits.durationMs, workDeadline = deadline - 30000;
  const wall = new AbortController(), timer = setTimeout(() => wall.abort(), config.limits.durationMs);
  const parentSignal = AbortSignal.any([io.signal, wall.signal]);
  let lock: Awaited<ReturnType<typeof acquireRefreshLock>> | undefined;
  let databaseMs = 0, pages = 0, persisted = 0, selected = 0, failed = 0, details = 0;
  let before: WatchmodeQuota | null = null, after: WatchmodeQuota | null = null;
  let releaseUnknown = 0, originUnknown = 0;
  const coverage = watchmodeSources.map(source => ({ source, missingTmdbIds: 0, unknownPopularity: 0, quarantined: 0, memberships: 0 }));
  const expectedMetadata = new Map<string, MovieMetadata>();
  let outcome: "success" | "partial" | "failed" = "success";
  let code: SweepCode = "complete", reportAttempted = false;
  const checkpoints: SweepState[] = [], complete = new Set<string>(), selectedByService = [0, 0, 0, 0], persistedByService = [0, 0, 0, 0];
  let wm: WatchmodeContext = { signal: parentSignal, now: io.now, deadline: workDeadline, creditCap: config.limits.credits, charges: 0, attempts: 0, stopped: false };
  const tmdb: ProviderContext = { signal: parentSignal, now: io.now, budget: { attempts: 0, maxAttempts: config.limits.tmdbAttempts, deadline: workDeadline, stopped: false } };
  const store = createWatchmodeStore(io.pool, io.guard), capability = Object.freeze({});
  const evidenceStore=createEvidenceStore(store);
  let evidence: EvidenceReport | null=null, evidenceReadback: unknown=null;
  let privateCleanup: unknown='not_configured';
  const metadataStore = createPgStore({ pool: io.pool, checkoutGuard: io.guard, catalogCapability: capability, operators: [] });
  let cursor = { nextPageService: 0, nextEnrichmentService: 0 };
  async function database<T>(work: (context: StoreContext) => Promise<T>, final = false): Promise<T> {
    if (!lock)
      throw new SweepError("refresh_lock_failed");
    const remaining = config.limits.databaseMs - databaseMs - (final ? 0 : 5000), until = final ? deadline : workDeadline;
    if (remaining <= 0)
      throw new SweepError("database_budget");
    if (io.now() >= until)
      throw new SweepError("wall_budget");
    const began = performance.now();
    try {
      await lock.check();
      const available = remaining - (performance.now() - began);
      if (available <= 0)
        throw new SweepError("database_budget");
      return await work({ signal: lock.signal, deadline: Date.now() + Math.max(1, Math.min(10000, available, until - io.now())) });
    }
    finally {
      databaseMs += performance.now() - began;
    }
  }
  async function checkpoint(endedAt: string | null = null) {
    await database(ctx => store.report({
      id, startedAt: new Date(start).toISOString(), endedAt,
      outcome: endedAt ? outcome : "running", processed: persisted, failed,
      checkpoint: {
        ...cursor, sweeps: checkpoints.map(s => ({ id: s.id, nextPage: s.nextPage })),
        pages, selected, code,
      },
    }, ctx), endedAt !== null);
  }
  const summary = () => ({
    runId: id, startedAt: new Date(start).toISOString(), version: config.version, generation: config.generation,
    limits: config.limits, terms: config.terms, sortBy: "title_asc", outcome, code, pages, selected, persisted, failed, details,
    selectedByService, persistedByService, watchmodeAttempts: wm.attempts, attemptedCredits: wm.charges, tmdbAttempts: tmdb.budget.attempts,
    coverage, releaseUnknown, originUnknown,
    quotaBefore: before, quotaAfter: after, observedSpend: observedSpend(before, after), databaseMs: Math.ceil(databaseMs), elapsedMs: io.now() - start,
    checkpoint: { ...cursor, sweeps: checkpoints.map(s => ({ id: s.id, source: s.source, nextPage: s.nextPage, complete: complete.has(s.id) })) },
    availability: evidence ? "cached_evidence" : "candidates_only", adTierCertainty: "unverified", arrivalFreshness: evidence ? "interval_or_unknown" : "not_derived",
    evidence,evidenceReadback,privateCleanup
  });
  async function enrichPromoted(signal: AbortSignal) {
    const promoted = await database(ctx => store.promoted(config.generation, new Date(io.now()).toISOString(), ctx));
    const catalog = await database(ctx => store.catalog(ctx)), known = new Set(catalog.movies.map(m => m.tmdbId));
    const cooling = new Set(await database(ctx => store.cooling(new Date(io.now()).toISOString(), ctx)));
    const due = catalog.movies.filter(m => config.refreshIds.includes(m.tmdbId) ||
      (!cooling.has(m.tmdbId) && (m.retired || refreshDue(m.refreshedAt, io.now())))).map(m => m.tmdbId);
    const blocked = new Set(promoted.conflicts);
    for (let i = 0; i < coverage.length; i++) {
      const members = promoted.sweeps.find(s => s.source === coverage[i].source)?.candidates ?? [];
      coverage[i].memberships = members.length;
      coverage[i].missingTmdbIds = members.filter(c => c.tmdbId === null).length;
      coverage[i].unknownPopularity = members.filter(c => c.popularity === null).length;
      coverage[i].quarantined = members.filter(c => blocked.has(c.watchmodeId)).length;
    }
    const queues = watchmodeSources.map(source => {
      const members = promoted.sweeps.find(s => s.source === source)?.candidates ?? [];
      return members.filter(c => !c.coolingDown && c.tmdbId !== null &&
        !known.has(c.tmdbId) && !blocked.has(c.watchmodeId)).sort(popularityOrder);
    });
    let freeSlots = Math.max(0, config.limits.catalog - catalog.count);
    while (details < config.limits.details) {
      const priority = due.shift();
      const turn = priority ? undefined : nextCandidate(queues, cursor.nextEnrichmentService);
      const externalId = priority ?? turn?.candidate.tmdbId;
      const selectedService = turn?.service;
      if (!externalId)
        break;
      if (!priority && freeSlots === 0) {
        outcome = "partial";
        if (code === "complete") code = "catalog_limit";
        break;
      }
      const matching = promoted.sweeps.map(s => ({
        source: s.source, sweepId: s.id,
        members: s.candidates.filter(c => c.tmdbId === externalId && !blocked.has(c.watchmodeId)),
      }));
      const references = matching.flatMap(s => s.members.map(c => ({
        sweepId: s.sweepId, watchmodeId: c.watchmodeId,
      })));
      const services = watchmodeSources.map((source, i) =>
        matching.some(s => s.source === source && s.members.length) ? i : -1).filter(i => i >= 0);
      for (const service of services)
        selectedByService[service]++;
      selected++;
      details++;
      await database(async () => { });
      const result = await io.metadata.getMovie({ source: "tmdb", externalId: tmdbId(externalId) }, { ...tmdb, signal });
      if (result.status === "failed" && ["budget", "deadline"].includes(result.code)) {
        outcome = "partial";
        if (code === "complete") code = "detail_budget";
        break;
      }
      if (result.status === "failed" && result.code === "auth")
        throw new SweepError("provider_auth");
      if (result.status === "failed" && result.code === "cancelled")
        throw new SweepError("cancelled");
      let status: EnrichmentOutcome = "failed";
      if (result.status === "ok") {
        if (result.value.release === null)
          releaseUnknown++;
        if (result.value.origin.group === "unknown")
          originUnknown++;
        const saved = await database(ctx => metadataStore.persistMovie(capability, result.value, config.limits.catalog, ctx));
        if (saved.status === "catalog_limit") {
          outcome = "partial";
          if (code === "complete") code = "catalog_limit";
          break;
        }
        status = saved.status;
        if ("movieId" in saved && saved.status !== "stale") {
          expectedMetadata.set(saved.movieId, result.value);
          persisted++;
          if (!known.has(externalId)) {
            known.add(externalId);
            freeSlots--;
          }
          else if (catalog.movies.some(m=>m.tmdbId===externalId && m.retired)) freeSlots--;
          for (const service of services)
            persistedByService[service]++;
        }
      }
      else if (result.status === "not_found")
        status = "not_found";
      if (status === "failed" || status === "identity_conflict" || result.status === "invalid") {
        failed++;
        outcome = "partial";
        if (code === "complete") code = "metadata_failed";
      }
      if (result.status === "ok" && status === "failed")
        throw new SweepError("metadata_failed");
      if (tmdb.budget.stopped)
        throw new SweepError("provider_auth");
      await database(ctx => store.advance(externalId, references, status, new Date(io.now()).toISOString(), ctx));
      if (config.evidence?.enabled && (status==='failed' || status==='not_found'))
        await database(ctx=>evidenceStore.retire(externalId,new Date(io.now()).toISOString(),status==='not_found',ctx));
      for (let i = 0; i < queues.length; i++)
        queues[i] = queues[i].filter(c => c.tmdbId !== externalId);
      if (selectedService !== undefined) {
        cursor.nextEnrichmentService = (selectedService + 1) % 4;
      }
      await checkpoint();
    }
    if (details === config.limits.details && (due.length || queues.some(q => q.length))) {
      if (outcome === "success")
        outcome = "partial";
      if (code === "complete")
        code = "detail_budget";
    }
  }
  try {
    if (!config.terms.accepted)
      throw new SweepError("terms_required");
    if (config.evidence?.enabled && !io.expirePrivateFiles) throw new SweepError('request_invalid');
    const lockStarted = performance.now();
    try {
      lock = await acquireRefreshLock(io.pool, io.guard, parentSignal);
    }
    finally {
      databaseMs += performance.now() - lockStarted;
    }
    if (io.preflight) await database(() => lock!.inspect(io.preflight!));
    if (io.expirePrivateFiles) {
      try {
        privateCleanup = await io.expirePrivateFiles(io.now(), lock.signal);
        await lock.check();
      }
      catch {
        throw new SweepError("private_cleanup_failed");
      }
    }
    wm = { ...wm, signal: lock.signal };
    // Provider cancellation follows the lifetime of the lock connection.
    before = await io.watchmode.status(wm);
    if (before.quota - before.used < config.limits.credits)
      throw new SweepError("quota_insufficient");
    await database(ctx => store.recoverInterrupted(new Date(io.now()).toISOString(), ctx));
    cursor = await database(ctx => store.cursor(ctx));
    const capacityBlocked = new Set(await database(ctx => store.capacityBlocked(config.generation, new Date(io.now()).toISOString(), ctx)));
    const batchId = await database(ctx => store.batch(config.generation, new Date(io.now()).toISOString(), ctx));
    for (const source of watchmodeSources) {
      const state = await database(ctx => store.resume(source, config.generation, new Date(io.now()).toISOString(), ctx, batchId));
      checkpoints.push(state);
      if (state.terminal === "complete")
        complete.add(state.id);
    }
    const finished = new Set(checkpoints.filter(s => s.terminal !== null).map(s => s.id));
    for (const state of checkpoints) {
      if (capacityBlocked.has(state.source) && !finished.has(state.id)) {
        await database(ctx => store.fail(state.id, "capacity_blocked", new Date(io.now()).toISOString(), ctx));
        finished.add(state.id);
      }
    }
    if (finished.size > complete.size) {
      outcome = "partial";
      code = capacityBlocked.size ? "sweep_too_large" : "service_partial";
    }
    await checkpoint();
    let stopPaging = false;
    while (finished.size < checkpoints.length && !stopPaging) {
      const index = cursor.nextPageService;
      const state = checkpoints[index];
      if (finished.has(state.id)) {
        cursor.nextPageService = (index + 1) % 4;
        continue;
      }
      if (pages >= config.limits.pages) {
        outcome = "partial";
        code = "page_budget";
        break;
      }
      try {
        await database(async () => { });
        const page = await io.watchmode.page(state.source, state.nextPage, wm);
        const saved = await database(ctx => store.page(state, page, new Date(io.now()).toISOString(), ctx));
        pages++;
        cursor.nextPageService = (index + 1) % 4;
        checkpoints[index] = { ...state, nextPage: state.nextPage + 1, totalPages: page.totalPages };
        if (saved.complete) {
          complete.add(state.id);
          finished.add(state.id);
        }
        if (saved.incomplete) {
          finished.add(state.id);
          failed++;
          outcome = "partial";
          code = "membership_incomplete";
        }
        // Store newly learned totals before refusing an impossible aggregate scan.
        // The terminal event prevents the next run paying to rediscover them.
        if (checkpoints.reduce((sum, s) => sum + (s.totalPages === null ? 1 : Math.max(1, s.totalPages)), 0) > 60) {
          for (const open of checkpoints.filter(s => !finished.has(s.id))) {
            await database(ctx => store.fail(open.id, "combined_page_limit", new Date(io.now()).toISOString(), ctx));
            finished.add(open.id);
          }
          outcome = "partial";
          code = "combined_page_limit";
          stopPaging = true;
        }
        await checkpoint();
      }
      catch (error) {
        code = sweepCode(error);
        if (["credit_budget", "wall_budget", "database_budget", "page_budget",
          "provider_transient", "provider_throttled"].includes(code)) {
          outcome = "partial";
          stopPaging = true;
          break;
        }
        const serviceLocal = [
          "totals_changed", "pagination_drift", "page_stalled", "title_invalid",
          "identity_invalid", "popularity_invalid", "page_invalid", "totals_invalid",
          "page_incomplete", "membership_incomplete", "body_invalid", "body_limit",
          "page_conflict", "page_nonadvancing", "provider_http", "sweep_expired", "sweep_too_large",
        ];
        if (serviceLocal.includes(code)) {
          await database(ctx => store.fail(state.id, code, new Date(io.now()).toISOString(), ctx));
          finished.add(state.id);
          failed++;
          outcome = "partial";
          cursor.nextPageService = (index + 1) % 4;
          await checkpoint();
          continue;
        }
        outcome = "failed";
        failed++;
        stopPaging = true;
        for (const open of checkpoints.filter(s => !complete.has(s.id)))
          await database(ctx => store.fail(open.id, code, new Date(io.now()).toISOString(), ctx), true);
      }
    }
    if (outcome !== "failed" && io.now() < workDeadline) {
      await enrichPromoted(lock.signal);
      if (config.evidence?.enabled) {
        evidence=await runEvidence(config,{store:evidenceStore,database,watchmode:io.watchmode,context:wm,now:io.now});
        if (evidence.sourceFailures) { outcome='partial'; if (code==='complete') code='service_partial'; }
        if (evidence.code!=='complete') {outcome='partial';if(code==='complete')code=evidence.code;}
        evidenceReadback=await database(ctx=>evidenceStore.readback(new Date(io.now()).toISOString(),ctx),true);
      }
    }
    await database(async () => { }, true);
    const finalStatusContext={...wm,deadline};
    try {
      after = await io.watchmode.status(finalStatusContext);
    }
    catch {
      after = null;
    }
    finally {
      wm.attempts=finalStatusContext.attempts;
      wm.stopped=finalStatusContext.stopped;
    }
    await database(ctx => store.verifyMetadata(expectedMetadata, ctx), true);
    await checkpoint(new Date(io.now()).toISOString());
    const readback = await database(ctx => store.readback(checkpoints.map(s => s.id), ctx), true);
    if (readback.length !== checkpoints.length || checkpoints.some(s => {
      const row = readback.find(r => r.id === s.id);
      return !row || row.pages !== s.nextPage - 1 || (complete.has(s.id) && row.outcome !== "complete");
    }))
      throw new SweepError("readback_mismatch");
    reportAttempted = true;
    await io.writeReport({ ...summary(), readback: "verified", services: readback }, AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - io.now()))));
  }
  catch (error) {
    outcome = "failed";
    code = sweepCode(error);
    if (lock && !lock.signal.aborted && checkpoints.length) {
      try {
        for (const open of checkpoints.filter(s => !complete.has(s.id)))
          await database(ctx => store.fail(open.id, code, new Date(io.now()).toISOString(), ctx), true);
        await checkpoint(new Date(io.now()).toISOString());
      }
      catch { /* A disconnected/crashed run remains running; the next locked run seals its interruption. */ }
    }
    if (!reportAttempted) {
      reportAttempted = true;
      try {
        await io.writeReport({ ...summary(), readback: "failed" }, AbortSignal.timeout(2000));
      }
      catch {
        code = "report_failed";
      }
    }
    else
      code = "report_failed";
  }
  finally {
    clearTimeout(timer);
    await lock?.release();
  }
  return { exitCode: outcome === "failed" ? 1 : outcome === "partial" ? 2 : 0, report: summary() };
}
