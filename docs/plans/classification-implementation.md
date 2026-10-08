# Classification Phase A: implementation review packet

Date: October 7, 2026. Branch: feat/classification; baseline f708373.
Approved scope: [classification plan](classification.md), narrowed by the trim
handoff and amended by .cache/classification-impl-handoff.md. Implementation is
uncommitted. Independent review/adjudication remains pending; no merge is claimed.

## Result and actual changes

- [Rubric v1](../rubric-v1.md), exact untrusted-output checker, duplicate-aware
  bounded JSON decoding, stored-only projection and deterministic SHA-256 input.
  No profile/rating/history fields reach prompt or fingerprint; named-film scores
  stay out of trusted prompt instructions. Native getters/hidden/symbol properties
  and sparse arrays are rejected, not normalized into plausible output.
- Pure agreement (exact/within-one, quadratic kappa, full confusion counts,
  Spearman) and effective coverage intersected with cached-link readiness.
  Current input fingerprints exclude stale labels; expired evidence is explicit.
  Model-parent reviews resolve uncertainty, with latest accept/replace/defer wins.
  Anchors remain calibration-only and survive metadata changes independently.
- Append-only guarded pg store, atomic/idempotent human imports, concurrent-import
  serialization, model input-change checks, readback and private snapshot export.
  Writes use fresh statement snapshots after the lock; exports use repeatable-read
  read-only snapshots. Server creation timestamps preserve microsecond ordering.
- One additive migration, 20261007000001_classification.sql: composite same-movie
  review-parent FK, self/kind checks and model-only authenticated reads. Legacy
  envelopes without a version and with null parent remain unchanged/operator-only.
- Metadata-only ID ingest reuses getMovie/resolveMovie/persistMovie and records the
  existing acquisition provenance. No ratings writer, service discovery or test-only
  production seed is needed. A fresh-migrations test starts with zero movies and
  personal rows, then uses the creation/import/review paths.
- Offline CLI, private exclusive output, bounded reads, fixed counts/codes,
  exit 0/2/1 and signal cleanup. Every action runs through a real process test;
  DB tests also execute actual import/review/export/report effect paths.
- Simple bounded classifier orchestration and hard zero live spend, plus Phase B
  report carry-over. Prior report identity hashes phase/candidates/configuration;
  missing/unreadable/mismatched reports fail before transport. Actual and unknown
  spend remain separate; all retries count. No resumability/durable ledger was built.
- Package scripts/Vitest discovery/CI use the same shared commands. Catalog schema
  detection recognizes state 7; backups accept state 6 before upgrade and preserve
  read-only validation of historical state-6 batch manifests. Existing catalog
  upgrade tests now assert the discovered current migration count.

Production files: src/domain/classification.ts, classification-reports.ts;
src/server/classification/{codec,files,orchestrator}.ts;
src/server/db/classification-store.ts; src/server/ingestion/anchor-metadata.ts;
scripts/classification.ts, classification-effects.ts; config example; migration.
Tests: tests/classification/{core,files,orchestrator,process,reports}.test.ts,
test-only fixtures.ts and tests/db/classification.test.ts. Controls:
tooling/classification-mutations.ts. Shared modifications: package.json,
vitest.config.ts, CI, catalog-schema/backup/availability-batch, metadata-disposable
harness, availability readback, catalog DB tests, README and owning documentation. No dependency/lockfile
change, UI change, credential reader, real adapter or retained migration.

## Observed-red and green evidence

Logs are under .cache/classification/evidence/. A passing positive control is not
represented as an observed regression. Later tests of established behavior use
explicit broken-gate controls where noted, with unconditional restoration.

