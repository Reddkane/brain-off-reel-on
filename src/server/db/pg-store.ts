import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import type { MovieId } from "../../domain/ids.ts";
import type { ExternalMovieKey, Issue } from "../../domain/metadata.ts";
import { fillAbsent } from "../../domain/ratings-import.ts";
import type { PersonalState } from "../../domain/ratings-import.ts";
import { instant, integer, movieId, tmdbId } from "../providers/tmdb-validation.ts";
import type { CatalogWriteResult, MetadataStore, OperatorContext, RatingsResult, ResolvedRating, StoreContext } from "./metadata-store.ts";
import { canonicalValues, insertMovie, movieValues, readMovie, updateMovie } from "./metadata-sql.ts";

class Refusal extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function safeDatabaseCode(error: unknown): string {
  if (error instanceof Refusal)
    return error.code;

  if (error && typeof error === "object" && "code" in error) switch (error.code) {
    case "23505":
      return "constraint_conflict";
    case "23514":
      return "constraint_check";
    case "42501":
      return "permission";
    case "57014":
      return "statement_timeout";
    case "55P03":
      return "lock_timeout";
  }

  return "database_failed";
}

export interface PgStoreOptions {
  readonly pool: Pool;
  readonly catalogCapability: object;
  readonly operators: readonly OperatorContext[];
  readonly checkoutGuard?: (client: PoolClient) => Promise<void>;
  readonly hooks?: {
    readonly afterCatalogLock?: () => Promise<void>;
    readonly afterMovieWrite?: () => Promise<void>;
    readonly beforeCommit?: (client: PoolClient) => Promise<void>;
    readonly afterProfileLock?: () => Promise<void>;
  };
}

