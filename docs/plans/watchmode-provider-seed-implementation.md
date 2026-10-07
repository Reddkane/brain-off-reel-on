# Watchmode provider seed implementation evidence

Branch: `feat/watchmode-provider-seed`. Baseline: `6a7c6ec` on main.
Implementation date: October 6, 2026. Contract: the complete local handoff
`.cache/watchmode-provider-seed-handoff.md`. No commit, push, PR, merge, deployment,
paid action, retained access, real credential read or real provider request.
The existing `.claude/` and ignored work are preserved.

## Result and acceptance review

Migration `20261006000001_watchmode_providers.sql` seeds four stable UUIDs,
display names and direct Watchmode identities: Netflix/203, HBO Max/387,
Disney+/372, Hulu/157, using the recorded verification document. A uniqueness
conflict aborts all provider inserts and DDL. No conflict-skipping clause is used.
The invoker guard denies every update/delete of an existing Watchmode mapping,
including provider cascades; provider display-name changes remain allowed.
The function explicitly revokes PUBLIC and all three API roles. Existing provider
identity/updated-at triggers and grants remain intact. Released migrations and
dependencies are unchanged.

Schema detection recognizes 3, 4, 5 and 6. State 6 retains the evidence inventory
and adds the exact enabled BEFORE ROW UPDATE/DELETE guard binding in `app`.
The migration-count acceptance compares discovery against current count 6.
Backup phase checks and manifest validation accept recognized noncurrent source
states 3/4/5 before upgrade and require the shared current count after upgrade.
Acquisition checks run in both 5 and 6. The movie identity digest is unchanged:
provider insertion is expected across this upgrade. Batch command validation uses
the shared current count without changing decisions, limits or aggregate caps.

Live composition checks exactly one required mapping for each of the four sources
in its read-only transaction under the dedicated refresh lock, after schema
validation and before cleanup/provider requests. Missing data yields the fixed
allowlisted `provider_mapping_missing`, zero attempted credits and provider calls,
unchanged expired private fixtures, a failure report and exit 1.

Catalog acceptance covers fresh seeds, 3/4/5 upgrades, no-op repeat, transactional
conflict rollback, phase mismatch before file creation, acquisition vetoes,
shared snapshot, hash/manifest validation and real disposable restore rehearsal.
Mapping denials run as catalog owner, non-superuser migration owner and service
role; display-name updates are positive controls. Evidence tests no longer insert
the four required mappings. The original platform fixture still has unrelated,
explicitly synthetic provider identities used by original schema/history tests;
these are not required-source mappings or production dependencies.

Real Node subprocesses cover both backup phases, their mismatches, upgrade,
inspect and repeat upgrade, plus successful live CLI and missing-mapping refusal.
Credential-free copies inside `.cache/` resolve the existing dependencies. Only
fixed target names/port or default effect composition in those copies are changed
to the already-inspected test-owned resources and invented keys/transport. CLI
entries, preflight, backup and schema logic remain the production implementation.
The existing Docker-denied process-entry suite also remains in `npm run check`.
Every temporary root and exact Docker container/network/volume is torn down by
its owning harness; no retained object is inspected or modified.

## Observed failures and controls

Initial pre-implementation regressions: Node's catalog/live/evidence test files,
exit 1, 60 tests, 44 passed and 16 failed. Missing migration data broke real
evidence paths after removing the hidden test seed; fresh state 6, mapping guards,
conflict rollback, state-4 backup and state-5 upgrade refusal were red. The missing
mapping regression reached provider work and reported an auth failure instead
of the required preflight refusal. Full log:
[initial red](../../.cache/provider-seed-initial-red.log).

First catalog green attempt: exit 1, 31 tests, 17 passed/14 failed. New test mistakes
were a state-5 importer expectation (the independent TMDB importer only needs the
evidence schema) and an overbroad fixture edit referring to `baseline` outside
its loop. Later failures cascaded from that incomplete test restoration.
Second catalog attempt: exit 1, 34 tests, 29 passed/5 failed. The process fixture
omitted runtime credentials for inspect; an old zero-provider assertion needed
to assert the four migration-owned providers and unchanged other counts.
Both issues were fixed; the subsequent catalog run passed 38/38.
[First attempt](../../.cache/provider-seed-catalog-green.log),
[second attempt](../../.cache/provider-seed-catalog-fixed.log),
[corrected run](../../.cache/provider-seed-catalog-ready.log).

