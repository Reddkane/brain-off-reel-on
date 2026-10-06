# Retained availability plan: revision evidence

This is evidence for the documentation revision requested in
`.cache/retained-availability-plan-handoff.md` and
`.cache/retained-availability-plan-handoff-2.md`, not evidence that the planned
backup command or live dispatch is implemented. Local baseline is `main` at
`446f78f`. PR CI green is reported by the first handoff; handoff 2 reports
post-merge main run `37371601501` green for check, database and metadata-database.
These are attributed reports, not fresh CI queries in this pass.

## Decisions and remaining edits

Preserved the three settled decisions: backup plus identity digest, at most nine
runs at unchanged per-run limits, and one Gate B authorization for the retained
sequence. Preserved the reviewer's lock-position and Windows signal requirements.
Completed the seven requested edits: exact stop-code allowlist, mechanical report
progress, pinned-image authentication proof, explicit cross-state digest SQL,
bounded host streaming/failure handling, dedicated lock/snapshot session, and
README operational usage. Plan tests still require observed-red regressions,
real disposable restore, digest mutation and final green before execution.

## Handoff 2 disposition

1. **Progress bug:** replaced unconditional page progress with catalog additions
   or advancement of an unfinished scan on the same sweep IDs. Complete rescans
   with no additions now stop; section 5 item 8 requires that observed-red case.
   Read `watchmode-store.ts` `batch()`/`resume()` and the worker's checkpoint/report
   fields directly; no database or provider execution in this revision.
2. **Simplification accepted:** removed the already-current source comparison,
   acquisition digest, per-path baseline counts, no-op test and alternate retention
   policy. Explicit backup phases enforce state 3 before upgrade and state 5 after
   it, refusing a wrong phase/state before dump creation. This small planned flag
   makes the first-backup guard enforceable without inferring invocation order.
   Shared state detection still recognizes state 4 for a clear refusal; prior
   three-state probe results below remain historical evidence, not extra scope.
3. **README:** repaired `?`, removed the earlier duplicate introduction and kept
   operational usage. Wrote all revised documents directly as UTF-8 bytes with LF;
   validation checks encoding, line endings and mojibake.
4. **Baseline:** recorded the reported green main CI run `37371601501` in both
   documents; no CI API access or inferred outcome.
5. **Config:** explicitly requires `evidence.enabled: true`, 100 movies, 20 source
   checks and empty flagged IDs; null readback stops the batch.
6. **Strictness retained:** one title-local failed source check vetoes the whole
   batch. The plan now labels that expected behavior and requires reauthorization
   to continue after the stop.
7. **Verified report rules:** preserved field names, stop-code allowlist, failure
   vetoes and active-catalog cap interpretation checked in the re-review.

No new disposable probe, production implementation, retained access, credential
read or provider call was performed for handoff 2. Prior probe commands/results
and failures are preserved below. Plan acceptance tests are specified, not run.

## Earlier disposable probe: commands and outcomes

Executed `python .cache/retained-availability-plan-probe.py`, final exit **0**.
The ignored probe script and full command log are retained for review:

- [probe script](../../.cache/retained-availability-plan-probe.py)
- [final exact-command log](../../.cache/retained-availability-plan-probe.log)
- [digest SQL executed](../../.cache/retained-plan-digest.sql)

Only generated synthetic credentials were used, sent on stdin to a private
container file. No password appeared in argv, environment, logs or host files.
The final container had a unique `bor-plan-backup-*` name/label, `--network none`,
tmpfs data, no volume, published port or host mount. Exact ID/label/image/isolation
was checked before use and teardown. `docker rm --force <that exact ID>` exited 0;
`docker ps --all --filter id=<that exact ID> --format {{.ID}}` exited 0 with no rows.
Every failed container attempt was also removed after the same identity check.
All synthetic dump files were removed by exact file path in `finally`.

Pinned image:
`postgres:17@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`.
No image pull was performed (`--pull=never`). The script records all Docker argv;
SQL is supplied on stdin from unchanged prerequisites/migrations and the digest
query reproduced in the plan. Internal database name was `bor_plan_backup`.

Authentication setup matched the retained setup code's
`POSTGRES_PASSWORD_FILE=/tmp/bor-password` and
`POSTGRES_HOST_AUTH_METHOD=scram-sha-256`. Querying only `type, auth_method` from
`pg_hba_file_rules` exited 0 and showed local socket trust, loopback host trust,
and an appended host scram-sha-256 rule. The socket command was:

```text
docker exec <test-owned-id> pg_dump --no-password \
  --host=/var/run/postgresql --username=postgres --dbname=bor_plan_backup \
  --format=custom
```

It exited **0 in each of states 3/4/5**, with stdout streamed as binary directly
to an exclusive synthetic host file. Sizes were 96,904, 121,958 and 147,233 bytes.
`docker exec -i <test-owned-id> pg_restore --list` with each archive on stdin
exited **0 three times**. These are archive-list checks, not completed restores.

The plan's digest query executed via:

