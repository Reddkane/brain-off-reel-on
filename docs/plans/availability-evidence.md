# Availability: evidence

Date: October 4, 2026.
Status: approved plan with the four small re-review changes incorporated;
implementation remains future work. No further full plan review is required.
Baseline: `main` at `093f0c2`, with local catalog #4, catalog fixes #5 and CI image-pull/
Docker-timeout handling #6 merged. Depends on [Availability: sweeps](availability-sweeps.md).

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

The new guard always denies UPDATE, including nested UPDATE. Preserve the existing
FK-cascade DELETE allowance. A direct DELETE is allowed only if the row's immutable
observed/checked timestamp is strictly older than the configured retention window;
at the exact boundary it remains denied. Default/max window is 30 days for Watchmode;
configuration may shorten it but cannot extend beyond the source limit. The database
policy is migration-owned/read-only to ordinary API/runtime roles, not a caller GUC
or per-delete cutoff. Existing grants/RLS still control who can issue DELETE; the
guard does not grant browser writes. New functions explicitly revoke PUBLIC/API
EXECUTE in the creation transaction, as the schema plan requires.

Each guarded cache row needs an immutable age basis. Snapshots use `checked_at`;
offers/observations use their snapshot's checked time through a fixed parent lookup;
tracks use `tracked_since`; new memberships/sweep evidence/links use their immutable
observation time.
`metadata_detail_attempts` uses its immutable `checked_at`, with a maximum 30-day
operational identity/outcome retention window; it contains no provider payload.
Sweep-linked enrichment checks continue to use acquisition `observed_at`, rather
than actual attempt `checked_at`, for their Watchmode cache age. No UPDATE can extend
lifetime. Test direct child deletes while
their parents still exist and the existing cascading-delete paths. Cleanup removes
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
   cannot be directly deleted; older rows can. All UPDATEs are denied regardless of
   age/role, valid existing FK cascades still work, immutable age/config cannot be
   changed to bypass the window, and unrelated original immutable guards still hold.
6. Five-calendar-month refresh start and six-calendar-month retirement boundaries,
   bounded retries, transient boundary failure without retirement, failed/404 refresh
   without timestamp changes and ordinary retirement of a movie referenced by
   classification/snapshot/recommendation records. First-party history/UUIDs survive;
   no hard deletion, forged refresh, retired eligibility or stale readback assumptions.
   A retired movie retains first-party-sourced IDs and restores the same UUID after
   a later successful refresh; provenance distinguishes independently fresh
   Watchmode IDs from expired TMDB cache and applies each source's own retention.
7. Idempotent bounded cleanup, evidence expiry/unknown arrival, private cache/report
   expiry, no unneeded source copies and repeat actual synthetic-provider/disposable-pg
   composition with honest reports, pool shutdown and exact resource teardown.

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
