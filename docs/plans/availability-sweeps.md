# Availability: sweeps

Date: October 4, 2026.
Status: approved plan and focused implementation review corrections implemented
and validated locally. Re-review of the corrected change set remains pending.
Baseline: `main` at `093f0c2`. Local catalog #4, catalog fixes #5 and CI image-pull/
Docker-timeout handling #6 are merged. Local runtime evidence is recorded below.

Specifications: [architecture](../architecture.md), [engineering](../engineering.md),
[metadata plan](pr-03-metadata.md), [local catalog](real-catalog.md),
[Watchmode verification](watchmode-verification.md), and the dependent
[Availability: evidence](availability-evidence.md) plan. Historical filenames stay
unchanged; work-area names are independent of GitHub pull-request numbers.

## 1. Scope and confirmed decisions

Implement the Watchmode provider, round-robin membership sweeps and checkpoints,
balanced popularity-ordered TMDB enrichment, one advisory lock and bounded requests.
Availability offers, arrival derivation, links and the retention migration belong
to Availability: evidence. Hosting owns the protected cron handler, scheduler wiring
and cron-denial tests; neither availability stage adds an HTTP handler or deployment.

Use Watchmode's free plan, US movie subscription listings and verified direct sources:
Netflix 203, HBO Max 387, Disney+ 372, Hulu 157. The user's subscriptions are Netflix
without ads, direct HBO Max Standard and a Disney+/Hulu bundle with ads, without
Live TV. The accepted Disney+/Hulu uncertainty policy stays explicit in configuration;
this stage does not turn candidates into confirmed offers or eligible picks.

Target daily full membership sweeps; the existing 48-hour availability limit stays.
Keep an initially 1,000-record enriched metadata catalog, separately from the larger
membership index. No paid change endpoint or automatic TMDB-discovery fallback.
Existing metadata discovery/selection behavior remains unchanged; new composition
supplies balanced candidates to the existing TMDB detail provider and pg store.
No classification, recommendation, personal setup, UI or new production-origin rules.

All work stays local. No commit, push, GitHub pull request, provisioning, spending,
deployment, retained migration application or full live import is authorized by
this implementation approval. The one-credit sort verification was separately
authorized. Preserve the retained catalog and unrelated `.claude/` work.

## 2. Provider and private configuration

Call the fixed Watchmode HTTPS host using the key from the fixed ignored credential
file in a private request header. Reuse bounded file parsing and the terms-gate
pattern; default CLI validation reads no credentials, sends no provider requests
and writes no database/private state. Effectful composition requires `--live`.
Placeholder templates contain no real key, password or private account data.

Private terms config records noncommercial free use, required attribution,
Watchmode's 30-day non-image cache limit, source/date and actual operator acceptance.
TMDB AI-use licensing stays deferred to the paid-tier stage per the user decision.
No SDK/ORM or generic provider/job platform is needed.

List each service separately with `types=movie`, `regions=US`, `source_types=sub`,
its verified `source_ids` value, `limit=250`, `sort_by=title_asc` and explicit
page numbers. Decode positive Watchmode IDs, movie type, optional canonical positive
TMDB IDs and TMDB movie type. Validate finite `popularity_percentile` in 0–100;
missing popularity is explicitly unknown, sorted after valid values. Missing TMDB
IDs are reported and excluded from enrichment, never matched by title. Conflicting
Watchmode/TMDB associations are quarantined from enrichment and later evidence.
`title_asc` was accepted by a free `/list-titles` probe on October 5, 2026 UTC
(five results, HTTP 200, one credit). It avoids popularity-driven page reshuffling;
equal-title/provider edits can still drift, so completeness and drift rules remain.

