import { readJson, decodeConfig, productionMapping } from "../src/server/ingestion/config.ts";
import { createTmdb } from "../src/server/providers/tmdb.ts";
import { decodeMovie, object, tmdbId } from "../src/server/providers/tmdb-validation.ts";
import { decodeSeed } from "../src/server/ingestion/ratings.ts";
export const at = "2026-10-03T00:00:00.000Z";
export const fixtureUrl = (name: string) => new URL(`../tests/fixtures/pr-03/${name}-synthetic.json`, import.meta.url);

export async function fixtures() {
  const raw = object(await readJson(fixtureUrl("tmdb"), 262144));

  if (raw.synthetic !== true)
    throw new Error("fixture_not_synthetic");

  const mapping = await productionMapping();
  const configRaw = object(await readJson(fixtureUrl("discovery"), 262144));

  if (configRaw.synthetic !== true)
    throw new Error("fixture_not_synthetic");

  const config = decodeConfig(configRaw, "2026-10-03"), seed = decodeSeed(await readJson(fixtureUrl("ratings"), 262144), "2026-10-03");

  if (!seed.synthetic)
    throw new Error("fixture_not_synthetic");

  let now = Date.parse(at);

  const provider = createTmdb("synthetic-token", mapping, {
    sleep: async ms => {
      now += ms;
    },

    fetch: async url => {
      const u = new URL(String(url));

      return new Response(JSON.stringify(u.pathname.includes("/discover/") ? {
        page: Number(u.searchParams.get("page")),
        total_pages: 2,
        total_results: 2,

        results: [{
          id: 900001
        }, {
          id: 900004
        }]
      } : {
        ...raw,
        id: Number(u.pathname.split("/").at(-1)),

        release_dates: raw.release_dates && {
          ...object(raw.release_dates),
          id: Number(u.pathname.split("/").at(-1))
        },

        keywords: {
          ...object(raw.keywords),
          id: Number(u.pathname.split("/").at(-1))
        },

        credits: {
          ...object(raw.credits),
          id: Number(u.pathname.split("/").at(-1))
        },

        external_ids: {
          ...object(raw.external_ids),
          id: Number(u.pathname.split("/").at(-1))
        }
      }), {
        status: 200
      });
    }
  });

  return {
    raw,
    mapping,
    config,
    seed,
    provider,
    now: () => now,

    movie: decodeMovie(raw, {
      source: "tmdb",
      externalId: tmdbId("900001")
    }, at, mapping).value
  };
}
