# Availability: evidence implementation review

October 5, 2026. Local implementation on `implementation/availability-evidence`,
based on `main` at `04bf010`. The approved evidence plan remains the acceptance
contract. Focused review and re-review approved this change set on October 5, 2026.
It does not record remote CI success or retained validation.

## Change set

The implementation adds offers/variants with unknown ad-tier inclusion, validated
cached web links and complete-sweep arrival derivation. Independent derivations
retain original membership/page times, including late enrichment, and preserve
episodes through consecutive complete present/absent/present drift. Background
source checks share the existing advisory lock, request lane, credit, wall and
database budgets. Successful empty checks and operational failure remain distinct.

The forward migration adds immutable retention stamps to existing offers and
observations, 13 own-age provider-cache guard bindings, five invoker functions,
retirement state and a separate acquisition table. Its restrictive mapping FK,
unconditional UPDATE denial, permanent first-party protection and strict provider
expiry apply at every DELETE depth. Legacy mappings are backfilled exclusively
as TMDB acquisitions at `metadata_refreshed_at`. Original snapshot/page insertion
seals and unrelated immutable guards remain intact. UTC function configuration
prevents session timezone changes from moving calendar retention boundaries.

TMDB refresh starts at five calendar months. Confirmed 404 permits retirement;
ordinary failure needs the six-month deadline and distributed failed retries.
Retirement clears provider fields/credits through ordinary movie UPDATE, preserving
the UUID and first-party history. Active-only cap/readback and successful restoration
use the same UUID when a retained identity resolves that shell. The importer now
refuses the older schema before ingestion; this work does not upgrade retained setup.

The shared disposable harness discovers all SQL migrations once in filename order.
Existing suites no longer manually duplicate the sweeps migration. Explicit upgrade
coverage seeds the released sweeps baseline before applying evidence, checks legacy
backfill and proves that repeating the upgrade helper does not replay migrations.
The original schema runner keeps its original baseline and expected-red controls.

New files included in review:

- `config/availability-evidence.example.json`
- `src/domain/availability-evidence.ts`
- `src/server/db/availability-evidence-store.ts`
- `src/server/ingestion/availability-evidence.ts`
- `src/server/ingestion/private-evidence-cleanup.ts`
- `src/server/providers/watchmode-sources.ts`
- `supabase/migrations/20261005000002_availability_evidence.sql`
- `tests/db/availability-evidence-ages.sql`
- `tests/db/availability-evidence.test.ts`
- `tests/metadata/availability-evidence.test.ts`
- this review packet

Tracked integration changes cover the Watchmode provider/store/worker/config,
metadata persistence, active-cap/import/readback paths, disposable harness and its
callers, the package command and CI invocation, README, architecture and the plan.
README, architecture, evidence/sweeps plan edits existed before implementation and
are preserved. `.claude/` work is preserved and excluded from the review patch.
No dependency or lockfile change was needed.

The complete tracked and new-file patch is available locally at
`.cache/availability-evidence-review.patch`; ordinary `git diff` omits the new files.
Use `git status --short` with this inventory to inspect the actual working tree.

## Acceptance evidence

| Approved acceptance | Actual coverage |
| --- | --- |
| 1–3: absence, drift, exact 48h, interrupted/gap/expired history and late enrichment | Pure tests plus retained real-pg omission/late derivation and repeated provider composition; per-service original clocks and supporting rows are asserted. |
| 4: direct services, variants, uncertainty and safe links | Decoder tests cover source types including TVE, formats, paid text, mobile fields, foreign hosts and URL attacks. Database composition checks variants, multiple links, successful empty checks and source failures. Disney+/Hulu label data is tested; UI display remains later work. |
| 5: every cache guard, own ages, cascades and seals | All 13 cache tables exercised as owner/service at younger, exact and expired ages, with unconditional UPDATE denial. Mixed-age cascades roll back; all-expired deep cascades succeed. API grants/function revokes, policy seals and original insertion/immutable seals are inspected. |
| 6: calendar refresh, retirement, provenance, caps and restoration | Month-end/exact boundaries, brief versus distributed failure windows, referenced retirement, timestamp preservation, same-UUID restoration and active-cap denial are tested. Unchanged first-party acquisitions and exact legacy backfill are asserted. |
| 7: bounded cleanup, repeat/report/teardown | Private inventory expiry includes copied original timestamps and refuses escapes. Review revisions add explicit expired snapshot and mixed-age sweep/page/member/event cleanup with a repeat pass. Actual synthetic transport/store composition checks reports and independent membership/link clocks; harness verifies exact owned resource teardown. |
| 8: final acquisition protections | Direct/nested first-party deletion and UPDATE denial, TMDB/Watchmode younger/exact/expired deletion, restrictive FK, and positive mapping deletion after expired acquisitions are tested. |

