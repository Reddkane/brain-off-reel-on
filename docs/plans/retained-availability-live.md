# Retained availability gate and local benchmark

Status: draft for scope/implementation approval. Preparing this plan authorizes
no implementation, retained database access, private-file cleanup, provider call,
commit, push, PR, merge, infrastructure, paid action or deployment.

Planning baseline: `main` at `446f78f`, the retained upgrade and live-composition
private-file cleanup (#9), squash-merged with PR CI green (check, database,
metadata-database), as reported in the handoff. The post-merge CI rerun on `main`
(run `37371601501`) is also green for all three jobs, as reported in handoff 2.
Implementation starts from that baseline on a new branch,
proposed `feat/availability-live-gate`.
Preserve `.claude/` and any other work found at that time.

The [architecture](../architecture.md), [engineering standards](../engineering.md),
[sweeps plan](availability-sweeps.md), [evidence plan](availability-evidence.md#9-before-the-retained-live-gate)
and [upgrade evidence](retained-upgrade-implementation.md) own the underlying
product rules and worker behavior. This plan owns the next CLI change and the
separately authorized local execution gates. [Hosting](hosting.md) remains later.

## 1. Outcome and scope

Make the existing, tested live composition callable through explicit CLI `--live`,
then, under one separate authorization, back up and upgrade the retained catalog
and run a bounded batch of live runs that fills the enriched catalog toward its
1,000-title cap. Produce evidence of real membership completeness, sampled offers/
links, pre-classification readiness, runtime, spend and honest partial outcomes.

Implementation scope:

- Wire `scripts/availability-sweeps.ts` to `liveSweepComposition`; preserve offline
  validation as the default and import-time inertness.
- Validate the current retained schema before cleanup or provider requests, reusing
  the existing full-schema checks. A recognized older catalog reports
  `upgrade_required`; the sweep command never performs an implicit upgrade.
- Connect SIGINT/SIGTERM cancellation, allowlisted operational diagnostics, counts
  on stdout and the existing exclusive private report protocol. Return the worker's
  exit status faithfully rather than treating a partial report as success.
- Add a `catalog:local backup` action (section 3): a guarded `pg_dump` restore point
  plus a cross-state identity digest, used before the state-3 retained upgrade
  and after it reaches state 5. A different initial state requires rescoping.
- Exercise the actual CLI-to-composition path with synthetic providers, temporary
  private roots and inspected disposable targets. Update README operational usage.

Keep existing worker selection, arrival rules, uncertainty policy, retention,
provider hosts, shared budgets and advisory-lock protocol. No dependency change
or new migration is expected. Hosting, scheduling, protected HTTP handlers,
classification, ranking, Auth, personal setup, UI and playback testing are outside
this change. Changing those rules requires a separately scoped proposal.

## 2. Changes and ownership

| Area | Planned change |
| --- | --- |
| `scripts/availability-sweeps.ts` | Explicit live dispatch; lazy/inert default effect composition; cancellation; separate argument/config and operational errors; bounded public summary. |
| `scripts/availability-live.ts` | Current-schema preflight before private cleanup/provider work; reuse fixed credential paths, guarded retained pool, real provider factories, repository-root expiry and pool shutdown. Run preflight inside `runSweeps` after it acquires the refresh lock, as a step immediately before `expirePrivateFiles`, so it cannot race a schema upgrade; no separate pre-lock check. |
| `scripts/catalog-local.ts` and a small helper only if needed | New `backup` action: retained-target inspection, refresh lock, container-local `pg_dump` to an exclusive private file, identity digest and post-upgrade acquisition check. Reuse shared guards and schema-state detection without a second migration list or arbitrary database target. |
| `src/server/db` / `src/server/ingestion` | Only the small reusable preflight/report support needed by composition; no redesign of persistence or orchestration. |
| `tests/metadata/availability-sweeps.test.ts` | Offline CLI, terms refusal, live dispatch, exit-code propagation, redaction and cancellation coverage through injected effects. |
| `tests/db/catalog.test.ts` | State-3 pre-upgrade and state-5 post-upgrade backup, refusal of any other initial state, digest equality across upgrade, acquisition check, exclusive file outside the cleanup inventory, target refusal and no row writes. |
| `tests/db/availability-live.test.ts` | Drive the CLI entry function through the real composition and fake transport; successful/partial/failure paths, schema refusal, cleanup ordering, overlap and pool closure. |
| README and implementation evidence | Operator commands, explicit execution scopes and measured evidence. Existing shared test commands/CI remain aligned. |

Do not create a generic operator platform, authorization token file, new credential
profile or configurable database URL. Terms acceptance records the provider-terms
decision; explicit `--live` selects effects. Neither substitutes for the agent's
separate retained execution authorization.

## 3. Retained backup and identity comparison

The recorded retained baseline holds about 100 TMDB titles and no personal data.
Verify those counts under Gate B; they are not assertions about its present state.
The upgrade's safety net is a restore point plus an identity digest comparison.
The retained sequence starts only from the recognized three-migration state.
The proposed backup action requires an explicit `--phase before-upgrade` or
`--phase after-upgrade`: the former requires state 3, the latter state 5. Detect
state under the acquired lock and refuse a phase mismatch before opening a dump
file. If the first backup finds anything other than state 3, stop before upgrade
and request a revised scope. State 4 remains recognized by shared detection but
is outside this sequence; no already-current source branch is implemented.
It reuses the existing retained container inspection and target guards and holds
the refresh advisory lock for its whole duration.

### Authentication, transfer and lock ownership

Use the fixed setup credential and guarded `postgres` pool already used by upgrade
for the coordinator session; never select a target from a connection URL or process
environment. Reuse container/image/volume/network/loopback inspection,
`migrationTargetGuard` and `catalogSchemaState`, then enforce the phase's expected
state. Keep existing unknown-state/target refusals.

The pinned image was checked on a test-owned, network-isolated, tmpfs container
with the same `POSTGRES_PASSWORD_FILE` initialization and
`POSTGRES_HOST_AUTH_METHOD=scram-sha-256`. Its local socket rules are `trust`;
the appended host rule is `scram-sha-256`. Password-free `pg_dump --no-password`
over `/var/run/postgresql` succeeded in all three states. This proves the pinned
image's initialization behavior, not the retained container's current HBA rules.
If its socket refuses authentication, fail with a fixed code before provider work.
Do not change HBA or silently fall back to passwords in argv/environment/logs;
propose a separately reviewed file-descriptor/credential-file approach instead.

The coordinator checks out one dedicated client, verifies the target, acquires
session advisory lock `(1112494674, 1)`, then starts
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`. Recheck guards/state in that
transaction, set UTC and a bounded statement timeout, and export its snapshot with
`SELECT pg_export_snapshot()`. Execute the digest query and, for state 5, acquisition
query on that same client/snapshot. Keep the transaction and client alive until the
dump and verification finish. `pg_dump` uses a separate container-local socket
session and imports that exported snapshot; it does not acquire the advisory lock.
This keeps dump and digest consistent while imports, upgrades and sweeps are excluded.
The disposable snapshot/lock probe passed; [planning evidence](retained-availability-plan-evidence.md)
records commands, outcomes, initial failures and limits.

Spawn without a shell or TTY, selecting the inspected exact container ID:

```text
docker exec <inspected-container-id> pg_dump --no-password \
  --host=/var/run/postgresql --username=postgres --dbname=bor_catalog_local \
  --format=custom --snapshot=<exported-snapshot-id>
```

Pipe stdout as binary bytes directly into an exclusive host file (`wx`, `0600`),
with stream backpressure and a byte counter. Do not buffer the dump in memory,
write it inside the container, use PowerShell text redirection, or copy it out later.
Use `.cache/real-catalog/private/catalog-backup-<uuid>.dump`. Resolve and verify the
private parent stays inside the repository and refuses symlink/reparse traversal.
On Windows, requested POSIX modes do not prove NTFS access control; use the existing
private directory's restricted access and record that platform limitation.

Bound the entire backup to 120,000 ms and the dump to 64 MiB, including coordinator
work, transfer and verification. Use a 5,000 ms SQL/lock-health timeout, cancellation
and connection-loss monitoring throughout. Timeout, cancellation, size overflow,
stream/disk failure, authentication refusal or lock loss kills the dump, closes the
stream and invalidates the restore point. Recheck lock health after child exit.
Wait for the child and host stream, validate a nonempty custom archive with the
container's `pg_restore --list` fed through stdin, and hash the host bytes (SHA-256)
within the same time bound. Archive listing is not a restore rehearsal; section 5
requires an actual disposable restore.

Only then write an exclusive `catalog-backup-<uuid>.manifest.json` with success,
dump byte count/hash, UTC/SHA/schema state, digest, acquisition result and retention
deadline. Console output is a fixed code, private file reference and digest/counts.
A file without a successful manifest is never a valid restore point. On failure,
remove only this invocation's partial dump/manifest using checked exact host paths;
if removal fails, leave it marked invalid and report cleanup failure. Never reuse a
partial file or overwrite an existing backup. Release the coordinator transaction,
lock and client in `finally`, after child/stream settlement. Connection loss aborts
the operation even if the subprocess happens to finish.

**Both dump and manifest names must stay outside the private-file cleanup inventory**:
`expirePrivateEvidence` JSON-parses matching files and refuses files over 2 MB.
Tests assert neither matches `^(?:provider-list|run-report)-[a-f0-9-]{36}\.json$`,
and a live cleanup test leaves both untouched. Do not widen the inventory regex.

### Identity digest query

The fixed query will live in `scripts/catalog-backup.ts`, a small effect helper
called by `catalog-local.ts`; it is not an additional command or database profile.
Execute this query in the coordinator's exported read-only snapshot:

```sql
SELECT
  (SELECT count(*) FROM app.movies) AS movies,
  (SELECT count(*) FROM app.movie_external_ids) AS external_ids,
  (SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id::text,
    to_char(metadata_refreshed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    ORDER BY id)::text, '[]')) FROM app.movies) AS movies_md5,
  (SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(movie_id::text, source, external_id)
    ORDER BY movie_id, source COLLATE "C", external_id COLLATE "C")::text, '[]'))
    FROM app.movie_external_ids) AS external_ids_md5,
  (SELECT min(metadata_refreshed_at) FROM app.movies) AS oldest_metadata_refreshed_at,
  (SELECT count(*) FROM app.profiles) AS profiles,
  (SELECT count(*) FROM app.profile_subscriptions) AS profile_subscriptions,
  (SELECT count(*) FROM app.profile_movies) AS profile_movies,
  (SELECT count(*) FROM app.selection_sessions) AS selection_sessions,
  (SELECT count(*) FROM app.recommendations) AS recommendations,
  (SELECT count(*) FROM app.feedback_events) AS feedback_events;
