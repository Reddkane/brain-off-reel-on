# Classification Phase B: implementation review packet

Date: October 8, 2026. Branch: `feat/classification-phase-b`.
Baseline: `c9f9d26`. Implemented and validated; uncommitted work ready for review.

## Implementation review correction

The review in `.cache/classification-phase-b-impl-review.md` found a real spend
bug: fresh invocations could discard main/pilot charges, while config-hash
matching and full re-projection obstructed continuation. The correction replaces
that behavior with a same-phase report chain; the earlier evidence below is
historical and does not establish the corrected ledger's behavior.

- Report v2 carries the immediately preceding report's cumulative actual and
  unknown spend even when rates, dates, settings, selection or stage change.
  Only the first pilot may be fresh. Main always requires its prior report.
- Each measurement names its movie and input fingerprint. Completed pairs are
  marked after persistence, carried forward and skipped for counting/dispatch/
  projection. Changed candidate settings or metadata are distinct work. Guarded
  DB completions also prevent paying again after a lost commit reply.
- Under the classification session lock, the private phase-head pointer hashes
  the latest report, refuses fresh/stale branches, and stays pending if report
  finalization fails. A DB query separately detects phase-tagged model results
  and matching legacy models when a fresh start has no pointer. No migration.
- This is local report-chain bookkeeping. Keep private state with the workspace;
  pending/missing/corrupt state requires explicit spend reconciliation, not a
  fresh reset. It does not implement Phase C multi-host reservations.
- Removed `thinkingCharacters`; pilot output tokens versus visible characters
  are the headroom signal. Report creation follows storage/phase preflight.
  Exact response-model matching, integer-only rates and mild pilot selection
  are documented operator watch items/limits.

Correction validation: offline classification tests 99/99 (exit 0), focused
strict typecheck and lint exit 0, requested mutation command exit 0 with 32
watched-red/restored controls and final offline/DB green. Two corrected DB runs
each passed 20 tests (exit 0), including missing-pointer fresh-start refusal,
zero-call continuation and DB completion readback, with verified teardown. Final
`npm run check` in the credential-free copy exited 0: strict app/pure types,
lint, 464 tests in 25 files and production build. Telemetry was disabled; the
existing multiple-lockfile warning from the copy remains informational. The
corrected full patch contains 23 files and is verified against the working tree
with `git apply --reverse --check` (exit 0). All DB targets are inspected
disposable resources. No paid pilot/provider or retained execution. Ready for
re-review of the material spend correction; pilot authorization remains separate.

## Approved scope and decisions

The original handoff and `.cache/classification-phase-b-plan-review.md` authorize
implementation and offline/disposable validation only. The amended
[plan](classification-phase-b.md) lists every review change at its top. Native
fetch is selected; no dependencies were installed. The pilot is built, not run
against Anthropic or the retained catalog. Anchors are ordinary active movies;
no calibration-only marker or personal-state write was introduced. User backlog
and existing `.claude/`/private files are preserved.

Implementation adds a native single-request Anthropic adapter, schema/prompt
counter with explicit compatibility fallback, realistic usage decoding, safe
operational outcomes, readable candidate IDs, checked config/cost gates,
pilot/main spend accounting, guarded retained composition, private key reader,
bounded TMDB anchor composition, versioned emotional cap and paired bootstrap.
No migration, ranking, UI, paid run, live provider request or retained access.

## Accounting and operator limits

Costs are integer micro-USD. US$35 is 35,000,000 units. At illustrative unverified
rates with 5,000 input/10,500 total output, three main attempts for 30 titles and
both candidates project US$31.05; a two-attempt two-title/two-candidate pilot
projects US$1.38. Both share the phase cap. Runtime preflight derives reservations
from counted requests and configured checked rates before paid dispatch.
Oversized main titles are excluded from both candidates before any paid call.
The pilot requires its two fitting titles and four successful pairs before main.

Price/terms/rejection-billing checks expire after seven days. The documented
[billing rule](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage)
was checked October 8, 2026: failed requests are not charged; client interruption
of an otherwise successful request can be charged. Only well-formed allowlisted
pre-processing 4xx/429/529 bodies are zero-cost under an explicit fresh check.
500s, malformed errors, disconnects and missing/unsupported usage halt with the
candidate's conservative maximum reserved as unknown spend.

No automatic paid retry occurs in fetch. Only the orchestrator retries known
zero-cost 429/529, bounded by two pilot/three main attempts and retry deadlines.
Fallback counting performs a distinct free compatibility request, not a hidden
paid retry. Main requires recorded pilot overhead before relying on fallback.
Reported output tokens include hidden thinking; visible answer characters are
the separate headroom signal, not a fabricated reasoning-token measure.

Keep the machine awake for separately authorized execution. The theoretical
invocation ceiling is 13 hours; actual duration and sufficiency must be measured
by the separately authorized pilot. Local accounting prevents further dispatch,
not provider billing overshoot or durable restart/concurrency reservations.
An ambiguous/failed report must be operator-adjudicated before another run.

