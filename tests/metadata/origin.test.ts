import { expect, it } from "vitest";
import { deriveOrigin } from "../../src/domain/production-origin.ts";
import { at, key, syntheticMapping } from "./helpers.ts";

const release = {
  date: "2025-01-01",
  source: "synthetic",
  semantics: "theatrical" as const,
  checkedAt: at
};

it("derives affirmative groups, mixed, and unknown extra companies", async () => {
  const mapping = await syntheticMapping();

  const companies = mapping.rules.map(r => ({
    source: "tmdb" as const,
    external_id: r.externalId,
    name: r.name,
    checked_at: at
  }));

  for (let i = 0;i < 3;i++)
    expect(deriveOrigin([companies[i]], key, release, mapping, at).group).toBe(mapping.rules[i].group);

  expect(deriveOrigin(companies, key, release, mapping, at).group).toBe("mixed");

  expect(deriveOrigin([...companies, {
    source: "tmdb",
    external_id: "900999",
    name: "Unknown",
    checked_at: at
  }], key, release, mapping, at).group).toBe("unknown");

  expect(deriveOrigin([companies[0]], key, null, mapping, at).group).toBe("unknown");

  expect(deriveOrigin([{
    ...companies[0],
    name: "Name collision"
  }], key, release, mapping, at).group).toBe("unknown");
});

it(
  "distribution, acquisition and marketing never establish production; expected-red control",
  async () => {
    const m = await syntheticMapping(),
      r = m.rules[0],
      companies = [{
        source: "tmdb" as const,
        external_id: r.externalId,
        name: r.name,
        checked_at: at
      }];

    for (const relationship of ["distribution", "acquisition", "uncertain"] as const) expect(deriveOrigin(companies, key, release, {
      ...m,

      rules: [{
        ...r,
        relationship,
        evidence: "Original on a subscription"
      }]
    }, at).group).toBe("unknown");

    expect(deriveOrigin(companies, key, release, {
      ...m,

      rules: [r, {
        ...r,
        relationship: "distribution"
      }]
    }, at).group).toBe("unknown");

    const assertion = (group: string) => expect(group).toBe("unknown");

    expect(() => assertion(deriveOrigin(companies, key, release, {
      ...m,

      rules: [{
        ...r,
        relationship: "production"
      }]
    }, at).group)).toThrow();
  }
);

it("enforces period, version, reference and title-specific evidence", async () => {
  const m = await syntheticMapping(),
    r = m.rules[0],
    c = [{
      source: "tmdb" as const,
      external_id: r.externalId,
      name: r.name,
      checked_at: at
    }];

  for (const rule of [{
    ...r,
    through: "2020-01-01"
  }, {
    ...r,
    from: "2026-01-01"
  }, {
    ...r,
    reference: ""
  }, {
    ...r,
    checkedAt: "2099-01-01"
  }]) expect(deriveOrigin(c, key, release, {
    ...m,
    rules: [rule]
  }, at).group).toBe("unknown");

  const result = deriveOrigin(c, key, release, {
    ...m,
    version: "synthetic-origin-v2",

    rules: [{
      ...r,
      scope: "movie",
      externalId: key.externalId
    }]
  }, at);

  expect(result.mappingVersion).toBe("synthetic-origin-v2");
  expect(result.group).toBe(r.group);
  expect(result.evidence[0].reference).toBe(r.reference);
});
