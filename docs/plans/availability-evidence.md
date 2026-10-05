# Availability: evidence

Date: October 4, 2026; readiness reconciliation October 5, 2026.
Status: approved plan with the October 5 readiness-review edits incorporated;
implementation passed focused review and re-review on October 5, 2026.
Section 9 lists the follow-up required before the retained live gate.
No further full plan review is required. The retained live gate remains closed.
Implementation evidence and the focused review packet are recorded in
[availability-evidence-implementation.md](availability-evidence-implementation.md).
Baseline: `main` at `04bf010`, with Availability: sweeps #7 fully merged after
local catalog #4, catalog fixes #5 and CI corrections #6.
All three CI jobs (`check`, `database`, `metadata-database`) passed on the first
run at `04bf010`, without a rerun.
Depends on [Availability: sweeps](availability-sweeps.md).

Specifications: [architecture](../architecture.md), [engineering](../engineering.md),
[Watchmode verification](watchmode-verification.md), the [schema evidence](pr-02-schema.md)
and [metadata plan](pr-03-metadata.md). Historical filenames and evidence stay intact.

## 1. Scope

Implement availability offers/evidence, subscription-arrival intervals, provider links
and the retention migration. Reuse the sweeps stage's normalized membership sets,
per-service complete promotions and failed/partial history, lock, quota preflight,
request lane, private terms config and reports. No separate budget ledger or lock.

Retain daily target/48-hour maximum availability age, the verified US direct source
IDs and the initially 1,000-record active metadata cap. The user permits Disney+/Hulu
bundle-with-ads titles with unknown title-level tier access to be eligible only with
`Ad-tier unverified` and availability-failure correction. Record uncertainty honestly.
Rental/purchase, free services, unpurchased channels and Live TV remain distinct.

No recommendation engine, trace/classification redaction, personal setup, UI, new
production-origin rules, protected HTTP cron handler, scheduling or hosting deployment.
Recommendations own the later provider-reference/expiry/redaction design; hosting
owns the cron authorization/denial tests. No commit, publication, retained migration
application or live import is authorized by this planning revision.

## 2. Complete sweeps as absence evidence

Omission from a **complete, promoted per-service sweep** is absence evidence for
that service, including for titles that first appear in a later sweep. Evidence is
derived from the retained complete set; it does not require a pre-existing title
track or a targeted `/sources` absence check. Do not fabricate an observation inside
an already sealed historical snapshot: reference the complete sweep whose membership
set supports absence, then persist the new derivation with its evidence identities.

For absence, use the service's actual sweep completion time; for presence, use the
title's actual page/source observation time. Preserve the bounded scan interval and
its pagination uncertainty. Promotion/resumption never renews an old page timestamp.
Newly configured service generations and a service's first sweep have unknown
arrival; no earlier absence is inferred from missing configuration or empty staging.

A partial, failed, in-progress or expired sweep cannot prove absence. Keep the old
unexpired successful availability with its original age; a failure cannot make it
fresh. Record terminal failed/partial sweeps as interruptions for arrival derivation.
Successful empty complete sweeps are absence evidence and differ from failed checks.
Sweep-stage checkpoint-only runs are not terminal partial logical sweeps.

## 3. Arrival and drift rules

Evaluate history independently for each movie/service/US/subscription track within
one service configuration generation. Apply drift suppression before arrival:

1. `present → absent → present` across consecutive complete per-service sweeps is
   continuity caused by possible pagination drift, **never a new arrival**. Preserve
   the prior arrival interval if it is still retained; otherwise remain unknown.
   Record drift separately from the interval reason so readback and later freshness
   work retain the interval and its original endpoints.
   The complete absent sweep is still absence evidence for that moment; suppression
   governs the subsequent arrival classification, not whether absence was recorded.
2. Otherwise, arrival requires absence in a complete promoted sweep **at most 48h**
   before the presence observation, with no failed or partial sweep between them.
   Keep the absence/presence timestamps as an interval, never an exact launch date.
   A newly appearing title can qualify through omission from the previous complete
   set even though no targeted absence row existed for it.
3. First service sweep, new service generation, a gap over 48h, any intervening
   failed/partial sweep, expired supporting sets or no prior complete set yields
   unknown arrival freshness. Do not fall back past an interruption to manufacture
   a qualifying interval.