First evidence attempt: exit 1, 32 tests, 31 passed/1 failed. The new subprocess
fixture serialized pg pool options, which omit its non-enumerable invented
password. Three focused diagnosis runs each failed 0/1; the final diagnosis
identified the synthetic SCRAM error. Explicit password copying fixed the fixture;
the focused process regression then passed 1/1. Temporary diagnostics existed
only in the test copy and are removed from the final tests.
[Evidence attempt](../../.cache/provider-seed-evidence-first.log),
[diagnosis 1](../../.cache/provider-seed-process-debug.log),
[diagnosis 2](../../.cache/provider-seed-process-debug-2.log),
[diagnosis 3](../../.cache/provider-seed-process-debug-3.log),
[focused green](../../.cache/provider-seed-process-fixed.log).

The initial `npm run check` passed 365/365 offline tests and the production build.
Later acceptance additions, including real process and acquisition-veto controls,
were exercised red through focused failures/mutations and then green; they were
not all present in the initial pre-implementation red run. See the final mutation
and validation tables below rather than treating fixture failures as production
mutation evidence.

## Required mutation controls

Both tools ran alone, sequentially, with no concurrent DB suites. Each child suite
exited 1 with actual assertion failures; both tool commands exited 0. All 24 source
mutations were restored in `finally`, followed by the shared final green commands.
The new controls remove the mapping seed, guard binding and mapping refusal, and
reinstate the old backup/batch schema assumptions. The retained state-replay anchor
intentionally still forces state 3 to attempt replay against every later state.

| Control | Child exit | Observed test counts |
| --- | --- | --- |
| `state_check_removed` | 1 | 9/28 passed; 19 failed |
| `cleanup_after_provider` | 1 | 10/13 passed; 3 failed |
| `backup_acquisition_skips_state5` | 1 | 30/35 passed; 5 failed |
| `watchmode_seed_removed` | 1 | 5/13 passed; 8 failed |
| `watchmode_guard_removed` | 1 | 20/25 passed; 5 failed |
| `watchmode_preflight_removed` | 1 | 11/13 passed; 2 failed |
| `backup_legacy_phase_rule` | 1 | 24/31 passed; 7 failed |
| `batch_legacy_schema` | 1 | 26/30 passed; 4 failed |
| `catalog_action_fallback_regression` | 1 | 1/6 passed; 5 failed |
| `batch_command_entry_removed` | 1 | 29/30 passed; 1 failed |
| `batch_credit_total_reset` | 1 | 28/30 passed; 2 failed |
| `operational_exit_zero` | 1 | 41/42 passed; 1 failed |
| `live_path_guards_removed` | 1 | 40/42 passed; 2 failed |
| `live_report_overwrites` | 1 | 41/42 passed; 1 failed |
| `signal_listener_removed` | 1 | 41/42 passed; 1 failed |
| `locked_preflight_removed` | 1 | 6/13 passed; 7 failed |
| `cli_refuses_all` | 1 | 0/13 passed; 13 failed |
| `batch_always_stops` | 1 | 23/30 passed; 7 failed |
| `backup_overwrites` | 1 | 24/29 passed; 5 failed |
| `backup_identity_always_equal` | 1 | 30/35 passed; 5 failed |
| `backup_state_check_removed` | 1 | 22/28 passed; 6 failed |
| `backup_snapshot_omitted` | 1 | 30/38 passed; 8 failed |
| `backup_failure_cleanup_removed` | 1 | 27/35 passed; 8 failed |
| `backup_hash_check_removed` | 1 | 27/35 passed; 8 failed |

Complete tool output:
[retained-upgrade controls](../../.cache/provider-seed-retained-controls.log),
[availability controls](../../.cache/provider-seed-availability-controls.log).
The existing tools also refresh their own ignored per-control logs under
`.cache/retained-upgrade/` and `.cache/availability-controls/`; handoff inputs and
unrelated cache work remain untouched.