Ignore harmless unknown provider fields. Invalid TMDB mappings and popularity become
unknown while valid Watchmode movie membership is preserved. Identified non-movies
are excluded and counted; retain their IDs with the page for drift checks. Rows
without a usable ID/type and short pages mark the service incomplete; none can create
absence evidence. Reject contradictory page structure and retain
no unneeded provider payload. Module imports start no work. Diagnostics allow fixed
codes/counts only, never raw transport, database or credential errors.

## 3. Round-robin sweeps, checkpoints and promotion

Fetch pages in round-robin service order; abundant Netflix pages cannot starve the
other services' first pages. Persist validated staged memberships and page completion
in one transaction. Record actual observation times, source/config version, page
parameters/totals, unresolved/excluded row counts, missing IDs and mapping conflicts.

A run's bounded checkpoint can leave the logical sweep in progress without claiming
success. Resume the same sweep within six hours of its start. Old staging is discarded
or expired before starting a new sweep; resumption never restamps old observations.
If HTTP succeeds but checkpoint commit fails, a retry may repeat a charged page.
Membership inserts/deduplication are idempotent; progress cannot advance without its
rows. Operational progress can use `refresh_runs`; cached Watchmode rows have
immutable observation timestamps and append-only writes. The evidence stage adds
their age-based DELETE guard and cleanup, rather than a new mutable provider cache.

Repeated/nonadvancing pages, inconsistent totals, missing pages and terminal provider
failures cannot yield a complete service sweep. Promote only after all that service's
pages validate and totals are internally consistent. Record promotion/completion
time and each member's actual observation time; freshness is not renewed by promotion.
Per-service completeness matters even when another service remains partial.
Service-local page, conflict/nonadvancing, drift and totals errors seal only that
service and produce a partial run; healthy services continue. Authentication,
credentials, target guards, lock loss and storage/integrity errors stop the run.
Exhausted transient/throttled provider errors stop paging as partial,
without calling other services, and leave staged sweeps open for
six-hour resume. Budgets also leave resumable checkpoints. Valid old staging displaced by a newer batch
is `superseded`; only staging beyond six hours is `expired`.

Persist the first page's newly learned totals before checking the aggregate 60-page
capacity. Combined overflow ends this run's unfinished sweeps with
`combined_page_limit`; that code never feeds a cached service block. The next run
may pay to discover current totals again, and operators must review the 60-page
policy if aggregate growth persists. Only a service reporting more than 60 pages
on its own receives `sweep_too_large` after its first response. Later runs of the
same generation skip that service while the finding is retained (at most 30 days),
with other services continuing; an explicit generation change may reprobe. Cached
refusals use `capacity_blocked` and cannot renew the original finding's age.
A lower per-run page budget instead leaves progress resumable over bounded runs.

Preserve unsuccessful/partial sweep outcomes and their order; a later successful
sweep must not hide a gap. An in-progress sweep contributes no absence evidence.
A checkpoint-only run is not a terminal failed/partial logical sweep; a terminal
failure/partial sweep is an interruption for arrival derivation even if later work
succeeds. Changing a service/configuration generation starts new evidence history.

A complete promoted per-service set is observed membership evidence, including
absence by omission for that service. It is not an atomic provider snapshot: page
drift remains possible. Availability: evidence handles that uncertainty by suppressing
`present → absent → present` arrivals. It can infer prior absence for a newly appearing
title by referencing the retained complete sweep, without inventing a retrospective
row inside a sealed historical snapshot. Preserve enough sweep identity/completeness
and membership data for that derivation within the 30-day cache window.

This stage reports candidates and sweep observations, not watchability. Failed/partial
sweeps preserve the prior successful set with its original age. Unattended recurring
live use waits for the evidence stage's retention path; a sweep-only release is not
a complete availability system.
**No live sweep, including a supervised run, may target the retained catalog until
Availability: evidence's age-based DELETE path is implemented and accepted.**
Until then sweep rows are append-only and a live run would start a 30-day cache
clock without an accepted cleanup path. Synthetic disposable validation is allowed.

## 4. Balanced popularity-ordered enrichment