4. Repeated presence does not move the arrival clock. A reappearance after multiple
   complete absent sweeps is evaluated by the same bounded absence-to-presence rule,
   separately from the single-absence drift pattern; record an episode transition.

Derive only from the retained evidence. No fabricated history, exact date, tier
entitlement or stacked boost for a movie on several services. Explanations use
`recently observed on your service` when that is the supported claim. Ranking owns
the boost/decay policy, whose windows must fit within Watchmode's 30-day cache limit.
Once supporting data expires, evidence is unknown; a current hash/listing cannot
reconstruct or renew an older interval.

## 4. Offers, variants and cached links

Source mappings identify services, not exact ad tiers. Keep requested variants,
mapping scope and tier certainty explicit. Disney+/Hulu `sub` offers remain
subscription offers; do not convert them into Watchmode `free` offers merely because
the user's bundle has ads. Preserve `unknown` tier inclusion and data for the future
UI label and correction flow. Only the explicit accepted uncertainty is eligible;
other hard gates are not relaxed.

Refresh `/title/{watchmode-id}/sources?regions=US` for flagged titles and a bounded
active shortlist in background work, at most 20 checks/run within the shared credit
cap. Watchmode IDs avoid additional resolution credits. A targeted source check can
confirm current offers or supply links, but is not required to establish complete
sweep omission. Paid mobile-link restriction text is missing link evidence, not a URL.

Validate HTTPS web destinations against a fixed reviewed provider-host allowlist;
do not server-fetch arbitrary links. Store per-offer links and their observation/
expiry dates separately: the existing single snapshot `watch_page_url` cannot hold
several provider destinations. Membership freshness and link-cache age are distinct;
neither renews the other. Missing links leave a title unready for a UI requiring that
destination until background refresh succeeds. Ordinary picks make no provider call.

Use an additive migration for service/variant certainty and link evidence, with
constraints/grants and fixed SQL. Preserve existing snapshot parent/child insertion
sealing and offers-before-observations ordering. New data is not silently appended
to an old sealed snapshot. Failed provider checks do not erase a previous success.

## 5. Time-bounded Watchmode retention

Remove the proposed maintenance-owner role, SECURITY DEFINER retention functions
and role-aware trigger exceptions. Use ordinary parameterized DELETEs under the
existing trusted service composition and one new **SECURITY INVOKER** time-bounded
guard. A new migration replaces the `guard_immutable_record` trigger binding only
on `availability_snapshots`, `movie_availability`, `availability_observations`,
`availability_tracks`, all new Watchmode cache/evidence tables, and the independent
`metadata_detail_attempts` retry records. Do not weaken the
original guard on classifications, recommendations, feedback or session deletion.

The new guard always denies UPDATE, including nested UPDATE. At every trigger
depth, including FK cascades, DELETE is allowed only if the row's own immutable
observed/checked timestamp is strictly older than the configured retention window;
at the exact boundary it remains denied. A mixed-age cascade fails and rolls back
the entire DELETE statement. This replaces the previous cascade exception only
on the listed cache/availability tables; personal account/profile deletion retains
the original guards on sessions, recommendations and feedback.
Default/max window is 30 days for Watchmode;
configuration may shorten it but cannot extend beyond the source limit. The database
policy is migration-owned/read-only to ordinary API/runtime roles, not a caller GUC
or per-delete cutoff. Existing grants/RLS still control who can issue DELETE; the
guard does not grant browser writes. New functions explicitly revoke PUBLIC/API
EXECUTE in the creation transaction, as the schema plan requires.

Each guarded cache row needs an immutable age basis. Snapshots use `checked_at`;
offers/observations use an immutable retention timestamp copied from their snapshot's
`checked_at`, backfilled by the migration and stamped by the insertion trigger.
This age remains available during cascades after the parent row has been deleted;
do not depend on a parent lookup at DELETE time or accept a caller-selected age.
Tracks use `tracked_since`; new memberships/sweep evidence/links use their immutable
observation time.
`metadata_detail_attempts` uses its immutable `checked_at`, with a maximum 30-day
operational identity/outcome retention window; it contains no provider payload.
Sweep-linked enrichment checks continue to use acquisition `observed_at`, rather
than actual attempt `checked_at`, for their Watchmode cache age. No UPDATE can extend
lifetime. Test direct child deletes while
their parents still exist and cascading-delete paths at every depth. Cleanup removes
expired children/snapshots first and only removes an old track when it has no
unexpired dependent observations, preserving current evidence under normal cleanup.

