import type { Pool, PoolClient } from "pg";
import { columns } from "./metadata-sql.ts";
// Identifiers are PR 3's fixed code-owned columns, never input or SQL text rewrites.
const timestampColumns = new Set(["release_date_checked_at", "certification_checked_at", "origin_checked_at", "metadata_refreshed_at"]);
const readAggregates = `SELECT id,jsonb_build_array(${columns.map(column => timestampColumns.has(column) ? `CASE WHEN ${column} IS NULL THEN NULL ELSE to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END` : column).join(",")}) AS aggregate FROM app.movies ORDER BY id`;
export async function localCatalogGuard(client: PoolClient): Promise<void> {
  try {
    const result = await client.query("SELECT current_database() AS database, session_user AS login, (SELECT count(*)=1 AND bool_and(name='bor-catalog-local-v1') FROM local_support.marker) AS valid");
    if (result.rows.length !== 1 ||
      result.rows[0].database !== "bor_catalog_local" ||
      result.rows[0].login !== "bor_catalog_ingest" ||
      result.rows[0].valid !== true)
      throw new Error("target_guard");
  }
  catch {
    throw new Error("target_guard");
  }
}
export async function readCatalog(pool: Pool, deadline: number) {
  const client = await pool.connect();
  let destroy = false, released = false;
  const timer = setTimeout(() => { destroy = true; released = true; client.release(true); }, Math.max(1, deadline - Date.now()));
  try {
    if (Date.now() >= deadline)
      throw new Error("deadline");
    await localCatalogGuard(client);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL ROLE service_role");
    await client.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, Math.min(5000, deadline - Date.now())))]);
    const movies = (await client.query("SELECT * FROM app.movies ORDER BY id")).rows;
    const aggregates = (await client.query(readAggregates)).rows;
    const mappings = (await client.query("SELECT * FROM app.movie_external_ids ORDER BY movie_id,source")).rows;
    const credits = (await client.query("SELECT * FROM app.movie_credits ORDER BY movie_id,source,person_external_id,role")).rows;
    const runs = (await client.query("SELECT id,outcome,processed_count,failed_count,ended_at FROM app.refresh_runs ORDER BY started_at,id")).rows;
    const excluded = (await client.query(`SELECT
      (SELECT count(*) FROM app.profiles)::int AS profiles,
      (SELECT count(*) FROM app.profile_movies)::int AS personal,
      (SELECT count(*) FROM app.profile_subscriptions)::int AS subscriptions,
      (SELECT count(*) FROM app.streaming_providers)::int AS providers,
      (SELECT count(*) FROM app.streaming_provider_external_ids)::int AS provider_mappings,
      (SELECT count(*) FROM app.movie_classifications)::int AS classifications,
      (SELECT count(*) FROM app.availability_snapshots)::int AS snapshots,
      (SELECT count(*) FROM app.movie_availability)::int AS offers,
      (SELECT count(*) FROM app.availability_tracks)::int AS tracks,
      (SELECT count(*) FROM app.availability_observations)::int AS observations,
      (SELECT count(*) FROM app.selection_sessions)::int AS sessions,
      (SELECT count(*) FROM app.recommendations)::int AS recommendations,
      (SELECT count(*) FROM app.feedback_events)::int AS feedback`)).rows[0];
    if (movies.length > 1000 ||
      new Set(mappings.map(m => `${m.source}/${m.external_id}`)).size !== mappings.length ||
      mappings.some(m => !movies.some(v => v.id === m.movie_id)) ||
      movies.some(m => !mappings.some(k => k.movie_id === m.id &&
        k.source === "tmdb")) ||
      credits.some(c => !movies.some(m => m.id === c.movie_id)))
      throw new Error("readback_integrity");
    await client.query("COMMIT");
    return {
      movies,
      aggregates,
      mappings,
      credits,
      runs,
      excluded
    };
  }
  catch (error) {
    destroy = true;
    throw new Error(error instanceof Error &&
      error.message === "target_guard" ? "target_guard" : "catalog_readback_failed");
  }
  finally {
    clearTimeout(timer);
    if (!released)
      client.release(destroy);
  }
}