Paging stops (including Watchmode transient/throttled errors, credit exhaustion and
combined overflow) still allow TMDB work from earlier promoted sets, subject to its
own remaining wall/database/detail/request budgets. Only a global run failure skips
enrichment. Later partial TMDB results retain the original paging-stop diagnostic;
their failure counts and per-title outcomes remain recorded. Promoted candidates'
`coolingDown` flag means a current retry cooldown,
not a permanent attempt marker. Hosting owns timely recovery of partial sweeps;
see [the hosting plan note](hosting.md).

Build one queue per service from promoted memberships. Within each queue, order
by valid Watchmode `popularity_percentile` descending, then ascending canonical
Watchmode title ID as a stable numeric tie-break. Unknown popularity comes last.
Round-robin across these sorted service queues under the unique-title limit.
Deduplicate TMDB movie IDs while preserving every service membership. A shared
title may count in several service coverage totals; unique persisted totals stay
separate. Empty/quarantined/unmapped service queues report zero with their reason.

Select at most 100 unique titles per run. Persist advancement so repeated runs do
not continually select the same front of a queue. Keep existing overdue/flagged
metadata refresh work ahead of new-title enrichment; within each service/new-title
queue the popularity order and stable tie-break apply.
Sort each service queue once per run. Retained per-title detail outcomes back off
across fresh daily memberships: not-found/identity-conflict seven days, stale one
day, transient failures one hour. Store actual `checked_at` separately from immutable
provider acquisition `observed_at`; attempts cannot renew cache age. These backoffs
also apply to catalog refreshes without any Watchmode membership. Independent
`metadata_detail_attempts` rows are keyed by canonical TMDB ID and actual `checked_at`,
record no provider payload, and use the latest outcome. One store query owns cooldown
rules for both paths; successful outcomes clear earlier failure cooldowns. Sweep-linked
checks preserve their original acquisition timestamps separately. Explicit operator
`refreshIds` can bypass backoff. Title-local detail failures produce partial progress
and a failure count; authentication/storage/integrity failures remain fatal.
The five-calendar-month refresh lead remains unchanged. A batch of 1,000 titles
refreshed together still becomes due together and can occupy about ten 100-detail
runs. This is unresolved scheduling/capacity tuning to benchmark before hosting;
do not defer refresh past the six-month deadline by adding arbitrary jitter.

Use the existing detail provider/store and exact external identities. Never substitute synthetic metadata
for a failed detail response. Do not write personal ratings/subscriptions.

The initial metadata cap remains 1,000. Lightweight memberships do not count against
it. The evidence stage introduces retirement and active-versus-retired accounting;
until then preserve the existing catalog-cap behavior. Report per-service selected
and persisted counts, deduplication, missing identities and release/origin unknowns.
Growing the enriched catalog requires actual coverage evidence, not merely many
service/title memberships. Verified company-origin mapping remains metadata work.

## 5. Single-run lock and request/credit budgets

Acquire one session-level PostgreSQL advisory lock on a dedicated guarded connection
before `/status`, provider work or checkpoint mutation. It covers manual sweeps,
enrichment, evidence refresh and any legacy importer that can overlap them.
Overlap returns `refresh_overlap`; lock-connection loss aborts waiting/active work.
Hold that same connection for the entire bounded run. Process death/disconnection
releases the lock. Use two real clients to verify overlap denial and crash release.
Pool reuse must retain the existing target guard; never target retained data in tests.

Use a serialized Watchmode lane with at least 600ms between starts, ten-second
request timeout, no redirects and streamed 2MiB response ceiling. Retry only
transient network/timeouts, 429 and 502/503/504, at most twice with bounded backoff
and Retry-After. Every retry consumes the per-run attempt/credit cap; 401/403 stops
new work without retry. Preserve existing TMDB pacing and attempt controls.