| Gate | Observed red | Final correction/evidence |
| --- | --- | --- |
| Output/input/JSON/prompt | core-red.log: scaffold accepted invalid scores/enums/provenance, duplicate/deep JSON and personal fields; missing prompt boundary. | Exact validation/projection/decoder; core suite and final shared check green. |
| Reports/reviews | reports-red.log: null scaffold failed all six report assertions. | Independent rates/kappa, effective review ordering and link intersection. |
| Cap/carry-over | orchestrator-red.log; config-carry-red.log; carry-process-red.log. | Missing/mismatched report refusal, hashed configuration, real process prevented spending a reset balance. |
| Spend fidelity | spend-fidelity-red.log: carried unknown reclassified as actual; unexpected actual charge lost. | Preserve unknown separately, record actual charge and halt. |
| Migration/access | db-red.log: missing-parent/version/foreign-key checks absent and human rows readable. | Native FK/CHECK and two-identity RLS green on disposable targets. |
| Human store | store-red.log: no-op scaffold returned zero instead of appending. | Atomic append/no-op reimport/readback through real store. |
| CLI actions | process-red.log: 11 actual entries failed expected validation/refusal/exclusive-write outcomes. | Actual entry dispatch/private paths/fixed exits; effect processes in DB suite. |
| Concurrent import | concurrency-red.log: controlled older isolation produced two duplicate judgments, expected one. | Restored read-committed writes; real two-waiter serialization test green. |
| Native/raw JSON | native-json-red.log: hidden/symbol/getter/sparse outputs accepted; raw valid JSON rejected. | Native structure validation and duplicate-aware raw-text parsing. |
| Signal entry | signal-red.log: deliberately removed handler returned spend_unknown instead of cancelled. | Restored actual entry handler; child process emits SIGINT and settles. Native Windows signal delivery is not claimed. |
| Stale input | stale-input-red.log: old labels contributed eligible coverage after input changed. | Snapshot requires current fingerprint; stale labels flagged/excluded. |
| Four controls | control-validator/provenance/personal_sentinel/coverage_intersection.log each failed assertions. | Verified source hash restoration, final offline + disposable DB green. Personal control leaks only into hash, proving the stronger privacy gate. |
| Review 1: local failures/spend | review-five-offline-red.log: persistence and backoff add 3 unknown units after 1 metered unit; local errors become spend_unknown. | Transport-only catch/timer; persistence/backoff preserve actual cost, cancellation and diagnostic codes. Continuation carries 1, not 4; thrown transport still reserves 3 (positive control). |
| Review 2: reviewer uncertainty | review-five-offline-red.log; review-assessment-red.log: medium review leaves a low gate eligible; template uses high for unassessed; unsupported low retains eligibility. | Explicit review-only unassessed default, medium/high override, supported fresh low only; changed unassessed scores and inadequate evidence remain high. Model/anchor uncertainty schema stays strict. |
| Review 3: availability counts | review-five-db-red.log: anchor-only unclassified is 0 instead of 1; model plus anchor counts 2 instead of 1. | Shared stored-row checker; unique valid model movies, excluding human/legacy/invalid rows. Candidate-neutral readback is distinct from candidate-specific eligibility. |
| Review 4: Windows path casing | review-path-red.log: real lowercase-cwd process exits 1; normal casing passes. | OS-aware path equality retains realpath/symlink checks; both Windows casings pass. |
| Review 5: parent diagnostic | review-parents-db-red.log and review-invalid-output-parent-red.log: actual legacy and malformed-model imports print file_failed. | Decode-only parent validation maps to review_parent_invalid; SQL acquisition stays outside that catch. Both real import processes refuse with zero appended rows. |

Test-authoring corrections: the first malformed-score table accidentally listed
valid level 1, which was removed; the small kappa example's expected value was
corrected from 0.75 to 2/3 by independently summing the nine marginal pairs
(expected squared disagreement 1, observed 1/3). Neither was a production defect
or a skipped test. Helpers moved out of test modules to avoid duplicate registration.
The first config-process test used the paid-run fake for Phase A, returning partial
and affecting its call counter. The test bridge was corrected to a zero-call Phase A
response before observing the intended casing failure in review-path-red.log.
Those initial authoring failures are retained, not counted as defect evidence.

## Commands and validation context

The final shared commands execute in a credential-free copy of tracked source and
the exact new files, with the existing dependency tree linked and no env/private
catalog files copied. No dependencies were installed/changed. Framework discovery
uses the copy as cwd; mutation controls run alone. All DB suites are sequential and
use inspected test-owned resources; logs record verified teardown. No CI run or
Supabase/HTTP/phone compatibility is claimed.

