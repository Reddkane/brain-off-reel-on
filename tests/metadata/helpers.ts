import { readFile } from "node:fs/promises";
import { decodeMapping } from "../../src/server/ingestion/config.ts";
import { decodeMovie, tmdbId } from "../../src/server/providers/tmdb-validation.ts";
export const at = "2026-10-03T00:00:00.000Z";

export const key = {
  source: "tmdb" as const,
  externalId: tmdbId("900001")
};

export async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`../fixtures/pr-03/${name}-synthetic.json`, import.meta.url), "utf8"));
}

export const mapping = {
  version: "origin-v1",
  rules: [],
  missingCategories: ["streamer_produced_financed", "traditional_studio", "independent"]
};

export async function movie() {
  return decodeMovie(await fixture("tmdb"), key, at, mapping).value;
}

export async function syntheticMapping() {
  return decodeMapping(await fixture("origin"));
}
