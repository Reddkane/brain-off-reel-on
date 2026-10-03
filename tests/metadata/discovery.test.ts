import { expect, it } from "vitest";
import { decodeConfig } from "../../src/server/ingestion/config.ts";
import { lowerBound, planBatches } from "../../src/server/ingestion/discovery.ts";
import { createTmdb } from "../../src/server/providers/tmdb.ts";
import { fixture, syntheticMapping } from "./helpers.ts";

it("fair bounded batches retain distinct provider variants and disjoint cohorts", async () => {
  const mapping = await syntheticMapping(),
    config = decodeConfig({
      ...await fixture("discovery") as object,
      mappingVersion: mapping.version
    }, "2026-10-03");

  const batches = planBatches(config, mapping);
  expect(batches).toHaveLength(51);
  expect(new Set(batches.map(b => b.providerKey)).size).toBe(3);
  expect(batches.filter(b => b.cohort === "undated_probe")).toHaveLength(3);
  expect(batches.find(b => b.cohort === "recent")?.dateBounds.from).toBe(lowerBound(config.asOf));
  expect(batches.find(b => b.cohort === "older")?.dateBounds.through).toBe("2024-10-02");
});

it("unverified probes disabled, excess bounds and unknown config rejected", () => {
  const base = {
    version: "discovery-v1",
    region: "US",
    providerIds: ["900101"],
    mappingVersion: "origin-v1"
  };

  expect(planBatches(decodeConfig(base, "2026-10-03"), {
    version: "origin-v1",
    rules: [],
    missingCategories: []
  })).toHaveLength(5);

  for (const change of [{
    limits: {
      attempts: 1501
    }
  }, {
    limits: {
      operations: 401
    }
  }, {
    limits: {
      titles: 501
    }
  }, {
    providers: []
  }, {
    providerIds: []
  }, {
    providerIds: ["900101", "900101"]
  }]) expect(() => decodeConfig({
    ...base,
    ...change
  }, "2026-10-03")).toThrow();
});

it(
  "historically supported company probes still source older films without assigning origin",
  async () => {
    const mapping = await syntheticMapping(),
      config = decodeConfig({
        version: "discovery-v1",
        region: "US",
        providerIds: ["900101"],
        mappingVersion: mapping.version
      }, "2026-10-03");

    const historical = {
      ...mapping,

      rules: [{
        ...mapping.rules[0],
        through: "2020-01-01"
      }]
    };

    expect(planBatches(config, historical).some(b => b.cohort === "older" &&
      b.originProbe === "streamer")).toBe(true);
  }
);

it("actual request OR monetization/provider/company, no region substitution or offers", async () => {
  const m = await syntheticMapping(),
    c = decodeConfig({
      version: "discovery-v1",
      region: "US",
      providerIds: ["900101"],
      mappingVersion: m.version
    }, "2026-10-03");

  let url = "";

  const p = createTmdb("synthetic", m, {
    sleep: async () => { },

    fetch: async u => {
      url = String(u);

      return new Response(JSON.stringify({
        page: 1,
        total_pages: 0,
        total_results: 0,
        results: []
      }));
    }
  });

  const batch = planBatches(c, m).find(b => b.originProbe === "streamer")!;

  expect((await p.discover(batch, {
    signal: AbortSignal.timeout(1000),
    now: Date.now,

    budget: {
      attempts: 0,
      maxAttempts: 1,
      deadline: Date.now() + 1000,
      stopped: false
    }
  })).status).toBe("ok");

  const u = new URL(url);
  expect(u.searchParams.get("with_watch_monetization_types")).toBe("flatrate|ads|free");
  expect(u.searchParams.get("with_watch_providers")).toBe("900101");
  expect(u.searchParams.get("with_companies")).toBe("900201");
  expect(u.searchParams.has("region")).toBe(false);
});