| Maximum, lowerable in private config | Value |
| --- | --- |
| Local run wall time | 10 minutes, reserving 30 seconds for finalization |
| Watchmode credits/run | 100, including retries and uncertain outcomes |
| Membership pages/sweep | 60 total across four services |
| TMDB detail operations/run | 100 with existing metadata attempt limits |
| Ordinary cumulative DB work/run | 120 seconds |
| Enriched metadata catalog | 1,000 initially |
| Logical sweep resume age | 6 hours |

The evidence stage adds at most 20 background source checks/run, sharing the same
Watchmode run cap. HTTP status checks cost zero credits but still use the request
lane, timeout and wall-time bounds. No scheduled-invocation duration belongs to
this local plan; hosting benchmarks its own bounded shared-worker configuration.

Simplify quota enforcement: no persisted monthly or rolling-31-day credit ledger.
Under the advisory lock, preflight `/status`; reject before chargeable work when
`quota - quotaUsed` is below the configured **whole run credit cap**. An invalid or
unavailable status also refuses work. Operators may explicitly lower the cap;
composition does not silently lower it to bypass preflight. Bound attempted spend
in memory using the documented worst-case cost before dispatch, including retries
and ambiguous timeouts; do not assume a failed request was free.

Read `/status` again at finalization and record actual observed spend in the exclusive
report: quota/used before and after, their delta, and local attempted-charge accounting.
An unavailable final status, reset or incomparable quota state reports spend unknown
with a fixed reason, never a fabricated zero. Account deltas can include unrelated
consumers; label that limit rather than attributing them to this job. The lock
serializes this application's runs; Watchmode's quota enforcement remains the
account-wide limit if other consumers use the key. No credit reservation table or
billing-period inference is introduced.

The observed 30-page sweep is about 30 credits, or 900 across 30 daily sweeps (930
across 31). Estimates exclude retries, source checks/reference refreshes and external
usage; page totals may grow. Full sweeps have not yet been benchmarked.

## 6. Reports, ownership and acceptance

Reuse retained checkout guards, private fixed configuration, default-offline CLI,
exclusive per-run files, readback crosschecks and safe failure-report grace. Reports
include per-service pages/completeness/timestamps, mapping gaps, selected/persisted
counts, attempts, observed spend, checkpoint, bounds/failure codes and DB/wall time.
Detailed cached Watchmode response data stays private and expires in the evidence
stage; operational counts/codes do not require an indefinite raw-response archive.
Exit 0 for complete work, 2 for bounded/checkpointed partial, 1 for operational refusal.

`src/domain` owns pure balancing decisions with supplied inputs/time;
`src/server/providers` owns decoding/transport; `src/server/ingestion` owns orchestration;
`src/server/db` owns guarded SQL/lock/checkpoints; `scripts` owns explicit composition.
Keep dependencies and released migration files unchanged unless an additive migration
is required. Provider-shaped data does not enter the pure recommendation engine.

Acceptance before implementation handoff:

1. Actual config/CLI offline behavior, terms refusal, fixed credential paths, module
   import inertness, safe malformed-row degradation/incomplete promotion and synthetic secret
   redaction. Tests/CI require no live key or provider network.
2. Four source mappings, missing TMDB IDs without guesses and conflicting identities;
   candidates do not claim ad-tier entitlement or recommendation eligibility.
3. Page round-robin prevents service starvation; enrichment is independently balanced
   and popularity descending with stable ties. Test abundant Netflix, small services,
   shared titles, empty queues, unknown popularity and resumable advancement/cap.
4. Complete/partial/stalled/changed-total sweeps, atomic page/checkpoint commit,
   six-hour resume expiry, source-generation reset and actual observation times.
   Complete omission is preserved as evidence input; partial omission is not absence.
5. Actual pacing/cancellation/retry caps; `/status` below/equal/above whole-run cap,
   status outage, uncertain charges, final spend reporting and immutable report files.