Deleting expired complete-sweep sets also expires any derivation that needs them.
Do not permanently copy an old provider payload into another cache or reset its
acquisition time. Evidence-bearing private reports/verification responses obey the
same 30-day inventory/cleanup policy; long-lived reports retain operational counts/
codes instead of stale source payloads. Provider cancellation cleanup remains an
operator obligation; early-age deletion is not enabled through an immutability
bypass in this plan.

## 6. TMDB refresh and retirement

Begin re-fetching at **five calendar months** after the last successful refresh,
with bounded retries across the remaining window. Only a successful re-fetch sets
`metadata_refreshed_at`; failed/404 requests never renew that timestamp. Retire only
after the **six-calendar-month deadline has passed** and all scheduled attempts
have failed. A confirmed TMDB **404** is the only early "gone" signal; a transient
outage near either boundary does not retire the movie. Use the existing provider/
store for successful refreshes and record failed attempts separately.

If current TMDB data reaches expiry without a successful refresh, use ordinary
`movies` UPDATEs to retain the internal UUID, clear cached provider fields, set a
locally generated unavailable placeholder and an explicit retired state. Clear
expired credits and TMDB-cached mappings through ordinary DML where permitted.
Record acquisition provenance on external IDs: IDs supplied by the first-party
ratings seed and fresh Watchmode `tmdb_id` values are not TMDB-cached data and
survive TMDB retirement, keeping personal history linkable and refreshable.
Watchmode-sourced IDs retain their original observation time and remain subject
to Watchmode's own 30-day cache limit; retirement never renews it. First-party
input identities persist independently. Never guess a replacement identity.

Keep `movie_external_ids` as the canonical mapping table. Add
`app.movie_external_id_acquisitions` with a composite FK to
`movie_external_ids(movie_id, source)` using **ON DELETE RESTRICT**, and primary
key `(movie_id, source, acquisition_path, acquired_at)`.
`acquisition_path` is constrained to `tmdb_metadata`, `watchmode_membership` or
`first_party_ratings`; `acquired_at` is the immutable actual acquisition time.
Independent acquisitions coexist for the same mapping, and repeated processing
of one acquisition is idempotent. Only a real new acquisition may add a later time.
Use service-only writes and explicit grants/RLS; first-party acquisition evidence
does not expire with provider caches. Provider acquisition rows follow their own
source retention. The FK prevents deleting a canonical mapping while any acquisition
row remains. Cleanup must first delete expired provider acquisitions; first-party
acquisitions keep their mapping protected. Retirement cannot cascade away evidence.

Protect this mixed-source table with a **SECURITY INVOKER** acquisition guard that
always denies UPDATE and checks DELETE at every trigger depth. Never permit DELETE
of `first_party_ratings` acquisitions. Permit DELETE of `tmdb_metadata` acquisitions
only strictly after six calendar months from `acquired_at`, and of
`watchmode_membership` acquisitions only strictly after the migration-owned
Watchmode retention window (default/max 30 days). Exact-boundary rows remain
protected. No caller cutoff, role exception or nested-delete bypass is allowed.
Revoke PUBLIC/API EXECUTE on the new function in its creation transaction;
existing grants/RLS continue to control access. Include this separate guard in
the final database trigger inventory.

Backfill every pre-migration external mapping as `tmdb_metadata`, using its movie's
`metadata_refreshed_at`, never migration time. The existing retained 100-title
catalog came entirely from the TMDB importer. Do not infer first-party provenance
from personal-history references or create Watchmode provenance during backfill.
New first-party seed and Watchmode paths record acquisitions even when the mapping
already exists or metadata persistence reports unchanged. Test backfill and later
independent acquisitions through the actual persistence paths.

Retired rows are ineligible and do not count toward the active enrichment cap.
Update readback/cap accounting to recognize retired shells; the current catalog
readback requires all movie rows to have a TMDB mapping. Successful later refresh
can restore active metadata only through valid identity resolution. Preserve the
UUID and first-party ratings/feedback/session graphs, including rows referenced by
classification/snapshot/recommendation history; do not hard-delete the movie graph.
No privileged retention owner or special movies-UPDATE bypass is needed.

