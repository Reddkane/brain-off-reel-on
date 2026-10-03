# PR 2: Schema, grants/RLS, and synthetic fixture inserts

Date: October 2, 2026

Status: Implemented locally on branch `pr-02-schema` after user approval and successful Docker Desktop/WSL2 Linux-engine verification. Independent re-review approved per the supplied review; nonblocking cleanup completed locally, remote CI confirmation remains pending; no publication or deployment authorized.

Specification: [architecture](../architecture.md), consolidated sections 2–3, 4–9 and 11. Section 15 is historical rationale. [Engineering standards](../engineering.md) own release gates.

Advisory implementation/review: GPT-6.1 Sol / High; GPT-6 Astra / High in a fresh context. No automatic model change.

## 1. Inspection and scope

Inspected AGENTS.md, README, architecture, engineering, PR 1 plan, tracked/untracked inventory, Git history, source identities, package/lock/configuration and actual CI. Root guidance applies; no nested or ancestor AGENTS.md was found. `main` is at `820d2ab` (CI, #1), following `70e8999` (foundation). Original planning found a clean tree; revision inspection found only this untracked plan and preserved it. PR 1/CI are merged and green per the user's supplied status; remote runs were not queried. Git warned about an inaccessible user-level ignore file; repository status/inventory completed. Preserve any other edits/untracked work.

Actual baseline: Node 24.14.0/npm 11.9.0, Next 16.3.8, React 19.3.0, TypeScript 6.0.3, ESLint 9.39.5, Vitest 5.0.3. `npm test` discovers only the foundation suite. Root TypeScript includes `tooling/**/*.mjs`; pure checks remain independent. CI has pinned checkout/setup-node actions, Node 24, read-only contents, `npm ci`/`npm run check`, a 15-minute timeout and no secrets. No migrations, database SDK/tooling, Supabase/Docker configuration or database tests exist. Docker and psql were not found on this host. Existing ignored build/dependency outputs must be preserved.

**Include:** physical storage for all architecture logical tables, origin evidence and availability observations; exact identity semantics, checks/indexes/FKs, grants/RLS, immutable ownership/server fields, synthetic SQL inserts, disposable real-Postgres checks and aligned CI. Storage for later behavior does not implement that behavior.

**Exclude:** metadata/provider adapters or resolution, real provider facts/responses, discovery/ingestion/refresh/cron/lease logic, classification workflow, recommendation logic, replay/pick CLI, API orchestration, Auth SDK/login/signup/session implementation, UI/settings/PWA, live infrastructure, paid services, credentials, deployment, commits or pushes. No production seeds, ORM, generic repository framework, full Supabase local stack, runtime dependencies or scheduler extensions.

## 2. Exact proposed implementation files and migration order

Only this plan is created now. Proposed future change set:

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20261002000001_catalog.sql` | app schema, catalog/evidence/availability tables/indexes; explicit privilege hardening. |
| `supabase/migrations/20261002000002_personal.sql` | Profiles/personal state/sessions/recommendations/feedback/refresh runs; cyclic selection FK last. |
| `supabase/migrations/20261002000003_access.sql` | Grants, RLS, immutable validation helpers and named CHECKs, invariant/immutability triggers and snapshot seal. |
| `.gitattributes` | `*.sql text eol=lf` for consistent SQL checkout/input on Windows and CI. |
| `tests/db/bootstrap.sql` | Disposable-only platform role/identity shim and database marker; never a deployment migration. |
| `tests/fixtures/pr-02-synthetic.sql` | Labeled invented catalog, accounts, preferences and history inserts. |
| `tests/db/assertions.sql` | Test-only boolean/count and exact SQLSTATE/constraint error helpers. |
| `tests/db/schema.sql` | Positive/negative schema, evidence, immutability and deletion checks. |
| `tests/db/access.sql` | Actual-role queries and effective grants/RLS assertions. |
| `tests/db/mutations.sql` | Rollback-only broken-enforcement controls. |
| `tooling/db-test.mjs` | Node built-in subprocess runner; disposable Docker lifecycle, migrations, assertions and cleanup. |
| `tests/db/runner.test.mjs` | Docker-independent Node test-runner cases for lifecycle/refusal handling with subprocess stubs. |
| `tooling/db-image.txt` | Official PostgreSQL 17 multi-architecture image **index** digest, not a platform manifest digest. |
| `package.json` | Add `test:db:runner` and `test:db`; retain existing test/check scripts. |
| `.github/workflows/ci.yml` | Additional database job using the shared runner; preserve existing job/actions/security. |
| `README.md` | DB prerequisites/commands/safeguards/ownership and shim limitations. |
| `docs/plans/pr-02-schema.md` | Adjudicated decisions and implementation evidence. |

No planned lockfile dependency change, src edits, Vitest discovery/config changes, new TypeScript project or unrelated doc rewrite. Migration SQL is owned by supabase/migrations (layout only, no CLI dependency); fixture/assertion SQL by tests, lifecycle tooling by tooling. Existing lint/root type checking covers the runner; ESLint covers the new .mjs tests, executed through Node rather than Vitest.

Apply the three timestamped files in order, each once as the non-superuser migration owner with `psql -h 127.0.0.1 -X --set=ON_ERROR_STOP=1 --single-transaction`. Each file revokes ordinary access on its new objects before commit; final access arrives in the access migration. No permissive IF NOT EXISTS masking drift. No custom checksum ledger, mismatch test or intermediate-pause runs: every test environment is recreated. Future retained environments use Supabase migration tracking, not PR 2 custom bookkeeping. Prerequisites: PostgreSQL 17, platform roles anon/authenticated/service_role, auth.users(id uuid), auth.uid() returning uuid, and explicit migration-owner auth schema USAGE/REFERENCES(id). Only disposable bootstrap supplies the shim and grants; application migrations never create/replace Auth objects/roles.

## 3. Physical schema and identity contract

All application objects are in **app**, owned by the migration administrator (`bor_migrator` in tests), never an API role. Bootstrap alone connects as the official image's superuser postgres to establish roles/platform prerequisites; all migrations, fixtures, inventories, mutations and administrator read-backs connect as bor_migrator. Use LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS, reflecting [Supabase's published postgres demotion](https://raw.githubusercontent.com/supabase/postgres/develop/migrations/db/migrations/10000000000000_demote-postgres.sql). LOGIN enables loopback trust without credentials; CREATEDB/CREATEROLE/REPLICATION mirror that documented role but are not used by application migrations; BYPASSRLS is an explicit platform administrator attribute, not SUPERUSER. No memberships in the bootstrap superuser. For test SET ROLE only, bootstrap grants anon/authenticated/service_role membership to bor_migrator WITH SET TRUE, INHERIT FALSE; no reverse memberships. Grant CREATE/CONNECT/TEMP on the disposable DB, auth schema USAGE, SELECT/INSERT/DELETE on auth.users, REFERENCES(id) on auth.users, and auth.uid EXECUTE explicitly. Bootstrap has two setup phases: initially omit only REFERENCES, require FK probe under bor_migrator to fail 42501, then finish bootstrap's grant and require the same probe to succeed under bor_migrator before migrations. No main test/migration/read-back runs as superuser, and bor_migrator is not assumed able to revoke a grant issued by a different auth-table owner. The shim does not model Supabase extension/reserved-role restrictions; verify eventual platform before real data.

Do not alter platform-owned auth/public schema defaults. No API schema exposure is configured now; PR 7 decides exposure, rather than assuming it. Placement does not replace grants/RLS. FORCE RLS cannot constrain a BYPASSRLS administrator; API assertions always use non-owner NOSUPERUSER NOBYPASSRLS roles. Direct owner UPDATE/DELETE guards are nevertheless tested, not exempted.

Notation: fields NOT NULL unless `?`. Standalone id = uuid PK DEFAULT gen_random_uuid(); no sequences. Dates = date; timestamps = timestamptz; JSON = jsonb; versions/fingerprints/source identifiers = text. created_at DEFAULT now(); updated_at DEFAULT now(), maintained by trigger. Required/optional non-null identity/name/version strings reject blank trimmed text; optional overview/diagnostic text may be empty. Text-array element and content-policy validation use the immutable helpers in real named CHECK constraints below; JSON container CHECKs remain ordinary SQL CHECKs. Deeper semantic evidence shapes below are contracts for later writers unless an SQL check is expressly required. No custom domains/composites/enums: named text CHECKs allow straightforward additive vocabularies.

Name constraints `<table>_<field/purpose>_check`, `<table>_<relationship>_fk`, `<table>_<purpose>_key`; indexes `idx_<table>_<purpose>`. FKs immediate unless stated. No FK identity update cascades. CASCADE/RESTRICT below mean ON DELETE. Every constraint/index/trigger appears in the test inventory.

Internal movies.id and streaming_providers.id are UUIDs compatible with existing MovieId/StreamingProviderId string brands. External IDs, including TMDB identifiers, are **namespaced text**, never internal PKs/FKs or numerically coerced IDs. Source person/company IDs likewise remain namespaced text. Names cannot resolve identity. Equal text in different namespaces is allowed. No provider mappings, new domain brands or cast helpers are implemented; PR 3/4 performs resolution.

### Catalog/classification

| Table | Exact fields/constraints |
| --- | --- |
| movies | id, title text, release_date date?, release_date_source text?, release_date_semantics text? in original_release/theatrical/digital/other, release_date_checked_at timestamptz?, runtime_minutes integer? >0, original_language text?, us_certification text? in G/PG/PG-13/R/NC-17/NR, certification_source text?, certification_checked_at timestamptz?, overview text?, poster_path text?, genres text[] DEFAULT '{}', keywords text[] DEFAULT '{}', production_company_evidence jsonb DEFAULT '[]' array, origin_group text DEFAULT 'unknown' in streamer_produced_financed/traditional_studio/independent/mixed/unknown, origin_evidence jsonb DEFAULT '[]' array, origin_mapping_version text?, origin_checked_at timestamptz?, rating numeric(4,2)? 0..10, vote_count integer? >=0, metadata_source text, metadata_refreshed_at timestamptz, created_at, updated_at. Release quartet and certification triple each all null or populated. Non-unknown origin requires nonempty evidence/version/check time; unknown may retain partial evidence. Future release dates remain valid. NR is not an ordinal ceiling. |
| movie_external_ids | movie_id uuid FK movies CASCADE, source text, external_id text; PK(movie_id,source), UNIQUE(source,external_id). One mapping/movie/source per architecture's normal rule. |
| movie_credits | movie_id uuid FK movies CASCADE, source text, person_external_id text, name text, role text, billing_order integer? >=0; PK(movie_id,source,person_external_id,role). Role is source credit/job text; multiple roles per person allowed. |
| movie_classifications | id, movie_id uuid FK movies RESTRICT, rubric_version text, narrative_complexity smallint?, attention_demand smallint?, emotional_burden smallint?, on_screen_text_dependence smallint? (each 0..4), pacing text?, tone text[] DEFAULT '{}', content_tags text[] DEFAULT '{}', field_provenance jsonb object, field_uncertainty jsonb object, input_evidence jsonb object, input_fingerprint text, model_id text?, prompt_id text?, review_status text in unreviewed/needs_review/reviewed, created_at. UNIQUE(id,movie_id) for recommendation composite FK. No unique movie/rubric/fingerprint: human revisions may share inputs. All revision fields immutable; correcting review status creates a new UUID. Unknown levels stay null, not fabricated zero. |
| streaming_providers | id, display_name text, created_at, updated_at. Name not unique. Each exact channel/ad-tier variant gets its own UUID; no package/playback fields or base-to-addon implication. |
| streaming_provider_external_ids | provider_id uuid FK streaming_providers CASCADE, source text, external_id text; PK(provider_id,source), UNIQUE(source,external_id). Normalizes architecture's source mappings. |

Company evidence elements: `{source, external_id?, name, checked_at}`; no guessed IDs. Origin elements: `{source, checked_at, relationship, company_source?, company_external_id?, evidence_text, reference?}`; relationship = commissioning/financing/production/co_production/acquisition/distribution/uncertain. Preserve raw evidence separately from origin group/version. Acquisition/distribution alone does not establish production origin; PR 3 validates that meaning, PR 2 stores acquisition-only evidence with unknown group. No company-management subsystem or invented real company facts.

Classification provenance keys correspond to attributes and distinguish supplied_evidence/human_judgment/model_prior_knowledge. Uncertainty retains supplied detail, not calibrated enjoyment probabilities. input_evidence retains actual supplied content, not only a hash. No viewer-dependent subtitle burden field; original language does not establish dubbed audio. Pacing/tone/tag vocabulary and uncertainty calibration belong to PR 5.

### Availability and observations

| Table | Exact fields/constraints |
| --- | --- |
| availability_snapshots | id, movie_id uuid FK movies RESTRICT, region text CHECK '^[A-Z]{2}$', source text, checked_at timestamptz, refresh_deadline timestamptz >= checked_at, outcome text in success/failed, watch_page_url text?, diagnostic_code text?, created_at, creation_xid xid8 DEFAULT pg_current_xact_id(). Trigger overwrites creation_xid on INSERT with current top-level transaction ID; caller cannot forge it. UNIQUE(movie_id,region,source,checked_at); UNIQUE(id,movie_id,region,source). URL if supplied starts https://; host validation belongs to PR 4. Failed URL null; successful empty URL may be null. |
| movie_availability | snapshot_id uuid FK availability_snapshots CASCADE, provider_id uuid FK streaming_providers RESTRICT, offer_type text in subscription/ads/free/rental/purchase; PK(snapshot_id,provider_id,offer_type). Invariant trigger requires successful snapshot. No offers is empty only for successful snapshot, not absent/failed check. |
| availability_tracks | movie_id uuid FK movies CASCADE, provider_id uuid FK streaming_providers RESTRICT, region text CHECK '^[A-Z]{2}$', source text, offer_type as above, tracked_since timestamptz; PK(movie_id,provider_id,region,source,offer_type). Distinguishes newly monitored variants from known absence. |
| availability_observations | snapshot_id uuid, movie_id uuid, provider_id uuid, region text, source text, offer_type text using same offer CHECK, state text in present/absent, provider_arrival_date date?, provider_arrival_source text?, provider_arrival_semantics text?; PK(snapshot_id,provider_id,offer_type). Composite FK(snapshot_id,movie_id,region,source) to availability_snapshots CASCADE; composite FK(movie_id,provider_id,region,source,offer_type) to availability_tracks CASCADE. Arrival triple all null/populated, only for present; semantics is nonblank source-defined text, never assumed subscription launch. |

Snapshots/offers/observations/tracks append-only. In addition, snapshot child membership is sealed at transaction commit: check_availability_evidence requires snapshot.creation_xid = pg_current_xact_id() on **every** offer and observation INSERT, raising 23514 with constraint `availability_snapshot_sealed_check` if unequal. Snapshot INSERT stamps the full xid8, irrespective of caller input; UPDATE cannot alter it. [PostgreSQL transaction ID functions](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-PG-SNAPSHOT) describe the epoch-aware value. This deliberately avoids 32-bit xmin comparison, freezing and subtransaction-xmin pitfalls: the full top-level ID is common to nested savepoints, distinct for later transactions and includes the epoch across 32-bit wraparound. It is database-local, not an arrival timestamp or durable cross-database identity. Rebuilding/restoring raw history requires atomic parent-and-child insertion so snapshots are stamped in the rebuilding transaction. No privileges to disable the stamp/guard in application paths; DDL-authorized recovery is outside enforcement promises. Committed snapshots, including empty successes, cannot gain new children. Concurrent sessions cannot read an uncommitted parent and fail sealing after commit.

Observation trigger also requires successful snapshot, checked_at >= tracked_since, present matching exact offer, absent having no matching offer. Offer insertion rejects an existing absent observation for that tuple. Insert snapshot, offers and observations in one transaction, offers first. Tracks may predate it. No absent-observation generation or arrival inference trigger. Failure creates no offers/observations and cannot overwrite success. Direct deletion forbidden; nested FK cascades allowed as below. Fixtures and expected-error tests must respect these transaction boundaries rather than adding children to already committed fixture snapshots.

Ordered successful presence/absence history, tracking start and failed snapshots support last absence, first presence, interval bounds, continuity/removal/reappearance episodes and failures/long gaps. Successful complete snapshots preserve empty checks; observations explicitly identify monitored absence. Missing/untracked variants are not automatically absent. Latest success query is separate from newer failure. PR 4 determines maximum usable observation gap and reappearance policy, deriving episodes/intervals from this raw history; PR 2 never assigns initial import a fresh arrival or resets its clock. Provider-supplied dates remain separate evidence. PR 7 freezes actual derived intervals/inputs in traces for replay.

### Personal/session/operational tables

| Table | Exact fields/constraints |
| --- | --- |
| profiles | id, account_id uuid? FK auth.users(id) CASCADE, region text DEFAULT 'US' CHECK '^[A-Z]{2}$', runtime_ceiling_minutes integer? >0, known_languages text[] DEFAULT '{}', subtitle_policy text DEFAULT 'unknown' in unknown/allowed/disallowed, content_policy jsonb DEFAULT '{}' object, revision bigint DEFAULT 1 >0, created_at, updated_at. Nullable owner only for local fixtures; no public fixed-profile API. No unique account_id: one profile initially is not permanent account/profile conflation. |
| profile_subscriptions | profile_id uuid FK profiles CASCADE, provider_id uuid FK streaming_providers RESTRICT, enabled boolean DEFAULT true; PK(profile_id,provider_id). |
| profile_movies | profile_id uuid FK profiles CASCADE, movie_id uuid FK movies RESTRICT, watched boolean DEFAULT false, watched_on date?, taste_rating text? in loved/liked/meh/disliked, tired_viewing_rating smallint? 0..4, permanent_exclusion boolean DEFAULT false, created_at, updated_at; PK(profile_id,movie_id). watched_on implies watched; watched with unknown date valid. Ratings/exclusions independent, unseen missing rating is missing evidence. |
| selection_sessions | id, profile_id uuid FK profiles CASCADE, started_at timestamptz DEFAULT now(), last_activity_at timestamptz, ended_at timestamptz?, outcome text DEFAULT 'active' in active/selected_provisional/selected_intent/availability_failure/abandoned/refresh_stale/refresh_failed/backend_unavailable/eligible_pool_exhausted, selected_recommendation_id uuid?, selected_at timestamptz?, correction_deadline timestamptz?, experiment_arm text? in personalized/quality_first, experiment_seed text?, experiment_version text?. Activity >= start; end >= activity; selected_at >= start; deadline >= selected_at. Selected outcomes require selection triple populated; other outcomes require all null. Active/provisional end null, finalized outcomes end populated. Experiment triple all null/populated. |
| recommendations | id, session_id uuid FK selection_sessions CASCADE, movie_id uuid FK movies RESTRICT, sequence integer >0, idempotency_key text, explanation text, algorithm_version text, config_version text, rubric_version text, classification_id uuid?, profile_revision bigint >0, trace jsonb object, created_at. UNIQUE(session_id,idempotency_key), UNIQUE(session_id,sequence), UNIQUE(session_id,id). Composite FK(classification_id,movie_id) to movie_classifications(id,movie_id) RESTRICT. Nullable classification supports synthetic structural records; PR 7 enforces eligible-pick requirements. |
| feedback_events | id, recommendation_id uuid FK recommendations CASCADE, event_type text in skip/not_interested/seen/too_heavy/not_available/choose/post_watch, reason text?, taste_rating text? using taste values, tired_viewing_rating smallint? 0..4, idempotency_key text, created_at; UNIQUE(recommendation_id,idempotency_key). Ratings only on post_watch, which requires at least one; other events both null. Skip/choose/availability failure never automatically means dislike/watched. |
| refresh_runs | id, job_name text, started_at timestamptz DEFAULT now(), ended_at timestamptz?, outcome text in running/success/partial/failed, processed_count integer DEFAULT 0 >=0, failed_count integer DEFAULT 0 >=0, checkpoint jsonb DEFAULT '{}' object, diagnostic_summary text?. Running iff end null; end >= start. Counts successful/failed processing separately, no assumption failed <= processed. No lease/workflow implementation. |

After recommendations exist add named FK `selection_sessions_selected_recommendation_fk`: `(selection_sessions.id, selected_recommendation_id)` → `(recommendations.session_id,recommendations.id)` NO ACTION, **NOT DEFERRABLE** as the proposed default. Selection must belong to same session. Acceptance requires one ordinary `DELETE FROM auth.users WHERE id = <A>` and, on a fresh fixture graph, one ordinary `DELETE FROM app.profiles WHERE id = <A-profile>`, with selected_recommendation_id populated beforehand; no SET CONSTRAINTS or pre-clearing fields. Assert the complete personal graph disappears and shared catalog survives. [PostgreSQL FK rules](https://www.postgresql.org/docs/17/sql-createtable.html) distinguish NO ACTION checks from immediate RESTRICT behavior, but cascade ordering here remains implementation evidence, not a claimed result. Retain/add deferrability only if the plain NOT DEFERRABLE experiment fails, recording exact error and successful plain-delete alternative; requiring the Auth caller to defer constraints is unacceptable. An unresolved failure blocks acceptance and requires plan adjudication. Canonical outcome/feedback transactions, expiry and correction enforcement remain PR 7. Failed selection clears current pointer/time/deadline while historical event survives.

content_policy is sparse: optional exclude_horror boolean, us_certification_ceiling in G/PG/PG-13/R/NC-17, emotional_burden_cap integer 0..4, strict_theme_exclusions nonblank string array. The real profiles_content_policy_check calls the immutable helper to validate supplied key types/bounds and reject unknown keys/JSON nulls. Missing keys are unconfirmed, not inferred content acceptance. No invented personal runtime/language/content defaults. Theme vocabulary is PR 5/8. Tired rating storage uses 0–4 as routine choice; user-facing anchors must be settled before collection later.

trace is an immutable object. Production snapshots must contain actual profile/context/catalog/classification/availability inputs or immutable references, explanation evidence and versions per architecture section 9; revision/hash alone cannot reproduce picks. Fixtures include synthetic:true and supplied snapshots, not a claim of replay-complete production traces. PR 7 defines executable replay validation, timing and replacement-session linkage plus origin/freshness history.

### Exact additional indexes

PK/UNIQUE constraints supply B-tree indexes; do not duplicate them. In addition:

| Table | Index columns/predicate |
| --- | --- |
| movie_classifications | (movie_id,created_at DESC,id); unique (id,movie_id) already specified. |
| availability_snapshots | (movie_id,region,source,checked_at DESC) WHERE outcome='success' only; the existing UNIQUE(movie_id,region,source,checked_at) covers unfiltered history via backward scan. |
| movie_availability | (provider_id,offer_type,snapshot_id). |
| availability_tracks | (provider_id). |
| availability_observations | (movie_id,provider_id,region,source,offer_type,snapshot_id); time from joined snapshot. |
| profiles | (account_id) WHERE account_id IS NOT NULL. |
| profile_subscriptions/profile_movies | (provider_id) / (movie_id). |
| selection_sessions | (profile_id,started_at DESC,id); (correction_deadline) WHERE outcome='selected_provisional'; (last_activity_at) WHERE outcome='active'. |
| recommendations | (movie_id); (classification_id,movie_id) WHERE classification_id IS NOT NULL. |
| refresh_runs | (job_name,started_at DESC,id). |

No extra indexes on movies/providers/mappings/credits/feedback: leading PK/unique keys cover child lookups. No GIN/ranking indexes or speculative performance subsystem.

## 4. Permission matrix, policies and guards

Grants and RLS are independent gates. See [PostgreSQL privileges](https://www.postgresql.org/docs/17/ddl-priv.html), [row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html), and [Supabase identity/RLS](https://supabase.com/docs/guides/database/postgres/row-level-security). Tests use ordinary non-owner roles; owner/superuser results cannot establish RLS. Service credentials bypass RLS and require independent future server authorization.

| Role | app schema | Shared catalog/evidence/availability | Six personal tables | refresh_runs | Sequences/functions |
| --- | --- | --- | --- | --- | --- |
| PUBLIC | No USAGE/CREATE | None | None | None | No app EXECUTE; no sequences. |
| anon | No USAGE/CREATE | None | None | None | No app EXECUTE; no sequences. |
| authenticated | USAGE only | SELECT, explicit read policies; no writes | Owned SELECT; restricted writes below | None | EXECUTE only on the two immutable boolean helpers; no direct trigger-function EXECUTE/CREATE. Platform auth.uid contract used. |
| service_role | USAGE only | SELECT/INSERT/UPDATE/DELETE, guards apply | SELECT/INSERT/UPDATE/DELETE, guards apply | SELECT/INSERT/UPDATE/DELETE | EXECUTE only on the same two helpers; no direct trigger-function EXECUTE/CREATE; no sequences. |
| migration administrator | Ownership/DDL, NOSUPERUSER | Migration/recovery authority; BYPASSRLS explicitly documented | Migration/recovery authority | Migration/recovery authority | Owns app objects/functions; runs inventory/read-backs, never an ordinary identity assertion. |

Explicitly revoke ALL on app schema/tables/sequences/functions from PUBLIC/anon/authenticated/service_role, then grant exact matrix. Leave platform-wide defaults unchanged and inspect actual new-object defaults in acceptance. Schema-scoped REVOKE cannot remove global grants; omit the misleading default-privilege statements. In particular PUBLIC function EXECUTE is a global built-in default: explicitly revoke it on each new app function in the same creation transaction. Then GRANT EXECUTE ON FUNCTION app.text_array_nonblank(text[]), app.profile_content_policy_valid(jsonb) TO authenticated, service_role only. PUBLIC/anon remain denied; all four trigger functions remain unavailable for direct API invocation. These pure boolean helpers read no records, so authenticated/service direct calls are an expected harmless capability, also needed for CHECK execution. Do not change platform administrator global defaults across schemas. Future migrations repeat per-object hardening before commit and extend effective-ACL inventory tests; no blanket future grants. [PostgreSQL default-privilege rules](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html) explain this distinction. No app user gets TRUNCATE/REFERENCES/TRIGGER/schema CREATE or MAINTAIN. No application migrations create LOGIN roles/memberships or alter platform schemas. No views/export functions; zero SECURITY DEFINER routines.

ENABLE and FORCE RLS on all **17 app tables**. Ten shared tables (movies, movie_external_ids, movie_credits, movie_classifications, streaming_providers, streaming_provider_external_ids, availability_snapshots, movie_availability, availability_tracks, availability_observations) have FOR SELECT TO authenticated USING(true) only. refresh_runs has no ordinary policy. No anon policy or shared write policy.

Personal predicates, all qualified SQL, no security-definer helper:

- profiles: account_id IS NOT NULL AND account_id = (SELECT auth.uid()).
- subscriptions/profile_movies/sessions: EXISTS matching owned app.profiles by profile_id.
- recommendations: EXISTS matching app.selection_sessions joined to owned app.profiles via session_id.
- feedback: EXISTS matching recommendation joined to session/owned profile via recommendation_id.

Separate policies named owned_select/owned_insert/owned_update/owned_delete, only for permitted actions TO authenticated. SELECT/DELETE use USING, INSERT uses WITH CHECK, UPDATE explicitly uses both. No personal true/PUBLIC policies. Null-owned graph invisible even with null uid. Ownership not duplicated as mutable account IDs on children.

| Table | Exact authenticated mutation grants |
| --- | --- |
| profiles | UPDATE(region,runtime_ceiling_minutes,known_languages,subtitle_policy,content_policy); no INSERT/DELETE. |
| profile_subscriptions | INSERT(profile_id,provider_id,enabled); UPDATE(enabled); DELETE owned. |
| profile_movies | INSERT(profile_id,movie_id,watched,watched_on,taste_rating,tired_viewing_rating,permanent_exclusion); UPDATE(watched,watched_on,taste_rating,tired_viewing_rating,permanent_exclusion); DELETE owned. |
| sessions/recommendations/feedback | SELECT only; transactional writes/sequence/outcomes/events/traces remain server-owned. |

No table-wide INSERT/UPDATE grants overriding these columns. Test effective has_column_privilege and has_table_privilege plus ACLs and actual statements. Ownership links, identity, revisions and timestamps cannot be user-supplied updates.

Exact app function inventory: four SECURITY INVOKER trigger functions and two SECURITY INVOKER IMMUTABLE boolean helpers; zero SECURITY DEFINER routines. All set search_path=pg_catalog and qualify app references. PUBLIC/anon EXECUTE revoked on all six; authenticated/service_role EXECUTE granted only on the two helpers. No other routines permitted:

- guard_identity(): rejects PK/FK changes on mutable records, session profile changes, profiles non-null account changes, supplied revision/created_at edits. Null→account linking only for service_role or administrator once; non-null ownership immutable. Preference changes increment revision and maintain updated_at. Cannot move subscriptions/movie state or sessions between owners. Attach to movies/providers/profiles/subscriptions/profile_movies/sessions/refresh_runs as applicable.
- touch_updated_at(): movies/providers/profile_movies timestamp maintenance; rejects created_at edits. Profiles handled by revision guard. Server-owned session/refresh start timestamps immutable; lifecycle fields remain service-writable for PR 7/4.
- guard_immutable_record(): reject every UPDATE and any DELETE with pg_trigger_depth() <= 1 on classifications/snapshots/offers/tracks/observations/recommendations/feedback; permit nested DELETE only at depth >1. No parent-row lookup, so RLS-hidden parents cannot fail open. [PostgreSQL trigger nesting](https://www.postgresql.org/docs/17/functions-info.html) supplies the depth. This is safe for the exact PR 2 trigger inventory because only FK cascade triggers issue nested DELETE; no app trigger executes DELETE. Future DML-issuing triggers must re-adjudicate this assumption. API roles lack TRIGGER/DDL/EXECUTE privileges; a DDL-authorized owner could deliberately disable/create triggers and is outside the threat boundary, but its ordinary direct DELETE is **not** exempt. Bind the same routine to selection_sessions BEFORE DELETE only: direct owner/service session deletion is forbidden, while profile/account cascades remain permitted. Test owner/service direct DELETE rejection and every permitted FK cascade. Profile deletion leaves shared catalog; movie/provider RESTRICT preserves personal references. Movie classification and snapshot FKs also RESTRICT deletion to preserve catalog evidence; history-free movies can still cascade mappings/credits.
- check_availability_evidence(): BEFORE INSERT on snapshots stamps creation_xid unconditionally; on offers/observations first checks the same-transaction seal, then successful snapshot, track time, matching/missing exact offer and rejection of offers contradicting prior absence. Named errors include availability_snapshot_sealed_check. No inferred arrivals or external effects.
- text_array_nonblank(text[]) RETURNS boolean IMMUTABLE: false for null input, null element, element containing only whitespace, or multidimensional nonempty array; true for empty array and one-dimensional nonblank elements. Implement normal iteration/unnest inside helper, not a forbidden CHECK subquery or delimiter trick.
- profile_content_policy_valid(jsonb) RETURNS boolean IMMUTABLE: validates the sparse object/key/type/bound contract including strict_theme_exclusions JSON string array with no null/blank elements; false for null/non-object/unrecognized keys. May call the text helper after validated conversion. No database reads, writes, dynamic SQL, role/GUC operations or effects in either helper.

Create the helpers before adding these ordinary constraints in the access migration (before any user grant); each is visible in pg_constraint with native 23514/constraint-name diagnostics:

| Constraint | CHECK expression |
| --- | --- |
| movies_genres_check | app.text_array_nonblank(genres) |
| movies_keywords_check | app.text_array_nonblank(keywords) |
| movie_classifications_tone_check | app.text_array_nonblank(tone) |
| movie_classifications_content_tags_check | app.text_array_nonblank(content_tags) |
| profiles_known_languages_check | app.text_array_nonblank(known_languages) |
| profiles_content_policy_check | app.profile_content_policy_valid(content_policy) |

Exact trigger names/events: `trg_<table>_identity` BEFORE UPDATE on movies/streaming_providers/profiles/profile_subscriptions/profile_movies/selection_sessions/refresh_runs; `trg_<table>_updated_at` BEFORE UPDATE on movies/streaming_providers/profile_movies; `trg_<table>_immutable` BEFORE UPDATE OR DELETE on movie_classifications/availability_snapshots/movie_availability/availability_tracks/availability_observations/recommendations/feedback_events; `trg_<table>_evidence` BEFORE INSERT on availability_snapshots/movie_availability/availability_observations. All FOR EACH ROW, bound to the corresponding four trigger functions above. Identity checks inspect each table's PK/FK fields; sessions/refresh_runs also protect started_at. No validation triggers or triggers on external mapping tables: mappings are service-managed resolver state with unique/FK enforcement; updates remain future validated adapter work. Named guards and column grants are independent checks. Existing platform auth.uid execution/schema rights are prerequisites, not objects/privileges rewritten by app migrations. Installed trigger execution is checked through table operations; direct trigger invocation unavailable, direct helper invocation allowed only to authenticated/service_role and owner.

**Auth boundary:** FK account UUID belongs to platform auth.users, not an app-owned account entity or movie/provider identity. Tests SET ROLE and synthetic JWT claim GUCs simulate a trusted gateway. They do not implement/prove identity verification, Auth service, login/session/CSRF or endpoint authorization. PR 7 provisions/links real private account, verifies identity with supported server integration, allowlists schema if needed and tests endpoint/privileged-client isolation. No browser can legitimately establish identity through these test controls.

## 5. Synthetic fixtures and automated acceptance

Every SQL fixture starts `SYNTHETIC TEST DATA — not provider records or personal preferences`. Accounts use UUIDs 10000000-0000-4000-8000-000000000001/2; profiles 20000000-0000-4000-8000-000000000001/2/3 (A/B/null owner). Distinct fixed UUID prefixes for movies (3), providers (4), snapshots (5), classifications (6), sessions (7), recommendations (8), feedback (9). All timestamps fixed UTC literals, no wall-clock expectations. Titles/services are Synthetic Movie A/Synthetic Base/Synthetic Add-on; sources synthetic_catalog/synthetic_availability/synthetic_namespace_2, not claimed TMDB facts. Include equal fixture-1 across namespaces and a leading-zero external ID. Do not reuse PR 1's deliberately non-UUID brand text as SQL UUIDs.

Insert explicit columns transactionally: test account rows; movies/providers/mappings/credits/classification revisions; profiles/subscriptions/state; tracks/snapshots/offers/observations; sessions/recommendations/selection updates; feedback/refresh runs. No ON CONFLICT DO NOTHING masking failures. Loaded only by runner, never migrations or production imports.

| Group | Required positive/negative cases |
| --- | --- |
| Identity | Cross-namespace same text and duplicate names pass; duplicate source/ID on another internal record, second movie/source mapping, orphan IDs/credits fail. |
| Metadata/origin | Missing runtime/date/certification, future release, known/mixed/unknown production, acquisition-only unknown. Invalid bounds/incomplete evidence tuple/known origin without evidence fail. |
| Classification | Same-input separate immutable revisions, unknown nulls, provenance categories, 0/4 pass; -1/5/wrong JSON container/update/direct deletion fail. |
| Availability | Success-empty, failure after success, initial presence, absence→presence, repeat presence, removal→reappearance, outage/long gap, newly tracked addon, separate sources/regions/offer types, separate synthetic provider date. Wrong composite relationship/duplicate offer/failed offer/observation before track/presence without offer/absence with offer fail. Same-transaction snapshot/children pass, including savepoint insertion. In a subsequent transaction, offer into previously committed success-empty (no absent observation) and observation into committed snapshot fail availability_snapshot_sealed_check. Caller-supplied creation_xid is overwritten. Old success retained after failure; no freshness inference asserted. |
| Preferences/state | A/B/null owner; exact subscriptions; unseen/unrated, watched unknown date, independent taste/tired/exclusion. Invalid policy shape/rating/runtime/duplicate pair/date with false fail. |
| History | All three owner graphs; active/provisional/finalized/failure with retained old selection event. Same-session pointer passes; foreign pointer, classification/movie mismatch, duplicate sequence/key, incoherent time/outcome fail. Same key across distinct contexts passes. |
| Deletion/ownership | Plain account DELETE and plain profile DELETE on separate populated selected-session graphs remove all personal children, preserve shared catalog; no SET CONSTRAINTS/pre-clearing. Referenced catalog deletion restricted. Non-superuser owner and service direct immutable UPDATE/DELETE fail; owner not exempt. Null-owned graph private; foreign ownership moves fail. |
| Validation helpers | Owner/authenticated/service_role direct calls to both helpers succeed: valid input returns true, invalid input false. Empty/nonblank arrays and sparse policy pass; null/blank/whitespace/tab/newline elements, multidimensional array, wrong JSON key/type/null/mixed string-number array, invalid cap/ceiling fail. Actual authenticated profile writes and service catalog/classification/profile writes pass native CHECKs for valid input and fail with named 23514 for invalid input. PUBLIC has no EXECUTE ACL; anon direct calls fail 42501, including a rollback-only schema-USAGE grant isolating helper EXECUTE denial from schema denial. Anon has only PUBLIC-derived function privileges, proving PUBLIC denial too. |

Use real statements and exact SQLSTATE/constraint-name helpers: unique 23505, FK 23503, CHECK/guards 23514 (guards explicitly raise named constraint errors), grants/RLS insert 42501. Expected-error helpers catch in exception subtransactions/savepoints; missing/wrong error fails. **Helper self-tests run first:** correct expected error passes; a successful statement expected to error must produce named assertion failure; a deliberate 23514 error expected as 23505 must fail; matching SQLSTATE with a different CONSTRAINT diagnostic name must fail separately. Catch these deliberate helper assertion failures in an outer harness, verify name/reason, and resume; unexpected pass makes test:db fail. No generic exception catch accepting any error, including the helper's own assertion.

All harness/assertion functions are test-only SECURITY INVOKER under bor_migrator. Harness sets ordinary role only around the tested statement, captures result/error and resets before calling assertions. Ordinary roles cannot execute test-support functions; there is no superuser test-function escalation. Record current_user/auth.uid inside role context. Filtered foreign SELECT/UPDATE/DELETE returns zero, so assert count **and** unchanged persisted values as bor_migrator. Every denial has a permitted control. No generic nonzero exit treated as enforcement evidence.

Required automated acceptance:

1. As bor_migrator, enumerate 17 tables/columns/constraints/indexes, four invoker trigger functions/two immutable invoker helpers, triggers/policies/ACL/default privileges and role attributes. Verify all six helper-based checks in pg_constraint, exact authenticated/service helper EXECUTE grants, no PUBLIC/anon helper EXECUTE, zero SECURITY DEFINER routines and no validation triggers. Verify owner NOSUPERUSER, explicit REFERENCES prerequisite (bootstrap's missing-grant denial/restored-grant positive), no membership in bootstrap superuser, ordinary roles NOBYPASSRLS. No explicit custom types/sequences/unexpected routines, reverse role memberships or ordinary CREATE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN. Automatic table row/array types are expected.
2. Assert current_user/auth.uid before contexts; authenticated neither owner, superuser nor BYPASSRLS. A reads exactly A graph, never B/null graph at all six personal tables; symmetric B. Missing/null subject sees no personal rows; guessed foreign session/recommendation/feedback IDs invisible.
3. Own preference/subscription/movie-state inserts/updates/deletes succeed; revision/timestamps correct. Foreign update/delete zero and unchanged; foreign insert 42501. All immutable owner/key/revision/time/server-field attempts fail with unchanged data. Shared SELECT succeeds but writes fail; refresh_runs denied.
4. Anonymous schema/read/mutation/function/DDL/TRUNCATE attempts fail 42501 with no side effects. Separately in rollback transaction temporarily grant anon schema USAGE/table SELECT: every table still zero via default RLS and direct helper calls still fail 42501. This proves independent RLS/function denial rather than schema-only denial. Restore by rollback. Authenticated direct helper calls succeed and return expected booleans; direct trigger calls remain denied.
5. Service role intentionally reads A/B/null graph, calls the pure helpers, inserts catalog and updates refresh runs, but still hits CHECK/guard failures; lacks app CREATE/direct trigger-function privileges. Record bypass limitation, do not claim service isolation.
6. Every constraint family/helper/evidence/immutable guard gets positive/negative cases above. RLS enabled+forced on all tables. With selected pointer populated, a single plain account DELETE, and separately plain profile DELETE, remove exactly their complete personal graphs; shared records and other account survive. Record FK deferrability and trigger-depth/cascade evidence. No skipped/only/pass-with-no-tests result.

### Expected-failure controls proving checks detect regressions

test:db automatically runs separate rollback-only mutations after green baseline, using the **same named acceptance assertions**. Named assertion must turn red for specified reason; failure to detect is a suite failure. Rollback restores controls, then require green rerun. SQL mutation errors/setup failures never count.

| Temporary break | Required detected failure |
| --- | --- |
| Drop movie_external_ids_source_external_id_key | Duplicate-mapping negative unexpectedly succeeds. |
| Disable profiles RLS | A visible IDs include B/null profiles. |
| Replace feedback owned SELECT predicate with true | A sees B feedback despite protected parent rows. |
| Grant anon schema USAGE/profiles SELECT plus anon true SELECT policy | Anonymous private-read denial fails. |
| Grant only authenticated UPDATE(account_id) | Effective has_column_privilege(authenticated,app.profiles,account_id,UPDATE) inventory assertion goes red, even though other defenses still reject reassignment. |
| Disable only profiles identity guard | service_role reassignment of a non-null account succeeds; guard-level ownership assertion goes red, independent of authenticated grants/RLS. |
| Grant authenticated UPDATE(account_id), disable identity guard, replace profiles update WITH CHECK with true | A reassigns own owner to B; immutable ownership assertion fails. Compound control weakens all three independent protections explicitly. |
| Disable only selection_sessions delete guard | Direct service deletion of an unselected session with recommendation/feedback history unexpectedly succeeds. |
| Disable only movie_classifications immutable trigger | Classification UPDATE negative unexpectedly succeeds. |
| Drop only selection_sessions_selected_recommendation_fk | Foreign-session selection-pointer negative unexpectedly succeeds (other status/time fields remain coherent). |
| Remove only same-transaction seal branch in check_availability_evidence | Later-transaction offer into committed success-empty snapshot succeeds; named seal negative goes red. Preserve successful-outcome/offer/absence checks and snapshot stamping. |
| Disable only availability_observations evidence trigger | Present observation without matching offer in a newly created same-transaction snapshot succeeds. |

Record mutation, assertion, expected/actual red, command and final green. No persistent source mutation, skipped tests or unrelated red accepted. Harness catches a named assertion failure, not arbitrary SQL/subprocess errors.

## 6. Minimal tooling, exact commands and disposable-only safeguards

Retain Node/npm and all existing npm dependencies. **E2 decided:** user chooses local Docker Desktop with WSL2 and is installing it. Implementation starts only after docker version succeeds on the development host, confirming both client and running Linux-container engine, and implementation is subsequently instructed. Local npm run test:db provides primary SQL/mutation red/green and Windows lifecycle evidence; CI confirms the same checks. Installation is still pending; this plan revision installs nothing. Docker absence remains a loud failure, never a skipped green run. No production/cloud database alternative is introduced.

Container supplies Postgres/psql; no host Postgres, pg npm package, ORM, pgTAP, Compose or Supabase CLI/full stack. Pin official postgres:17 multi-architecture **image index** digest in tooling/db-image.txt, retaining the same index pin across developer architecture/CI; record resolved platform manifest/architecture and server patch in evidence. Do not pin a per-platform manifest as the shared reference. Select/verify the maintained patch and index at implementation time, without inventing a digest now; review licensing/security findings. Validate Docker startup on the local host and availability on the actual CI image.

Exact scripts: `"test:db:runner": "node --test tests/db/runner.test.mjs"` and `"test:db": "node tooling/db-test.mjs"`. Keep npm test/check DB-independent and Vitest discovery unchanged. test:db runs the same Node --test command in a child before Docker startup; nonzero runner-test exit stops the DB run. tests/db/runner.test.mjs imports focused runner functions with injected subprocess stubs; importing tooling does not start Docker. Tests need only Node built-ins and never probe a real Docker daemon. They cover unexpected arguments, missing Docker, container identity/isolation mismatch before SQL/removal, bounded readiness failure, SQL/test failure cleanup, generic abort cleanup and stopped-container error preservation. The stub abort case does not exercise main() timer or OS signal registration. Local `npm run test:db:runner` works without Docker/npm dependency installation; existing foundation check still needs npm ci. Runner lifecycle:

- Reject unexpected arguments. No external URL/reset/migrate mode, no .env loading, no host connection variables interpreted/logged or forwarded to psql. Do not reject unrelated host DATABASE_URL/PGHOST/etc.: all SQL always goes through docker exec into the newly created container with explicit host/user/database flags; host environment cannot select its database target. No env-variable rejection list or per-variable stub tests.
- Create unique bor-pr02-<random hex> container using `docker run --detach --name <unique-name> --network none --label bor.pr02.disposable=true --label bor.pr02.run=<random-token> --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=bor_pr02_test <pinned-image>`. No ports, credentials, host mounts or persistent volumes. Trust confined to nonnetworked disposable container. Record Docker-returned ID; never operate on a guessed existing name. Omit --rm so a crashed/stopped container remains inspectable for explicit cleanup without replacing the execution error.
- Before SQL/destruction inspect matching ID/name/run labels, NetworkMode=none, no ports/host mounts, expected tmpfs. Check database name/version and bootstrap marker inside container. Poll `docker exec <id> pg_isready -h 127.0.0.1 -U postgres -d bor_pr02_test` with 30-second startup bound; total run bounded to 5 minutes. All psql connections likewise use -h 127.0.0.1: [official image initialization](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh) uses a temporary socket-only server, so socket readiness is not sufficient. Loopback TCP remains available with --network none; no published port is required.
- Feed SQL stdin using `docker exec -i <id> psql -h 127.0.0.1 -X --set=ON_ERROR_STOP=1 --single-transaction -U <role> -d bor_pr02_test`, Node spawn argument arrays, no shell interpolation. Role is postgres for bootstrap only, bor_migrator thereafter. Bootstrap supplies the non-superuser owner/explicit grants in section 3, NOSUPERUSER NOLOGIN NOBYPASSRLS anon/authenticated and NOSUPERUSER NOLOGIN BYPASSRLS service_role; minimal auth.users(id uuid PK), SECURITY INVOKER auth.uid() reading request.jwt.claim.sub/request.jwt.claims. Supply authenticated/service auth schema USAGE/function EXECUTE. No Auth service/password/token/real identity. Assertion helpers/marker in test_support unavailable to API roles; no migration ledger.
- SET LOCAL ROLE/claim values per test transaction; rollback/reset contexts. Run bootstrap→migrations→fixtures→helpers→green suites→mutation controls→fresh green. Assert nonzero named cases and inventory.
- Test reset with one fresh container recreate/replay of the full ordered migration/fixture/green sequence. No checksum mismatch/intermediate-pause runs; never rerun applied migration files in the same DB.
- Finally cleanup success/failure/timeout/handled interruption with `docker rm --force <created-id>` after rechecking identity/labels; verify gone. Never remove arbitrary containers/volumes/host directories. If process killed, recorded ID permits verified emergency cleanup below. Logs synthetic assertion names/IDs, no secrets.

Pure Node runner tests and actual Docker/Postgres suites are separate evidence. Stubs prove lifecycle/refusal handling, never database enforcement. Missing Docker fails loudly with the agreed local/CI prerequisite, never a skipped green DB result. Plain Postgres shim proves real constraints/grants/RLS, not Supabase gateway/Auth/platform integration.

Exact local PowerShell commands after implementation:

```powershell
Set-Location -LiteralPath 'C:\Users\Reddk\Documents\Coding\brain-off-reel-on'
node --version
npm --version
$env:NEXT_TELEMETRY_DISABLED = '1'
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm run check
if ($LASTEXITCODE -ne 0) { throw 'Foundation checks failed' }
npm run test:db:runner
if ($LASTEXITCODE -ne 0) { throw 'Runner checks failed' }
```

After the user's Docker installation/start, require this host check before implementation; after implementation, run the database suite:

```powershell
docker version
if ($LASTEXITCODE -ne 0) { throw 'Docker unavailable' }
npm run test:db
if ($LASTEXITCODE -ne 0) { throw 'Database checks failed' }
```

Retain local named SQL/mutation/final-green logs and confirming CI logs. Review documentation/new-file whitespace and scope:

```powershell
git diff --check
git status --short --untracked-files=all
```

Initial dependency/image retrieval requires network; tests use no providers/hosted DB. Run npm audit during implementation dependency review; adjudicate findings without unrelated upgrades. No repeated UI browser smoke needed for unchanged application.

Normal setup/teardown entirely test:db; rerun creates fresh database. After an unhandled process kill, use recorded ID only, inspect matching runner labels/isolation settings before removal:

```powershell
docker inspect '<recorded-created-container-id>'
# After verifying recorded name/run labels, network isolation and expected tmpfs:
docker rm --force '<recorded-created-container-id>'
```

CI adds database job on existing push/PR triggers: ubuntu-latest, timeout-minutes:10, read-only contents, telemetry disabled; same currently pinned checkout/setup-node actions, persist-credentials:false, .nvmrc, but no npm cache/install in this job because runner/tests use Node built-ins only. [GitHub's Ubuntu 26 announcement](https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/) schedules ubuntu-latest rollout from October 19 through November 19, 2026. Verify actual runner OS/Docker version/image architecture at implementation time rather than infer availability from the label. Record job setup-image details and docker version in evidence. Separate fail-fast steps:

```sh
node --version
docker version
npm run test:db
```

Existing check job unchanged (`npm ci`, `npm run check`). No production secrets, DB service ports, .env, database caches, pull_request_target or personal-data artifacts. Docker is runner-provided; repository tooling handles teardown. Database job is an additional required check when branch protection is later authorized/configured, not a live hosting/protection change now.

## 7. Compatibility, recovery, decisions and review readiness

No existing DB backfill. Additive transactional migrations target PostgreSQL 17 and documented Supabase auth UUID/role contract; built-in UUID generation needs no extension. Custom schema exposure, actual hosted role/default privileges and platform Auth schema compatibility must be verified in PR 7 before real data. Do not provision Supabase to validate PR 2.

Migration failure rolls back that file; discard test container. No custom migration ledger/checksum implementation in PR 2. Timestamped filenames already follow future Supabase tracking; never edit released migrations applied to retained environments. Later correction uses forward migration/backfill. No destructive down migration: code rollback is separate from data recovery. Reset is disposable container recreation only. Retained-environment recovery needs separate authorized private backup/restore; PR 7 owns actual pre-trial restoration/deletion rehearsal. **Include in PR 7's logical-restore rehearsal:** each snapshot must be inserted together with its offers/observations in one transaction; otherwise its server-stamped creation_xid seal rejects later child inserts. Do not assume a generic pg_dump/pg_restore transaction layout satisfies this requirement; exercise and record the actual restore procedure. No seal-bypass routine added in PR 2. Plain Auth/profile cascades, non-superuser ownership/REFERENCES, direct-delete guard, snapshot seal and validators must be proven in PR 2 acceptance.

Implementation review gate: only intended section 2 files, no secrets/real provider assertions/runtime app dependencies. Local npm run check, test:db:runner and test:db pass; aligned CI confirms. Inspect full diff/untracked inventory. Evidence includes schema/ACL/policy/function/role inventory, native helper-based CHECKs, helper self-tests, positive/negative SQL, all individual/compound mutation reds/final green, multi-arch index and resolved platform/server/Node/npm versions, local Windows lifecycle/full reset replay and shim limits. No migration/test/app implementation or infrastructure was created/executed during planning/revision.

Routine choices settled: app schema, disposable Postgres 17, UUID keys/text external IDs, text CHECK vocabularies, explicit column grants, nullable platform account FK, sparse unconfirmed preferences, tracked raw observations, compact versioned origin evidence, immutable records/ownership. No material architecture departure proposed. PR 1 plan's unborn-Git/CI-exclusion statements are its historical starting scope, not instructions to remove merged CI. Architecture/README status prose lags actual foundation without changing PR 2 scope.

**Choice settled; installation gate pending:** local Docker Desktop/WSL2 is chosen. Require successful host docker version before implementation; installation is in the user's hands. No product-decision blocker identified. Image index digest and non-superuser role/plain-cascade/seal/CHECK proof are implementation gates. Origin mapping, usable observation gap/reappearance policy, verified provider-date/audio semantics, host allowlist, classification/tag vocabulary and tired-rating anchors, replay format, authenticated gateway and actual personal preferences remain decisions in later owning PRs. Preserve evidence/unknown values without claiming inferred freshness, replay completeness or eligibility.

**E1 retained by user adjudication:** authenticated profile column updates and subscription/movie-state write grants/policies stay as specified, so user-scoped server clients and PR 2 isolation tests work. PR 7 decides whether app is exposed to the Data API. If exposed, explicitly accept or revoke direct browser writes to profile_subscriptions/profile_movies; server-side validation, rate limits and CSRF handling do not apply to direct PostgREST calls. The exposure decision also accounts for existing profile UPDATE grants. PR 2 configures no gateway/exposure.

Compatibility consequences: the published Supabase owner is NOSUPERUSER **with BYPASSRLS**, so matching it cannot alone exercise FORCE RLS; ordinary-role tests remain essential, and cascade guard does not query RLS-filtered parents. A3's NOT DEFERRABLE plain-delete behavior has not been executed here: acceptance must prove it before asserting Auth deletion compatibility. Corrected A5 grants caller EXECUTE on the two read-free immutable predicates so ordinary named CHECKs can execute; direct authenticated/service calls are expected, PUBLIC/anon denied. All six app functions are invoker routines. No account UUID/ownership semantic change proposed. If plain deletion or platform grants fail, report evidence and adjudicate before materially changing identity/deletion behavior.

**Re-review corrections complete**, with the host Docker installation/start gate and implementation-evidence gates visible. This documentation task does not implement the schema or authorize later features, accounts/provider access, deployment or Git publication.

## 8. Review disposition

All requested changes adopted. D1–D4 identify the four minor bullets in their original order. No implementation experiments are represented as completed evidence.

| Item | Disposition | Reason/change |
| --- | --- | --- |
| A1 | Adopted | Non-superuser bor_migrator mirrors documented Supabase attributes/explicit grants; owner runs migrations/read-backs, depth-based guard rejects its direct DELETE. |
| A2 | Adopted | Readiness and every psql invocation use loopback TCP, avoiding temporary socket-only init server. |
| A3 | Adopted | Proposed NOT DEFERRABLE NO ACTION; plain selected-graph account/profile deletes mandatory, no SET CONSTRAINTS; any deferrability requires failure/success evidence. |
| A4 | Adopted | Server-stamped full xid8 seals snapshot children to creation transaction; late offer/observation negatives and isolated seal mutation required. |
| A5 | Adopted, corrected on re-review | Two pure IMMUTABLE invoker helpers granted EXECUTE only to authenticated/service_role, revoked from PUBLIC/anon; real named CHECKs, four invoker trigger functions, zero SECURITY DEFINER routines. |
| A6 | Adopted | .gitattributes SQL LF rule retained for deterministic input even after dropping checksums. |
| B1 | Adopted | Remove ledger/checksum mismatch/intermediate-pause runs; retain ordered single-transaction migrations and fresh reset. |
| B2 | Adopted | Timestamped supabase/migrations layout now, without CLI/full stack. |
| B3 | Adopted | Remove env rejection/per-variable tests; only newly created inspected container is a possible SQL target. |
| C1 | Adopted | Add individual column-grant inventory and privileged identity-guard mutations; retain compound end-to-end bypass control. |
| C2 | Adopted | Add classification immutability, same-session FK and isolated seal controls. |
| C3 | Adopted | Helper self-tests explicitly prove failure on unexpected success, wrong SQLSTATE and wrong constraint name. |
| C4 | Adopted | tests/db/runner.test.mjs via node --test/test:db:runner; Docker-independent, invoked by test:db, no Vitest discovery change. |
| D1 | Adopted | Remove duplicate unfiltered snapshot index; UNIQUE key covers history. |
| D2 | Adopted | No npm ci/cache in database job; Node built-ins only. |
| D3 | Adopted | Pin multi-architecture image index, record platform resolution separately. |
| D4 | Adopted | Record October 19–November 19 Ubuntu 26 rollout and verify actual runner Docker at implementation time. |
| E1 | Adopted | Keep adjudicated personal write grants; explicit PR 7 Data API/browser-write decision with server-control limitations. |
| E2 | Decided: local Docker Desktop/WSL2 | User installing; host docker version success gates implementation, local test:db is primary evidence and CI confirms. |
| Restore note | Adopted | PR 7 logical-restore rehearsal loads each snapshot and its offers/observations in one transaction to satisfy creation_xid seal. |
| Verified items | Retained | 17-table split, referencing indexes, RLS predicates/uid shape, SQLSTATEs and claim lookup unchanged. |

## 9. Original implementation evidence — October 2, 2026

Implemented the section 2 inventory on `pr-02-schema`: three timestamped migrations,
SQL LF attributes, bootstrap/assertion/schema/access/mutation SQL, synthetic inserts,
Node runner and its tests, pinned image, two npm commands, the database CI job,
README and this evidence. At that handoff there were 17 changed/untracked files: three modified
tracked files and 14 untracked files, including the pre-existing approved plan.
No `src`, lockfile, application dependencies, Vitest configuration or architecture
changes. Original approved scope and decisions above are retained as the planning
record. No commit, push, PR, hosted resource, deployment or real data was created.

### Environment and image

- Windows local host: Node 24.14.0, npm 11.9.0; Docker Desktop 4.93.0 (240920),
  client/engine 29.8.1, API 1.56, context desktop-linux, server linux/amd64.
  `docker version` and `docker info --format '{{.OSType}}'` succeeded before edits.
  Sandbox access initially denied the Docker pipe; approved elevated execution
  confirmed the prerequisite and was used for actual disposable runs.
- `docker buildx imagetools inspect postgres:17` and its raw index confirmed OCI
  **image index** `sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`.
  The resolved linux/amd64 platform manifest is
  `sha256:e31e3d5327d1806f6177827c9710643e4f35f7ab3f14d26d05332753d3e95ee0`;
  arm64 and other Linux platform manifests exist in the same index.
  The pulled/started server reports PostgreSQL **17.11**, Debian
  17.11-1.pgdg13+2, x86_64, GCC 14.2.0. The runner logs image ID/RepoDigests,
  architecture and server version independently of the shared index pin.
- [Official PostgreSQL version policy](https://www.postgresql.org/support/versioning/)
  lists 17.11 as the maintained minor release and PostgreSQL 17 support through
  November 2029. The [PostgreSQL licence](https://www.postgresql.org/about/licence/)
  permits use/modification/distribution subject to its notices; the
  [official image](https://hub.docker.com/_/postgres) supplies Postgres/psql.
  This is test tooling, not a distributed production image. No claim of a clean
  full operating-system image CVE scan is made.

### Commands and final results

| Command | Local evidence |
| --- | --- |
| `npm ci` | Passed with unchanged lockfile/dependencies. First sandbox attempt failed writing npm's external cache; elevated retry succeeded. |
| `npm run check` | Passed: strict app/tooling/pure typecheck, zero-warning lint, 134 foundation tests, production build. |
| `npm run test:db:runner` | 11 passed, zero skipped: arguments, missing Docker, identity/labels/ports/mounts, readiness bound, callback and nonzero-psql failure cleanup, timeout/signal abort paths, teardown failure and explicit SQL target flags. Subprocess stubs are not database evidence. |
| `npm run test:db` | Passed on real local Postgres: bootstrap/REFERENCES probe, ordered owner migrations, fixtures, helper self-tests, schema/access baseline, 11 named mutation reds, rollback/final green, fresh container bootstrap/migration/fixture/helper/green replay and teardown. |
| `npm run typecheck`, `npm run lint` | Passed again after final runner hardening. |
| `git diff --check` and full untracked inventory | Passed; reviewed new SQL/tooling files as well as ordinary tracked diffs. |
| `npm audit --json` | Completed with exit 1: five high reports from the existing development-only chain described below; no dependency mutation. |
| `npm audit --omit=dev --json` | Passed with zero production dependency vulnerabilities. |

Ignored local evidence is retained in `.cache/pr02-db.log`, `pr02-runner.log`,
`pr02-check.log`, `pr02-install.log` and `pr02-audit.json`. Final real-DB log contains
1,729 distinct PASS labels and 5,188 PASS notices across baseline, final green and
fresh reset; this includes ACL/column inventories and the REFERENCES prerequisite.
The schema inventory is **17 tables, 154 columns, 145 constraints, 40 indexes
(14 additional indexes), 23 policies, 20 application triggers, four invoker trigger
functions and two IMMUTABLE invoker helpers**. Exact column lists/index columns,
predicates/direction/trigger bindings and effective per-column ACLs are asserted;
full native definitions/ACLs/defaults are logged for review. All six helper CHECKs
are native named constraints. No SECURITY DEFINER routines, custom domains/enums,
views, sequences, ordinary CREATE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN privileges,
API trigger EXECUTE privileges, reverse memberships or owner-superuser membership.

Both immutable helpers are exercised as owner/authenticated/service and denied to
anon after isolating EXECUTE from schema access. Correct expected-error handling
passes; deliberately successful SQL, wrong SQLSTATE and wrong constraint name
produce individually verified helper assertion reds. A/B/null-owner visibility
is tested at all six personal tables; JSON claim fallback/null and current roles
are checked. Foreign updates/deletes return zero with owner read-backs unchanged.
Positive personal writes maintain revision/timestamps. Service bypass visibility
and real service CHECK/guard failures are recorded without claiming service isolation.

Snapshot children succeed in their parent's transaction, including a child
savepoint, and the supplied creation_xid is overwritten. Late offer and observation
inserts fail `23514/availability_snapshot_sealed_check`. Offer/observation success,
track-time, exact-offer and composite FK controls are tested separately. Classification,
history, feedback, identity/server fields and their native CHECKs/FKs/uniques are
tested with permitted controls. Owner/service immutable direct UPDATE/DELETE fail.
Unreferenced movie/provider deletion proves nested catalog cascades. On separately
restored populated selected graphs, one plain Auth account DELETE and one plain
profile DELETE each remove all personal children while shared catalog/other account
survive. The selection FK remains **NO ACTION NOT DEFERRABLE**; no SET CONSTRAINTS
or pointer pre-clearing was needed.

Final real container IDs:

- Baseline/mutations/final green: `00af719d672fcf5ed3cb8c1927505b6bc0551307d5864945b4022abb1c489f68`,
  run label `fd011df3e7780f19f25bdcac`.
- Fresh reset replay: `af90cc3916c023206d002eca664e9618489581f08e209acb015f508087c6f59e`,
  run label `d562d20bf1ec32214a293297`.

Both were inspected before SQL and deletion, force-removed by recorded ID, and
verified absent. A final read-only `docker ps --all --filter label=bor.pr02.disposable=true`
returned no containers. Every earlier failed SQL run also logged verified teardown.
No existing container, host database, directory or volume was a destructive target.

### Meaningful reds and corrections

Every row below is automatically produced by `npm run test:db`; each mutation
is rolled back in an exception subtransaction and the original suites then pass.
Only the expected named assertion counts; SQL/setup errors do not count as red evidence.

| Mutation | Required assertion turned red |
| --- | --- |
| Drop external mapping uniqueness | duplicate-mapping: expected 23505/key, actual success |
| Disable profiles RLS | profile-isolation: foreign/null visible IDs |
| Feedback SELECT predicate true | feedback-isolation: foreign feedback visible |
| Anon schema/table grants plus true SELECT | anon-private-read: expected 42501, actual success |
| Authenticated account_id column grant only | account-column-grant: effective grant inventory |
| Profiles identity trigger disabled only | service-ownership: expected 23514/ownership guard, actual success |
| Compound ownership protections weakened | authenticated-ownership: expected 42501, actual success |
| Classification immutability trigger disabled | classification-immutable: expected 23514/immutable guard, actual success |
| Same-session FK dropped | same-session-selection: expected 23503/FK, actual success |
| Only seal branch removed, stamp/other evidence checks retained | snapshot-sealed: expected 23514/seal, actual success |
| Observation evidence trigger disabled only | observation-offer: expected 23514/offer match, actual success |

**Test-only adjustment with real failure evidence:** the originally specified
three-part compound control (column grant, identity-trigger disable, UPDATE WITH
CHECK true) failed to bypass ownership: PostgreSQL raised `42501 new row violates
row-level security policy for table "profiles"`. The unchanged SELECT ownership
predicate also protects the new row. Reported this concrete result before adjusting
the rollback-only compound setup to additionally use SELECT USING(true). That
control now reaches the intended ownership-bypass red. Production grants/policies
and the three individual protections remain exactly as approved; no identity or
deletion architecture change was made.

During implementation, real runs also caught a collision between an automatically
named origin-array CHECK and the explicit origin-evidence CHECK (resolved by an
explicit array CHECK name), a harness query-variable ambiguity, DML incorrectly
using EXECUTE INTO, a Windows UTF-8 BOM after prepending marker SQL, a negative
outcome test also violating its independent end CHECK, and a self-test CASE syntax
error. Corrected these defects rather than counting them as regression-control
evidence. SQL input now has UTF-8 without BOM and LF; negatives isolate the named
constraint. No temporary source weakening remains; final green is required.

### Remaining risk and independent review handoff

The audit reports `GHSA-vfj7-8cjw-p6xm` in braces <=3.0.3 (deep-pattern stack
exhaustion), propagating through micromatch, fast-glob, @next/eslint-plugin-next
and eslint-config-next: five high dependency reports for one underlying advisory.
It is the unchanged development lint dependency chain, driven by repository-owned
glob patterns; PR 2 accepts no untrusted provider/browser pattern input and the
database job installs no npm dependencies. npm proposes a breaking downgrade to
eslint-config-next 14.2.35, incompatible with the pinned Next 16 baseline. Do not
apply that unrelated downgrade. Track a compatible upstream fix in dependency
maintenance; the repository owner remains responsible for that residual development
DoS exposure. ESLint 9's existing maintenance warning remains unchanged.

Remote CI is **not yet executed/verified**: commits, pushes and PR creation are
excluded from this task. The aligned database job preserves existing pinned actions
and security, adds no install/cache/secrets/services, and uses exactly test:db.
Actual GitHub runner OS/image/Docker details and green remote logs must be recorded
when publication is authorized; do not infer them from ubuntu-latest or its pending
October 19–November 19 Ubuntu 26 rollout. Local Windows/Docker results are primary.

Plain Postgres proves database enforcement under the shim, not Supabase gateway,
Auth identity verification, reserved-role/platform/default-privilege compatibility,
or endpoint authorization. PR 7 still owns those checks, schema-exposure/browser-write
adjudication, restore transaction layout and real-data recovery rehearsal. Future
app DML-issuing triggers require re-review of the depth-based cascade guard.
DDL-authorized owners and privileged services remain outside ordinary RLS isolation.

Self-review inspected the actual 17-file inventory and acceptance evidence against
sections 2–7; no remaining implementation blocker found. Ready for an independent
review of **uncommitted changes including untracked files**, using this plan and
the retained logs. The Codex desktop launcher successfully opened this workspace;
the review-pane UI itself cannot be selected/verified through the available native
tools. No independent-review completion or remote-CI green is claimed.


## 10. Independent review corrections: October 2, 2026

The supplied independent working-tree review found one blocking history deletion
path and four cleanup issues. This round keeps the same 17-file inventory and
changes no dependencies, application code, identity semantics or publication state.
Section 9 retains the original run evidence; this section supersedes its deletion,
trigger-count, runner-test coverage and mutation-count claims where changed.

| Finding | Correction and acceptance |
| --- | --- |
| 1: session deletion erases history | BEFORE DELETE session guard rejects owner/service direct deletes, including a selected session. A shared session-delete negative uses a session with recommendation/feedback history and no selected pointer, so disabling only that guard reaches the named mutation red. Existing plain selected-graph account/profile cascades must remain green. |
| 1: catalog history retention | Chose to preserve classification/snapshot evidence. Their movie FKs change CASCADE to RESTRICT, a deliberate revision of the earlier plan. Separate owner/service negatives isolate each FK; readbacks retain history. History-free movies still delete mappings/credits, and unused providers still delete mappings. |
| 2: ineffective default revokes | Removed the three schema-scoped default revokes and documented explicit per-object hardening in every future creation transaction. A rollback-only invoker function probe proves PUBLIC-derived API EXECUTE defaults, then proves explicit revoke removes them. No platform/global defaults altered; Supabase compatibility stays in PR 7. |
| 3: ambiguous RLS references | Qualified profiles.account_id, recommendations.session_id, feedback_events.recommendation_id and each dynamically named outer profile_id. Existing actual-role visibility/write suites verify policies. |
| 4: overstated runner tests | Replaced duplicate timeout/signal labels with one generic abort cleanup test. It makes no claim about main()'s five-minute timer or SIGINT/SIGTERM registration. |
| 5: crash error masked by automatic removal | Removed --rm; explicit identity-checked removal remains. A stopped-container stub models auto-removal and verifies the original execution error and inspected teardown. |

The application trigger inventory is now **21**, with the same six invoker
functions and 17 tables. Mutation controls now contain **12** named expected reds.
The existing personal-reference movie FK test initially hit the new classification
restriction first; its negative now inserts a personal reference on an otherwise
history-free movie inside the error subtransaction, isolating the original
profile_movies_movie_fk instead of relaxing the expected constraint check. Failed
runs verified disposable teardown. No temporary enforcement weakening remains.

Validation completed locally:

- `npm run check`: passed strict typechecks, zero-warning lint, 134 foundation
  tests and production build (`.cache/pr02-review-check.log`).
- `npm run test:db:runner`: all 11 passed, zero skipped; also rerun by test:db.
- `npm run test:db`: passed real PostgreSQL baseline, all 12 named mutation reds,
  final green and fresh reset replay (`.cache/pr02-review-db.log`). Plain account
  and profile deletion, owner/service session deletion denials, independent
  classification/snapshot restrictions and function-default/revoke probes passed
  in all three green suites. Explicit teardown verified for both created IDs:
  `895764d8f35ed7c2e110a2a1460e6945bebd09462da6507f3249ebea93df6499`
  and `142bbbd49c8b106d26671f8a809fc0cc6faaa69bac9e71eb1da4d211126d411b`.
- `git diff --check`: passed; inspected the actual tracked diff and untracked
  inventory, including changed SQL and lifecycle tests. No new files beyond the
  original PR 2 inventory. Docker sandbox access required approved escalation.

No dependency or image-pin change; original audit disposition remains applicable.
The subsequent supplied independent re-review approved all five corrections and
reported its own successful test:db run, including all 12 mutation reds, final
green, fresh replay and verified teardown.
Remote CI and actual Supabase/Auth verification remain unverified. Nothing committed,
pushed, published, provisioned or deployed.


## 11. Nonblocking re-review cleanup: October 2, 2026

Retain availability_tracks_movie_fk CASCADE: a history-free movie may remove
unobserved tracks, while classifications/snapshots prevent deletion of evidence.
README now explicitly includes those tracks alongside mappings/credits. The
existing history-free catalog deletion case now inserts a track and asserts it
is removed, preserving direct track immutability and observed-history restrictions.

Each rollback-only SQL suite now establishes a named outer savepoint, rolls back
to it, and releases it. psql still owns the enclosing --single-transaction and
commits it normally; suite writes remain rolled back without ending psql's
transaction prematurely or emitting 'there is no transaction in progress'.
Migrations/fixtures/helpers and runner flags remain unchanged.

Validation: `npm run test:db` exited 0 with all 11 runner tests, baseline,
12 named mutation reds, final green, fresh reset replay and verified teardown.
The extended track-cascade assertion passed in all three green suites; no WARNING
lines remain in `.cache/pr02-nits-db.log`. `git diff --check` and UTF-8/whitespace
inspection of the three untracked SQL suites passed. No application, dependency,
runner or migration change; foundation checks were not repeated for this SQL/doc
cleanup. No commit, push or PR authorized.