```

These movie/mapping columns are created in migration 1; all six personal/history
tables are created in migration 2. Migrations 4/5 preserve them. The query ran
successfully with equal digests against synthetic states 3, 4 and 5. JSON arrays
avoid separator ambiguity; UTC microseconds and explicit key ordering avoid
session timezone/order differences. The md5 values are change detectors, not
cryptographic authenticity proofs. Normalize `oldest_metadata_refreshed_at` to UTC
microseconds on output, retaining PostgreSQL timestamp precision. Compare every
returned count/digest/timestamp
exactly; schema state is recorded separately and must change as expected.

The state-5 acquisition check executes separately, only when detection confirms
that table exists:

```sql
SELECT count(*) AS acquisition_mismatches
FROM app.movie_external_ids e
JOIN app.movies m ON m.id = e.movie_id
WHERE (SELECT count(*) FROM app.movie_external_id_acquisitions a
       WHERE a.movie_id = e.movie_id AND a.source = e.source
         AND a.acquisition_path = 'tmdb_metadata'
         AND a.acquired_at = m.metadata_refreshed_at) <> 1;

SELECT count(*) AS unexpected_acquisitions
FROM app.movie_external_id_acquisitions a
JOIN app.movies m ON m.id = a.movie_id
WHERE a.acquisition_path <> 'tmdb_metadata'
   OR a.acquired_at <> m.metadata_refreshed_at;