export function createPgStore(options: PgStoreOptions): MetadataStore {
  // pg emits asynchronous idle-client errors separately from query rejection.
  // The unusable client is removed by pg-pool; never forward raw driver errors.
  if (!options.pool.listenerCount("error"))
    options.pool.on("error", () => { });

  const {
    pool
  } = options;

  const operators = new Map(options.operators.map(op => [op, {
    profileId: op.profileId,
    accountId: op.accountId
  }]));

  function authorized(op: OperatorContext) {
    const issued = operators.get(op);
    return issued !== undefined &&
      issued.profileId === op.profileId &&
      issued.accountId === op.accountId;
  }

  async function transaction<T>(ctx: StoreContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    ctx.signal.throwIfAborted();

    if (ctx.deadline <= Date.now())
      throw new Refusal("deadline");

    const client = await pool.connect();
    let destroy = false, begun = false, released = false;

    const connectionError = () => {
      destroy = true;
    };

    client.on("error", connectionError);
    const end = Math.min(ctx.deadline, Date.now() + 10000);

    const abort = () => {
      destroy = true;

      if (!released) {
        released = true;
        client.release(true);
      }
    };

    const timer = setTimeout(abort, Math.max(1, end - Date.now()));

    ctx.signal.addEventListener("abort", abort, {
      once: true
    });

    try {
      ctx.signal.throwIfAborted();

      if (Date.now() >= ctx.deadline)
        throw new Refusal("deadline");

      try {
        await options.checkoutGuard?.(client);
      } catch {
        destroy = true;
        throw new Refusal("target_guard");
      }

      ctx.signal.throwIfAborted();
      await client.query("BEGIN");
      begun = true;
      await client.query("SET LOCAL ROLE service_role");

      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)", [
        String(Math.max(1, Math.min(5000, end - Date.now()))),
        String(Math.max(1, Math.min(2000, end - Date.now())))
      ]);

      const result = await work(client);
      ctx.signal.throwIfAborted();

      if (Date.now() >= end)
        throw new Refusal("deadline");

      await options.hooks?.beforeCommit?.(client);
      const committed = await client.query("COMMIT");
      begun = false;

      if (committed.command !== "COMMIT")
        throw new Refusal("commit_failed");

      return result;
    } catch (e) {
      if (begun && !destroy) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroy = true;
        }
      }

      throw e;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", abort);
      client.removeListener("error", connectionError);

      if (!released) {
        released = true;
        client.release(destroy);
      }
    }
  }

  async function profile(client: PoolClient, op: OperatorContext): Promise<boolean> {
    const p = await client.query<{
      account_id: string | null;
    }>("SELECT account_id FROM app.profiles WHERE id=$1 FOR UPDATE", [op.profileId]);

    return p.rows.length === 1 && p.rows[0].account_id === op.accountId;
  }

  function identity(key: ExternalMovieKey): void {
    if (key.source === "tmdb")
      tmdbId(key.externalId);
    else if (key.source !== "imdb" || !/^tt[0-9]{7,10}$/.test(key.externalId))
      throw new Refusal("invalid_input");
  }

  return {
    async persistMovie(capability, m, cap, ctx): Promise<CatalogWriteResult> {
      if (capability !== options.catalogCapability) return {
        status: "failed",
        code: "unauthorized"
      };

      try {
        integer(cap, 1, 1000);
        instant(m.checkedAt);

        if (!m.keys.length ||
          m.keys.length > 2 ||
          new Set(m.keys.map(k => k.source)).size !== m.keys.length ||
          !m.keys.some(k => k.source === "tmdb"))
          throw new Refusal("invalid_input");

        m.keys.forEach(identity);

        return await transaction(ctx, async client => {
          await client.query("SELECT pg_advisory_xact_lock(730003)");
          await options.hooks?.afterCatalogLock?.();

          const mappings = await client.query<{
            movie_id: string;
            source: string;
            external_id: string;
          }>(
            "SELECT movie_id,source,external_id FROM app.movie_external_ids WHERE (source=$1 AND external_id=$2) OR (source=$3 AND external_id=$4)",
            [m.keys[0].source, m.keys[0].externalId, m.keys[1]?.source ?? null, m.keys[1]?.externalId ?? null]
          );

          const ids = [...new Set(mappings.rows.map(r => r.movie_id))];

          if (ids.length > 1) return {
            status: "identity_conflict"
          };

          let id: MovieId;
          let status: "created" | "updated" = "created";
          const issues: Issue[] = [];

          if (ids.length) {
            id = movieId(ids[0]);
            const state = (await client.query(
              "SELECT metadata_state FROM app.movies WHERE id=$1 FOR UPDATE", [id]
            )).rows[0].metadata_state;

            const slots = await client.query<{
              source: string;
              external_id: string;
            }>("SELECT source,external_id FROM app.movie_external_ids WHERE movie_id=$1", [id]);

            if (m.keys.some(k => slots.rows.some(s => s.source === k.source &&
              s.external_id !== k.externalId))) return {
                status: "identity_conflict"
              };

            const old = (await client.query<{
              aggregate: unknown[];
            }>(readMovie, [id])).rows[0].aggregate;

            if (String(old[22]) > m.checkedAt) return {
              status: "stale",
              movieId: id,
              issues: []
            };

            const credits = (await client.query<{
              source: "tmdb";
              personExternalId: string;
              name: string;
              role: string;
              billingOrder: number | null;
            }>(
              'SELECT source,person_external_id AS "personExternalId",name,role,billing_order AS "billingOrder" FROM app.movie_credits WHERE movie_id=$1 AND source=$2',
              [id, "tmdb"]
            )).rows.sort((a, b) => a.role.localeCompare(b.role) ||
              a.personExternalId.localeCompare(b.personExternalId));

            if (String(old[22]) === m.checkedAt) {
              const equal = isDeepStrictEqual(old, canonicalValues(m)) &&
                isDeepStrictEqual(credits, m.credits) &&
                m.keys.every(k => slots.rows.some(s => s.source === k.source &&
                  s.external_id === k.externalId));

              if (equal) for (const k of m.keys) await client.query(
                "INSERT INTO app.movie_external_id_acquisitions VALUES($1,$2,'tmdb_metadata',$3) ON CONFLICT DO NOTHING",
                [id, k.source, m.checkedAt]
              );
              return equal ? {
                status: "unchanged",
                movieId: id,
                issues: []
              } : {
                status: "identity_conflict"
              };
            }

            const next = canonicalValues(m);
            if (state === "retired" && Number((await client.query(
              "SELECT count(*) FROM app.movies WHERE metadata_state='active'"
            )).rows[0].count) >= cap) return { status: "catalog_limit" };

            if ([1, 5, 6, 7, 10, 11, 19].some(i => old[i] !== null &&
              next[i] === null) ||
              (old[15] !== "unknown" &&
                m.origin.group === "unknown")) issues.push({
                  code: "changed_to_unknown",
                  severity: "warning"
                });

            await client.query(updateMovie, [...movieValues(m), id]);
            status = "updated";
          } else {
            const count = await client.query<{
              count: string;
            }>("SELECT count(*) FROM app.movies WHERE metadata_state='active'");

            if (Number(count.rows[0].count) >= cap) return {
              status: "catalog_limit"
            };

            id = movieId((await client.query<{
              id: string;
            }>(insertMovie, movieValues(m))).rows[0].id);
          }

          const duplicate = await client.query<{
            possible: boolean;
          }>(
            "SELECT EXISTS(SELECT 1 FROM app.movies WHERE id<>$1 AND title=$2 AND release_date IS NOT DISTINCT FROM $3::date) AS possible",
            [id, m.title, m.release?.date ?? null]
          );

          if (duplicate.rows[0].possible) issues.push({
            code: "possible_duplicate",
            severity: "info"
          });

          await options.hooks?.afterMovieWrite?.();

          for (const k of m.keys) if (!mappings.rows.some(r => r.source === k.source &&
            r.external_id === k.externalId)) await client.query(
              "INSERT INTO app.movie_external_ids(movie_id,source,external_id) VALUES($1,$2,$3)",
              [id, k.source, k.externalId]
            );

          for (const k of m.keys) await client.query(
            "INSERT INTO app.movie_external_id_acquisitions VALUES($1,$2,'tmdb_metadata',$3) ON CONFLICT DO NOTHING",
            [id, k.source, m.checkedAt]
          );

          await client.query("DELETE FROM app.movie_credits WHERE movie_id=$1 AND source=$2", [id, "tmdb"]);

          for (const c of m.credits) await client.query(
            "INSERT INTO app.movie_credits(movie_id,source,person_external_id,name,role,billing_order) VALUES($1,$2,$3,$4,$5,$6)",
            [id, c.source, c.personExternalId, c.name, c.role, c.billingOrder]
          );

          return {
            status,
            movieId: id,
            issues
          };
        });
      } catch (e) {
        return {
          status: "failed",
          code: safeDatabaseCode(e)
        };
      }
    },

    async resolveMovie(key, ctx) {
      identity(key);

      return transaction(ctx, async client => {
        const r = await client.query<{
          movie_id: string;
        }>(
          "SELECT movie_id FROM app.movie_external_ids WHERE source=$1 AND external_id=$2",
          [key.source, key.externalId]
        );

        return r.rows.length ? movieId(r.rows[0].movie_id) : null;
      });
    },

    async authorizeProfile(op, ctx) {
      if (!authorized(op))
        return false;

      try {
        return await transaction(ctx, client => profile(client, op));
      } catch {
        return false;
      }
    },

    async applyRatings(op, rows, ctx): Promise<RatingsResult> {
      if (!authorized(op)) return {
        status: "unauthorized",
        changed: 0,
        indices: []
      };

      try {
        return await transaction(ctx, async client => {
          if (!(await profile(client, op))) return {
            status: "unauthorized",
            changed: 0,
            indices: []
          };

          await options.hooks?.afterProfileLock?.();

          if (rows.length > 100)
            throw new Refusal("invalid_input");

          const ordered = rows.slice().sort((a, b) => a.movieId.localeCompare(b.movieId));

          if (new Set(ordered.map(r => r.movieId)).size !== ordered.length) return {
            status: "conflict",
            changed: 0,
            indices: ordered.flatMap(r => [...r.indices])
          };

          for (const r of ordered) {
            movieId(r.movieId);
            identity(r.key);

            if (r.key.source !== "tmdb")
              throw new Refusal("invalid_input");

            await client.query(
              "SELECT movie_id FROM app.profile_movies WHERE profile_id=$1 AND movie_id=$2 FOR UPDATE",
              [op.profileId, r.movieId]
            );

            const mapping = await client.query<{
              movie_id: string;
            }>(
              "SELECT movie_id FROM app.movie_external_ids WHERE source=$1 AND external_id=$2 FOR SHARE",
              [r.key.source, r.key.externalId]
            );

            if (mapping.rows[0]?.movie_id !== r.movieId) return {
              status: "unresolved",
              changed: 0,
              indices: [...r.indices]
            };
          }

          const changes: {
            row: ResolvedRating;
            value: PersonalState;
            existing: boolean;
          }[] = [];

          const conflicts: number[] = [];

          for (const r of ordered) {
            const current = await client.query<PersonalState>(
              "SELECT watched,watched_on::text,taste_rating,tired_viewing_rating FROM app.profile_movies WHERE profile_id=$1 AND movie_id=$2",
              [op.profileId, r.movieId]
            );

            const decision = fillAbsent(r.fields, current.rows[0] ?? null);

            if (decision.status === "conflict")
              conflicts.push(...r.indices);
            else if (decision.status === "changed") changes.push({
              row: r,
              value: decision.value,
              existing: current.rows.length > 0
            });
          }

          if (conflicts.length) return {
            status: "conflict",
            changed: 0,
            indices: conflicts
          };

          // First-party identity survives provider expiry even on an unchanged seed.
          for (const r of ordered) await client.query(`INSERT INTO app.movie_external_id_acquisitions
            SELECT $1,$2,'first_party_ratings',COALESCE(
              (SELECT min(acquired_at) FROM app.movie_external_id_acquisitions WHERE movie_id=$1 AND source=$2 AND acquisition_path='first_party_ratings'),statement_timestamp())
            ON CONFLICT DO NOTHING`, [r.movieId, r.key.source]);

          for (const {
            row,
            value,
            existing
          } of changes) {
            const values = [
              op.profileId,
              row.movieId,
              value.watched,
              value.watched_on,
              value.taste_rating,
              value.tired_viewing_rating
            ];

            await client.query(
              existing ? "UPDATE app.profile_movies SET watched=$3,watched_on=$4,taste_rating=$5,tired_viewing_rating=$6,updated_at=now() WHERE profile_id=$1 AND movie_id=$2" : "INSERT INTO app.profile_movies(profile_id,movie_id,watched,watched_on,taste_rating,tired_viewing_rating) VALUES($1,$2,$3,$4,$5,$6)",
              values
            );
          }

          return {
            status: changes.length ? "applied" : "unchanged",
            changed: changes.length,
            indices: []
          };
        });
      } catch {
        return {
          status: "failed",
          changed: 0,
          indices: []
        };
      }
    },

    async recordRun(capability, progress, ctx) {
      if (capability !== options.catalogCapability)
        return false;

      try {
        await transaction(ctx, async client => {
          await client.query(
            "INSERT INTO app.refresh_runs(id,job_name,started_at,ended_at,outcome,processed_count,failed_count,checkpoint,diagnostic_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at,outcome=excluded.outcome,processed_count=excluded.processed_count,failed_count=excluded.failed_count,checkpoint=excluded.checkpoint,diagnostic_summary=excluded.diagnostic_summary",
            [
              progress.id,
              "metadata_ingest_v1",
              progress.startedAt,
              progress.endedAt,
              progress.outcome,
              progress.processed,
              progress.failed,
              JSON.stringify(progress.checkpoint),
              "metadata_counts_v1"
            ]
          );
        });

        return true;
      } catch {
        return false;
      }
    }
  };
}