6. Real two-client advisory overlap refusal before provider calls, lock-loss abort,
   crash release, wrong target/login/marker refusal, and legacy importer participation.
7. Actual synthetic-provider/disposable-pg composition, repeat identity/credits,
   readback honesty, pool shutdown and exact test-owned teardown.

Use `npm run check`, affected existing database/metadata/catalog commands and a new
shared `test:availability:sweeps:db` command locally and in credential-free CI.
Run existing mutation controls if owning metadata persistence code changes. Review
the complete tracked/new-file diff against these criteria; resolve findings and
obtain focused re-review before separately authorized live application/import.
Protected-handler and cron-denial acceptance belongs to hosting, not this plan.

## 7. Delivery boundary

Implement/verify this stage first, then hand its promoted sweep sets, failed/partial
outcome history, immutable observation timestamps and normalized identities to
Availability: evidence. Neither planning approval nor offline acceptance authorizes
changing the retained catalog, publishing the branch or enabling a schedule.
The CLI must refuse retained live sweeps before reading credentials or opening a
database connection while the evidence-stage cleanup gate remains closed.

## 8. Initial implementation and review handoff

The complete change set includes these new files (ordinary tracked diffs omit them):

- `src/domain/availability-sweeps.ts`: pure identity conflict detection and balanced
  popularity queues with numeric ties and unknown popularity last.
- `src/server/providers/watchmode.ts`: fixed host/header, stable title sort, strict
  movie/page/quota decoding, serialized 600ms lane, bounded retries, stream ceiling
  and cancellation. `scripts/watchmode-key.ts` parses only the fixed credential file
  when explicitly called; the current CLI never calls it.
- `src/server/db/watchmode-store.ts`, `refresh-lock.ts` and
  `supabase/migrations/20261005000001_availability_sweeps.sql`: guarded transactions,
  four-service logical batch resume, per-service promotion/interruption history,
  retained acquisition timestamps, enrichment advancement and real SQL readback.
  Five cache tables use the existing append-only guard. An invoker insertion guard
  seals page membership/completed sets and prevents enrichment from renewing ID age;
  its PUBLIC/API EXECUTE grants are explicitly revoked. It is not the future
  age-based DELETE guard. Released migrations remain unchanged.
- `src/server/ingestion/sweep-config.ts`, `availability-sweeps.ts`,
  `scripts/availability-sweeps.ts` and `config/availability-sweeps.example.json`:
  whole-run quota preflight, request/credit/detail/catalog/DB/wall limits, durable
  service turns, overdue/flagged refresh priority, reports and the closed live gate.
  The internal worker borrows a trusted caller-owned pool; disposable composition
  owns its close/teardown. Reports use the existing exclusive private writer.
- `tests/metadata/availability-sweeps.test.ts` and
  `tests/db/availability-sweeps.test.ts`: offline and disposable acceptance.

Changed existing runtime files are `scripts/catalog-import.ts` and
`scripts/catalog-config.ts`: the legacy live importer/listing acquires the same
guarded advisory lock before provider work, propagates lock-loss cancellation and
includes lock acquisition in DB accounting. Its regression suite adds a real
two-client overlap control. `package.json` and `.github/workflows/ci.yml` expose
the same sweeps DB and offline CLI commands locally/CI. No dependency or lockfile
change. README, architecture and the two plans/verification document carry the
approved wording/naming and implementation boundary; `.claude/` is untouched.

Initial validation before focused implementation review, on Node 24.14.0 /
PostgreSQL 17.11 (the correction evidence in section 9 supersedes these counts):