## Final shared validation

All six commands ran sequentially after mutation restoration. All final tests
passed with no skips/cancellations; each disposable harness verified exact teardown.

| Command | Exit | Final counts / result |
| --- | --- | --- |
| `npm run check` | 0 | 365/365 offline tests in 16 files; strict typechecks, zero-warning lint, production build. |
| `npm run test:db` | 0 | 11/11 runner tests; baseline, post-control and fresh-reset SQL green. Log has 5,233 PASS notices and 18 expected-red helper/control notices; notices are not independent test cases. Original released schema baseline remains explicit. |
| `npm run test:metadata:db` | 0 | 22/22 tests in each of two fresh cycles (44 executions). |
| `npm run test:catalog:db` | 0 | 38/38 tests. |
| `npm run test:availability:sweeps:db` | 0 | 43/43 tests. |
| `npm run test:availability:evidence:db` | 0 | 33/33 tests. |
| `node tooling/retained-upgrade-mutations.ts` | 0 | 2/2 expected-red controls, individually counted above. |
| `node tooling/availability-live-mutations.ts` | 0 | 22/22 expected-red controls, individually counted above. |

Final full logs:
[check](../../.cache/provider-seed-final-check.log),
[database](../../.cache/provider-seed-final-test-db.log),
[metadata database](../../.cache/provider-seed-final-test-metadata-db.log),
[catalog database](../../.cache/provider-seed-final-test-catalog-db.log),
[sweeps database](../../.cache/provider-seed-final-test-availability-sweeps-db.log),
[evidence database](../../.cache/provider-seed-final-test-availability-evidence-db.log).

The local preloader emits suppression diagnostics on stderr; PowerShell may label
these `NativeCommandError`. The recorded native process statuses are 0, and the
suppressed content was never loaded. No suite was skipped or weakened. No remote
CI or retained execution result is claimed.

## Rollout limitation and retained context

The handoff reports run 1 completed 30 pages/four sweeps, enriched 100 titles,
failed its first source check and spent 31 credits, leaving state 5 and 200 movies.
These are attributed handoff facts, not fresh retained readback. One of the nine
runs and 31 credits have already been used. Separate authorization must settle
remaining runs and credit allowance; no automatic sequence or allowance reset is
implemented. The original strict failure/progress rules remain unchanged.

The acquisition-check limitation recorded here was resolved in review; see
"Review follow-up" below.

Validation uses the existing ignored `.cache/no-credential-env.cjs` preloader to
prevent Next/Vite automatic dotenv content loading; it suppresses all dotenv reads
and reports the count. No real credentials are used by any test. This local
preloader is not a repository/CI configuration change; remote CI is unverified.
Synthetic provider responses do not establish real API compatibility, entitlement,
playback or hosted-platform acceptance. Requested POSIX modes do not verify NTFS
ACLs. The November 3, 2026 Watchmode probe deadline remains unchanged.

## Final review and review artifact

Self-review covers every handoff criterion: seed/conflict transaction, guard roles
and cascade behavior, schema 3/4/5/6 detection, all current-state consumers,
before/after manifests and acquisitions, unchanged identity digest, locked data
preflight, removal of hidden test seeds, real process entries, observed-red controls,
shared validations, documentation and exact disposal. The explicit exception is
chronology: some later acceptance additions were mutation-tested red after the
production change, rather than all being written before it; this is disclosed
above. The acquisition veto was replaced in review (below).
Focused external review remains required before publication or retained execution.

Review patch: [complete tracked-plus-new-file patch](../../.cache/watchmode-provider-seed-review.patch).
It contains only the 17 intended files, including the new migration, process helper
and this document. Released migrations, dependency files, `.claude/`, private data
and generated artifacts are excluded. `git diff --check`, local documentation
link/encoding checks and reverse applicability of the complete patch pass.
The actual code diff confirms restored temporary mutations; the ingestion worker
and other unrelated files have no remaining changes.