Recommendation/trace/classification redaction is **deferred to recommendation work**.
That work must reference provider evidence rather than copy provider payloads into
immutable traces/classification inputs or explanations. It must define expiry-aware
versioned references (not merely a mutable current movie row), any legacy-copy
cleanup and `evidence_expired` replay behavior before
creating real immutable copied data. Refreshing current movies does not renew old
copies. This availability migration does not redact or rewrite those records or
pretend their future retention design is implemented.

## 7. Acceptance, reports and delivery

`src/domain` owns pure arrival/uncertainty/expiry decisions with supplied time;
`src/server/providers` owns source decoding; `src/server/ingestion` owns evidence
composition; `src/server/db` owns additive schema/fixed SQL/readback/cleanup;
`scripts` owns guarded explicit composition. Reuse the sweeps lock/budget/report
protocol and retained target guard. No new dependency is anticipated.

Reports crosscheck persisted offers, links, observations/intervals, expired counts,
retired movies and per-service unknown/drift/gap/partial reasons. Actual observed
spend shares the sweep report protocol. Console output stays fixed counts/codes;
exclusive private detailed files expire appropriately. Distinguish unknown from
successful empty availability and operational failure. Restore validation mutations.

Acceptance must include:

1. Complete promoted omission proves absence, including for a subsequently new title;
   no targeted check required. First/new service sweep stays unknown.
2. Consecutive complete `present → absent → present` preserves continuity and never
   generates a new arrival; test it within 48h as well as with longer timing.
3. A true new title omitted from the prior complete sweep gains an arrival interval
   when presence is at most 48h later; exact 48h qualifies, greater than 48h does not.
   Failed/partial/in-progress/expired sets and changed service generation cannot
   supply absence; intervening failed/partial sweeps suppress arrival. Repeated
   presence retains its clock; multi-service evidence never stacks boosts.
   A title first present in sweep N and enriched days later still derives its
   original arrival interval from the retained complete sweeps and original page
   times; enrichment time never becomes the presence time.
4. Actual source/link decoding, configured direct subscriptions versus rental/free/
   channels, unknown ad tiers and accepted Disney+/Hulu label data, paid mobile-link
   text and malformed/foreign-host URL refusal. Link work is background-only.
5. Real-pg age guards on every listed/new Watchmode table: younger/exact-boundary rows
   cannot be deleted at any trigger depth; older rows can. Mixed-age cascades fail
   atomically, and all-expired cascades succeed. All UPDATEs are denied regardless of
   age/role, immutable age/config cannot be
   changed to bypass the window, and unrelated original immutable guards still hold.
6. Five-calendar-month refresh start and six-calendar-month retirement boundaries,
   bounded retries, transient boundary failure without retirement, failed/404 refresh
   without timestamp changes and ordinary retirement of a movie referenced by
   classification/snapshot/recommendation records. First-party history/UUIDs survive;
   no hard deletion, forged refresh, retired eligibility or stale readback assumptions.
   A retired movie retains first-party-sourced IDs and restores the same UUID after
   a later successful refresh; provenance distinguishes independently fresh
   Watchmode IDs from expired TMDB cache and applies each source's own retention.
   Upgrade backfill records only TMDB acquisitions at existing metadata fetch
   times. Independent acquisition paths coexist and reprocessing is idempotent;
   first-party acquisition on an already mapped/unchanged movie survives retirement.
7. Idempotent bounded cleanup, evidence expiry/unknown arrival, private cache/report
   expiry, no unneeded source copies and repeat actual synthetic-provider/disposable-pg
   composition with honest reports, pool shutdown and exact resource teardown.
8. Real-pg acquisition protection: deleting a canonical mapping with a first-party
   acquisition fails through the restrictive FK; deleting a first-party acquisition
   directly fails regardless of age. For each provider acquisition path, DELETE
   inside its retention window and at the exact boundary fails, while DELETE
   strictly past the window succeeds. Verify UPDATE denial and absence of a nested
   DELETE bypass. After all expired provider acquisitions are removed, deleting a
   mapping with no remaining acquisitions succeeds as a positive control.