| Command | Exit / evidence |
| --- | --- |
| npm run check | 0; typecheck, zero-warning lint, 436 tests in 21 files and production build (review-check-green.log). No env-file discovery in the credential-free invocation. Next warns about inferred workspace root because copy and parent both have lockfiles; production configuration was not changed to silence it. |
| npm run test:db | 0; original runner/SQL access assertions, expected-red controls, fresh reset and verified teardown. |
| npm run test:classification:db | 0; 13 tests, including migration-only creation, concurrent imports, CLI effects, review ordering, availability readback, invalid parent diagnostics and legacy upgrade (review-five-db-green.log). |
| npm run test:classification:controls | 0; all four assertions red, hashes restored, final 71 offline cases and 13 DB cases green (review-test-classification-controls-green.log). |
| npm run test:catalog:db | 0; 48 tests and test-owned volume/UUID preservation. |
| npm run test:metadata:db | 0; runner/lifecycle plus two fresh cycles of 22 integration tests each. |
| npm run test:availability:sweeps:db | 0; 43 tests, synthetic transports. |
| npm run test:availability:evidence:db | 0; 33 tests, synthetic transports and actual CLI processes. |

Failure output is preserved in the corresponding logs. The initial controls DB
scratch log was overwritten by a subsequent run; controls-db-initial-failure.log
recovers its full error diagnostic/stack/counts from the captured tool output and
explicitly records that limitation. No failed invocation is called a pass.
Corrected ordinary failures were:

- db-production.log: PostgreSQL 42702, ORDER BY created_at ambiguous in snapshot
  export. Qualified the table's timestamp/id ordering; subsequent workflow green.
- controls-db-initial-failure.log: evidence_expired from old schema fixtures.
  Added optional migration-only disposable setup and verified zero-row creation;
  source deadlines apply specifically to TMDB metadata, not first-party synthetic
  namespaces. Restored controls and final DB suite green.
- catalog-db-initial-failure.log: current state was 7, tests expected 6; nested
  failure prevented baseline restoration and caused a missing expected upgrade
  rejection. Updated expected current state, not the underlying safety checks;
  full 48-case suite then passed. Historical state-6 report validation remains.

**Credential-read incident:** the initial source-checkout npm run check reported
Next automatically loading the existing .env.local. No values were printed or
directly inspected. That indirect framework read violated the no-read restriction;
validation moved to a credential-free copy. Subsequent framework checks use that
copy, and the final evidence does not rely on the contaminated invocation.
No retained catalog/private catalog files were accessed or modified.
The five-finding review reruns use review-*.log; controls retain their per-control
logs and final green logs. The affected availability suites and all required
commands were rerun sequentially; the unchanged metadata-only suite retains its
earlier passing evidence. Availability-live and completedSetup now require schema
7, so a future retained state-6 sweep first needs a separately authorized upgrade.

## Limits and review handoff

The handoff prohibited real adapters/credential readers. Accordingly the shipped
classification-effects composition is empty: standalone apply/read-local refuses
local_store_unconfigured. Production store/CLI methods accept an explicitly
guarded, capability-issued pool, exercised through real disposable processes;
real connection wiring and retained execution remain separately authorized work.
Metadata live dispatch and classifier live dispatch are disabled. This is a scope
constraint, not a hidden fixture-dependent production bootstrap.

Human evidence is structured and bounded, not independently fact-checked; overview
alone cannot resolve attention/complexity. Model self-uncertainty is uncalibrated.
Private snapshot deadlines must be respected/deleted by the operator; Windows ACL
privacy and native SIGINT/SIGTERM delivery are unverified. A metadata input change
needs a compatible new classification, not transferred old reviews. The 99-link
baseline limits real coverage; no actual model agreement/coverage is measured here.

Bootstrap intervals/tokenizers/reasoning budgets/verified prices precede Phase B;
durable reservations/reconciliation/manifests/resume precede Phase C. Both phases,
retained upgrade/execution, commits, pushes, PRs and deployment remain unauthorized.
Review .cache/classification-review.patch against the approved acceptance table,
including new files; resolve findings and re-review material revisions before merge.
