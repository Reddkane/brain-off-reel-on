import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { batchCommand, batchDecision } from "../../scripts/availability-batch.ts";
const ids = [203, 387, 372, 157].map((source, i) => ({ id: `10000000-0000-4000-8000-00000000000${i}`, source }));
function report(code = "detail_budget", active = 101, unfinished = false) {
  return {
    runId: "20000000-0000-4000-8000-000000000001", code, outcome: code === "complete" ? "success" : "partial", readback: "verified",
    pages: 4, persisted: 1, failed: 0, details: 1, attemptedCredits: 4, tmdbAttempts: 1,
    evidence: { code: "complete", sourceFailures: 0 }, evidenceReadback: { active, retired: 0 },
    checkpoint: { sweeps: ids.map(row => ({ ...row, nextPage: 2, complete: !unfinished })) },
    services: ids.map(row => ({ id: row.id, source_id: row.source, pages: 1, outcome: unfinished ? null : "complete" })),
  };
}
const totals = { runs: 1, attemptedCredits: 4, details: 1, tmdbAttempts: 1 };
describe("retained batch manual decision contract", () => {
  it("completed four-service rescan with pages and no new titles stops", () => {
    expect(batchDecision(2, report("detail_budget", 100), 100, totals).decision).toBe("stop");
  });
  it.each(["complete", "detail_budget", "wall_budget", "database_budget"])("allows only verified progressing %s", code => {
    expect(batchDecision(code === "complete" ? 0 : 2, report(code), 100, totals).decision).toBe("continue");
  });
  it.each(["credit_budget", "page_budget", "combined_page_limit", "quota_insufficient", "provider_http", "provider_auth", "capacity_blocked", "sweep_failed", "cancelled", "refresh_overlap", "report_failed", "unknown"])("stops disallowed %s", code => {
    expect(batchDecision(2, report(code), 100, totals).decision).toBe("stop");
  });
  it("failure vetoes precede cap and an earlier allowed budget code", () => {
    for (const change of [{ evidence: null }, { evidence: { code: "provider_http", sourceFailures: 0 } },
      { evidence: { code: "complete", sourceFailures: 1 } }, { evidenceReadback: null }, { evidenceReadback: { active: 1000 } },
      { readback: "failed" }, { failed: 1 }, { outcome: "failed" }])
      expect(batchDecision(2, { ...report("detail_budget", 1000), ...change }, 100, totals).decision).toBe("stop");
  });
  it("cap completion requires 1000 active and records partial without another run", () => {
    expect(batchDecision(2, report("catalog_limit", 1000), 999, totals).decision).toBe("cap");
    expect(batchDecision(2, report("catalog_limit", 999), 999, totals).decision).toBe("stop");
    expect(batchDecision(2, report("detail_budget", 1000), 999, totals).decision).toBe("cap");
    expect(batchDecision(1, report("wall_budget", 1000), 999, totals).decision).toBe("stop");
  });
  it("refresh-only persistence and missing/negative catalog deltas stop", () => {
    for (const previous of [101, 102, null]) expect(batchDecision(2, report(), previous, totals).decision).toBe("stop");
    expect(batchDecision(2, { ...report(), persisted: 0 }, 100, totals).decision).toBe("stop");
  });
  it("unfinished same-ID checkpoints advance; a new full scan is not resume progress", () => {
    const prior = report("detail_budget", 100, true);
    const advanced = report("wall_budget", 100, true);
    advanced.checkpoint.sweeps[0].nextPage = 3;
    advanced.services[0].pages = 2;
    advanced.pages = 1;
    expect(batchDecision(2, advanced, prior, totals).decision).toBe("continue");
    expect(batchDecision(2, advanced, { ...prior, readback: "failed" }, totals).decision).toBe("stop");
    expect(batchDecision(2, prior, prior, totals).decision).toBe("stop");
    expect(batchDecision(2, prior, 100, totals).decision).toBe("continue");
    expect(batchDecision(2, report("wall_budget", 100), prior, totals).decision).toBe("stop");
    advanced.services[0].pages = 1;
    expect(batchDecision(2, advanced, prior, totals).decision).toBe("stop");
  });
  it.each([{ ...totals, runs: 9 }, { ...totals, attemptedCredits: 900 }, { ...totals, details: 900 }, { ...totals, tmdbAttempts: 2700 }])("stops at each aggregate ceiling %j", aggregate => {
    expect(batchDecision(2, report(), 100, aggregate).decision).toBe("stop");
  });
});