Numbered provider-host review gate 3 was completed and recorded in the approved
plan before source-link implementation. It uses public official destinations;
no live authenticated Watchmode probe was performed. The allowlist deliberately
refuses foreign provider hosts even when an official homepage redirects there.

## Validation results

All commands below exited successfully against offline synthetic data or owned
disposable PostgreSQL 17.11 fixtures. No retained resource or live provider was used.

| Shared command | Result and local evidence |
| --- | --- |
| `npm run check` | Typecheck, pure-boundary checks, lint, 316 tests across 13 files and production build passed; `.cache/evidence-check.log`. |
| `npm run test:db` | Original schema acceptance and 12 expected-red controls passed, followed by final green and fresh reset/teardown. |
| `npm run test:metadata:db` | 22 tests passed in each of two fresh cycles; `.cache/evidence-metadata-db.log`. Final controls also reran both cycles against the final persistence code. |
| `npm run test:catalog:db` | 18 tests passed including A1 persistence and exact test-owned teardown; `.cache/evidence-catalog-db.log`. |
| `npm run test:availability:sweeps:db` | 43 tests passed; `.cache/evidence-sweeps.log`. |
| `npm run test:availability:evidence:db` | Initial 14 reported tests passed; review revision expands this to 19, including fresh replay, explicit upgrade and realistic scale; see the revision evidence below. |
| `npm run test:metadata:controls` | All seven named mutations produced assertion failures; finally restored sources; final offline and two-cycle DB green. `.cache/evidence-controls.log` and `.cache/evidence-check/.cache/pr03/`. Controlled source hashes match the reviewed working tree. |
| `npm run metadata:local -- --scenario repeat` | Synthetic repeat passed with idempotent persistence and verified teardown; `.cache/evidence-repeat.log`. Its expected bounded discovery result remains partial. |
| `npm run metadata:dry-run -- --config tests/fixtures/pr-03/discovery-synthetic.json --as-of 2026-10-03` | Passed offline configuration validation. |
| `npm run ratings:dry-run -- --input tests/fixtures/pr-03/ratings-synthetic.json --as-of 2026-10-03` | Passed offline validation, zero writes. |
| `npm run availability:sweeps -- --config config/availability-evidence.example.json` | Passed offline bounds validation; retained live gate remains closed. |
| `git diff --check` | Passed. |

The initial root `check` passed but Next loaded the existing `.env.local` file;
no values were displayed or provider calls made. Final `check` and controls used
a credential-free source copy under `.cache/evidence-check`, with no `.env` files
or `.claude/` and a junction to installed dependencies. The build reported a
multiple-lockfile workspace-root warning and passed. No dependency install was made.

Early disposable failures exposed a reserved SQL variable, missing-record-field
trigger branch and synthetic fixture insertion/clock assumptions. These were
corrected and the affected suites rerun. Ordinary sandbox Docker access was denied;
approved disposable commands ran with escalation. No tests were skipped or checks
weakened. Temporary mutation changes were restored.

## Focused review and remaining limits

The actual code/migration and tracked/new-file change set were reviewed locally.
Review fixes included independent link/membership readiness clocks, absent-title
candidate fallback, bounded cleanup, immutable UTC age checks, final-status attempt
accounting, and movie row locking/stale handling during restoration. No known
blocking finding remains from that local review. Independent focused re-review
remains required by the approved workflow, particularly the migration's complete
guard inventory, acquisition lifecycle and actual composition/readback paths.

Routine bounded choices: history accepts at most 256 retained sweeps per service
and refuses an overfull replay as unknown; evidence handles at most 100 movies
with at most 20 source checks inside shared budgets. Cleanup removes at most 1,000
rows per table per run and inspects at most 100 explicitly named private files;
larger backlogs require subsequent runs. Retry exhaustion requires three failed
windows at least seven days apart, with the latest within one day, after expiry;
a short boundary outage cannot retire a movie. First-party acquisitions are
permanent, so they can intentionally block canonical mapping/hard deletion.

