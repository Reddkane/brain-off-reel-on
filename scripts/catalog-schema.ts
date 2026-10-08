import type { PoolClient } from "pg";

const originalTables = [
  "availability_observations", "availability_snapshots", "availability_tracks",
  "feedback_events", "movie_availability", "movie_classifications", "movie_credits",
  "movie_external_ids", "movies", "profile_movies", "profile_subscriptions", "profiles",
  "recommendations", "refresh_runs", "selection_sessions",
  "streaming_provider_external_ids", "streaming_providers",
];
const sweepTables = [
  "watchmode_sweeps", "watchmode_pages", "watchmode_memberships",
  "watchmode_sweep_events", "watchmode_enrichment_checks", "metadata_detail_attempts",
];
export const currentTables = [...originalTables, ...sweepTables,
  "provider_retention_policy", "movie_external_id_acquisitions",
  "watchmode_offer_variants", "watchmode_links", "watchmode_arrivals"].sort();

export const currentMigrationCount = 7;

const availabilityCacheTables = ["availability_snapshots", "movie_availability", "availability_observations", "availability_tracks"];
/** Provider-cache tables existing in a state; from state 5 they are bound to guard_provider_cache. */
export function providerCacheTables(state: 3 | 4 | 5 | 6 | 7): string[] {
  return state >= 4 ? [...availabilityCacheTables, ...sweepTables] : [...availabilityCacheTables];
}

/** No ledger: accept only known inventories with their distinguishing bindings. */
export async function catalogSchemaState(client: PoolClient): Promise<3 | 4 | 5 | 6 | 7> {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename"))
    .rows.map(row => row.tablename).join(",");
  let state: 3 | 4 | 5 | 6 | 7 | null = tables === originalTables.join(",") ? 3 :
    tables === [...originalTables, ...sweepTables].sort().join(",") ? 4 :
      tables === currentTables.join(",") ? 5 : null;
  if (!state)
    throw new Error("upgrade_state_unknown");
  const columns = (await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='app' AND (column_name='metadata_state' OR column_name='retention_at')
    ORDER BY table_name,column_name`)).rows.map(row => `${row.table_name}.${row.column_name}`);
  const expectedColumns = state >= 5 ? [
    "availability_observations.retention_at", "movie_availability.retention_at",
    "movies.metadata_state", "watchmode_arrivals.retention_at", "watchmode_offer_variants.retention_at",
  ] : [];
  if (columns.join(",") !== expectedColumns.join(","))
    throw new Error("upgrade_state_unknown");
  const triggers = (await client.query(`SELECT c.relname AS table_name,t.tgname,p.proname,pn.nspname AS function_schema,t.tgenabled,t.tgtype
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname='app' AND NOT t.tgisinternal`)).rows;
  const providerGuard = triggers.find(row => row.tgname === "watchmode_provider_mapping_immutable");
  if (providerGuard) {
    if (state !== 5 || providerGuard.table_name !== "streaming_provider_external_ids" ||
      providerGuard.proname !== "guard_watchmode_provider_mapping" || providerGuard.function_schema !== "app" ||
      providerGuard.tgenabled !== "O" || providerGuard.tgtype !== 27) throw new Error("upgrade_state_unknown");
    state = 6;
  }
  const subject = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='movie_classifications' AND column_name='subject_classification_id' AND data_type='uuid'")).rowCount;
  if (subject) {
    const constraints = (await client.query(`SELECT conname,contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='app.movie_classifications'::regclass AND conname IN ('classification_subject_fk','classification_subject_not_self','classification_kind_parent')`)).rows;
    const policy = (await client.query("SELECT qual FROM pg_policies WHERE schemaname='app' AND tablename='movie_classifications' AND policyname='shared_select'")).rows[0]?.qual;
    if (state !== 6 || constraints.length !== 3 || constraints.some(c => !c.convalidated) ||
      !constraints.some(c => c.contype === 'f' && /FOREIGN KEY \(subject_classification_id, movie_id\)/.test(c.definition) && /ON DELETE RESTRICT/.test(c.definition)) ||
      typeof policy !== 'string' || !policy.includes('classification-evidence-v1') || !policy.includes("'model'")) throw new Error("upgrade_state_unknown");
    state = 7;
  }
  const guard = state >= 5 ? "guard_provider_cache" : "guard_immutable_record";
  // pg_trigger bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16.
  const bindings = providerCacheTables(state).map(table =>
    [table, availabilityCacheTables.includes(table) ? `trg_${table}_immutable` : `${table}_immutable`, guard, 27]);
  if (state >= 4) {
    for (const table of ["watchmode_pages", "watchmode_memberships", "watchmode_sweep_events"])
      bindings.push([table, `${table}_seal`, "check_watchmode_evidence", 7]);
    bindings.push(["watchmode_enrichment_checks", "watchmode_enrichment_checks_age", "check_watchmode_evidence", 7]);
  }
  if (state >= 5) {
    bindings.push(["movie_external_id_acquisitions", "external_id_acquisitions_immutable", "guard_external_id_acquisition", 27]);
    bindings.push(["provider_retention_policy", "retention_policy_seal", "guard_retention_policy", 31]);
  }
  if (bindings.some(([table, name, routine, type]) => !triggers.some(row =>
    row.table_name === table && row.tgname === name && row.proname === routine &&
    row.function_schema === "app" &&
    row.tgenabled === "O" && row.tgtype === type)))
    throw new Error("upgrade_state_unknown");
  return state;
}

export async function migrationTargetGuard(client: PoolClient) {
  try {
    const result = await client.query(`SELECT current_database() AS database, session_user AS login,
      (SELECT count(*)=1 AND bool_and(name='bor-catalog-local-v1') FROM local_support.marker) AS valid,
      (SELECT pg_get_userbyid(nspowner)=session_user FROM pg_namespace WHERE nspname='app') AS owner,
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='app' AND pg_get_userbyid(c.relowner)<>session_user) AS relations_owned`);
    const row = result.rows[0];
    if (row?.database !== "bor_catalog_local" || row.login !== "postgres" ||
      !row.valid || !row.owner || !row.relations_owned)
      throw new Error("target_guard");
  }
  catch {
    throw new Error("target_guard");
  }
}
