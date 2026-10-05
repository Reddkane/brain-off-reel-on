import { array, integer, object, instant } from "./tmdb-validation.ts";
export const providerWebHosts: Readonly<Record<number, readonly string[]>> = {
    203: ["netflix.com", "www.netflix.com"], 387: ["play.hbomax.com"],
    372: ["disneyplus.com", "www.disneyplus.com"], 157: ["hulu.com", "www.hulu.com"]
};
export interface SourceOffer {
    readonly sourceId: number;
    readonly offerType: "subscription" | "free" | "rental" | "purchase" | "live_tv";
    readonly format: string | null;
    readonly webUrl: string | null;
    readonly missingReason: "missing" | "restricted" | "refused" | null;
    readonly tierInclusion: "unknown";
}
export interface SourceCheck {
    readonly observedAt: string;
    readonly offers: readonly SourceOffer[];
    readonly unknownTypes?: number;
}
export function providerWebLink(source: number, raw: unknown): Pick<SourceOffer, "webUrl" | "missingReason"> {
    if (raw === null || raw === undefined || raw === "")
        return { webUrl: null, missingReason: "missing" };
    if (typeof raw !== "string" || raw.length > 2048)
        return { webUrl: null, missingReason: "refused" };
    if (!raw.startsWith("https://"))
        return { webUrl: null, missingReason: /paid|plan|upgrade/i.test(raw) ? "restricted" : "refused" };
    try {
        const url = new URL(raw);
        if (/[\s\\\u0000-\u001f\u007f]/.test(raw) || url.username || url.password || url.port ||
            !providerWebHosts[source]?.includes(url.hostname))
            throw new Error();
        return { webUrl: url.href, missingReason: null };
    }
    catch {
        return { webUrl: null, missingReason: "refused" };
    }
}
export function decodeSourceCheck(raw: unknown, observedAt: string): SourceCheck {
    instant(observedAt);
    const offers: SourceOffer[] = [];
    let unknownTypes = 0;
    for (const input of array(raw, 500)) {
        const row = object(input), sourceId = integer(row.source_id, 1);
        if (typeof row.region !== "string" || !/^[A-Z]{2}$/.test(row.region))
            throw new Error("source_region");
        const offerType = row.type === "sub" ? "subscription" : row.type === "free" ? "free" : row.type === "rent" ? "rental" : row.type === "buy" ? "purchase" : row.type === 'tve' ? 'live_tv' : null;
        if (!offerType) {
            unknownTypes++;
            continue;
        }
        if (row.format !== null && row.format !== undefined && (typeof row.format !== "string" || row.format.length > 40))
            throw new Error("source_format");
        if (row.region !== "US")
            continue;
        // Mobile fields are intentionally not copied: free-plan restriction text is not a link.
        offers.push({ sourceId, offerType, format: typeof row.format === "string" ? row.format : null,
            ...providerWebLink(sourceId, row.web_url), tierInclusion: "unknown" });
    }
    return { observedAt, offers, unknownTypes };
}