Run `npm run check`, affected schema/metadata/catalog commands and a new shared
`test:availability:evidence:db` command locally and in credential-free CI. Run existing
mutation controls when their owning code changes. Review the actual migration,
trigger inventory, configuration/composition paths and complete tracked/new-file
change set; resolve findings and obtain focused re-review. No protected-handler or
cron-denial tests are counted here; hosting owns those gates.

After both availability stages pass their acceptance/re-review, a separately
authorized retained migration/import can benchmark a complete daily scan and bounded
evidence refresh. UI work must later verify the visible uncertainty label, attribution
and availability correction on the actual device. Recommendation/ranking work owns
freshness decay windows that fit entirely inside the 30-day retained evidence window.

## 8. Readiness map against merged sweeps

This map specifies the integration changes from `04bf010`. Sections 1-7 own the
behavior and acceptance; the schema decisions below are implementation requirements.

### Integration and proposed change map

| Existing integration | Required evidence-stage work |
| --- | --- |
| `src/domain/availability-sweeps.ts` | Keep balancing separate. Add pure evidence decisions in `src/domain/availability-evidence.ts`, with supplied history/time/policy, original observation times, intervals, episode continuity and explicit unknown reasons. Add pure calendar-expiry/retirement decisions here or a focused domain module. |
| `src/server/db/watchmode-store.ts` | `promoted()` supplies only the latest complete set per service. Add a bounded retained-history query for complete sets and terminal interruptions in the same generation; include original membership/page times, sweep completion times and supporting IDs. Do not derive arrivals from `promoted()` alone or treat an unfinished resumable batch as a terminal failure. Reuse conflict quarantine. |
| `src/server/providers/watchmode.ts` | Extend the existing provider with validated US source-check decoding through the same serialized request lane/context, retry and charge accounting. Do not create a second provider instance/lane for background links. Preserve distinct offer types, uncertain tier inclusion and missing-link outcomes. |
| `src/server/ingestion/availability-sweeps.ts`, `sweep-config.ts` | Reuse one acquired refresh lock, whole-run quota preflight, Watchmode context, cancellation and DB/wall accounting. Add bounded evidence/cleanup orchestration in `src/server/ingestion/availability-evidence.ts`; source checks have a lowerable maximum of 20 within the existing cap, not 20 extra credits. Keep finalization/readback time reserved. |
| `supabase/migrations/20261005000001_availability_sweeps.sql` | Leave this merged migration unchanged. Add a later migration, proposed `20261005000002_availability_evidence.sql`, for evidence/link/variant storage, retirement state, external-ID provenance and migration-owned retention policy/guard. Preserve all insertion seals and unrelated immutable guards. |
| `src/server/db/pg-store.ts`, `metadata-sql.ts`, `metadata-store.ts` | Record independent identity acquisition provenance through metadata, sweeps and first-party ratings paths; restore retired metadata to the same UUID only through valid identity resolution. Preserve stale-write/conflict checks. Clearing provider fields must satisfy existing grouped evidence constraints. Owning persistence changes require the existing mutation controls. |
| `src/server/db/watchmode-store.ts`, `scripts/catalog-import.ts` | Current sweep cap counts all `movies`; catalog readback also compares all movie rows to the cap. Make active-cap/readback behavior retirement-aware, including shells without an expired TMDB mapping. Do not count retired shells as active or weaken identity checks for active rows. |
| `scripts/availability-sweeps.ts`, `watchmode-key.ts`, `catalog-config.ts`, `local-catalog-target.ts` | Current CLI is offline-only and refuses live work before credential/DB access. Keep that gate during development. Reuse fixed credential paths, guarded composition and exclusive reports; inventory and expire private provider-bearing files as well as DB rows. No retained migration/import is part of this preparation or offline implementation acceptance. |
| `tests/db/availability-sweeps.test.ts`, `availability-corrections.test.ts`, `tooling/metadata-disposable.ts` | Change the shared disposable harness to discover all `.sql` migrations in `supabase/migrations/` and apply them once in filename order. Remove manual sweeps-migration application from both existing suites. Metadata tests run with the full schema. Use a harness-owned explicit baseline cutoff only for upgrade tests that seed pre-evidence synthetic rows before applying the remaining migration; do not repeat migration lists in individual test files. Verify fresh replay and upgrade. |
| `package.json`, `.github/workflows/ci.yml` | Add `test:availability:evidence:db` and invoke that exact command in credential-free `metadata-database` CI. Add offline evidence coverage under `tests/metadata/availability-evidence.test.ts`; do not alter passing existing checks to accommodate failures. |