| Command | Local evidence |
| --- | --- |
| `npm run check` | Typecheck, lint, 306 offline tests and production build pass; used a hash-verified physical source/dependency copy without environment files. The copy emits Next's harmless multiple-lockfile workspace-root warning. |
| `npm run test:availability:sweeps:db` | 17 tests pass, including actual synthetic HTTP decoding/SQL composition, one-title fairness, quota boundaries, sealed promotion, atomic rollback/replay, six-hour resume, generation reset, interruption recovery, immutable ages, cap/refresh priority, deliberate aggregate corruption, two-client overlap/loss/crash release; exact container/network teardown verified. |
| `npm run test:catalog:db` | 18 tests pass, including legacy overlap before discovery/listing and retained-volume semantics on a uniquely named synthetic test volume; exact test-owned teardown verified. |
| `npm run test:metadata:db` | 22 tests pass in each of two fresh disposable cycles; teardown verified. |
| `npm run availability:sweeps -- --config config/availability-sweeps.example.json` | Actual Node entry point prints bounded offline scope and closed live gate; no credentials/network/DB. |

Review controls caught and corrected budget-stop cursor advancement, re-scanning a
completed service inside an unfinished batch, catalog capacity counting only mapped
movies, and lock checks missing from DB accounting. PostgreSQL fault/corruption
controls restore their synthetic triggers/functions in `finally`; no production
source mutation remains. Existing metadata persistence/ingest code was not changed,
so its seven mutation controls were not rerun in this stage. Remote CI and focused
external implementation review remain unverified pending separately authorized
publication/review; local passing checks do not constitute review acceptance.

The sort probe cost one free credit. No full live scan, retained DB read/migration/
write, commit, push, PR or deployment occurred. Arrival derivation, provider links,
time-based deletion, retirement/provenance migration and visible UI labels remain
Availability: evidence or later work, as scoped above. The revised M1 wording is
in evidence §6; late enrichment is evidence acceptance item 3.

## 9. First focused review correction pass (superseded where noted in section 10)

The correction pass keeps the approved stage boundary and changes the orchestration
failure behavior, cached outcomes and database cost:

- Service-local sweep failures preserve healthy services; transient/title-local
  detail failures report partial progress. Authentication, guards, lock loss and
  storage/integrity failures remain fatal.
- Impossible sweep totals are saved before terminal capacity refusal. Repeat runs
  avoid charged rediscovery; cached refusals cannot renew the original finding's age.
  Superseded batches have their own interruption reason.
- Missing mappings/popularity degrade to unknown. Unidentifiable membership and
  short pages retain valid staged rows but cannot promote or supply absence evidence.
- Per-title outcomes back off across new sweeps and overdue refreshes. An append-only
  `checked_at` records actual attempt time while `observed_at` keeps provider age.
- One array INSERT stores all memberships on a page. Conflict grouping runs in SQL
  with an observation-age index; the worker no longer loads the entire retained
  membership history into Node. Enrichment sorts service queues once per run.
- Personal-history invariants are fixture assertions, allowing legitimate concurrent
  ratings in production. Enrichment has a separate function scope, fixed diagnostic
  codes have one typed allowlist, new TypeScript uses two-space formatting, and dead
  persisted sort/duplicate fields are removed. Trigger table branches are explicit.

Additional new files omitted by tracked-only diffs are
`src/server/providers/sweep-error.ts` and
`tests/db/availability-corrections.test.ts`. The latter has its own disposable fixture
and independently seeded scenarios. The shared DB command includes both test files.
Released migrations and metadata persistence/provider logic remain unchanged.

Seven defect regressions were first run against the original implementation: all
seven failed for the reviewed behavior, then passed after correction. Four additional
controls cover incomplete promotion, global provider authentication, detail
authentication without a stop flag, and overdue-refresh backoff. The capacity case
also verifies that refusal age expires instead of renewing on each run.

Local evidence for that pass:

| Command | Result |
| --- | --- |
| `npm run check` | Typecheck, lint, 307 offline tests and production build pass in the hash-verified credential-free copy. Only the existing copy's multiple-lockfile workspace warning remains. |
| `npm run test:availability:sweeps:db` | 29 tests pass (27 scenarios plus two parent tests); exact disposable container/network teardown verified. |
| Membership SQL roundtrip control | Four 250-title pages store 1,000 memberships with four INSERT statements; the original implementation required 1,000. This is a roundtrip control, not a hosted runtime benchmark. |
| Personal-history controls | Isolated first-party rows remain identical; a concurrent real rating insert no longer fails the worker. |

Legacy catalog/metadata acceptance remains the initial evidence above: their owning
logic was not changed in this correction pass, so their suites/mutation controls were
not rerun. No temporary source mutation remains. No live provider call or retained
catalog access/migration occurred in this pass; changes remain uncommitted locally.

Hosting must verify a dedicated direct/session-mode connection and the actual
session-lock lifetime before scheduling; architecture owns that requirement and its
official Supabase reference. Large-batch refresh scheduling remains operational
tuning within the approved five-to-six-calendar-month window. No arbitrary jitter,
retention implementation or hosting deployment is added here. Focused re-review
remains required before separately authorized live use, and the CLI gate stays closed.

## 10. Implementation re-review corrections

The re-review correctly found that the first capacity fix cached an aggregate
overflow as four independent service blocks. It also found that transient failures
were sealing resumable work and that retry records missed discovery-only catalog
titles. The corrected behavior is defined in sections 2–4 above.

The correction fixture now accepts asymmetric service totals and real synthetic
HTTP failures. Before changing production, six regression scenarios failed: the
original symmetric capacity case revised to require a fresh run, asymmetric
50/6/4/5-page overflow, a 503 burst after ten saved Netflix pages, throttling without
peer requests, a catalog-only TMDB 404, and an identified Hulu non-movie. All now
pass. Controls also cover a single over-60-page service with healthy peers and block
expiry, consecutive excluded-only pages, and local page-conflict/nonadvancing errors.

`metadata_detail_attempts` is added to the still-unapplied sweeps migration. It is
append-only, service-only and RLS protected, independent of memberships; the evidence
stage must add its checked-time DELETE path before any retained run. Existing
Watchmode acquisition ages and first-party history remain unchanged. Released
migrations and owning metadata persistence/provider logic remain untouched.

The unused `balancedCandidates` and `conflictingIdentities` functions/tests are
removed. Production and unit tests use `nextCandidate` plus `popularityOrder`;
integration acceptance verifies actual enriched ID order, fairness, deduplication
and SQL conflict quarantine. Both selection paths use the same cooldown query.
Run diagnostics and `store.fail` use `SweepCode`, including `complete`,
`capacity_blocked` and `combined_page_limit`. Reviewed production modules have no
lines longer than 180 characters. SQL readback includes per-service failure codes
and excluded-row counts.

Final review's small correction separates `stopPaging` from a global failed outcome:
four new regressions first failed, then passed for enrichment from earlier promoted
sets after transient/throttled failures, credit exhaustion and combined overflow.
A seeded authentication control verifies that global failures still skip enrichment.
A further failed-then-passing assertion ensures a partial TMDB failure does not hide
the original transient paging code. `attempted` is renamed `coolingDown` throughout
the promoted-set contract. The new [hosting plan note](hosting.md) owns bounded retry
within six hours from the original sweep start and retention of the originating cause;
no scheduler implementation is added.

Final validation: `npm run check` passes typecheck, lint, 307 offline tests and build
in the hash-verified credential-free copy; `npm run test:availability:sweeps:db`
passes 43 tests (41 scenarios plus two parent tests). Disposable container/network
teardown is verified. The only build warning is the existing copy's multiple
lockfile workspace-root warning. No temporary source mutation remains.

Refresh-date clustering remains unresolved scheduling work, explicitly described
above. No arbitrary jitter is added to the approved refresh lead/deadline. No live
provider request, retained catalog access/migration, commit, push or deployment
occurred. Focused re-review remains pending and the live gate stays closed.