describe("read-only operator batch command", () => {
  const manifest = { success: true, phase: "after-upgrade", schemaState: 5, digest: { movies: "100" }, acquisition: { acquisition_mismatches: "0", unexpected_acquisitions: "0" } };
  function wire(run: number, active: number) {
    const value = report("detail_budget", active);
    return { ...value, version: "availability-sweeps-v1", generation: "synthetic-batch", terms: { accepted: true },
      limits: { durationMs: 600000, credits: 100, pages: 60, details: 100, tmdbAttempts: 300, databaseMs: 120000, catalog: 1000 },
      startedAt: `2026-10-05T12:0${run}:00.000Z`, elapsedMs: 1000,
      runId: `20000000-0000-4000-8000-00000000000${run}`,
      checkpoint: { sweeps: value.checkpoint.sweeps.map(s => ({ ...s, id: s.id.replace("10000000", `${run}0000000`) })) },
      services: value.services.map(s => ({ ...s, id: s.id.replace("10000000", `${run}0000000`) })),
    };
  }
  async function command(runs: unknown[], exits = runs.map(() => 2), backup: unknown = manifest) {
    const files: Record<string, unknown> = { "manifest.json": backup };
    const args = ["--manifest", "manifest.json"];
    runs.forEach((run, i) => { files[`report${i}.json`] = run; args.push("--report", `report${i}.json`, "--exit", String(exits[i])); });
    const output: string[] = [];
    const exit = await batchCommand(args, { read: async path => JSON.stringify(files[path]), output: text => output.push(text) });
    return { exit, value: JSON.parse(output[0]) };
  }
  it("converts the string backup count and computes totals across ordered reports", async () => {
    const result = await command([wire(1, 101), wire(2, 102)]);
    expect(result.exit).toBe(0);
    expect(result.value).toMatchObject({ decision: "continue", netNewTitles: 1, totals: { runs: 2, attemptedCredits: 8, details: 2, tmdbAttempts: 2 } });
  });
  it("does not permit a later report to undo an earlier stop", async () => {
    const result = await command([wire(1, 100), wire(2, 101)]);
    expect(result.exit).toBe(2);
    expect(result.value).toMatchObject({ decision: "stop", reason: "completed_rescan_no_additions", stoppedAtRun: 1, totals: { runs: 2 } });
  });
  it("uses recorded exit statuses and rejects duplicate, out-of-order or inconsistent reports", async () => {
    expect((await command([wire(1, 101)], [1])).value.decision).toBe("stop");
    for (const runs of [[wire(1, 101), wire(1, 102)], [wire(2, 101), wire(1, 102)], [wire(1, 101), { ...wire(2, 102), generation: "changed" }]])
      expect((await command(runs)).exit).toBe(1);
  });
  it("the executable CLI reads only explicit synthetic files and prints computed totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "bor-batch-command-"));
    try {
      const manifestPath = join(root, "manifest.json"), first = join(root, "first.json"), second = join(root, "second.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(first, JSON.stringify(wire(1, 101)));
      await writeFile(second, JSON.stringify(wire(2, 102)));
      const result = await promisify(execFile)(process.execPath, ["scripts/availability-batch.ts", "--manifest", manifestPath,
        "--report", first, "--exit", "2", "--report", second, "--exit", "2"], { windowsHide: true, timeout: 10000 });
      expect(JSON.parse(result.stdout)).toMatchObject({ decision: "continue", totals: { runs: 2, attemptedCredits: 8, details: 2, tmdbAttempts: 2 } });
    }
    finally {
      const owned = relative(tmpdir(), root);
      expect(!isAbsolute(owned) && !owned.startsWith("..") && root.includes("bor-batch-command-")).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects malformed or wrong-phase manifests without printing private input", async () => {
    for (const backup of [{ ...manifest, phase: "before-upgrade" }, { ...manifest, digest: { movies: "01" } }, { ...manifest, success: false }, { ...manifest, acquisition: { acquisition_mismatches: "1", unexpected_acquisitions: "0" } }])
      expect((await command([wire(1, 101)], [2], backup)).exit).toBe(1);
    const output: string[] = [];
    expect(await batchCommand(["--manifest", "x", "--report", "y", "--exit", "2"], { read: async () => { throw new Error("invented_secret_sentinel"); }, output: text => output.push(text) })).toBe(1);
    expect(output.join("\n")).not.toContain("sentinel");
  });
});