### Schema and retention checkpoints

The exact existing guard inventory to replace is four original availability tables
(`availability_snapshots`, `movie_availability`, `availability_observations`,
`availability_tracks`) plus six merged tables (`watchmode_sweeps`, `watchmode_pages`,
`watchmode_memberships`, `watchmode_sweep_events`, `watchmode_enrichment_checks`,
`metadata_detail_attempts`). New evidence/link cache tables also need the age guard.
The new `movie_external_id_acquisitions` table needs its separate mixed-source
acquisition guard and restrictive mapping FK specified in section 6.
Retain the merged insertion triggers separately from the replacement UPDATE/DELETE
guard. Verify the final trigger inventory in PostgreSQL, not just migration text.

The original observation schema has an exact `provider_arrival_date`, not a bounded
arrival interval. Leave that field empty for sweep-derived arrival. Add a separate
derivation representation with absence/presence endpoints, source generation,
episode/reason and supporting evidence references. Its own derivation timestamp
must not extend any supporting cache lifetime. Late enrichment derives against
retained complete sets without adding children to sealed historical snapshots or
inventing a pre-existing availability track. Choose constraints/FKs and expiry
queries together so deletion makes unsupported derivations unknown.

The original offer primary key is `(snapshot_id, provider_id, offer_type)`.
Represent variant certainty and multiple link evidence without conflating tiers
or trying to overwrite that immutable row. Keep provider-source IDs distinct from
internal provider UUIDs, and verify exact mapping in the trusted composition.

For cleanup, an old parent may have newer dependent data: sweep start, page,
completion and evidence acquisition times differ. Enforce each row's own retention
age in the database at every trigger depth, as specified in section 5. Cleanup may
avoid blocked parents for progress, but cannot bypass the guard. Test a direct
parent DELETE outside cleanup: younger or exact-boundary descendants must cause
statement rollback, including restoration of any expired rows already visited.
Test all-expired cascades as a positive control. Purging any part of a complete
set must also prevent its later use as complete absence evidence. A set's start
age alone is not proof that every child is expired.

`movie_external_ids` remains one canonical row per movie/namespace. Implement the
separate acquisition table and deterministic TMDB backfill specified in section 6;
do not bolt mutually exclusive provenance columns onto the mapping row. Upgrade
tests must prove that legacy rows are never labeled first-party and that later
first-party acquisitions preserve identity through provider expiry and retirement.

### Implementation order and review evidence

#### Gate 3: provider web-host review (October 5, 2026)