Synthetic checks establish mechanics, not real catalog coverage, licensed provider
truth, account tier inclusion, visible device labels or retained performance.
No remote CI run, retained migration, live provider call or daily-scan benchmark
was performed. The CLI live gate stays closed. No UI, ranking, classification,
Auth, scheduling or hosting work, commit, push, PR or deployment was performed.

## Changes-requested review revision

The reviewer independently ran the initial evidence suite: exit 0, 14/14 passed,
with disposable container/network removal. Other initial validation results above
are implementation evidence, not independently rerun results. The reviewer found
a plausible scale problem and three missing regressions. The earlier cleanup
description overstated its expired-data coverage; the explicit cases below replace
that claim.

1. `prepareHistory()` now validates retained completeness once per service per
   evidence run, after cleanup. Each movie uses only primary-key presence lookups
   against that run's prepared history. A `(sweep_id,page)` membership index also
   makes page integrity counts cheap and benefits the existing promotion validator.
   History is evaluated at one supplied run timestamp, not silently restamped for
   each later movie. Candidates now use Maps/Sets for identities, timestamps and flags.
2. A separate test really DELETEs an aged membership, then proves its previously
   complete sweep becomes interrupted and cannot supply complete absence evidence.
   The late-enrichment test has an accurate name. The aged fixture uses ordinary
   sealed SQL inserts; a stale worker checkpoint cannot create that fixture.
3. Cleanup now has an explicit expired sweep with old and young pages, a young
   membership/event, an entirely expired sweep, and an expired snapshot graph with
   offers/observations/variants/links. It removes the expired branches without
   throwing, keeps the young chain and parent, and repeats safely.
4. Fresh Watchmode membership is acquired for a retired movie with no first-party
   acquisition. The test asserts original-time acquisitions for both namespaces,
   idempotence, expired TMDB acquisition removal, surviving TMDB mapping and same-UUID
   restoration. Removing `tmdb` from the acquisition VALUES list fails this regression.

Lower-priority revisions: unknown source types are skipped and counted in safe
reports while valid rows survive; the four new cache/acquisition tables no longer
grant service UPDATE. Owner tests still verify the unconditional UPDATE guards and
service tests verify permission denial. Drift uses `drift_sweep`/a separate readback
flag while keeping `reason=interval` and the original endpoints; pure and real-pg
tests cover that behavior.

The realistic fixture contains 30 daily Netflix sweeps × 15 pages × 250 memberships
(112,500 rows). It seeds all rows through the actual insertion seals, ANALYZEs the
tables, then runs the actual evidence composition under the shared lock with 100
mapped candidates and no provider calls. It verifies four completeness preparations,
all 30 Netflix sweeps, 100 derivations and the configured 120,000ms database ceiling.
Measured database work was 1,857ms on the first run and 2,412ms on the corrected
19-test run; latter wall time was 2,413ms. The final post-control 19/19 green run
measured 1,694ms database / 1,695ms wall, with all 30 sweeps asserted. Fixture
construction is outside the
refresh budget. This measures local synthetic history/acquisition/cleanup/derivation
work, not a four-provider daily scan or retained environment benchmark.

Revision checks: `check` (316 tests, typecheck/lint/build), metadata DB (22 tests in
each of two fresh cycles), catalog DB (18), sweeps DB (43) and evidence DB (19) passed.
Logs are `.cache/evidence-revision-{check,metadata,catalog,sweeps,db}.log`. Focused
temporary review controls remove Watchmode's TMDB acquisition and the completeness
condition; each must trigger its named regression assertion, restore in finally,
then finish with the full green evidence suite. Their evidence is recorded in
`.cache/evidence-revision-controls.log` and per-control logs.
Final post-control green evidence is `.cache/evidence-revision-db-final.log`;
reviewed source hashes match the restored credential-free validation copy.
No owning metadata mutation-control source changed in this revision; the seven-control results above
remain the prior implementation evidence.

Initial revision runs caught an invalid stale-worker fixture and a test callback
type error; both were corrected before final checks. Checks were not weakened.
The complete review patch is regenerated with tracked and new files.

Focused re-review approved this revision. Before any separately authorized retained live
gate, a guarded retained upgrade command for migrations 4/5 and CLI wiring for
`expirePrivateEvidence` are still required. Neither is implemented or invoked by
this revision; the live CLI continues to refuse. Existing docs and `.claude/` work
remain preserved, and no retained resource, provider credentials or personal payload
were accessed.
