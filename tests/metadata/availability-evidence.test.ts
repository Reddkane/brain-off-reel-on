import { describe, expect, it } from "vitest";
import { calendarMonths, deriveArrival, metadataAction, subscriptionAccess, type EvidenceSweep } from "../../src/domain/availability-evidence.ts";
import { decodeSourceCheck, providerWebLink } from "../../src/server/providers/watchmode-sources.ts";
import { createWatchmode, type WatchmodeContext } from "../../src/server/providers/watchmode.ts";
import { expirePrivateEvidence } from "../../src/server/ingestion/private-evidence-cleanup.ts";
import { mkdtemp, mkdir, writeFile, utimes, unlink, rmdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { decodeSweepConfig } from "../../src/server/ingestion/sweep-config.ts";
const day = 86400000;
const base = Date.parse("2026-01-01T00:00:00Z");
function sweep(n: number, present: boolean, overrides: Partial<EvidenceSweep> = {}): EvidenceSweep {
    return { id: String(n), generation: "g", startedAt: base + n * day, completedAt: base + n * day,
        expiresAt: base + (n + 30) * day, outcome: "complete", presenceAt: present ? base + n * day : null, ...overrides };
}
describe("retained sweep evidence", () => {
    it('validates evidence maxima inside the shared sweep config', async () => {
        const raw = JSON.parse(await readFile('config/availability-evidence.example.json', 'utf8'));
        expect(decodeSweepConfig(raw).evidence?.sourceChecks).toBe(20);
        expect(() => decodeSweepConfig({ ...raw, evidence: { ...raw.evidence, sourceChecks: 21 } })).toThrow();
        expect(decodeSweepConfig({ ...raw, evidence: { ...raw.evidence, sourceChecks: 0 } }).evidence?.sourceChecks).toBe(0);
    });
    it("rejects link attacks and paid mobile text, keeping distinct US source offers", () => {
        for (const raw of ['http://netflix.com/title/1', 'https://netflix.com.evil.test/x', 'https://evil.netflix.com/x', 'https://hulu.com/x', 'https://a@netflix.com/x', 'https://netflix.com:444/x', 'https://netflix.com\\@evil.test/x', '//netflix.com/x', 'https://netflix.com/\nfoo'])
            expect(providerWebLink(203, raw).webUrl).toBeNull();
        expect(providerWebLink(203, 'Available on paid plans').missingReason).toBe('restricted');
        expect(providerWebLink(203, 'https://www.netflix.com/title/1').webUrl).toBe('https://www.netflix.com/title/1');
        const offers = decodeSourceCheck(['sub', 'free', 'rent', 'buy'].map(type => ({ source_id: 372, type, region: 'US', web_url: 'https://www.disneyplus.com/watch/1', ios_url: 'Paid plans only', format: 'HD' })), new Date(base).toISOString()).offers;
        expect(offers.map(o => o.offerType)).toEqual(['subscription', 'free', 'rental', 'purchase']);
        expect(offers.every(o => o.tierInclusion === 'unknown')).toBe(true);
        expect(decodeSourceCheck([], new Date(base).toISOString()).offers).toEqual([]);
        const changed = decodeSourceCheck([{ source_id: 203, type: 'unknown', region: 'US' }, { source_id: 157, type: 'sub', region: 'US', web_url: 'https://www.hulu.com/watch/1' }], new Date(base).toISOString());
        expect(changed.unknownTypes).toBe(1);
        expect(changed.offers.map(o => o.offerType)).toEqual(['subscription']);
    });
    it("uses the same serialized request lane and credit counter for pages, retries and sources", async () => {
        let now = base, attempts = 0;
        const starts: number[] = [], paths: string[] = [];
        const provider = createWatchmode('synthetic-key-12345', { sleep: async (ms) => { now += ms; }, fetch: async (input) => {
                const url = new URL(String(input));
                starts.push(now);
                paths.push(url.pathname);
                if (url.pathname.includes('/sources/')) {
                    attempts++;
                    return attempts === 1 ? new Response(null, { status: 503 }) : Response.json([{ source_id: 157, type: 'sub', region: 'US', web_url: 'https://www.hulu.com/watch/1' }]);
                }
                return Response.json({ page: 1, total_pages: 0, total_results: 0, titles: [] });
            } });
        const ctx: WatchmodeContext = { signal: AbortSignal.timeout(5000), now: () => now, deadline: base + 100000, creditCap: 3, charges: 0, attempts: 0, stopped: false };
        await Promise.all([provider.page(203, 1, ctx), provider.sources!(1, ctx)]);
        expect(ctx.charges).toBe(3);
        expect(starts.every((n, i) => i === 0 || n - starts[i - 1] >= 600)).toBe(true);
        expect(paths).toContain('/v1/title/1/sources/');
        await expect(provider.sources!(1, ctx)).rejects.toMatchObject({ code: 'credit_budget' });
        expect(ctx.charges).toBe(3);
    });
    it("expires inventoried private files strictly after their age without deleting credentials", async () => {
        const root = await mkdtemp(join(tmpdir(), 'bor-evidence-')), dir = join(root, '.cache', 'watchmode-verification');
        await mkdir(dir, { recursive: true });
        const file = join(dir, 'probe.json'), credential = join(dir, 'runtime.json');
        try {
            await writeFile(file, '{"synthetic":true}');
            await writeFile(credential, '{"synthetic":true}');
            await utimes(file, new Date(base), new Date(base));
            expect((await expirePrivateEvidence(root, base + 30 * day, AbortSignal.timeout(5000))).deleted).toBe(0);
            expect((await expirePrivateEvidence(root, base + 30 * day + 1, AbortSignal.timeout(5000))).deleted).toBe(1);
            await access(credential);
            expect((await expirePrivateEvidence(root, base + 31 * day, AbortSignal.timeout(5000))).deleted).toBe(0);
            // Copying old provider evidence into a newly created file cannot renew its age.
            await writeFile(file, JSON.stringify({ synthetic: true, observedAt: new Date(base).toISOString() }));
            expect((await expirePrivateEvidence(root, base + 31 * day, AbortSignal.timeout(5000))).deleted).toBe(1);
        }
        finally {
            await unlink(file).catch(() => { });
            await unlink(credential);
            await rmdir(dir);
            await rmdir(join(root, '.cache'));
            await rmdir(root);
        }
    });
    it("uses omission for a newly enriched movie, exact 48h and original page times", () => {
        const history = [sweep(0, false), sweep(2, true)];
        expect(deriveArrival(history, "g", base + 8 * day)).toMatchObject({ reason: "interval", absenceAt: base, presenceAt: base + 2 * day });
        expect(deriveArrival([history[0], sweep(2, true, { presenceAt: base + 2 * day + 1, completedAt: base + 2 * day + 1 })], "g", base + 8 * day).reason).toBe("gap");
    });
    it("preserves repeated presence and single-absence drift at short and long gaps", () => {
        for (const n of [3, 8]) {
            const result = deriveArrival([sweep(0, false), sweep(1, true), sweep(2, false), sweep(n, true)], "g", base + 10 * day);
            expect(result).toMatchObject({ reason: "interval", driftSweep: "2", presenceAt: base + day, absenceAt: base, episode: "1" });
        }
        expect(deriveArrival([sweep(0, false), sweep(1, true), sweep(2, true)], "g", base + 3 * day).presenceAt).toBe(base + day);
    });
    it("multiple omissions start a new episode; interruptions and expiry prevent manufactured arrivals", () => {
        expect(deriveArrival([sweep(0, true), sweep(1, false), sweep(2, false), sweep(3, true)], "g", base + 4 * day)).toMatchObject({ reason: "interval", episode: "3" });
        expect(deriveArrival([sweep(0, false), sweep(1, false, { outcome: "interrupted" }), sweep(2, true)], "g", base + 3 * day).reason).toBe("interrupted");
        expect(deriveArrival([sweep(0, false, { expiresAt: base + day }), sweep(2, true)], "g", base + 3 * day).reason).toBe("expired");
        expect(deriveArrival([sweep(0, false, { generation: "old" }), sweep(1, true)], "g", base + 3 * day).reason).toBe("generation");
        expect(deriveArrival([sweep(0, true)], "g", base + day).reason).toBe("first_sweep");
    });
    it("uses calendar boundaries, confirmed 404 and exhausted retries", () => {
        const refreshed = Date.parse("2026-08-31T12:00:00Z"), expiry = calendarMonths(refreshed, 6);
        expect(new Date(expiry).toISOString()).toBe("2027-02-28T12:00:00.000Z");
        expect(metadataAction(refreshed, calendarMonths(refreshed, 5), false, false)).toBe("refresh");
        expect(metadataAction(refreshed, expiry, false, true)).toBe("refresh");
        expect(metadataAction(refreshed, expiry + 1, false, false)).toBe("refresh");
        expect(metadataAction(refreshed, expiry + 1, false, true)).toBe("retire");
        expect(metadataAction(refreshed, refreshed, true, false)).toBe("retire");
    });
    it("keeps subscription tier uncertainty and unrelated offers distinct", () => {
        expect(subscriptionAccess(372, "subscription", "unknown")).toEqual({ eligible: true, label: "Ad-tier unverified" });
        for (const offer of ["free", "rental", "purchase", "ads"])
            expect(subscriptionAccess(372, offer, "unknown").eligible).toBe(false);
        expect(subscriptionAccess(634, "subscription", "unknown").eligible).toBe(false);
        expect(subscriptionAccess(634, "subscription", "included").eligible).toBe(false);
    });
});
