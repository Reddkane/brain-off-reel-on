# Retained availability live gate: implementation evidence

Date: 2026-10-05 (client date). Baseline: `main` at
`446f78f05f53ce08f296766c5c66b5d52065d296` (#9). Implementation is uncommitted on
`feat/availability-live-gate`. The user approved the plan and this implementation;
**no retained execution, commit, publication or deployment was authorized**.

## Change set

Preserved the approved README/plan/revision-evidence work and `.claude/`. The plan
has only the two requested prose line wraps; its decisions and runbook are intact.
No dependency, lockfile, migration, provider policy, selection or persistence change.

- `availability-sweeps.ts` dispatches exactly once through explicit `--live`,
  validates bounded JSON/terms/private paths, lazily imports effects, propagates
  worker exit 0/2/1 and emits the fixed allowlisted summary. Offline/import paths
  create no credentials, pool or providers. SIGINT/SIGTERM listeners are removed
  in finally. Operational failures cannot be recast as configuration failures.
- `availability-live.ts` performs full shared schema detection on the held lock
  client before cleanup. Recognized old schemas report `upgrade_required`;
  unknown inventories refuse. The read-only preflight consumes ordinary database
  budget. Cancellation during that preflight remains `cancelled`. Cleanup, quota,
  provider work, exclusive reports and owned-pool shutdown use the existing worker.
- `catalog:local backup --phase before-upgrade|after-upgrade` requires schema 3/5
  respectively, before dump creation. One dedicated guarded postgres client owns
  the advisory lock, repeatable-read/read-only transaction, exported snapshot,
  identity digest and acquisition query. No row writes or implicit upgrade.
- `catalog-backup.ts` streams password-free socket `pg_dump` from the inspected
  exact ID with backpressure, a 64-MiB counter and 120-second deadline. SQL/health
  checks are bounded to five seconds. Inspection and repository-SHA child work
  receive cancellation. Child/stream settlement precedes coordinator release.
  The same snapshot stays alive through archive listing, streamed SHA-256 and
  exclusive manifest verification. Phase/state, ID, SHA, timestamps, digest,
  acquisition results, size/hash and source-age deadline are validated. Failure
  removes only owned partial files; a created manifest is invalidated before
  removal, with a fixed cleanup-failure code if cleanup fails.
- `private-directory.ts` refuses parent symlinks/junctions and containment escapes.
  Backup filenames are outside the unchanged cleanup inventory. Digest timestamps
  retain UTC microseconds; the six-month deadline uses conservative millisecond
  precision. SHA lookup is rooted at this repository, independent of shell cwd.
- `availability-batch.ts` is read-only manual decision support, not an execution
  loop or authorization mechanism. Failure vetoes precede cap/continuation,
  including one failed title source check. It checks verified current/previous
  readback, catalog deltas, persisted additions, actual `services.source_id`,
  sweep IDs, cumulative checkpoints and committed per-run page deltas. Complete
  rescans with zero additions stop. Active cap 1,000, nine invocations and aggregate
  900 credits/900 details/2,700 attempts end the batch at unchanged per-run limits.

## Original implementation validation (2026-10-05)

All commands use the repository's existing npm entry points. Local environment
loading is isolated with the ignored `.cache/no-credential-env.cjs` preloader;
`NODE_OPTIONS` is restored after each command. It supplies empty content for automatic synchronous dotenv reads by Next/Vite
and synchronizes builtin ESM bindings. Next can still list a discovered `.env.local`
path in its banner; the underlying credential contents are not read. Suppression
counts are logged without values.
It leaves validation assertions and source checks intact. CI has no credential
files and needs no command changes. Docker runs required sandbox escalation;
only inspected disposable resources were used.

| Command | Final exit | Test evidence | Log |
| --- | ---: | --- | --- |
| `npm run check` | 0 | Typecheck, zero-warning lint, 345 offline tests, production build | `.cache/availability-final-check.log` |
| `npm run test:db` | 0 | 11 runner tests; SQL schema/access replay, expected-red controls, final green and fresh reset; 5,233 PASS notices across repeated phases, not distinct test cases | `.cache/availability-validation-test-db.log` |
| `npm run test:metadata:db` | 0 | 22 tests in each of two fresh cycles (44 executions), no skips | `.cache/availability-validation-test-metadata-db.log` |
| `npm run test:catalog:db` | 0 | 26 tests, no skips/cancellations | `.cache/availability-final-test-catalog-db.log` |
| `npm run test:availability:sweeps:db` | 0 | 43 tests, no skips/cancellations | `.cache/availability-final-test-availability-sweeps-db.log` |
| `npm run test:availability:evidence:db` | 0 | 29 tests, including actual CLI paths, no skips/cancellations | `.cache/availability-final-test-availability-evidence-db.log` |

Metadata persistence was not modified, so the conditional
`test:metadata:controls` gate does not apply. No check was weakened, test skipped,
package installed or schema migration edited. No remote CI outcome is claimed.

## Observed-red regressions and controls

Each new acceptance group has an observed assertion failure before being counted:
CLI dispatch/redaction failed against the closed gate; the completed-rescan batch
case failed against an always-continue implementation. The opposite batch control
failed the positive continuation cases. Path/report/signal/schema/complete/resume
acceptance was then checked by targeted source controls. Backup snapshot, failure
cleanup, digest and hash acceptance likewise rejected targeted mutations. The final
manifest schema and preflight-cancellation regressions failed before correction.

Required controls ran **alone**, with source restoration in finally:

| Command/control | Harness exit | Expected child result |
| --- | ---: | --- |
| `node tooling/retained-upgrade-mutations.ts` | 0 | State replay removal: exit 1, 24 tests / 7 pass / 17 fail. Cleanup-after-provider: exit 1, 9 tests / 6 pass / 3 fail. |
| `node tooling/availability-live-mutations.ts` | 0 | Eleven focused controls below, all assertion-red; all sources restored. |
| `node tooling/availability-live-mutations.ts backup_identity_always_equal` | 0 | Exit 1, 26 tests / 23 pass / 3 fail; the timestamp-comparison assertion caught the mutant. |
| `node tooling/availability-live-mutations.ts backup_overwrites` | 0 | Exit 1, 24 reached tests / 21 pass / 3 fail; the original archive was not preserved. |

The full focused-control run preceded the final preflight-cancellation test, so its
DB CLI counts are nine rather than the final ten. Logs:
`.cache/availability-retained-controls-final.log`,
`.cache/availability-live-controls-final.log`,
`.cache/availability-identity-control.log`,
`.cache/availability-backup-exclusive-control.log` and `.cache/availability-controls/`.

| Focused control | Child exit | Pass / fail |
| --- | ---: | --- |
| Operational exit forced to zero | 1 | 40 / 1 (41 CLI tests) |
| Live path guards removed | 1 | 40 / 1 |
| Live report overwrites allowed | 1 | 40 / 1 |
| SIGINT listener removed | 1 | 40 / 1 |
| Locked schema preflight removed | 1 | 6 / 3 (9 DB CLI tests) |
| CLI refuses every live invocation | 1 | 0 / 9 |
| Batch always stops | 1 | 20 / 5 (25 batch tests) |
| Backup state detection removed | 1 | 20 / 4 (24 reached tests) |
| Exported snapshot omitted | 1 | 22 / 4 (26 catalog tests) |
| Partial-file cleanup removed | 1 | 22 / 4 |
| Manifest hash comparison removed | 1 | 22 / 4 |

The one-microsecond SQL timestamp mutation is restored in finally, even if its
comparison assertion fails. Temporary source mutations are restored byte-for-byte.
The final shared checks run against restored sources, not the mutated versions.

## Acceptance review against plan section 5

| Criterion | Evidence/disposition |
| --- | --- |
| 1. Inert offline/imports and input/path refusal | CLI unit tests cover both terms values, duplicate/malformed/oversized JSON, invalid flags and private paths; actual junction/nonregular path test. Path-removal control is red. |
| 2. Terms, single dispatch, 0/2/1 and safe output | Injected CLI tests plus actual DB operator dispatch. Forced-success and refuses-everything controls are red. Unknown sentinels stay out of public diagnostics. |
| 3. Locked schema and target refusal | Real current and sweeps-baseline databases, unknown inventory, real shared guards; preflight-removal control red. Backup rejects runtime login and unknown schema before file creation. |
| 4. Cleanup before providers under lock | Three temporary inventories, expired/current files, real contender refusal, report cleanup counts, malformed cleanup and overlap with zero provider calls. Oversized binary backup and manifest survive live cleanup. |
| 5. Complete/repeat/partial through operator path | Four-service synthetic scan enriches one shared canonical title, persists uncertain offers/links, crosschecks SQL/report/public counts, repeats without a new UUID, and resumes unfinished IDs with committed page counts. |
| 6. Cancellation and finalization | SIGINT event traverses CLI, real preflight or real fake-provider transport, stops new requests, releases lock and ends the owned pool. Failed reports preserve progress or emit fixed report failure. SIGTERM is wired, not claimed as Windows delivery-tested. |
| 7. Backup/restore/digest/guards/bounds | Actual state-3 and state-5 operator backups, phase refusals for states 3/4/5, unknown inventory/login refusal, read-only snapshot, socket/no-password argv, contender exclusion during dump/list, real restore, equal digests, acquisition zeros, actual filename collision/original-byte preservation, microsecond mutation, hash/schema tampering, overflow, disk/stream/auth/archive/timeout/cancel/lock-loss invalidation. |
| 8. Batch decision/caps | 25 offline decision tests exercise all allowed budgets, complete and cap codes, disallowed codes, masked evidence/source failure, missing/null/failed current or previous readback, refresh-only persistence, incomplete advancement, restart/nonadvancement, committed pages and every aggregate ceiling. A real repeated CLI report also stops. |
| 9. Exact teardown/privacy | Test-owned IDs/labels/image/network/volume are inspected before teardown; harness logs verify removal. Restore cluster is tmpfs and separately inspected. Temporary roots/files are removed. Retained resources and `.claude/` were untouched. Framework env-loading exception below is explicit. |

Restore rehearsal uses a second inspected disposable tmpfs cluster, an explicitly
created fresh `bor_backup_restore` database and explicit platform/runtime role
prerequisites. `pg_restore --exit-on-error --no-owner --no-privileges` restores the
custom archive; identity SQL equals the source digest. This proves data/schema
restoration, not a cluster-role/password backup or retained recovery authorization.

## Failures and limitations (preserved)

- Initial CLI red: 2 failures / 37 passes (39 tests); batch red: exit 1,
  21 failures / 4 passes (25). The first CLI wrapper did not preserve the native
  process status, so its shell exit 0 is not described as a successful test run.
- A first non-escalated DB attempt failed before resource creation because Docker
  access was unavailable in the sandbox. Subsequent test-only escalation worked.
- Initial operator DB wiring serialized the decoded rather than wire config,
  leaving no dispatch result; corrected to use the actual wire JSON. Later complete/
  partial tests failed (exit 1, 6 pass / 3 fail of 9) because synthetic Watchmode
  provider mappings were absent. Explicit invented mappings corrected the fixture.
- Initial backup overflow surfaced child termination instead of `backup_size_limit`
  (exit 1, 21 pass / 3 fail of 24); streaming failure precedence was corrected.
- A nested Node test was registered on the outer test while that test awaited its
  child, causing a 240-second timeout: 11 reached, 7 pass, 4 cancelled. Fixed the
  nesting. The test-owned container/network/volume were already removed by its
  finally path; a cleanup helper correctly refused the absent ID (exit 1), and the
  exact remaining synthetic temporary root was removed with containment checks.
- Typecheck caught the overloaded pg connect return type and later narrowing;
  corrected with explicit `PoolClient` typing. These failures did not run tests.
- The first env-isolation attempt refused Vite's automatic dotenv read and stopped
  before tests. A later preloader returned a Buffer for `utf-8`, causing a startup
  failure; corrected without touching credential files. Neither is counted as red
  acceptance. A signal-removal mutant initially survived because an assertion in
  the callback was caught by the CLI; the assertion was moved outside that callback,
  then the same mutant failed. These validation defects are not omitted.
- Initial `npm run check` passed 343 tests/build but Next automatically loaded
  `.env.local`; early Vitest uses Vite's automatic dotenv loading too. This violated
  the requested no-real-credential-read constraint. No values were printed, no real
  provider calls were made, and production credential readers were never invoked
  by acceptance. Subsequent validation suppressed those automatic loaders.
- Concurrent final validation initially produced `npm run check` exit 1: 343 pass /
  2 timeout failures of 345, in existing ESLint boundary tests at unchanged five-
  second limits. Database commands all passed. The final check is rerun alone.
- Late observed-reds: missing previous verified readback (exit 1, 24 pass / 1 fail
  of 25); manifest schema tampering (exit 1, 22 pass / 4 fail of 26); SIGINT
  during schema preflight (exit 1, 9 pass / 1 fail of 10, mislabeled `upgrade_state_unknown`).
  Actual dump collision also failed (exit 1, 21 pass / 3 fail of 24) before a
  test-only UUID seam was added, then an
  overwrite-permitted source mutant broke the original-archive preservation assertion.
  All were corrected and their affected commands rerun.
- SIGINT tests emit the Node SIGINT event through the actual operator path; native
  physical PowerShell Ctrl+C delivery was not manually exercised. SIGTERM delivery
  on Windows, actual retained HBA/access, real quota/provider compatibility, NTFS
  permission enforcement, retained upgrade/batch, hosting and independent external
  re-review/CI remain unverified. Requested POSIX modes are not an NTFS ACL claim.

## Original handoff (2026-10-05)

Local review covered production changes, all new files, the plan's nine acceptance
criteria and future decision table. Correction/re-review passes resolved stream-error
masking, signal-test masking, current/previous readback and committed-page accounting,
manifest schema validation, preflight cancellation and inspection/SHA cancellation.
At the original handoff no code finding was known and independent review had not
occurred. The subsequent user review and its revisions are recorded below.

Final review patch: `.cache/retained-availability-live-review.patch`, containing
tracked modifications plus every intended new file, including the two approved
planning documents and this evidence. `.claude/`, caches, dumps, credentials,
generated output and dependencies are excluded. Final whitespace and reverse-apply checks both exited 0. The original patch contained 19 files; the refreshed patch contains 20
intended files. UTF-8, LF-only/fence validation and local Markdown links passed.
The index was not staged or committed.

This is implementation/synthetic evidence. It supplies no Gate B authorization and
makes no claim about the retained catalog's present state or live benchmark results.


## Review revisions, 2026-10-06

The user supplied an independent review: approve after fixing the action fallback
and providing an executable batch-decision command. Their reruns were reported
as catalog 26/26, evidence 29/29 and batch/sweeps Vitest 66/66, all exit 0, with
exact teardown. Those are attributed reviewer results, not Codex reruns. Gate B
remains unauthorized; the Watchmode probe deadline remains 2026-11-03.

Addressed both required findings:

1. The actual catalog CLI catch uses `catalogLocalDiagnostic(action, error)`.
   Unknown failures use `backup_failed` only for `backup`; setup/upgrade/inspect/
   start/stop retain `catalog_local_failed_inspect_required`. Known allowlisted
   codes retain their exact meanings. Six tests pin this action distinction.
2. `node scripts/availability-batch.ts --manifest <after-upgrade-manifest>
   --report <first-report> --exit <recorded-worker-exit>` is executable and read-only.
   Repeat the report/exit pair in invocation order for every run, at most nine.
   It validates the successful state-5 after-upgrade manifest/acquisition zeros,
   converts canonical string `digest.movies` to a safe integer, and computes all
   running totals. It checks distinct run IDs, timestamps/nonoverlap, unchanged
   generation/terms and approved limits. The first stop/cap remains terminal;
   supplied later reports still count toward the printed totals. Unknown codes,
   malformed fields, wrong phases, unsafe counts and inconsistent histories fail
   closed with a fixed public diagnostic. Recorded worker exits are supplied
   explicitly rather than inferred from a budget code. No credentials, database,
   provider or worker invocation is part of this command.

Also addressed the path-hook and preflight-diagnostic notes. Live config path
validation now runs regardless of injected effects; tests inject a temporary root
with real regular config files. A real junction test confirms injected effects
cannot bypass that check. Known inventory mismatches remain `upgrade_state_unknown`;
unexpected SQL failures use `schema_preflight_failed`; lock loss/cancellation keep
their established diagnostics. The new operational code is a batch stop code.

The second-Ctrl+C force-exit suggestion is not implemented in this revision.
The existing graceful cancellation path is retained. CI without the local dotenv
preloader remains unverified. README now explicitly states that invalid/conflicting
TMDB titles (`metadata_failed`) stop the batch, while ordinary `not_found` alone
is not that failure code. No stop rule, limit, migration or dependency changed.

### Observed red and mutation evidence for the revisions

- Initial action/command regression run: exit 1, 35 tests / 28 pass / 7 fail.
  `.cache/availability-review-fixes-red.log`.
- Always-continue command stub: exit 1, 29 tests / 25 pass / 4 fail, exercising
  negative input/history groups. `.cache/availability-batch-command-negative-red.log`.
- Injected-effect junction bypass: exit 1, 42 tests / 41 pass / 1 fail.
  `.cache/availability-path-hook-red.log`.
- Preflight SQL error misclassification: exit 1, 11 tests / 9 pass / 2 fail
  (the parent and its failing subtest). No skips/cancellations.
  `.cache/availability-preflight-diagnostic-red.log`.
- Focused controls ran alone with exit 0 and byte-for-byte source restoration:
  `node tooling/availability-live-mutations.ts catalog_action_fallback_regression
  batch_command_entry_removed batch_credit_total_reset live_path_guards_removed
  operational_exit_zero`. Every child exited 1 with assertion failures:

| Control | Tests | Pass / fail |
| --- | ---: | --- |
| Wrong action fallback | 6 | 1 / 5 |
| Executable command entry removed | 30 | 29 / 1 |
| Cumulative credits reset each run | 30 | 28 / 2 |
| Operational exit forced to zero | 42 | 41 / 1 |
| Path guards removed | 42 | 40 / 2 |

Log: `.cache/availability-review-fix-controls.log`, with individual logs under
`.cache/availability-controls/`. The actual executable command test uses explicit
synthetic temporary JSON files and checks its stdout totals, not only an injected
reader. All affected green commands below ran after restoring controls.

### Revision validation

| Command | Exit | Counts/evidence |
| --- | ---: | --- |
| `npm run check` | 0 | 357 tests in 15 files; typecheck, zero-warning lint and production build; `.cache/review-fix-check.log` |
| `npm run test:catalog:db` | 0 | 26/26; `.cache/review-fix-test-catalog-db.log` |
| `npm run test:availability:evidence:db` | 0 | 30/30; `.cache/review-fix-test-availability-evidence-db.log` |
| `npm run test:availability:sweeps:db` | 0 | 43/43; `.cache/review-fix-test-availability-sweeps-db.log` |
| Focused Vitest batch/sweeps/diagnostics | 0 | 77/77 before adding the executable test; the final check includes all 78 focused cases |
| Focused executable/batch Vitest | 0 | 30/30; `.cache/availability-batch-executable-green.log` |
| Extra standalone `npm run typecheck` | 0 | No tests; `.cache/review-fix-typecheck.log`; environment exception below |

The final check ran alone, with the existing dotenv-content preloader and builtin
ESM synchronization. One extra standalone typecheck was mistakenly invoked without
that preloader. Next typegen invokes the config loader, which can read `.env.local`;
this is another exception to the requested credential-read constraint. No values
were printed or used for provider calls. The full typecheck was subsequently rerun
as part of the isolated final check. This exception is not described as credential-
free validation.

`test:db` and `test:metadata:db` were not repeated in this revision: their schema/
metadata persistence execution paths were unchanged. Their last results remain
Codex's prior 11 runner tests plus SQL replay/controls and two 22-test metadata
cycles, both exit 0, as recorded above. No remote CI result is claimed.

Revision review checked action routing, real file/CLI dispatch, baseline conversion,
full-history accumulation, irreversible stop decisions, redaction, path checks and
preflight taxonomy against the approved contract. No required review finding remains
open. The revised code has not received another independent re-review yet. Nothing
is staged, committed, pushed or published. Retained container/volume/database and
retained private inventories were not accessed; `.claude/` is preserved. The
framework credential-loading exception above applies to `.env.local`. The refreshed complete review patch contains 20 intended
files; whitespace, reverse-apply and local documentation checks are rerun at handoff.
