import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogCode, decodeCatalog, decodeTokenFile, firstImportLimits, subscriptions, privateJson } from "../../scripts/catalog-config.ts";
import { catalogArguments, catalogCommand, listProviders, writeCatalogReport } from "../../scripts/catalog-import.ts";
import type { CatalogIO } from "../../scripts/catalog-import.ts";
import { refuseCollisions, verifyCatalogContainer } from "../../scripts/catalog-local.ts";
export function catalogFixture() {
  return {
    version: "catalog-local-v1",
    region: "US",
    mappingVersion: "origin-v1",
    services: Object.keys(subscriptions).map((service, i) => ({
      service,
      providerId: i === 0 ? "900101" : null,
      providerName: i === 0 ? "Invented synthetic provider" : null,
      checkedAt: i === 0 ? "2026-10-03" : null,
      qualification: i === 0 ? "Synthetic test mapping, not a real provider ID" : null,
      omission: i === 0 ? null : "Synthetic unresolved service"
    })),
    limits: {
      ...firstImportLimits
    },
    terms: {
      accepted: false,
      checkedAt: null,
      source: null,
      decision: null
    }
  };
}
describe("catalog private configuration and CLI", () => {
  it("prints only recognized internal codes, redacting raw errors even if lowercase", () => {
    for (const code of ["terms_required", "provider_mapping_unverified", "target_guard", "resource_occupied", "port_occupied", "setup_nonempty"])
      expect(catalogCode(new Error(code), "generic_failed")).toBe(code);
    for (const message of ["invented_secret_sentinel", "Bearer invented-secret-sentinel", "password=synthetic", "ENOENT secret-path"])
      expect(catalogCode(new Error(message), "generic_failed")).toBe("generic_failed");
  });
  it("writes per-run/listing evidence exclusively without overwriting earlier files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bor-catalog-report-test-"));
    const id = "10000000-0000-4000-8000-000000000001", next = "10000000-0000-4000-8000-000000000002";
    const filenames = [`run-report-${id}.json`, `run-report-${next}.json`, `provider-list-${id}.json`, `provider-list-${next}.json`];
    try {
      await writeCatalogReport({
        runId: id,
        outcome: "success",
        synthetic: true
      }, directory);
      await writeCatalogReport({
        runId: next,
        outcome: "partial",
        synthetic: true
      }, directory);
      await expect(writeCatalogReport({
        runId: id,
        outcome: "replacement"
      }, directory)).rejects.toThrow("report_exists");
      for (const executionId of [id, next])
        await writeCatalogReport({
          action: "provider_listing",
          executionId,
          checkedAt: "2026-10-03",
          synthetic: true
        }, directory);
      await expect(writeCatalogReport({
        action: "provider_listing",
        executionId: id
      }, directory)).rejects.toThrow("report_exists");
      expect(JSON.parse(await readFile(join(directory, filenames[0]), "utf8")).outcome).toBe("success");
      for (const file of filenames)
        expect(await readFile(join(directory, file), "utf8")).toContain(file.includes(next) ? next : id);
    }
    finally {
      for (const file of filenames)
        await unlink(join(directory, file)).catch(() => { });
      await rmdir(directory);
    }
  });
  it("rejects duplicate JSON keys, including escaped equivalent keys and nested objects", () => {
    expect(privateJson('{"limits":{"titles":1},"services":[{"service":"Netflix"}]}')).toEqual({
      limits: {
        titles: 1
      },
      services: [{
          service: "Netflix"
        }]
    });
    for (const json of ['{"password":"invented","password":"other"}', '{"limits":{"titles":1,"titles":100}}', '{"version":1,"vers\\u0069on":2}'])
      expect(() => privateJson(json)).toThrow("duplicate_json_key");
  });
  it("records confirmed tiers and supports an explicit resolved subset", () => {
    const result = decodeCatalog(catalogFixture(), "2026-10-03");
    expect(result.config?.providerIds).toEqual(["900101"]);
    expect(result.services.filter(s => s.providerId === null)).toHaveLength(3);
    expect(subscriptions.Hulu).toContain("with ads; no Live TV");
    expect(subscriptions["HBO Max"]).toBe("Standard, no ads, direct");
  });
  it.each(Object.keys(firstImportLimits))("refuses an enlarged %s limit", key => {
    const config = catalogFixture();
    Object.assign(config.limits, {
      [key]: firstImportLimits[key as keyof typeof firstImportLimits] + 1
    });
    expect(() => decodeCatalog(config, "2026-10-03")).toThrow();
  });
  it("refuses synthetic flags, malformed IDs, empty subsets and unknown settings", () => {
    expect(() => decodeCatalog({
      ...catalogFixture(),
      synthetic: true
    }, "2026-10-03")).toThrow();
    for (const id of ["0", "-1", "1|2", "123x", "https://example.test", null]) {
      const config = catalogFixture();
      config.services[0].providerId = id;
      expect(() => decodeCatalog(config, "2026-10-03")).toThrow();
    }
  });
  it("rejects unknown/duplicate/incomplete flags", () => {
    for (const args of [[], ["--target", "secret"], ["--config", "x", "--as-of", "2026-10-03", "--live", "--live"], ["--config", "x", "--as-of", "2026-10-03", "--list-providers"]])
      expect(() => catalogArguments(args)).toThrow();
  });
  it("parses only the token and rejects duplicates, expansion, malformed keys and overrides", () => {
    const token = "invented-secret-sentinel-0123456789";
    expect(decodeTokenFile(`OTHER=$(never-evaluated)\nTMDB_READ_ACCESS_TOKEN='${token}'`)).toBe(token);
    for (const source of [`TMDB_READ_ACCESS_TOKEN=${token}\nTMDB_READ_ACCESS_TOKEN=${token}`, "TMDB_READ_ACCESS_TOKEN=$(secret)", `export TMDB_READ_ACCESS_TOKEN=${token}`, "TMDB_READ_ACCESS_TOKEN missing", "TMDB_READ_ACCESS_TOKEN=x"])
      expect(() => decodeTokenFile(source)).toThrow("token_config_invalid");
    expect(() => decodeTokenFile(`TMDB_READ_ACCESS_TOKEN=${token}`, "conflicting-secret")).toThrow("token_config_invalid");
  });
  it("actual default composition never reads credentials, connects, fetches or writes", async () => {
    const calls: string[] = [], output: string[] = [];
    const forbidden = async () => { calls.push("effect"); throw new Error("invented-secret-sentinel"); };
    const io: CatalogIO = {
      read: async () => JSON.stringify(catalogFixture()),
      token: forbidden,
      password: forbidden,
      pool: () => { throw new Error("pool"); },
      transport: {
        fetch: forbidden,
        sleep: forbidden
      },
      now: Date.now,
      writeReport: forbidden,
      output: s => output.push(s),
      signal: new AbortController().signal
    };
    expect(await catalogCommand(["--config", "synthetic.json", "--as-of", "2026-10-03"], io)).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(output[0]).mode).toBe("offline_dry_run");
    expect(await catalogCommand(["--config", ".cache/real-catalog/private/test.json", "--as-of", "2026-10-03", "--live"], io)).toBe(1);
    expect(calls).toEqual([]); // terms refusal happens before the token is touched
    expect(output.join("\n")).not.toContain("invented-secret-sentinel");
  });
  it("bounds listing and counts auth failure without retry or leaking payloads", async () => {
    let calls = 0;
    const budget = {
      attempts: 0,
      maxAttempts: 2,
      deadline: Date.now() + 10000,
      stopped: false
    };
    await expect(listProviders("invented-secret-token", {
      now: Date.now,
      signal: new AbortController().signal,
      budget
    }, {
      sleep: async () => { },
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://api.themoviedb.org/3/watch/providers/movie?watch_region=US&language=en-US");
        expect(init?.redirect).toBe("error");
        return new Response("invented-secret-token", {
          status: 401
        });
      }
    })).rejects.toThrow("listing_unverified");
    expect(calls).toBe(1);
    expect(budget.attempts).toBe(1);
    expect(budget.stopped).toBe(true);
  });
  it("listing charges a failed operation to the same exhausted ledger", async () => {
    let calls = 0;
    const budget = {
      attempts: 1,
      maxAttempts: 2,
      deadline: Date.now() + 10000,
      stopped: false
    };
    const context = {
      now: Date.now,
      signal: new AbortController().signal,
      budget
    };
    const io = {
      sleep: async () => { },
      fetch: async () => {
        calls++;
        return new Response("invented-secret-sentinel", {
          status: 503
        });
      }
    };
    await expect(listProviders("invented-secret-sentinel", context, io)).rejects.toThrow("listing_unverified");
    await expect(listProviders("invented-secret-sentinel", context, io)).rejects.toThrow("listing_refused");
    expect(calls).toBe(1);
    expect(budget.attempts).toBe(2);
  });
});
describe("catalog resource refusals", () => {
  const r = {
    container: "synthetic",
    volume: "synthetic-data",
    network: "synthetic-net",
    port: 55432,
    label: "bor.catalog.test=synthetic"
  };
  const container = () => ({
    Id: "a".repeat(64),
    Name: "/synthetic",
    State: {
      Running: true
    },
    Config: {
      Labels: {
        "bor.catalog.test": "synthetic"
      }
    },
    HostConfig: {
      NetworkMode: r.network,
      AutoRemove: false,
      Privileged: false,
      Tmpfs: null,
      PortBindings: {
        "5432/tcp": [{
            HostIp: "127.0.0.1",
            HostPort: "55432"
          }]
      }
    },
    Mounts: [{
        Type: "volume",
        Name: r.volume,
        Destination: "/var/lib/postgresql/data",
        RW: true
      }],
    NetworkSettings: {
      Networks: {
        [r.network]: {}
      },
      Ports: {
        "5432/tcp": [{
            HostIp: "127.0.0.1",
            HostPort: "55432"
          }]
      }
    }
  });
  it("requires exact named volume and loopback-only binding", () => {
    expect(verifyCatalogContainer(container(), r)).toBe("a".repeat(64));
    for (const type of ["bind", "tmpfs"]) {
      const c = container();
      c.Mounts[0].Type = type;
      expect(() => verifyCatalogContainer(c, r)).toThrow();
    }
    const c = container();
    c.Mounts[0].Name = "unrelated";
    expect(() => verifyCatalogContainer(c, r)).toThrow();
    const publicBinding = container();
    publicBinding.HostConfig.PortBindings["5432/tcp"][0].HostIp = "0.0.0.0";
    expect(() => verifyCatalogContainer(publicBinding, r)).toThrow();
    const actualPublic = container();
    actualPublic.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0";
    expect(() => verifyCatalogContainer(actualPublic, r)).toThrow();
  });
  it("refuses colliding names without any mutation", async () => {
    for (const kind of ["ps", "volume", "network"] as const) {
      const calls: string[][] = [];
      await expect(refuseCollisions(r, async (args) => { calls.push(args); return args[0] === kind ? kind === "ps" ? "existing" : r[kind] : ""; })).rejects.toThrow("resource_occupied");
      expect(calls.every(args => ["ps", "volume", "network"].includes(args[0]) &&
        !args.includes("create"))).toBe(true);
    }
  });
  it("refuses an occupied loopback port", async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      if (!address ||
        typeof address === "string")
        throw new Error("test_address");
      await expect(refuseCollisions({
        ...r,
        port: address.port
      }, async () => "")).rejects.toThrow("port_occupied");
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
