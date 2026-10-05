/** Evidence is supplied in logical sweep order, independently for one service generation. */
export interface EvidenceSweep {
    readonly id: string;
    readonly generation: string;
    readonly startedAt: number;
    readonly completedAt: number;
    readonly expiresAt: number;
    readonly outcome: "complete" | "interrupted";
    readonly presenceAt: number | null;
}
export type ArrivalReason = "interval" | "first_sweep" | "generation" | "gap" | "interrupted" | "expired" | "drift" | "absent";
export interface ArrivalEvidence {
    readonly state: "present" | "absent" | "unknown";
    readonly reason: ArrivalReason;
    readonly episode: string | null;
    readonly absenceAt: number | null;
    readonly presenceAt: number | null;
    readonly supports: readonly string[];
    readonly driftSweep: string | null;
}
/** Replays retained history so late metadata enrichment never moves an arrival clock. */
export function deriveArrival(history: readonly EvidenceSweep[], generation: string, now: number): ArrivalEvidence {
    let result: ArrivalEvidence = { state: "unknown", reason: "first_sweep", episode: null, absenceAt: null, presenceAt: null, supports: [], driftSweep: null };
    let prior: EvidenceSweep | undefined;
    let beforePrior: EvidenceSweep | undefined;
    let priorPresence: ArrivalEvidence | undefined;
    let interrupted = false;
    for (const sweep of history) {
        if (sweep.generation !== generation) {
            prior = undefined;
            beforePrior = undefined;
            priorPresence = undefined;
            result = { ...result, state: "unknown", reason: "generation", absenceAt: null, presenceAt: null, supports: [], driftSweep: null };
            continue;
        }
        if (sweep.expiresAt <= now || sweep.completedAt > now) {
            prior = undefined;
            beforePrior = undefined;
            priorPresence = undefined;
            result = { ...result, state: "unknown", reason: "expired", absenceAt: null, presenceAt: null, supports: [], driftSweep: null };
            continue;
        }
        if (sweep.outcome !== "complete") {
            interrupted = true;
            continue;
        }
        if (sweep.presenceAt === null) {
            result = { state: "absent", reason: "absent", episode: result.episode, absenceAt: sweep.completedAt, presenceAt: null, supports: [sweep.id], driftSweep: null };
        }
        else if (prior?.presenceAt !== null && prior?.presenceAt !== undefined) {
            // Keep the first presence and its supporting interval, including its expiry.
            result = priorPresence ?? result;
        }
        else if (prior && beforePrior?.presenceAt !== null && beforePrior?.presenceAt !== undefined) {
            result = priorPresence ? { ...priorPresence, driftSweep: prior.id } : result;
        }
        else {
            const gap = prior ? sweep.presenceAt - prior.completedAt : -1;
            const reason: ArrivalReason = interrupted ? "interrupted" : !prior ? result.reason === "expired" || result.reason === "generation" ? result.reason : "first_sweep" : gap < 0 || gap > 172800000 ? "gap" : "interval";
            result = { state: "present", reason, episode: sweep.id,
                absenceAt: reason === "interval" ? prior?.completedAt ?? null : null,
                presenceAt: sweep.presenceAt, supports: reason === "interval" && prior ? [prior.id, sweep.id] : [sweep.id], driftSweep: null };
        }
        if (sweep.presenceAt !== null)
            priorPresence = result;
        beforePrior = prior;
        prior = sweep;
        interrupted = false;
    }
    return result;
}
/** Clamp calendar arithmetic at month ends; preserve UTC time of day. */
export function calendarMonths(time: number, months: number): number {
    const date = new Date(time), day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const end = new Date(date.getTime());
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    date.setUTCDate(Math.min(day, end.getUTCDate()));
    return date.getTime();
}
export function metadataAction(refreshed: number, now: number, confirmedGone: boolean, exhausted: boolean): "keep" | "refresh" | "retire" {
    if (confirmedGone || (now > calendarMonths(refreshed, 6) && exhausted))
        return "retire";
    return now >= calendarMonths(refreshed, 5) ? "refresh" : "keep";
}
export function subscriptionAccess(source: number, offer: string, tier: "unknown" | "included" | "excluded") {
    const eligible = offer === "subscription" && tier !== "excluded" &&
        [203, 387, 372, 157].includes(source);
    return { eligible, label: eligible && tier === "unknown" && [372, 157].includes(source) ? "Ad-tier unverified" : null };
}