```

Migration 5 creates `(movie_id, source, acquisition_path, acquired_at)` and backfills
from the original mapping/movie timestamps. Both results must be zero immediately
after upgrading the legacy catalog; checks passed in the disposable probe. Compare
identity digests first, so the post-upgrade timestamps are also proved equal to the
pre-upgrade values. State 5 is supported for the second backup only, after the
state-3 upgrade has passed. No acquisition-tuple digest, per-path baseline counts
or current-state source/no-op comparison branch is needed.

Backup never upgrades, resets, repairs or writes rows. Restoring is not automated:
a `pg_restore` into the retained database needs its own explicit authorization.
Record actual digest counts; the documented 100-title catalog is historical
evidence, not a current assertion.

Retention: a dump carries TMDB data whose age is its oldest `metadata_refreshed_at`,
and it sits outside automatic expiry. Delete the batch's dumps once its results
are accepted, and no later than six calendar months after that oldest timestamp
(about 2027-04-04 for the 2026-10-04 import). Record that deadline in the operator
evidence, and remove its provider-bearing manifest on the same schedule. Both
backups precede the first Watchmode request; a different initial state requires
rescoping rather than introducing another dump-retention policy.
If a source-age deadline has already passed, stop and review preservation/expiry
before creating a new copy. No dump is made after the live batch under this scope.

## 4. Proposed batch configuration and limits

A batch of up to nine sequential retained runs at identical configuration is
proposed (section 6, Gate B). No preliminary live probe is needed: each run's
locked quota preflight is its first provider request,
after schema validation and private-file expiry. Prepare the public template with
`terms.accepted=false`; record the actual accepted decision/date only in the private
operator configuration after review. The batch config must set
`evidence.enabled: true`, `evidence.movies: 100`, `evidence.sourceChecks: 20` and
`evidence.flaggedWatchmodeIds: []`. Catalog progress and cap checks require that
readback; `evidenceReadback === null` stops the batch for missing evidence fields.
Keep `generation=us-direct-v1`, US movie
subscription listings and sources 203/387/372/157 with the accepted uncertainty policy.

Use these existing, decoder-valid per-run limits for every run in the batch; they
are ceilings, not expected spend or completion promises:

| Limit | Proposed value |
| --- | ---: |
| Wall time / reserved finalization | 600,000 ms / 30,000 ms |
| Watchmode attempted credits, including retries/uncertain failures | 100 |
| Membership pages, combined across four services | 60 |
| TMDB detail operations / total TMDB attempts | 100 / 300 |
| Cumulative database budget | 120,000 ms |
| Active metadata catalog cap | 1,000 |
| Evidence candidate limit / background source checks | 100 / 20 |
| Explicit refresh IDs / flagged Watchmode IDs | Empty initially |

Expected first-run outcome, from the free-key verification (about 30 pages for a
full scan: Netflix 15, HBO Max 6, Disney+ 4, Hulu 5): membership completes well
inside the page and credit caps, and the run most likely exits 2 on the 100-detail
budget against several thousand member titles. With the legacy 100 titles (Netflix-
skewed) already counted, nine 100-detail runs reach the 1,000-title cap.

Every run re-scans membership (about 30 credits), so roughly 270 of the batch's
credits buy repeated scans rather than new titles; that is accepted and yields
early drift evidence. Titles enriched within one batch all become due for TMDB
refresh together about five months later; record the batch date for hosting,
which owns refresh spreading.

Membership pages and source-check retries share the 100-credit ceiling; evidence
has no extra allowance. `/status` is uncharged by the current provider accounting
but consumes the request lane and wall time. The locked quota preflight requires
remaining account quota at least equal to the whole configured cap. Do not silently
lower a cap on quota refusal or extrapolate historic page totals as current truth.

Private configuration must remain inside `.cache/availability/private/`; secrets
remain in the existing fixed files, never configuration values, arguments or process
environment. Validate explicit config paths and bounded JSON before enabling effects.
Offline validation reads only its explicit config, never credentials or databases.

Batch ceilings: nine runs, 900 attempted Watchmode credits (about 36% of the
2,500-credit free month), 900 TMDB detail operations and 2,700 TMDB attempts.
Runs are invoked one at a time, attached, never overlapping; each report is
recorded before the next run starts. There is no loop script, scheduled job,
implicit paid tier or budget enlargement. Any run beyond the batch, or any run
after a stop condition in section 6, needs its own explicit approval.

## 5. Acceptance before any retained execution

Watch new regressions fail before implementation, then restore every temporary
mutation and obtain final green. Tests/CI use invented credentials and responses;
no default production credential reader, retained target or live provider is used.

1. Offline CLI remains inert for accepted and unaccepted terms. Invalid flags,
   duplicate/oversized/malformed config and unsafe live config paths fail before
   credentials, pool creation or provider work. Imports start nothing.
2. Without terms acceptance, `--live` refuses before effects. With accepted synthetic
   config, it invokes the real composition exactly once, preserves exit 0/2/1,
   and prints only allowlisted codes/counts. Unknown thrown messages containing
   secret sentinels never reach stdout/stderr.
3. A known older schema reports `upgrade_required`, and an unknown/wrong
   marker/database/login refuses before cleanup and provider requests. Current
   schema passes preflight. Use a real disposable PostgreSQL target for this proof.
4. Through CLI dispatch, prove cleanup completes inside the acquired lock before
   the first fake provider request, with expired/current files in every inventory
   directory and inspected/deleted/bounded counts in the exclusive report. Cleanup
   failure and advisory overlap each produce zero provider calls.
5. Run a small complete synthetic four-service scan with TMDB enrichment and source
   evidence through the actual CLI composition. Crosscheck SQL, uncertainty/link
   reports and public counts. Repeat without duplicate canonical IDs; a bounded
   partial run remains resumable and does not invent complete absence evidence.
6. Signal cancellation reaches the worker/provider transport, stops new requests,
   releases the lock and closes the composition-owned pool. Reports preserve
   committed progress or clearly record finalization/report failure. The operator
   runs from PowerShell, where Ctrl+C delivers SIGINT and SIGTERM is not reliably
   delivered: prove SIGINT end to end; wire SIGTERM to the same path but do not
   claim it as tested on Windows.
7. Back up state 3 with `--phase before-upgrade` and state 5 with
   `--phase after-upgrade` on disposable targets; refuse state 4/5 as an initial
   source before creating a dump, upgrading or requesting providers. Prove
   the dump restores into a fresh disposable database, digests are equal across
   upgrade, the acquisition check passes, no rows are written, the dump file is
   exclusive and outside the cleanup inventory, and foreign targets/unknown states
   are refused. Mutate one movie's `metadata_refreshed_at` between digests and
   watch the comparison go red. Prove bounded binary streaming, password-free
   socket dump, shared exported snapshot, contender refusal throughout dump/digest,
   lock-loss cancellation, partial-file invalidation, manifest/hash verification
   and both filenames excluded from live cleanup. Restore prerequisites/roles on
   the new disposable target explicitly; a dump is not a cluster-role backup.
8. Exercise the batch decision table with real report shapes: all three allowed
   partial codes, cap completion, each disallowed code, masked evidence failure,
   missing/failing/null evidence readback, refresh-only persistence, advancement
   of an unfinished scan, no progress and run/aggregate ceilings. Watch a test fail
   before implementation where all four sweeps are complete, `netNewTitles === 0`
   and `pages > 0`: it must stop, even on an allowed code. Also distinguish a
   restarted full scan from continuation of the same unfinished sweep IDs and
   reject a nonadvancing unfinished sweep. These tests do not perform live runs.
9. Exact teardown covers every test-owned container/network/volume and temporary
   root. Backup files/config examples contain no real identity, personal or
   credential material. Preserve retained resources and `.claude/` throughout
   validation.

Run existing state-replay and cleanup-order controls using
`node tooling/retained-upgrade-mutations.ts` alone. Add a focused CLI control that
forces operational exit 0; refusal/partial tests must go red. Restore controls and
rerun affected commands. If owning metadata persistence changes, also run its
existing `test:metadata:controls` command.

Implementation validation uses `npm run check`, `test:db`, `test:metadata:db`,
`test:catalog:db`, `test:availability:sweeps:db` and
`test:availability:evidence:db` through their shared npm commands. Update the
existing CI command wiring only if new acceptance is not covered there. Report
exit statuses and test counts, review tracked plus new files, resolve findings
and obtain focused re-review. Produce an implementation evidence document and a
complete review patch; no commit, push, PR or merge without authorization.

## 6. Operator runbook (proposed commands, not yet executable as a complete flow)

### Gate A: implementation and release readiness

Confirm the reviewed upgrade baseline is merged, the CLI/backup implementation is
reviewed, required CI/local checks pass and the exact execution SHA is recorded.
Confirm the production CLI still defaults offline. Privately prepare and validate
one evidence config, with actual terms source/date/decision and the bounds above.
Review applicable Watchmode/TMDB noncommercial use, attribution and retention
conditions at execution time; record sources, dates and decisions. Record TMDB's
decision in operator evidence rather than adding unsupported fields to sweep JSON.
Resolve credential/config/cleanup paths consistently from the repository root.
Record credential presence only; do not display files or secret values. Preparing
this plan does not involve those private checks.

### Gate B: one authorization for backup, upgrade and the live batch

A single authorization covers the whole retained sequence. The request must show
`bor-catalog-local`, its named volume and loopback port, the exact execution SHA,
known source/target schema states, the private config reference, region/generation/
four sources, per-run limits and the batch ceilings from section 4. It covers the
backup files, the guarded additive upgrade, the worker's bounded provider requests,
database evidence/checkpoint and metadata writes, source-age retention/retirement,
exclusive report creation and expiry of matching files in the three fixed private
inventories. It permits no reset, volume deletion, target recreation, restore,
first-party/history rewrite or hard deletion of the movie graph.

Sequence:

```powershell
npm run catalog:local -- backup --phase before-upgrade
npm run catalog:local -- upgrade
npm run catalog:local -- inspect
npm run catalog:local -- backup --phase after-upgrade
# then, up to nine times, one at a time:
npm run availability:sweeps -- --config .cache/availability/private/config.json --live
```

**Hard stop before any provider request** if the first backup fails, the upgrade
fails, the digests differ, or the acquisition check fails. The first backup must
confirm state 3; any other initial state stops this sequence and needs a revised
scope. The second backup must confirm state 5. The recognized legacy state needs
upgrading, not failed-fresh-setup disposal. On migration failure, inspect the remaining complete state and
fixed code; never reset or dispose. A retry or restore needs new authorization.
Also stop if either backup, inspect, manifest/archive validation or identity
comparison fails. If verified personal/history counts differ from the recorded
zero-personal baseline, stop and obtain a revised scope before live execution.

### Mechanical batch continue/stop rule

Read the exact stop code from the top-level `code` in
`evidence-report-<runId>.json` (the worker summary), and crosscheck the CLI's planned
fixed summary line: `exit=<0|1|2> code=<sweepCode> run=<uuid> pages=<n> persisted=<n>`.
Use `outcome`, `readback` and counters from that same run, never a prior report.
A missing/malformed report, `readback` other than `verified`, mismatched exit/code,
unknown code or lost finalization stops the batch. Preserve the worker's exit code;
these rules do not convert a failure to partial or success.

Apply these rules in order:

1. `catalog_limit` means the cap was reached: stop the batch successfully after
   verifying `evidenceReadback.active === 1000`. The run can still exit 2; record
   that partial outcome and any outstanding evidence work. A different active
   count is a finding and stops the batch without claiming the cap. Also end the
   batch when a verified allowed-code report already shows `active === 1000`,
   even if its code remains `detail_budget` because the last detail filled the
   final slot; do not spend another run merely to elicit `catalog_limit`.
2. Continue on exit 0 with `code === "complete"`, or exit 2 with `code` exactly one
   of `detail_budget`, `wall_budget`, `database_budget`, and only with the progress
   check below. Check additional failure vetoes before accepting cap completion
   or continuation. These are values from `src/server/providers/sweep-error.ts`.
   A `wall_budget` or `database_budget` run that actually exits 1 still stops.
3. Every other code stops the batch: in particular `credit_budget`, `page_budget`,
   `combined_page_limit`, `quota_insufficient`, all `provider_*` codes,
   `capacity_blocked`, `sweep_failed`, cancellation, lock/schema errors and
   evidence/report errors. The first four are unexpected at the proposed limits
   and must be recorded as findings. Where `evidence.code` or source failures
   exposes an additional stop condition (`evidence.sourceFailures > 0` or an
   `evidence.code` outside `complete` and the same three allowed budget codes),
   that condition also vetoes continuation;
   an earlier `detail_budget` must not mask a later provider/evidence failure.
   A single title-local failed `/sources` check (including `provider_http` or
   `body_invalid`) therefore stops this first batch; that strict veto is expected
   behavior, and continuing after it needs new authorization.
4. Stop after nine invocations or any batch ceiling is reached. Authorization
   does not permit another run after a stop, even with unchanged configuration.

Define progress from existing summary fields:

- **Catalog progress:** `persisted > 0 && netNewTitles > 0`. `persisted` includes
  refreshes/reactivations, so compute net new canonical titles as
  `evidenceReadback.active + evidenceReadback.retired` minus the previous verified
  run's same total (use post-upgrade backup `movies` for the first run). Never infer
  additions from `selected`, `details` or per-service totals, which can duplicate
  titles across subscriptions. Missing/null readback stops the batch.
- **Resume progress:** `pages > 0` and at least one `checkpoint.sweeps[]` entry
  has `complete === false` and an advanced `nextPage` for that same unfinished
  sweep ID. Crosscheck `id`, `source`, `nextPage`, `complete` against `services[]`
  (`id`, `pages`, `outcome`); `nextPage === services.pages + 1`, and an unfinished
  entry must have `services.outcome === null` (no terminal event). Compare to the
  previous verified report's
  `nextPage` for the same ID/source. For a newly created sweep ID, the starting
  `nextPage` is 1, so an initial unfinished scan must reach `nextPage > 1`. Resumed
  sweeps must retain their IDs and advance from the previous verified checkpoint;
  never compare a new ID to a completed sweep's old page count. A new scan can
  qualify only while unfinished and advancing, not merely because it scanned
  pages. Top-level `pages` is per run, whereas sweep `nextPage`/service `pages`
  are cumulative.

Mechanically: continue-eligible progress is `catalogProgress || resumeProgress`.
If all four sweeps are complete and `netNewTitles === 0`, stop even when `pages > 0`
and record the finding that candidate queues produced no new titles. `store.batch`
in `src/server/db/watchmode-store.ts` reuses only sweeps without a terminal event;
once all services complete, the next invocation creates a new batch and starts
at page 1. Repeating a complete scan is therefore not resume progress.

If neither progress condition holds, stop. Missing fields, inconsistent
checkpoints, nonadvancing unfinished IDs or negative/unexplained catalog deltas
stop for investigation. Record all operands and the decision before the next run.

Keep each process attached and record exit code, run/report UUID, start/end UTC
and public counts. Do not fetch destinations, playback pages, account entitlement
or extra raw provider probes. Missing credentials or quota/connectivity failures
are reported failures, never a reason to skip acceptance or purchase a plan.

### Gate C: interpret results and decide on recovery

| Result | Operator disposition |
| --- | --- |
| Exit 0 | Check persisted readback, all four service states and evidence/coverage/spend fields before recording complete local acceptance. |
| Exit 2 | Record the exact bound/provider code, complete services and incomplete checkpoints. Membership completeness and overall enrichment/evidence completion are separate findings. Continue the batch only under the Gate B continue rule; never treat exit 2 as success. |
| Exit 1 | Stop on the fixed operational/schema/lock/report error. Preserve committed data and diagnostic references; investigate without reset or disposal. |
| Resumable open sweep | The next batch run (or a separately approved run after the batch) uses the same generation and original checkpoints inside their six-hour window. Measure from original sweep start, not retry time. |
| Terminal/expired sweep | Preserve failure/expiry history. A newly authorized scan is new work; do not relabel it as resume or renew original observation ages. |

An enrichment-only partial run can have four complete service sweeps and no open
membership batch to resume. Report that distinction. A further run is allowed
only with catalog progress and no other stop condition;
it starts new membership work; no evidence-only or enrichment-only CLI mode is added here.
The batch is not promised to reach the 1,000-title cap within its ceilings.

## 7. Benchmark evidence and exit criteria

The private report and a sanitized implementation handoff must account for:

- Per-service pages, observed totals, membership/exclusion/unresolved/conflicting
  IDs, complete/partial state and original observation/completion times.
- Metadata selected/persisted/failed by service, active/retired counts and missing
  runtime/language/certification. Crosscheck canonical UUIDs and mappings.
- Evidence candidates/derivations/source checks/failures; offers, valid/missing links,
  uncertainty and per-service initial/gap/drift/partial/arrival reasons.
- The existing pre-classification cached subscription/link readiness count, together
  with the active catalog denominator and the 20-check sampling limit. It is not a
  preference-filtered eligibility count or proof of entitlement. Initial service
  history can legitimately have unknown arrivals; do not force positive intervals.
- Private inspected/deleted/bounded counts and database cleanup outcomes; exact
  report/SQL readback agreement and preservation of first-party/history state.
- Wall/database timing, attempts/attempted credits, quota before/after and observed
  account delta. Missing/reset final status is spend unknown with its reason;
  account-wide changes can include other consumers. Label that attribution limit.

No arbitrary minimum watchable-count threshold is introduced. Use the measured
coverage and gaps to scope classification and future evidence refreshes. A complete
local membership benchmark requires four intact promoted service sets within the
batch; incomplete services remain an unresolved measured result. Overall
run completion and evidence readiness must be reported separately and honestly.

The ten-minute local worker ceiling does not prove suitability for the architecture's
hosted scheduler/runtime. Hand measurements and unresolved gaps to hosting, which
owns its connection mode, runtime margin, protected handler, scheduling and timely
partial recovery. This plan enables no daily schedule or deployed pick flow.

Provider-bearing private artifacts retain their existing source-age expiry rules.
The prior verification-file deadline remains November 3, 2026; this plan does not
extend it or authorize touching those files now. Sanitize public evidence to
counts/codes and avoid indefinite archives of raw responses or provider data.

## 8. Delivery sequence

1. Review/approve this scope and implementation contract.
2. Implement CLI/backup/preflight changes with observed-red tests on an isolated branch.
3. Run shared checks and controls, restore mutations, review/re-review and deliver
   the implementation evidence plus complete patch.
4. After separately authorized publication/merge, prepare the exact retained scope.
5. Obtain Gate B authorization; back up, upgrade and verify; then run the batch
   under its continue/stop rules and report results.
6. Record gaps and hand the evidence to hosting/classification planning. Delete
   the backup dumps once results are accepted (section 3 deadline).

## 9. Decisions (user, 2026-10-05)

1. **Backup instead of an audit command.** A `pg_dump` restore point plus identity
   digest is the selected preservation mechanism (section 3).
2. **Fill path: one batch authorization of up to nine runs** at the unchanged
   per-run limits, rather than raising the 100-detail maximum or accepting a small
   catalog (sections 4 and 6).
3. **One authorization** covers backup, upgrade and the live batch, with a hard stop
   before any provider request if the backup, upgrade, identity comparison or acquisition check fails.