## Review follow-up (2026-10-06)

Review confirmed the acquisition limitation on the retained catalog (read-only):
the original check returned 186 mismatches and 424 `watchmode_membership`
acquisitions, so the next backup would have failed with `backup_acquisition_failed`
and the batch command would have rejected every resumed batch. The rows are
legitimate run-1 provenance; the check assumed a never-swept catalog, as the handoff
specified in error.

- `acquisitionSql` now returns one count, `mappings_without_acquisition`: identity
  mappings with no acquisition row. It must be 0 (retained: 0). Backup, manifest
  validation and the batch command use it.
- Tests: states 5 and 6 refuse an unprovenanced mapping before creating a dump;
  a state-6 backup accepts a Watchmode identity with `watchmode_membership`
  acquisitions on both namespaces.
- The provider-mapping guard also refuses an UPDATE that moves a non-Watchmode
  mapping into the `watchmode` source.
- Observed red (`test:catalog:db`, each restored byte-for-byte): provenance limited
  to `tmdb_metadata` 33/41 (acceptance tests fail); check disabled 29/37 (refusal
  tests fail); guard NEW.source clause removed 39/41 (guard test fails).
- Final: `test:catalog:db` 41/41.

## Review follow-up 2 (2026-10-07): backup retention

Codex's re-review found that backup retention still assumed TMDB-only data: the
manifest deadline was six months after the oldest TMDB metadata even when the dump
held Watchmode data, whose window is 30 days. The retained catalog holds Watchmode
data from 2026-10-06 16:43 UTC, so the next backup would have been labelled
2027-04-04 instead of about 2026-11-05.

- `backupRetentionDeadline` takes the earlier of TMDB oldest + 6 calendar months and
  Watchmode oldest + `provider_retention_policy.watchmode_window`. Watchmode oldest
  is the minimum age column over every table bound to `guard_provider_cache`, read
  from `pg_trigger.tgargs`, plus `watchmode_membership` acquisitions.
- The manifest records `watchmodeSourceAge` (`oldest`, `windowSeconds`; null before
  state 5), and `verifyBackup` recomputes the deadline from it. Backup refuses data
  already past the deadline (`backup_retention_expired`) and a state-4 catalog with
  sweep rows (`backup_retention_unknown`). The CLI prints `retentionDeadline`.
- Tests: a state-6 backup with one-day-old Watchmode acquisitions gets a deadline
  equal to that timestamp + 30 days (computed in SQL), earlier than the TMDB-only
  deadline, and manifest tampering of deadline/window/age is refused; 2020-dated
  Watchmode data is refused before dump creation; state-4 sweep data is refused;
  a state-3/4 manifest with a Watchmode age, or any altered deadline, is refused.
- The guard test now uses a provider without a Watchmode mapping, so without the
  guard the UPDATE would succeed.
- Observed red (`test:catalog:db`, restored byte-for-byte): deadline ignores
  Watchmode 34/45; expiry refusal removed 37/45; state-4 refusal removed 36/40;
  manifest deadline unchecked 28/36; guard NEW.source clause removed 43/45.
- README P3 (stale acquisition-veto text) corrected; README and plan retention
  text rewritten. Final: `test:catalog:db` 45/45.

## Review follow-up 3 (2026-10-07): pre-evidence cache rows

Codex found the state-4 refusal checked only `watchmode_sweeps`; a
`metadata_detail_attempts` row (no sweep FK) let a backup succeed with the TMDB-only
deadline. Schema detection now exports `providerCacheTables(state)` (the four
availability tables, plus the six sweep tables from state 4), which its own binding
check uses; backup refuses any state below 5 when any of those tables has a row
(`backup_retention_unknown`).

- Tests: state 4 refuses a sweep row and, separately, an independent detail attempt;
  a state-6 deadline is set by a detail attempt two days older than the membership
  acquisitions.
- Observed red (`test:catalog:db`, restored byte-for-byte): sweeps-only state-4 check
  31/36 (detail-attempt case fails); trigger-bound ages ignored 40/48.
- Final: `test:catalog:db` 48/48.
