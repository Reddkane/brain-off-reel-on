import type { DiscoveryBatch } from "../../domain/metadata.ts";
import type { OriginMapping } from "../../domain/production-origin.ts";
import type { DiscoveryConfig } from "./config.ts";
import { InvalidInput } from "../providers/tmdb-validation.ts";

export function cohort(date: string | null, asOf: string): "recent" | "older" | "future" | "unknown" {
  if (!date)
    return "unknown";

  if (date > asOf)
    return "future";

  return date >= lowerBound(asOf) ? "recent" : "older";
}

export function lowerBound(asOf: string): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 730);
  return d.toISOString().slice(0, 10);
}

export function planBatches(config: DiscoveryConfig, mapping: OriginMapping): DiscoveryBatch[] {
  if (config.mappingVersion !== mapping.version)
    throw new InvalidInput();

  const probes: {
    name: DiscoveryBatch["originProbe"];
    ids: string[];
  }[] = [{
    name: "unfiltered",
    ids: []
  }];

  for (const [name, group] of [
    ["streamer", "streamer_produced_financed"],
    ["studio", "traditional_studio"],
    ["independent", "independent"]
  ] as const) {
    // Historical production periods remain useful for the older sourcing cohort.
    // Detail evidence applies each rule's exact period; probe labels are never truth.
    const ids = [...new Set(mapping.rules.filter(
      r => r.group === group &&
        r.scope === "company" &&
        ["production", "co_production", "financing", "commissioning"].includes(r.relationship) &&
        r.from <= config.asOf &&
        r.checkedAt <= config.asOf
    ).map(r => r.externalId))].sort();

    if (ids.length > 10)
      throw new InvalidInput();

    if (ids.length) probes.push({
      name,
      ids
    });
  }

  const lower = lowerBound(config.asOf), prior = new Date(`${lower}T00:00:00Z`);
  prior.setUTCDate(prior.getUTCDate() - 1);
  const batches: DiscoveryBatch[] = [];

  for (const providerKey of config.providerIds) {
    for (const cohort of ["recent", "older"] as const) for (const sort of (cohort === "recent" ? ["popularity.desc", "primary_release_date.desc"] : ["popularity.desc", "vote_count.desc"]) as DiscoveryBatch["sort"][]) for (const p of probes) batches.push({
      id: `${providerKey}/${cohort}/${sort}/${p.name}`,
      providerKey,
      cohort,
      sort,
      originProbe: p.name,

      dateBounds: cohort === "recent" ? {
        from: lower,
        through: config.asOf
      } : {
        through: prior.toISOString().slice(0, 10)
      },

      companyIds: p.ids,
      page: 1
    });

    batches.push({
      id: `${providerKey}/undated_probe/title.asc/unfiltered`,
      providerKey,
      cohort: "undated_probe",
      originProbe: "unfiltered",
      sort: "title.asc",
      dateBounds: {},
      companyIds: [],
      page: 1
    });
  }

  return batches;
}
