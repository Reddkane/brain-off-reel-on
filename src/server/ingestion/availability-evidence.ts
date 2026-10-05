import type { WatchmodeContext, WatchmodeProvider } from "../providers/watchmode.ts";
import type { StoreContext } from "../db/metadata-store.ts";
import type { createEvidenceStore } from "../db/availability-evidence-store.ts";
import type { SweepConfig } from "./sweep-config.ts";
import { SweepError } from "../providers/sweep-error.ts";
export interface EvidenceReport {
    candidates: number;
    derived: number;
    sourceChecks: number;
    sourceFailures: number;
    unknownSourceTypes: number;
    offers: number;
    links: number;
    acquisitions: number;
    deleted: number;
    reasons: Record<string, number>;
    code: 'complete' | 'credit_budget' | 'wall_budget';
}
/** Runs only inside the sweeps worker's acquired lock and shared accounting. */
export async function runEvidence(config: SweepConfig, io: {
    readonly store: ReturnType<typeof createEvidenceStore>;
    readonly database: <T>(work: (ctx: StoreContext) => Promise<T>, final?: boolean) => Promise<T>;
    readonly watchmode: WatchmodeProvider;
    readonly context: WatchmodeContext;
    readonly now: () => number;
}) {
    const report: EvidenceReport = { candidates: 0, derived: 0, sourceChecks: 0, sourceFailures: 0, unknownSourceTypes: 0, offers: 0, links: 0, acquisitions: 0, deleted: 0, reasons: {}, code: 'complete' };
    const settings = config.evidence;
    if (!settings?.enabled)
        return report;
    const stamp = () => new Date(io.now()).toISOString();
    report.deleted = await io.database(ctx => io.store.cleanup(ctx));
    report.acquisitions = await io.database(ctx => io.store.acquireMemberships(config.generation, stamp(), ctx));
    const candidates = await io.database(ctx => io.store.candidates(config.generation, stamp(), settings.movies, settings.flaggedWatchmodeIds, ctx));
    report.candidates = candidates.length;
    const historyAt = stamp();
    const histories = await io.database(ctx => io.store.prepareHistory(config.generation, historyAt, ctx));
    for (const candidate of candidates) {
        const reasons = await io.database(ctx => io.store.derive(candidate.movieId, candidate.watchmodeId, config.generation, historyAt, ctx, histories));
        report.derived++;
        for (const reason of reasons)
            report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
        if (report.sourceChecks >= settings.sourceChecks)
            continue;
        if (io.context.charges >= io.context.creditCap) {
            report.code = 'credit_budget';
            break;
        }
        if (io.now() >= io.context.deadline) {
            report.code = 'wall_budget';
            break;
        }
        if (!io.watchmode.sources)
            throw new SweepError('request_invalid');
        await io.database(async () => { });
        report.sourceChecks++;
        try {
            const result = await io.watchmode.sources(candidate.watchmodeId, io.context);
            report.unknownSourceTypes += result.unknownTypes ?? 0;
            const saved = await io.database(ctx => io.store.sourceCheck(candidate.movieId, result, ctx));
            report.offers += saved.offers;
            report.links += saved.links;
        }
        catch (error) {
            if (error instanceof SweepError && (error.code === 'credit_budget' || error.code === 'wall_budget')) {
                report.code = error.code;
                break;
            }
            if (!(error instanceof SweepError) || !['provider_transient', 'provider_http', 'body_invalid', 'body_limit', 'provider_throttled'].includes(error.code))
                throw error;
            await io.database(ctx => io.store.sourceFailure(candidate.movieId, stamp(), ctx));
            report.sourceFailures++;
        }
    }
    return report;
}
