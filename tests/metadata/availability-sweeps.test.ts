import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextCandidate, popularityOrder } from "../../src/domain/availability-sweeps.ts";
import { createWatchmode, decodeWatchmodePage, decodeQuota, SweepError } from "../../src/server/providers/watchmode.ts";
import type { WatchmodeContext } from "../../src/server/providers/watchmode.ts";
import { decodeSweepConfig, sweepMaxima } from "../../src/server/ingestion/sweep-config.ts";
import { observedSpend, refreshDue, sweepCode } from "../../src/server/ingestion/availability-sweeps.ts";
import { sweepCommand } from "../../scripts/availability-sweeps.ts";
import { decodeWatchmodeKeyFile } from "../../scripts/watchmode-key.ts";
import { writeCatalogReport } from "../../scripts/catalog-import.ts";
const at = "2026-10-05T00:00:00.000Z";
const title = (id = 900001) => ({ id, tmdb_id: String(id), type: "movie", tmdb_type: "movie", popularity_percentile: 80 });
const page = () => ({ page: 1, total_pages: 1, total_results: 1, titles: [title()] });
function context(): WatchmodeContext { return { signal: new AbortController().signal, now: () => 0, deadline: 100000, creditCap: 100, charges: 0, attempts: 0, stopped: false }; }
const candidate = (id: number, popularity: number | null) => ({ watchmodeId: id, tmdbId: String(id), popularity });
describe("availability configuration and retained live gate", () => {
  it("actual CLI validates offline and refuses live without credential, pool or provider capabilities", async () => {
    const raw = await readFile("config/availability-sweeps.example.json", "utf8"), output: string[] = [];
    const io = { read: async () => raw, output: (s: string) => output.push(s) };
    expect(await sweepCommand(["--config", "synthetic.json"], io)).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({ mode: "offline_dry_run", sortBy: "title_asc", liveGate: "evidence_retention_required" });
    expect(await sweepCommand(["--config", "synthetic.json", "--live"], io)).toBe(1);
    expect(output.at(-1)).toBe("terms_required");
    const accepted = JSON.parse(raw);
    accepted.terms.accepted = true;
    expect(await sweepCommand(["--config", "synthetic.json", "--live"], { ...io, read: async () => JSON.stringify(accepted) })).toBe(1);
    expect(output.at(-1)).toBe("evidence_retention_required");
    expect(await sweepCommand(["--target", "retained"], io)).toBe(1);
  });
  it.each(Object.keys(sweepMaxima))("refuses enlargement of %s", async (key) => {
    const config = JSON.parse(await readFile("config/availability-sweeps.example.json", "utf8"));
    config.limits[key] = sweepMaxima[key as keyof typeof sweepMaxima] + 1;
    expect(() => decodeSweepConfig(config)).toThrow("config_invalid");
  });
  it("refuses identity/terms/uncertainty overrides and duplicate refresh identities", async () => {
    const raw = JSON.parse(await readFile("config/availability-sweeps.example.json", "utf8"));
    for (const change of [{ region: "CA" }, { generation: "bad|generation" }, { adTierPolicy: "assume_ad_access" }, { refreshIds: ["01"] }, { refreshIds: ["900001", "900001"] }, { unknown: true }, { terms: { ...raw.terms, accepted: "yes" } }])
      expect(() => decodeSweepConfig({ ...raw, ...change })).toThrow("config_invalid");
  });
  it("parses only the Watchmode key and never evaluates unrelated values", () => {
    const key = "invented-secret-sentinel";
    expect(decodeWatchmodeKeyFile(`OTHER=$(never-run)\nWATCHMODE_API_KEY='${key}'`)).toBe(key);
    for (const raw of ["", `WATCHMODE_API_KEY=${key}\nWATCHMODE_KEY=${key}`, "WATCHMODE_API_KEY=$(secret)", "WATCHMODE_API_KEY=x"])
      expect(() => decodeWatchmodeKeyFile(raw)).toThrow("credential_invalid");
    expect(sweepCode(new Error(key))).toBe("sweep_failed");
    expect(sweepCode(Object.assign(new SweepError("page_invalid"), { code: key }))).toBe("sweep_failed");
  });
  it("exclusive reports retain the original file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bor-sweeps-report-")), runId = "10000000-0000-4000-8000-000000000001";
    try {
      await writeCatalogReport({ runId, synthetic: true, outcome: "partial" }, directory);
      await expect(writeCatalogReport({ runId, outcome: "success" }, directory)).rejects.toThrow("report_exists");
      expect(JSON.parse(await readFile(join(directory, `run-report-${runId}.json`), "utf8")).outcome).toBe("partial");
    }
    finally {
      await unlink(join(directory, `run-report-${runId}.json`));
      await rmdir(directory);
    }
  });
});
describe("Watchmode decoding and pure selection", () => {
  it("decodes candidates without inventing missing IDs or popularity", () => {
    const value = page();
    Object.assign(value.titles[0], { tmdb_id: null, popularity_percentile: null });
    expect(decodeWatchmodePage(value, 1, at).titles[0]).toEqual({ watchmodeId: 900001, tmdbId: null, popularity: null });
    expect(decodeWatchmodePage({ ...page(), harmless: "extra" }, 1, at).titles).toHaveLength(1);
  });
  it.each([{ id: 0 }, { id: "900001" }, { type: null }])("marks missing movie membership identity unresolved %j", change => {
    const value = page();
    Object.assign(value.titles[0], change);
    expect(decodeWatchmodePage(value, 1, at)).toMatchObject({ titles: [], unresolvedRows: 1 });
  });
  it.each([{ tmdb_id: "001" }, { tmdb_id: {} }, { tmdb_type: "tv" }])("preserves membership with an unusable TMDB mapping %j", change => {
    const value = page();
    Object.assign(value.titles[0], change);
    expect(decodeWatchmodePage(value, 1, at)).toMatchObject({ titles: [{ watchmodeId: 900001, tmdbId: null }], unresolvedRows: 0 });
  });
  it.each([NaN, 101, "80"])("uses unknown popularity for %j", popularity => {
    const value = page();
    Object.assign(value.titles[0], { popularity_percentile: popularity });
    expect(decodeWatchmodePage(value, 1, at).titles[0].popularity).toBeNull();
  });
  it("marks short pages incomplete and refuses contradictory totals or a different page", () => {
    expect(decodeWatchmodePage({ ...page(), titles: [] }, 1, at)).toMatchObject({ unresolvedRows: 1 });
    for (const value of [{ ...page(), total_results: 251 }, { ...page(), total_pages: 61 }, { ...page(), page: 2 }])
      expect(() => decodeWatchmodePage(value, 1, at)).toThrow();
    expect(() => decodeWatchmodePage({ ...page(), total_pages: 61, total_results: 15001 }, 1, at)).toThrow("sweep_too_large");
    expect(decodeWatchmodePage({ page: 1, total_pages: 0, total_results: 0, titles: [] }, 1, at).titles).toEqual([]);
  });
  it("uses production queue turns, wraps the cursor, skips empty services and sorts numeric ties", () => {
    const queues = [[candidate(1, 90)], [], [candidate(6, 10)], []];
    expect(nextCandidate(queues, 1)).toEqual({ candidate: candidate(6, 10), service: 2 });
    expect(nextCandidate(queues, 3)).toEqual({ candidate: candidate(1, 90), service: 0 });
    expect(nextCandidate([[], [], [], []], 0)).toBeUndefined();
    expect([candidate(10, 80), candidate(2, 80), candidate(1, null)].sort(popularityOrder).map(r => r.watchmodeId)).toEqual([2, 10, 1]);
  });
  it("counts identified non-movie rows as exclusions, not unresolved membership", () => {
    const value = page();
    Object.assign(value.titles[0], { type: "tv_series" });
    expect(decodeWatchmodePage(value, 1, at)).toMatchObject({ titles: [], excludedRows: 1, unresolvedRows: 0 });
  });
});
describe("actual Watchmode transport", () => {
  it("uses the fixed host/header/stable sort and serializes starts at 600ms", async () => {
    let now = 0;
    const starts: number[] = [];
    const provider = createWatchmode("synthetic-watchmode-key", {
      sleep: async (ms) => { now += ms; },
      fetch: async (url, init) => {
        const u = new URL(String(url));
        expect(u.origin).toBe("https://api.watchmode.com");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("X-API-Key")).toBe("synthetic-watchmode-key");
        expect(u.searchParams.has("apiKey")).toBe(false);
        starts.push(now);
        if (u.pathname.includes("status"))
          return Response.json({ quota: 2500, quotaUsed: 9 });
        expect(Object.fromEntries(u.searchParams)).toMatchObject({ sort_by: "title_asc", source_types: "sub", types: "movie", regions: "US", limit: "250" });
        return Response.json(page());
      }
    });
    const ctx = { ...context(), now: () => now };
    await Promise.all([provider.page(203, 1, ctx), provider.page(387, 1, ctx), provider.status(ctx)]);
    expect(starts).toEqual([0, 600, 1200]);
    expect(ctx.charges).toBe(2);
    expect(ctx.attempts).toBe(3);
  });
  it.each([401, 403])("stops without retry for auth %s", async (status) => {
    let calls = 0;
    const ctx = context();
    const provider = createWatchmode("synthetic-watchmode-key", { sleep: async () => { }, fetch: async () => { calls++; return new Response("invented-secret-sentinel", { status }); } });
    await expect(provider.page(203, 1, ctx)).rejects.toThrow("provider_auth");
    await expect(provider.page(387, 1, ctx)).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
    expect(ctx.charges).toBe(1);
    expect(ctx.stopped).toBe(true);
  });
  it("charges transient retries/uncertain errors and refuses before exceeding the run cap", async () => {
    const ctx = { ...context(), creditCap: 2 };
    let calls = 0;
    const provider = createWatchmode("synthetic-watchmode-key", { sleep: async () => { }, fetch: async () => { calls++; throw new Error("invented-secret-sentinel"); } });
    await expect(provider.page(203, 1, ctx)).rejects.toThrow("credit_budget");
    expect(ctx.charges).toBe(2);
    expect(calls).toBe(2);
  });
  it.each([429, 502, 503, 504])("retries bounded transient HTTP %s", async (status) => {
    let calls = 0, now = 0;
    const ctx = { ...context(), now: () => now };
    const provider = createWatchmode("synthetic-watchmode-key", { sleep: async (ms) => { now += ms; }, fetch: async () => { calls++; return calls < 3 ? new Response("", { status, headers: { "Retry-After": "2" } }) : Response.json(page()); } });
    await provider.page(203, 1, ctx);
    expect(calls).toBe(3);
    expect(ctx.charges).toBe(3);
    expect(now).toBeGreaterThanOrEqual(status === 429 ? 4000 : 3000);
  });
  it("bounds body size and refuses malformed JSON/unsafe Retry-After without retries", async () => {
    for (const response of [new Response("x".repeat(2097153)), new Response("invalid JSON"), new Response("", { status: 429, headers: { "Retry-After": "999" } })]) {
      const ctx = context();
      let calls = 0;
      const provider = createWatchmode("synthetic-watchmode-key", { sleep: async () => { }, fetch: async () => { calls++; return response; } });
      await expect(provider.page(203, 1, ctx)).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
  it("refuses cancelled or deadline-exhausted work before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createWatchmode("synthetic-watchmode-key", { sleep: async () => { }, fetch: async () => { throw new Error("must not fetch"); } });
    await expect(provider.page(203, 1, { ...context(), signal: controller.signal })).rejects.toThrow("cancelled");
    await expect(provider.page(203, 1, { ...context(), deadline: 0 })).rejects.toThrow("wall_budget");
  });
  it("cancels a stalled response stream instead of hanging on reader.read", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const provider = createWatchmode("synthetic-watchmode-key", {
      sleep: async () => { }, fetch: async () => {
        const stream = new ReadableStream({ start() { setTimeout(() => controller.abort(), 10); }, cancel() { cancelled = true; } });
        return new Response(stream);
      }
    });
    await expect(provider.page(203, 1, { ...context(), signal: controller.signal })).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
  });
  it("validates quota and reports missing/reset final status as unknown", () => {
    expect(decodeQuota({ quota: 2500, quotaUsed: 10 })).toEqual({ quota: 2500, used: 10 });
    for (const value of [{ quota: 100, quotaUsed: 101 }, { quota: "2500", quotaUsed: 10 }, {}])
      expect(() => decodeQuota(value)).toThrow();
    expect(observedSpend({ quota: 2500, used: 9 }, { quota: 2500, used: 10 }).credits).toBe(1);
    expect(observedSpend({ quota: 2500, used: 9 }, null).credits).toBeNull();
    expect(observedSpend({ quota: 2500, used: 9 }, { quota: 2500, used: 1 }).credits).toBeNull();
  });
  it("starts refresh at five calendar months, clamping end-of-month dates", () => {
    expect(refreshDue("2026-05-05T00:00:00.000Z", Date.parse(at) - 1)).toBe(false);
    expect(refreshDue("2026-05-05T00:00:00.000Z", Date.parse(at))).toBe(true);
    expect(refreshDue("2026-01-31T00:00:00.000Z", Date.parse("2026-06-30T00:00:00.000Z"))).toBe(true);
  });
});
