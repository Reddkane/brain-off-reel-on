# Watchmode verification and catalog follow-up

Stable-sort follow-up: October 5, 2026 UTC, a bounded Netflix US subscription
movie `/list-titles` call with `sort_by=title_asc`, page 1 and limit 5 returned
HTTP 200 and five titles, costing one free credit (status delta). Sweep requests
use limit 250; enrichment separately orders the supplied popularity percentiles.
No live sweep or retained database mutation was performed.

Date: October 4, 2026.
Verification baseline: `d6d6750` (local real-catalog #4).
Current planning baseline: `main` at `093f0c2`; catalog fixes #5 and CI image-pull/
Docker-timeout handling #6 are merged. Verification/fix work originally used
`fix/catalog-follow-up`; the revised plans use local `docs/availability-plans`.
Existing untracked `.claude/` is preserved.

## Authorized scope and prerequisites

The user's handoff authorizes the three local fixes below and requires verification
with a free Watchmode key before designing the availability integration. Watchmode
is the availability authority; TMDB remains the metadata source. Existing metadata
discovery and selection logic stays unchanged. TMDB AI-use licensing remains deferred to the
paid-tier stage by the user's decision; no gate is added here.

The retained `bor-catalog-local` container, `bor-catalog-local-pg17` volume and
`127.0.0.1:55432` catalog must not be reset, removed or used by tests. Verification
performed no database operation or import. No commit, publication, deployment,
account creation or paid action is authorized by this work. On October 4 the user
explicitly chose to keep all changes local while preparing the free-scan implementation.

## Local fixes and acceptance

- `test:metadata:db` prints only allowlisted lifecycle/suite failure codes. Work and
  cleanup failures in the disposable runner's AggregateError both remain visible.
  Unknown errors are generic; no retry is introduced. The historical main CI flake
  has no established root cause and was not reproduced here.
- `metadata-sql.ts` exports one code-owned column expression used by the metadata
  store's locking readback and the retained catalog's aggregate readback. Timestamp
  columns retain the existing UTC millisecond formatting and null semantics.
- The catalog failure-report write has a fixed two-second grace, independent of
  an exhausted finalization deadline. Only that local write uses the grace; it
  permits no extra provider/database work and preserves exclusive report creation.

Acceptance: offline code/redaction checks, actual metadata DB suites in two fresh
disposable cycles, and catalog DB acceptance including expiry after the successful
post-ingest readback. The expiry regression waits 25ms before completing the failure
report, so the former 1ms signal fails it. Temporary clock replacement is restored
in `finally`. Full repository checks run in a source/dependency copy without any
credential file. Metadata mutation controls exercise affected persistence checks.

## Live evidence

The user supplied `.env.local` as the Watchmode credential location. Only the
Watchmode key was selected, never printed or put in request URLs. Requests used
the fixed HTTPS API host, `X-API-Key`, no redirects, a ten-second timeout and a
serialized lane paced at least 600ms apart. Verification was bounded to 15 credits.

`/status` verified a 2,500-credit allowance, initially 0 used, finally 9 used.
Each charged request was bracketed by status checks; no other account traffic was
observed. These deltas establish the cost of these requests, not a universal
guarantee about metering or future plan access.

| US service | Verified source ID/name | Source type | Host source |
| --- | --- | --- | --- |
| Netflix | 203 / Netflix | sub | null (direct) |
| HBO Max | 387 / HBO Max | sub | null (direct) |
| Disney+ | 372 / Disney+ | sub | null (direct) |
| Hulu | 157 / Hulu | sub | null (direct) |

All four entries explicitly include US. Distinct directory entries include
Netflix Free 440, Hulu on Disney+ 634, HBO Max via Amazon Prime 490, Max Roku Channel
733 and HBO via Hulu 385. None replaces the four direct mappings. The source
directory did not expose separate Netflix, Disney+ or Hulu ad-tier entries. This
does **not** verify included-title access for a particular subscription tier.
The user's Netflix without ads, direct HBO Max Standard, and Disney+/Hulu bundle
with ads (without Live TV) stay explicit preferences. Ad-tier inclusion is unknown,
especially for Disney+/Hulu; service-level `sub` offers cannot confirm it.

Each `/list-titles` request used `types=movie`, `regions=US`, `source_types=sub`,
one verified `source_ids` value, `limit=250`, `page=1`. All returned 200 and 250
titles; total pages were Netflix 15, HBO Max 6, Disney+ 4 and Hulu 5. All 1,000
returned records had a TMDB ID. This first-page sample does not establish complete
coverage or rule out missing mappings on other pages. Returned fields were `id`,
`title`, `year`, `imdb_id`, `tmdb_id`, `tmdb_type`, `type`, `popularity_percentile`.
Joins must check movie type and canonical TMDB ID; absent IDs are reported without
guessing a title match.

| Service sample | Watchmode ID | TMDB ID | Matching offer |
| --- | --- | --- | --- |
| Netflix | 11018528 | 1514863 | sub / US / 4K |
| HBO Max | 1908308 | 1083381 | sub / US / 4K |
| Disney+ | 1543522 | 569094 | sub / US / 4K |
| Hulu | 1921622 | 1314481 | sub / US / HD |

Each `/title/{watchmode-id}/sources?regions=US` returned 200 and its matching direct
service. Observed source fields: `source_id`, `name`, `type`, `region`, `ios_url`,
`android_url`, `web_url`, `format`, `price`, `seasons`, `episodes`. Web URLs were
HTTPS destinations on netflix.com, play.hbomax.com, disneyplus.com and hulu.com.
They are returned destinations, not tested playback or verified entitlement.
iOS/Android fields contained the paid-plan restriction message rather than a URL;
that text must never be treated as a deep link. No ad-tier, leaving or expiry field
was present in these four matching offers. Missing expiry is unknown, not indefinite
availability. No arrival-date claim is supported by these samples.

| Endpoint used | Requests | Actual credit delta | Result |
| --- | --- | --- | --- |
| `/status` | 26 | 0 | 200 |
| `/sources?regions=US` | 1 | 1 | 200 |
| `/list-titles` (one US region) | 4 | 1 each | 200 |
| `/title/{watchmode-id}/sources` | 4 | 1 each | 200 |
| `/changes/new_titles` | 1 | 0 | 401 |
| `/changes/titles_sources_changed` | 1 | 0 | 401 |
| `/changes/titles_details_changed` | 1 | 0 | 401 |

Change probes used an explicit October 3 daily window, `limit=1`, `page=1`, with
US specified for source changes. Documentation marks these three endpoints as
paid-only and charges successful change pages one credit. Their successful cost
could not be verified using this free account. There was no automatic paid upgrade.

Ignored private evidence: `.cache/watchmode-verification/probe.json` and
`title-probe.json`; probe scripts contain no credential values. The initial sandbox
attempt could not verify connectivity; authorized network execution succeeded.
Raw non-image response caches must be refreshed or deleted within 30 days (by
November 3, 2026); reverify the mappings before reuse after that date.

## Terms and next implementation gate

[Watchmode API documentation](https://api.watchmode.com/docs),
[plan page](https://api.watchmode.com/) and
[terms, updated September 1, 2026](https://api.watchmode.com/tc) were checked on
October 4. The free plan is noncommercial with attribution required. Terms section
3 limits free-plan non-image caches to 30 days and requires deletion when the
account is cancelled/terminated. Image rights are separate; no images were fetched.
Record acceptance and attribution requirements in the future private terms config.

**Decision, October 4:** the user selected the free plan with bounded full scans.
Daily membership sweeps replace paid change endpoints; metadata/link work remains
incremental and resumable. The four observed page totals sum to 30, giving about
30 credits per sweep and 900 over 30 daily sweeps, excluding retries and per-title
source checks. Page counts may grow. Complete scans have not been run or timed.
The 30 pages allow up to 7,500 service/title memberships, not a verified count of
unique titles. All 1,000 sampled IDs support a possible TMDB join; identity matching
and successful TMDB detail retrieval still require validation.

The user explicitly allows Disney+/Hulu bundle-with-ads titles with unknown
title-level ad-tier access to be eligible, provided the UI shows `Ad-tier unverified`
and preserves availability-failure correction. No title is relabeled as confirmed
ad-tier inclusion. Other unpurchased variants/channels remain excluded. The full
[Availability: sweeps](availability-sweeps.md) and
[Availability: evidence](availability-evidence.md) plans record the decisions and
remaining work.

The remaining authorized follow-up needs its concrete
implementation plan and acceptance evidence: balanced per-service sourcing and
selected/persisted counts; TMDB detail/store reuse; paced Watchmode requests;
per-run credit cap and locked `/status` preflight that refuses when remaining quota
is below the whole run cap, with actual observed spend in the exclusive report;
availability
refresh/deletion within 30 days; six-month TMDB metadata refresh/purge; bounded
resumable work; enforced single-run lock; retained target guards, private terms
config, exclusive reports, readback crosschecks, offline defaults and credential-free
CI. The user's revised review drops the persisted credit ledger. Hosting owns the
protected cron handler and cron-denial tests. Complete promoted sweep omission
supplies absence evidence; drift-aware arrival and the ordinary age-based retention
migration belong to Availability: evidence. Ad-tier uncertainty remains distinct
from confirmed inclusion.

## Validation and review evidence

| Check | Result |
| --- | --- |
| `npm run check` | Final exit 0: typechecks, zero-warning lint, 269 offline tests and production build in `.cache/catalog-follow-up-check`, without credential files. |
| `npm run test:metadata:db` | Exit 0: 22 tests in each of two fresh PostgreSQL 17.11 cycles; exact test-owned container/network teardown verified. |
| `npm run test:catalog:db` | Exit 0: 17 tests, including expired finalization reporting and A1 same-volume/different-container persistence; exact test-owned teardown verified. |
| `npm run test:metadata:controls` | Exit 0: all seven named expected-red assertion controls, restored source, then final offline and two-cycle DB green in the isolated copy. |
| Change-set review | Tracked changes plus the three new files reviewed; no dependency, migration, metadata selection, credential or `.claude/` changes. |

Initial ordinary-sandbox DB commands refused Docker with `docker_version_failed`
and `docker_failed`; authorized Docker-access execution passed. Initial offline
execution had two lint-probe timeouts; the isolated final checks passed without
changing test timeouts or skipping tests. The isolated Next build emitted the
existing nested-lockfile workspace warning; the build succeeded. These local
results do not establish the historical main CI flake's cause or new remote CI.

Self-review covered secret redaction, unchanged SQL projections/locking, report
grace limited to local writes, actual CLI diagnostic refusal and restored validation
mutations. The user subsequently supplied Claude's approval of all three fixes;
Claude explicitly did not rerun the suites. Remote CI has not been performed.
The original fix/verification pass made no commit or push; the fixes subsequently
merged in #5, followed by #6. Private check/control logs remain ignored under the
isolated copy. The new plan review requests are reflected in the two availability
drafts; their implementation/re-review remain pending. Earlier fix approval does
not approve the new plan implementation or migration.

Retention must account for the released immutable snapshot/classification/history
constraints; deleting referenced movie rows is not an existing supported shortcut.
Any required schema change must be planned and verified on disposable resources
before applying anything to the retained catalog. The currently retained metadata
has not been refreshed or purged by this follow-up.

TMDB discovery fallback is not selected. Verified company-to-origin rules belong
to a focused follow-up in the metadata/mapping area before ranking enables origin
variety; availability membership cannot supply production-origin evidence.
Production `origin-v1` has no verified rules, and this work fabricates none.
UI attribution belongs to the UI work; application endpoint rate limits remain
API, sessions and Auth work. Those deferred areas are not implemented here.
