import { open } from "node:fs/promises";
import { strictDate } from "../../domain/metadata-evidence.ts";
import type { OriginMapping, OriginRule } from "../../domain/production-origin.ts";
import { array, exactKeys, integer, InvalidInput, object, optionalText, providerId, text, tmdbId } from "../providers/tmdb-validation.ts";

export interface DiscoveryConfig {
  readonly version: "discovery-v1";
  readonly asOf: string;
  readonly region: "US";
  readonly providerIds: readonly ReturnType<typeof providerId>[];
  readonly mappingVersion: string;
  readonly limits: {
    readonly pages: number;
    readonly operations: number;
    readonly titles: number;
    readonly details: number;
    readonly attempts: number;
    readonly catalog: number;
    readonly durationMs: number;
    readonly databaseMs: number;
  };
}

export const maxima = {
  pages: 5,
  operations: 400,
  titles: 500,
  details: 600,
  attempts: 1500,
  catalog: 1000,
  durationMs: 1800000,
  databaseMs: 300000
};

export function decodeConfig(input: unknown, asOf: string): DiscoveryConfig {
  const o = object(input);
  exactKeys(o, ["version", "synthetic", "region", "providerIds", "mappingVersion", "limits"]);

  if (o.version !== "discovery-v1" ||
    o.region !== "US" ||
    !strictDate(asOf) ||
    (o.synthetic !== undefined &&
      typeof o.synthetic !== "boolean"))
    throw new InvalidInput();

  const ids = array(o.providerIds, 8).map(providerId);

  if (!ids.length || new Set(ids).size !== ids.length)
    throw new InvalidInput();

  const l = o.limits === undefined ? {} : object(o.limits);
  exactKeys(l, Object.keys(maxima));

  const limits = {
    ...maxima
  };

  for (const k of Object.keys(maxima) as (keyof typeof maxima)[]) if (l[k] !== undefined)
    limits[k] = integer(l[k], 1, maxima[k]);

  return {
    version: "discovery-v1",
    asOf,
    region: "US",
    providerIds: ids.slice().sort((a, b) => Number(a) - Number(b)),
    mappingVersion: text(o.mappingVersion),
    limits
  };
}

export function decodeMapping(input: unknown): OriginMapping {
  const o = object(input);
  exactKeys(o, ["version", "rules", "missingCategories", "limitations"]);

  const rules: OriginRule[] = array(o.rules, 100).map(v => {
    const r = object(v);

    exactKeys(r, [
      "source",
      "externalId",
      "name",
      "scope",
      "group",
      "relationship",
      "from",
      "through",
      "reference",
      "evidence",
      "checkedAt",
      "limitations"
    ]);

    if (r.source !== "tmdb" ||
      (r.scope !== "company" &&
        r.scope !== "movie") ||
      !["streamer_produced_financed", "traditional_studio", "independent"].includes(String(r.group)) ||
      ![
        "production",
        "co_production",
        "commissioning",
        "financing",
        "acquisition",
        "distribution",
        "uncertain"
      ].includes(String(r.relationship)))
      throw new InvalidInput();

    const from = text(r.from), through = optionalText(r.through), checkedAt = text(r.checkedAt), reference = text(r.reference, 2000);

    if (!strictDate(from) ||
      (through !== null &&
        (!strictDate(through) ||
          through < from)) ||
      !strictDate(checkedAt) ||
      !/^https:\/\//.test(reference))
      throw new InvalidInput();

    return {
      source: "tmdb",
      externalId: tmdbId(r.externalId),
      name: text(r.name),
      scope: r.scope,
      group: r.group as OriginRule["group"],
      relationship: r.relationship as OriginRule["relationship"],
      from,
      through,
      reference,
      evidence: text(r.evidence, 2000),
      checkedAt,
      limitations: text(r.limitations, 2000)
    };
  });

  const missingCategories = array(o.missingCategories, 3).map(v => text(v));

  if (missingCategories.some(v => !["streamer_produced_financed", "traditional_studio", "independent"].includes(v)))
    throw new InvalidInput();

  return {
    version: text(o.version),
    rules,
    missingCategories
  };
}

export async function readJson(path: string | URL, max: number): Promise<unknown> {
  const file = await open(path, "r");

  try {
    const data = Buffer.alloc(max + 1);
    let size = 0;

    while (size < data.length) {
      const {
        bytesRead
      } = await file.read(data, size, data.length - size, null);

      if (!bytesRead)
        break;

      size += bytesRead;
    }

    if (size > max)
      throw new InvalidInput();

    return JSON.parse(new TextDecoder("utf-8", {
      fatal: true
    }).decode(data.subarray(0, size)));
  } finally {
    await file.close();
  }
}

export async function productionMapping(): Promise<OriginMapping> {
  return decodeMapping(await readJson(new URL("./origin-mapping.json", import.meta.url), 262144));
}