## Acceptance and validation evidence

Validation is being recorded here as commands finish. No checks are skipped to
obtain green. Docker suites run sequentially and use inspected disposable
targets with verified teardown. Credential-free process copies use throwing
global network transports and explicit synthetic provider responses.

| Command | Exit / evidence |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run tests/classification/anthropic.test.ts` | 0: adapter request/realistic usage/error tests. Initial missing-module red was scaffolding only, not behavioral regression evidence. |
| `node node_modules/vitest/vitest.mjs run tests/classification` | 0: 90 tests at the focused run; final control harness offline green covers all 92 current classification tests, including actual credential permissions and main fallback refusal. |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 at focused run. |
| `npm run test:classification:db` | Initial sandbox exit 1 (`docker_version_failed`: named-pipe access denied); authorized Docker execution exit 0, 19 tests, four inspected containers/networks removed. Actual composition pilot/main/export/anchor CLI and lock checks passed. |
| `npm run test:classification:controls` | First harness exit 1: nonunique freshness replacement anchor, restored; corrected runs exit 0: 23, 26, 27 and final 28 watched-red controls, each followed by final offline/DB green. Final run includes first-main-fallback refusal. Logs under `.cache/classification/evidence/`; SHA-256 restoration checked for every mutation. |
| `npm run check` in credential-free `.cache/classification-check-copy` | Final exit 0: type generation, strict app/pure types, lint, 457 tests in 24 files and production build. Earlier runs were also 0 with 454/456 tests. Final run set `NEXT_TELEMETRY_DISABLED=1`. Build warned of two lockfiles and inferred the parent workspace; no env/private files were copied. |
| `npm run test:catalog:db` | 0: 48 tests, inspected disposable catalog/upgrade/backup acceptance and verified owned resource teardown. |
| `npm run test:availability:evidence:db` | 0: 33 tests, fresh/upgrade/evidence/live CLI paths, fake providers and verified teardown. |
| `npm run test:metadata:db` | 0: two fresh cycles, 22 tests each, synthetic responses and verified teardown. |
| `npm run test:availability:sweeps:db` | 0: 43 tests, including real two-client overlap/loss and metadata/availability regressions; verified teardown. |
| `node node_modules/vitest/vitest.mjs run tests/classification/private-key-process.test.ts` | Initial fixture failure: Windows `Set-Acl` broadening required SeSecurityPrivilege; corrected to DACL-only `icacls` on the owned synthetic file. Exit 0 verifies private acceptance and broad-read denial. No real key file read. |
| Original patch assembly and reverse check | 0: original 22-file patch matched the pre-correction tree. Corrected 23-file patch verification is recorded in the correction section. |

Intermediate focused runs also caught 14 legacy CLI process failures after a
decoder was imported from the replaced test effect module (exit 1). Moving the
decoder into the config leaf restored all processes (exit 0). Focused typecheck
iterations caught duplicate/type-only imports, pg readonly argument typing,
test ID brands and the credential test's missing NODE_ENV type; each was fixed
before shared validation. None was suppressed or skipped. There is no
provider-compatibility or real credential claim from these checks.

The real CLI tests exercise `run --live`, `anchors-ingest --live`, both imports
with `--apply`, export and reporting. Their synthetic execution is not a live
pilot and does not verify account permissions, actual provider schema support,
response latency or price/terms values. Existing Phase A same-movie FK, human
privacy, no-op/atomic import, coverage and upgrade tests remain active.

## Review inventory and residual work

Review tracked changes and every new source/test/plan file in the complete
`.cache/classification-phase-b-review.patch`; it excludes user backlog, `.claude/`
and all private cache data. Material findings need correction and affected checks
before handoff. Actual retained execution remains closed pending the user's
separate authorization and fresh operator checks.

Self-review corrections: comparison reports now bootstrap identical common
movie/metadata/anchor fingerprint sets; oversized exclusions include both
candidates' raw/budgeted counts; lock failures use safe dedicated codes; HTTP
date Retry-After is supported; missing export candidate refuses before storage;
settings may increase output allowance after pilot, subject to context and
fresh worst-case/cap preflight. A first-time main compatibility fallback refuses
without a successful pilot fallback measurement; it does not assume the initial
256-token margin established that overhead. There are no schema or migration changes.

Final review inventory: 12 modified tracked files and 11 intended new files.
The patch includes the amended plan, this packet, operator instructions, all
three Phase B server modules, private credential helper and four new test files.
`git diff --check` passed; the mutation lock is absent. The prior user work
remains untracked and outside the patch. Existing CI commands already discover
the added offline tests and execute the expanded classification DB suite.
The original schema runner was not rerun: no migration/inventory/schema code
changed; classification fresh/upgrade and catalog schema acceptance passed.

Unverified by design: real provider/account compatibility, actual pilot latency
and truncation, real credentials/NTFS settings, verified operator price/terms
records and retained execution. These require separate authorization. No
implementation or validation issue remains unresolved in the approved offline scope.