Reviewed before source-link implementation. The October 4 verification notes
record matching direct US source IDs and HTTPS web destinations; the private
verification files remain private and are not fixture input. Official references:
[Netflix help and official sign-in destination](https://help.netflix.com/en/node/33222),
[HBO Max help](https://help.hbomax.com/us-en/Home/Index) and its
[web player](https://play.hbomax.com/intercept/unsupported.html),
[Disney+](https://www.disneyplus.com/) and [Hulu](https://www.hulu.com/).
[Watchmode's explorer](https://api.watchmode.com/docs) is script-rendered; the
verified response field contract in `watchmode-verification.md` supplies the
previously observed shapes without a new live API probe.

Fixed exact hosts, per direct provider source (no wildcard subdomains):

| Source | Accepted web hosts |
| --- | --- |
| Netflix 203 | `netflix.com`, `www.netflix.com` |
| HBO Max 387 | `play.hbomax.com` |
| Disney+ 372 | `disneyplus.com`, `www.disneyplus.com` |
| Hulu 157 | `hulu.com`, `www.hulu.com` |

Decoder contract: bounded array of source objects; positive source ID, recognized
`sub/free/rent/buy` type and two-letter region; only US offers are composed.
`tve` is retained as a distinct decoder outcome and excluded from direct subscription
composition. The public Hulu homepage currently redirects to Disney+; this does
not authorize cross-provider returned links or establish title playback.
Preserve format and multiple per-offer web-link outcomes; no tier claim is inferred.
Paid mobile-link text, absent URLs and malformed links are missing evidence.
Refuse HTTP, credentials, nondefault ports, control/space/backslash characters,
protocol-relative URLs, suffix/lookalike/subdomain tricks, foreign-provider hosts
and arbitrary HTTPS destinations. Do not fetch destinations or infer entitlement.
New hosts require a later reviewed contract change. This gate is complete for
these conservative hosts; playback/entitlement remain unverified.

1. Add pure history/arrival/expiry decisions and tests for section 7 boundaries,
   including late enrichment, exact 48h, drift, interruptions and calendar months.
2. Add the migration, guarded history/evidence/cleanup store and real-pg acceptance:
   all ten existing guard bindings, new tables, immutable config, child deletes,
   mixed-age cascades, snapshot seals, upgrade replay and first-party preservation.
3. Before writing source-link code, enumerate and review the exact provider web
   host allowlist and decoder contract using official references and existing
   private verification evidence without exposing payloads. Record the reviewed
   hosts and refusal cases in the plan/test contract before proceeding. Arbitrary
   HTTPS hosts and paid mobile-link restriction text are rejected. This gate does
   not authorize a live provider probe.
4. Extend source decoding and shared-worker composition; add private-file expiry,
   retirement-aware metadata/cap/readback and synthetic repeat acceptance.
5. Wire the shared evidence DB command into CI and run `npm run check`,
   `npm run test:db`, `npm run test:metadata:db`, `npm run test:catalog:db`,
   `npm run test:availability:sweeps:db`, `npm run test:availability:evidence:db`,
   and `npm run test:metadata:controls` when owning persistence code changes.
   Run mutation controls alone and restore temporary mutations before final green.
6. Review the complete tracked/new-file change set against section 7, resolve
   findings and obtain focused re-review before any separate retained live gate.

Include pre-classification coverage counts/reasons in readback/report design as
required by the architecture roadmap. Synthetic counts validate reporting only;
real watchable coverage and a complete-scan runtime benchmark remain unverified
until separately authorized retained execution. Hosting still owns scheduling,
partial-sweep retries and refresh-date clustering; no jitter or scheduler is added.

## 9. Before the retained live gate

Both items below are required follow-up work, delivered as their own change after
this implementation merges and before any retained live sweep. Neither is
authorization to run against the retained catalog or a live provider; each run
still needs separate approval.

### Retained schema upgrade

`catalog:import` and the evidence read model now require migration
`20261005000002_availability_evidence.sql`, so they refuse the retained catalog's
original three-migration schema. `catalog:local setup` also applies only those
three migrations, so a fresh retained setup is refused in the same way.

- `catalog:local setup` applies every migration in `supabase/migrations/` in
  filename order, so a new setup reaches the current schema.
- A guarded upgrade action applies only the missing migrations to an existing
  retained catalog. It reuses setup's guards (database name, `local_support` marker,
  loopback target, migration owner) and refuses an unknown schema state rather
  than guessing which migrations are present. Each migration runs in its own
  transaction; a failure leaves the earlier state intact and reports a fixed code.
- `completedSetup` accepts only the current full inventory after setup or upgrade.
- Acceptance: on a disposable catalog target seeded with the original
  three-migration schema and synthetic movies, upgrade reaches the current
  inventory, backfills TMDB acquisitions at `metadata_refreshed_at`, and a repeat
  upgrade is a no-op. `catalog:import` succeeds afterwards and refuses before.
  `npm run test:catalog:db` covers this.

### Private-file cleanup in the live CLI

`expirePrivateEvidence` is implemented and tested, but no CLI composition supplies
it, and `runSweeps` refuses evidence-enabled runs without it.

- The live sweeps composition passes `expirePrivateEvidence` with the repository
  root, inside the acquired refresh lock and before any provider request.
- A cleanup failure stops the run before provider calls and reports a fixed code;
  the report records inspected/deleted counts and whether the bound was reached.
- Acceptance: an operator-path test drives the actual CLI composition with
  synthetic expired and unexpired files in each inventory directory and a fake
  provider, and asserts deletion order (before the first provider call) and report
  counts. The live gate itself stays closed until separately authorized.

Independently of this work, the raw Watchmode verification responses in
`.cache/watchmode-verification/` (`probe.json`, `title-probe.json`) must be deleted
by 2026-11-03 under Watchmode's 30-day cache limit. If this follow-up has not
shipped by then, delete them manually.