```text
docker exec -i <test-owned-id> psql --no-password \
  --host=/var/run/postgresql --username=postgres --dbname=bor_plan_backup \
  -X -A -t -v ON_ERROR_STOP=1
```

All **three state queries exited 0**. The synthetic movie retained its UUID and
`2026-10-04T12:34:56.123456Z` refresh time, and the single synthetic mapping retained
its source/external ID. Movie/mapping digests and all six personal/history counts
were equal across the upgrade. Both state-5 acquisition checks exited 0 and
returned zero mismatches/unexpected paths. All named columns/tables therefore
exist in those states; the acquisition table is queried only in state 5.

A separate held `psql` coordinator session acquired advisory lock `(1112494674,1)`,
started repeatable-read/read-only, exported a snapshot and executed the digest.
A separate `pg_dump --snapshot=<exported-id>` imported that snapshot and streamed
to the host file, exit **0**. Contender sessions' `pg_try_advisory_lock` returned
false before and after the dump, then true after coordinator commit/unlock/exit.
The digest equalled the earlier synthetic digest. This proves the proposed session
layout is workable; production guards, cancellation and streaming failure handling
remain implementation acceptance work.

## Initial failures (not omitted)

1. The first ordinary sandbox probe exited **1** before creating any resource.
   `docker image inspect <pinned-image> --format "{{.Id}} {{.Os}}/{{.Architecture}}"`
   exited **1**, with this complete Docker stderr:

   ```text
   WARNING: Error loading config file: open C:\Users\Reddk\.docker\config.json: Access is denied.
   permission denied while trying to connect to the docker API at npipe:////./pipe/docker_engine
   ```

   The probe reported `RuntimeError: Unexpected exit: 1`. The same authorized,
   isolated probe was subsequently run with sandbox escalation; automatic review
   permitted it. No retained action was attempted.

2. The first escalated probe exited **1** because socket `pg_isready` saw the
   image's temporary initialization server before the requested database existed.
   The first SQL command exited **2**. Full command/error/teardown evidence is in
   [the startup failure log](../../.cache/retained-availability-plan-probe-startup-failure.log):

   ```text
   psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  database "bor_plan_backup" does not exist
   ```

   The readiness probe was corrected to wait for the final TCP listener. The
   container was verified and removed, exit 0, before retry.

3. The next probe exited **1** on a wrong test assumption: a password-free
   loopback TCP `psql SELECT 1` was expected to exit 2 but actually exited **0**.
   The HBA query explained the loopback trust rule; this was not a socket-dump
   failure. Full command/HBA/teardown evidence is in
   [the assumption failure log](../../.cache/retained-availability-plan-probe-tcp-assumption-failure.log).
   The probe reported `RuntimeError: Unexpected exit: 0`. Removed that incorrect
   expectation, retained explicit local-trust/appended-scram assertions, then
   reran successfully (exit 0). The final snapshot extension also exited 0.

## Scope and limitations

No retained container, volume, private file or database was inspected or changed;
no real credentials were read, provider calls made, production implementation
edited, dependency changed, commit/push/PR/merge performed or CI result inferred.
The disposable probe was explicitly requested by handoff item 3.3.

The proposed 120-second/64-MiB limits, manifest/hash protocol, cleanup exclusions,
post-upgrade acquisition checks, failure/cancellation cases, restore rehearsal
and batch-decision tests are plan acceptance criteria, not implemented behavior.
The image probe does not assert the retained target's current HBA configuration.
The retained sequence now requires a state-3 source and a state-5 post-upgrade
backup before any Watchmode request; other source states require rescoping.
Windows POSIX mode requests do not prove NTFS permissions. `persisted` counts refreshes as well as additions; the plan uses
verified total-count deltas to label net additions. Pages count as resume progress
only when they advance the same unfinished sweep IDs, not completed rescans. The existing worker can return exit 1 on a wall/database budget exception;
only a real exit 2 with an allowed code qualifies for continued batch execution.

Full npm/database suites were not run for this documentation-only revision. The
required suites and mutation controls remain gates for the later implementation.

## Documentation validation and review artifact

- Handoff 2 validation: all three files pass UTF-8 without BOM, LF-only,
  mojibake, Markdown-fence and whitespace checks; exit 0. README has one plan
  introduction and the restored section symbol.
- Local document links: 12 passed; exit 0.
- Documented progress predicate: 6 sanity examples passed, including completed
  rescans with zero additions stopping, refresh-only persistence stopping,
  additions continuing, unfinished advancement continuing and nonadvancement
  stopping. These are documentation checks, not observed-red implementation tests.
- Proposed evidence-enabled config: 2 terms-acceptance variants passed the real pure decoder,
  exit 0; no composition/effects invoked.
- Error-code/report-field references and dump/manifest cleanup-regex checks:
  exit 0 (with a matching run-report positive control).
- `git diff --check`: exit 0.
- Complete tracked/new-file patch: `.cache/retained-availability-plan.patch`;
  `git apply --reverse --check .cache/retained-availability-plan.patch`: exit 0.

The patch contains README, the revised plan and these evidence notes. Ignored
probe artifacts and the handoff are review inputs, not proposed tracked files.
