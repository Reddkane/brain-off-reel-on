import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, mkdtemp, unlink, rmdir, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextCandidate, popularityOrder } from "../../src/domain/availability-sweeps.ts";
import { createWatchmode, decodeWatchmodePage, decodeQuota, SweepError } from "../../src/server/providers/watchmode.ts";
import type { WatchmodeContext } from "../../src/server/providers/watchmode.ts";
import { decodeSweepConfig, sweepMaxima } from "../../src/server/ingestion/sweep-config.ts";
import { observedSpend, refreshDue, sweepCode } from "../../src/server/ingestion/availability-sweeps.ts";
import { sweepCommand as operatorSweepCommand, validateLiveConfigPath, type SweepCLIIO } from "../../scripts/availability-sweeps.ts";
import { writeLiveSweepReport } from "../../scripts/availability-live.ts";
import { decodeWatchmodeKeyFile } from "../../scripts/watchmode-key.ts";
import { writeCatalogReport } from "../../scripts/catalog-import.ts";
let testRoot: string;
beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "bor-sweep-cli-input-"));
  await mkdir(join(testRoot, ".cache/availability/private"), { recursive: true });
  await writeFile(join(testRoot, ".cache/availability/private/synthetic.json"), "{}");
});
afterEach(async () => { await rm(testRoot, { recursive: true, force: true }); });
const sweepCommand = (args: readonly string[], io: SweepCLIIO) => operatorSweepCommand(args, { root: testRoot, ...io });
const at = "2026-10-05T00:00:00.000Z";
const title = (id = 900001) => ({ id, tmdb_id: String(id), type: "movie", tmdb_type: "movie", popularity_percentile: 80 });
const page = () => ({ page: 1, total_pages: 1, total_results: 1, titles: [title()] });
function context(): WatchmodeContext { return { signal: new AbortController().signal, now: () => 0, deadline: 100000, creditCap: 100, charges: 0, attempts: 0, stopped: false }; }
const candidate = (id: number, popularity: number | null) => ({ watchmodeId: id, tmdbId: String(id), popularity });
describe("availability configuration and retained live gate", () => {
  it("offline and unaccepted live remain inert; accepted live preserves exit codes", async () => {
    const raw = JSON.parse(await readFile("config/availability-sweeps.example.json", "utf8"));
    const output: string[] = [];
    let calls = 0;
    for (const exitCode of [0, 2, 1]) {
      const io = {
        read: async () => JSON.stringify(raw), output: (s: string) => output.push(s),
        live: async () => { calls++; return { exitCode, report: { runId: "10000000-0000-4000-8000-000000000001", code: exitCode === 0 ? "complete" : exitCode === 2 ? "detail_budget" : "provider_auth", pages: 4, persisted: 1 } }; },
      };
      raw.terms.accepted = false;
      expect(await sweepCommand(["--config", "synthetic.json"], io)).toBe(0);
      expect(await sweepCommand(["--config", "synthetic.json", "--live"], io)).toBe(1);
      expect(output.at(-1)).toBe("terms_required");
      raw.terms.accepted = true;
      expect(await sweepCommand(["--config", "synthetic.json"], io)).toBe(0);
      expect(calls).toBe(exitCode === 0 ? 0 : exitCode === 2 ? 1 : 2);
      expect(await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], io)).toBe(exitCode);
      expect(output.at(-1)).toBe(`exit=${exitCode} code=${exitCode === 0 ? "complete" : exitCode === 2 ? "detail_budget" : "provider_auth"} run=10000000-0000-4000-8000-000000000001 pages=4 persisted=1`);
    }
    expect(calls).toBe(3);
  });
  it("invalid inputs and unsafe live paths refuse before dispatch; operational diagnostics redact", async () => {
    const raw = JSON.parse(await readFile("config/availability-sweeps.example.json", "utf8"));
    raw.terms.accepted = true;
    const output: string[] = [];
    let calls = 0;
    const io = { read: async () => JSON.stringify(raw), output: (s: string) => output.push(s), live: async () => { calls++; throw new Error("invented_secret_sentinel"); } };
    for (const args of [["--config", "synthetic.json", "--live"], ["--target", "retained"], ["--config", "x", "--live", "--live"]])
      expect(await sweepCommand(args, io)).toBe(1);
    expect(calls).toBe(0);
    for (const value of ['{"version":1,"version":2}', "invalid JSON", "x".repeat(65537)])
      expect(await sweepCommand(["--config", "x"], { ...io, read: async () => value })).toBe(1);
    expect(await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], io)).toBe(1);
    expect(calls).toBe(1);
    expect(output.at(-1)).toBe("sweep_failed");
    expect(output.join("\n")).not.toContain("sentinel");
  });
  it("SIGINT cancellation reaches the dispatched operation and removes both signal listeners", async () => {
    const raw = JSON.parse(await readFile("config/availability-sweeps.example.json", "utf8"));
    raw.terms.accepted = true;
    let reached = false;
    let received: AbortSignal | undefined;
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const io = {
      read: async () => JSON.stringify(raw), output: () => {},
      live: async (_config: unknown, signal: AbortSignal) => {
        reached = true;
        received = signal;
        process.emit("SIGINT");
        expect(signal.aborted).toBe(true);
        throw new Error("synthetic cancellation");
      },
    };
    expect(await sweepCommand(["--config", ".cache/availability/private/synthetic.json", "--live"], io)).toBe(1);
    expect(reached).toBe(true);
    expect(received?.aborted).toBe(true);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
  it("live config parent junctions and nonregular files refuse before effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "bor-live-path-"));
    try {
      await mkdir(join(root, ".cache/availability/private"), { recursive: true });
      const path = join(root, ".cache/availability/private/synthetic.json");
      await writeFile(path, "{}");
      await validateLiveConfigPath(path, root);
      await expect(validateLiveConfigPath(join(root, ".cache/availability/private"), root)).rejects.toThrow();
      await mkdir(join(root, "synthetic-other"));
      await symlink(join(root, "synthetic-other"), join(root, ".cache/availability/private/junction"), "junction");
      await writeFile(join(root, "synthetic-other/synthetic.json"), "{}");
      await expect(validateLiveConfigPath(join(root, ".cache/availability/private/junction/synthetic.json"), root)).rejects.toThrow("private_path_required");
    }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  it("injected live effects cannot bypass a junction in the real config path", async () => {
    const raw = JSON.parse(await readFile("config/availability-sweeps.example.json", "utf8"));
    raw.terms.accepted = true;
    await mkdir(join(testRoot, "synthetic-other"));
    await writeFile(join(testRoot, "synthetic-other/config.json"), "{}");
    await symlink(join(testRoot, "synthetic-other"), join(testRoot, ".cache/availability/private/junction"), "junction");
    let calls = 0;
    const io = { read: async () => JSON.stringify(raw), output: () => {}, live: async () => { calls++; throw new Error("must not run"); } };
    expect(await sweepCommand(["--config", ".cache/availability/private/junction/config.json", "--live"], io)).toBe(1);
    expect(calls).toBe(0);
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
  it("actual live report writer uses exclusive files and validates run identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "bor-live-report-"));
    const report = { runId: "10000000-0000-4000-8000-000000000001", synthetic: true };
    try {
      await writeLiveSweepReport(root, report, new AbortController().signal);
      await expect(writeLiveSweepReport(root, report, new AbortController().signal)).rejects.toMatchObject({ code: "EEXIST" });
      expect(JSON.parse(await readFile(join(root, ".cache/availability/private", `evidence-report-${report.runId}.json`), "utf8"))).toEqual(report);
      await expect(writeLiveSweepReport(root, { runId: "../synthetic" }, new AbortController().signal)).rejects.toThrow("report_failed");
    }
    finally { await rm(root, { recursive: true, force: true }); }
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
