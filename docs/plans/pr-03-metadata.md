# PR 3: Metadata boundary, bounded ingest, and resolved ratings

Date: October 3, 2026
Status: Implemented on `implementation/pr-03-metadata` following the user's subsequent authorization; approved by the supplied re-review after the ANSI-color correction and successful controls rerun; ready for separately authorized commit. The approved specification and historical planning record below are retained. Section 14 records implementation evidence; section 15 supplies the checkout review prompt. No credentialed or real-data work was performed.

Specification: [architecture](../architecture.md), especially sections 3, 5, 8–11; [engineering](../engineering.md); [PR 2 storage and evidence](pr-02-schema.md). Architecture owns product behavior; this plan settles PR 3 engineering choices. Advisory implementation/review: GPT-6.1 Sol / High, fresh independent review; no model switching or delegation implied.

## 1. Baseline and scope

Inspected root AGENTS.md, README, architecture, engineering, PR 2 plan, source, all three migrations, bootstrap, runner, test/configuration files, package/lockfile and CI. Root guidance applies; no nested repository guidance was found outside ignored dependencies. Actual branch is `main`, HEAD `73dfa57` (#2), following merged PR 1 foundation/CI. Initial tracked tree is clean; untracked `.claude/` is pre-existing work and must be preserved. Git's inaccessible user ignore-file warning does not invalidate the repository inventory.

**Confirmed by the user:** PR 2 merged, CI passed, independent re-review approved all five corrections and independently passed the database suite; both subsequent nonblocking nits were fixed and validated. Historical pending review/CI/publication prose in PR 2 and older architecture status is superseded by that supplied status. This planning task does not independently rerun those suites or query remote CI.

Actual tooling: Node 24.14.0/npm 11.9.0; pinned Next 16.3.8, React/React DOM 19.3.0, TypeScript 6.0.3, ESLint 9.39.5, eslint-config-next 16.3.8, Vitest 5.0.3, @types/node 24.19.1 and React types 19.3.0. Existing `npm test` discovers only the foundation boundary file. `npm run check` is typecheck/lint/test/build. The separate database CI job has no npm install and runs the built-in Node runner plus PostgreSQL tests. Both jobs use pinned actions, Node 24, read-only permissions and no secrets.

Include metadata/discovery interfaces and TMDB adapter, evidence normalization, versioned origin mapping, namespaced identity resolution, bounded repeatable catalog persistence, resolved ratings import, private diagnostics and synthetic acceptance tests. Populate only movies, movie_external_ids, movie_credits and profile_movies; use refresh_runs for metadata-run progress. Discovery consumes supplied exact provider mappings, without creating subscriptions or provider identities.

Exclude per-title watch-provider calls/observations, availability eligibility or arrival inference, scheduled refresh/cron/leases, classification workflow, ranking, API/Auth/session orchestration, UI/settings/PWA, infrastructure/deployment and real-data execution. Do not touch classification, snapshot, track, session or recommendation data. No streaming credentials or personal preferences are inferred.

**Local execution choice (H1/H3):** implement a reusable pg store, provider adapter, orchestration and diagnostics, composing them only with synthetic fixtures and a dedicated disposable database in PR 3. Keep PR 2's runner/isolation checks unchanged. A separate real-catalog step is confirmed for immediately after PR 3, before PR 4/5 live validation; it adds persistent local composition/configuration without new ingest logic (section 11). No retained/hosted environment or real-data execution is implemented or performed in PR 3. The user has no existing watch/ratings history; section 7 therefore specifies a small hand-written seed rather than an export importer.

## 2. Contracts and ownership

Use readonly records, explicit discriminated outcomes and runtime decoders from `unknown`. Domain code imports only relative domain modules; recommendation behavior remains unchanged, with its existing type export receiving an explicit .ts specifier for Node resolution. Effects depend inward on domain; domain never imports server, framework, Node, provider shapes, storage or fixtures. Time, policy, mapping and existing state are arguments. Hashing, fetching, UUID generation, files, sleeping, Docker lifecycle and persistence stay outside domain.

| Contract | Exact normalized content |
| --- | --- |
| ExternalMovieKey | `{source: 'tmdb' | 'imdb', externalId: string}`; TMDB movie ID retains TmdbMovieId brand. Namespace supplies movie context. Other namespaces are rejected by this adapter, not coerced. |
| DateEvidence | `{date: YYYY-MM-DD, source: string, semantics: 'original_release'|'theatrical'|'digital'|'other', checkedAt: UTC instant}`; nullable as a whole. Source identifies endpoint, country/type and selection-policy version. |
| CertificationEvidence | `{value: 'G'|'PG'|'PG-13'|'R'|'NC-17'|'NR', source: string, checkedAt: UTC instant}` or null. NR is not an ordered rating. |
| CompanyEvidence | `{source:'tmdb', external_id:string, name:string, checked_at:UTC instant}`. This is TMDB's company association, not verified financing/commissioning. |
| OriginEvidence | PR 2 element keys `{source,checked_at,relationship,company_source?,company_external_id?,evidence_text,reference?}`; relationships commissioning/financing/production/co_production/acquisition/distribution/uncertain. Qualified classifications require references. |
| OriginResult | `{group: streamer_produced_financed|traditional_studio|independent|mixed|unknown, evidence: OriginEvidence[], mappingVersion: string, checkedAt: UTC instant, issues: Issue[]}`. Persist unknown with version/time too, so failed coverage is attributable. |
| MovieMetadata | `{keys: ExternalMovieKey[], title, release:DateEvidence|null, runtimeMinutes:number|null, originalLanguage:string|null, certification:CertificationEvidence|null, overview:string|null, posterPath:string|null, genres:string[], keywords:string[], companies:CompanyEvidence[], origin:OriginResult, rating:number|null, voteCount:number|null, credits:Credit[], metadataSource:'tmdb', checkedAt:UTC instant}`. No internal movie UUID until resolution. |
| Credit | `{source:'tmdb', personExternalId:string, name:string, role:string, billingOrder:number|null}`; cast role `cast`, crew exact `job` text, limited to Director/Writer/Screenplay. Cast capped at 20 by order then ID; missing order sorts last. Same person/role deduplicates, conflicting names emit an issue; character text is not a role key. |
| Issue | `{code: allowlisted string, field?: allowlisted path, severity:'info'|'warning'|'error'}`. No arbitrary provider text or personal row content in normal diagnostics. |
| DiscoveryBatch | `{id, providerKey:TmdbProviderId, cohort:'recent'|'older'|'undated_probe', originProbe:'unfiltered'|'streamer'|'studio'|'independent', sort, dateBounds, companyIds:string[], page:number}`. Full provenance retained separately from verified title fields. |
| DiscoveryPage | `{batchId,page,totalPages,totalResults,candidateKeys:ExternalMovieKey[],issues:Issue[]}`. Totals are provider claims, not catalog size. |
| ProviderResult<T> | `ok {value,issues}` / `not_found` / `invalid {issues}` / `failed {code,retryable}`. Empty successful collections stay distinguishable from failures. |
| CatalogWriteResult | `created` / `updated` / `unchanged` / `stale` with MovieId, or `identity_conflict` / `catalog_limit` / `failed`; never return an external ID as MovieId. |
| RatingsResult | Batch `applied` / `unchanged` / `unresolved` / `conflict` / `unauthorized` / `invalid` / `failed`, with counts and row indices only. Ratings keys are TMDB-only; metadata still retains provider-supplied IMDb mappings for cross-checks/deduplication. |

Provider port in `src/server/providers/metadata-provider.ts`: `discover(batch, context)`, `getMovie(tmdbKey, context)`. Context supplies abort signal, clock and remaining request budget; provider factory receives injected fetch/sleep and a token only at effect composition. No find/title-search/availability method or generic provider registry. getMovie requires all selected appended metadata components to be present and validate before returning a writable aggregate. Discovery summaries never stand in for detailed metadata.

Persistence port in `src/server/db/metadata-store.ts`: `persistMovie(metadata, limits)`, `resolveMovie(tmdbKey)`, `applyRatings(operatorContext, resolvedSeed)`, `recordRun(progress)`. applyRatings authorizes before reading existing personal state and reports conflicts without a review/override protocol. No arbitrary SQL port exposed to scripts. OperatorContext is created by trusted composition with catalog-write capability or exact profile authorization; IDs/roles/capabilities cannot come from ratings files or provider data. The reusable store accepts a pg pool from trusted composition; only test tooling constructs disposable targets. Runtime UUID constructors validate before branding; narrowly scoped brand construction belongs to effect decoders and receives compile/runtime negative tests. New pure modules obey existing assertion-free rules.

## 3. Official TMDB facts and normalization policies

Public documentation and the official OpenAPI were read on October 3, 2026, without authentication or API calls. The web tool timed out on OpenAPI; a read-only public-document fetch succeeded. No provider responses were recorded. OpenAPI fields/examples confirm structure, not completeness, accuracy, nullable behavior or universal semantics. Synthetic fixtures are invented contract cases, never described as captured TMDB records.

| Endpoint / official reference | Confirmed facts; planned use |
| --- | --- |
| [Discover](https://developer.themoviedb.org/reference/discover-movie) | `GET /3/discover/movie`: watch_region, with_watch_providers, monetization, primary_release_date bounds, company filters, page and sort. Region changes returned release-date semantics. Comma/pipe support AND/OR for documented filters. Candidate sourcing only. |
| [Movie details](https://developer.themoviedb.org/reference/movie-details), [OpenAPI](https://developer.themoviedb.org/openapi/tmdb-api.json) | `GET /3/movie/{id}`: title, release_date, runtime, original_language, genres `{id,name}`, production_companies `{id,name,origin_country,logo_path}`, overview, poster_path, vote_average, vote_count, imdb_id, adult/video. The schema has sparse required/nullability descriptions; no financing/commissioning field. Reject adult/video records for this movie seed policy, not as a personal content preference. |
| [Release dates](https://developer.themoviedb.org/reference/movie-release-dates) | `GET /3/movie/{id}/release_dates`: country groups with certification, release_date timestamp, type, language/note/descriptors. Types 1 premiere, 2 limited theatrical, 3 theatrical, 4 digital, 5 physical, 6 TV. |
| [Keywords](https://developer.themoviedb.org/reference/movie-keywords), [credits](https://developer.themoviedb.org/reference/movie-credits) | Separate keyword `{id,name}` collection and cast/crew collections. Cast has order; crew has job, not cast billing order. |
| [External IDs](https://developer.themoviedb.org/reference/movie-external-ids) | Movie external IDs include IMDb, retained for metadata cross-checks and exact mapping conflicts. Ignore social IDs. No find endpoint or IMDb ratings input. |
| [Movie provider list](https://developer.themoviedb.org/reference/watch-providers-movie-list) | Lists providers with optional watch_region; names/IDs describe entries, not the user's subscriptions. Read-only listing may help later manual selection; exact variant establishment/persistence stays PR 4. |

Use one request per detail aggregate: `GET /3/movie/{id}?language=en-US&append_to_response=release_dates,keywords,credits,external_ids`. Official [append_to_response documentation](https://developer.themoviedb.org/docs/append-to-response), checked during revision, confirms multiple same-namespace subrequests become named objects in one response. The four selected movie subresources are documented above. Validate root ID and every response movie ID that the subresource contract supplies against the requested ID; all four named components must be present, correctly shaped and successful. No default-empty substitution or separate-request fallback on missing/malformed appended objects. Check root imdb_id against external_ids.imdb_id if both present; disagreement is identity_conflict. An invalid component prevents writes for that movie; existing good data survives. Synthetic combined responses exercise this path; live compatibility remains separate.

**Release policy `tmdb-release-v1` (H6):** do not persist discovery.release_date as authoritative, or label an undocumented primary date original_release. Select the earliest valid US event of types 2/3/4. If none exists, fall back to the earliest valid worldwide event of types 2/3/4/5/6. Type 1 premieres/festivals never supply the persisted date or move a title into the older cohort; premiere-only evidence yields null and `release_ambiguous`. Type 2/3 maps theatrical, 4 digital, 5/6 other. Record selected country/type and `US` versus `worldwide_fallback` plus policy version in source/diagnostics. Cohort uses that persisted selected date, not a festival/primary discovery date. This is an observed typed release, not a guarantee of worldwide first release.

Drop note parsing entirely: free-text notes may be retained as bounded evidence text but never identify a re-release or affect selection. Primary date is a consistency check only. For a US selection, a primary date earlier than the US event is allowed (premiere/foreign release); a primary date later than it is contradictory and yields null + release_ambiguous. For worldwide fallback, a primary date earlier than the chosen event with no earlier typed event (including premiere) explaining it, or later than the chosen event, yields null + release_ambiguous. An explained earlier premiere still does not replace the typed date. No non-premiere dates means null. This narrow rule cannot detect every re-release/cut and is tested/documented as a limitation. Future dates remain dates, but future cohort is separate and never treated as freshness. Parse real calendar dates strictly (including leap years); take the provider's date component rather than shifting release dates by the host timezone. Accept documented ISO timestamps with valid offsets; reject impossible dates/offsets. Unknowns remain in discovery diagnostics/pool. No new original_release claim is made without documented evidence.

**Certification policy `tmdb-us-certification-v1`:** inspect US records only. Ignore blank certification as missing, never convert blank to NR. Prefer theatrical types 2/3; if absent, digital type 4. At that tier require one distinct recognized code across records. Conflicting codes, unfamiliar codes at the selected tier, or no supported tier yield null triple and an issue; do not pick the least restrictive or “latest” code for an unidentified cut. NR only comes from explicit NR. Source string records endpoint/US/tier/policy; checked time is supplied fetch time, not certification issuance. Preserve compact US record evidence in private bounded run reports for inspection, not personal history. The existing schema stores a selected tuple, not all certification events; no historical certification store is required by PR 3.

Runtime null/zero is unknown; negative/wrong type invalid. Original language does not establish available audio. Unknown optional strings become null only for documented empty/null absence; arbitrary wrong types are invalid. Genre/keyword arrays are deduplicated and stably sorted names, not title identity. vote_average zero with zero votes becomes unknown rating; validate finite 0–10 values, round to two decimals for numeric(4,2), retain vote_count including zero. Poster is a validated relative image path, not a URL: reject traversal, query, fragment, scheme, backslash and control characters. No homepage/image fetch or HTML interpretation. Later URL construction uses documented [image configuration](https://developer.themoviedb.org/docs/image-basics); PR 3 stores only the path.

Not confirmed: data completeness; whether every company entry distinguishes production from distribution; canonical worldwide primary-date meaning; exact variant coverage; live page size/max usable page; title uniqueness; legal retention allowance. Do not build correctness on these assumptions. Local page ceiling is 5 independently of any provider maximum, results-array ceiling 100. Recheck contract drift and caching/retention terms before any separately authorized live use. [FAQ](https://developer.themoviedb.org/docs/faq) requires attribution for noncommercial use and separate commercial licensing; it does not establish unlimited retention rights. No licensed distribution, UI attribution work or commercial approval is claimed.

## 4. Versioned production-origin evidence

Use a small checked-in `src/server/ingestion/origin-mapping.json`, decoded at startup into pure rules. Real mapping entries require namespace/ID, display name for review only, group, relationship, date applicability, scope (`company` or `movie`), reference HTTPS URL, short evidence excerpt/paraphrase, checked date and limitations. Version `origin-v1` is immutable once used; changes create a new version. Snapshot qualifying rules into each movie's origin_evidence, so overwritten mappings cannot erase the basis. No company-management subsystem, automatic web research, ownership graph or classification/review UI.

Implementation must curate a small primary-source-backed seed: at least one unambiguous production entity per streamer/studio/independent category, or explicitly record an unverified/missing category and leave its probe disabled. Verify TMDB ID/name correspondence from official sources; never put synthetic IDs in the production mapping. Do not classify an entire distributor/platform merely because it sometimes produces films. Prefer title-specific commissioning/financing/production evidence where a company has multiple roles. A company rule is applicable only when its primary-source evidence supports the production entity and period in question; ambiguous role/date/name/ID yields unknown. Company ownership/brand alone does not prove each film's funding. This is a manual evidence-curation acceptance gate, not a personal-preference blocker.

Pure derivation `deriveOrigin(companies, movieKey, releaseEvidence, rules, at)` collects applicable qualifying production/financing/commissioning/co-production evidence. One fully supported group gives that group; multiple supported groups give mixed. An unassessed additional company or conflicting evidence gives unknown with partial evidence, rather than asserting a complete sole-origin classification. Explicit title evidence covering the production relationship may resolve that uncertainty. No matching company, only acquisition/distribution, “Original” marketing, availability, name substring, countries or absence from known studios gives unknown. Independent requires affirmative evidence, not absence of streamer/studio entries. Unknown/mixed are preserved without penalty, exclusion or fixed quota. Mapping-probe labels never overwrite derived groups.

Tests use a separate clearly labeled synthetic mapping fixture with positive cases for all groups, mixed co-production, ownership/role changes, missing dates, name collision, distribution/acquisition-only, marketing-only, extra unknown company and rule-version changes. Production modules must not import this fixture. Curated real rules receive source/shape/applicability review; synthetic tests alone cannot prove their truth.

## 5. Bounded discovery and diagnostics

Configuration `discovery-v1` requires explicit UTC asOf date, US region, 1–8 supplied exact TMDB provider IDs, and mapping version. Local acceptance uses invented subscriptions. Do not read personal profiles to source catalog discovery or persist provider mappings/subscriptions in this PR.

Recent is `[asOf minus 730 calendar days, asOf]`; older is before that lower bound (strict disjoint boundary). This is a sourcing window, not PR 6 freshness decay. Build per-provider/per-cohort batches with two sorts: popularity.desc and primary_release_date.desc for recent; popularity.desc and vote_count.desc for older. For each of those add unfiltered and up to three supported company-origin probes. Each company list is OR-separated, max 10 IDs/group; more requires explicit configuration rejection, not silent truncation. No without_companies “independent” inference. Request with watch_region=US, that one provider ID, with_watch_monetization_types=flatrate|ads|free (OR), language=en-US, include_adult=false, include_video=false and primary_release_date bounds; omit region to avoid its documented release-date substitution. Ad-tier IDs remain distinct; these broader candidate filters avoid missing ad-tier services and never establish subscription entitlement or verified offers. Detail normalization uses the US-preferred release policy, so source cohort and persisted cohort can differ and both are reported.

An additional one-page unfiltered, undated_probe per provider removes date bounds and uses title.asc. It can expose unknown/future/older records; it cannot claim exhaustive missing-date coverage. After detail normalization, report actual release cohort recent/older/future/unknown and origin group independently of query cohort/probe.

Limits (hard-coded maximums, configurable downward only): 5 pages/batch; 100 result elements/page; 8 providers; at most 136 batch definitions (8 × [2 cohorts × 2 sorts × 4 probes + 1 probe]); 400 distinct discovery-page operations/run (failed operations also consume a slot); 500 distinct selected discovery titles; 100 additional distinct ratings titles; 600 combined detail operations/run; 1,000 total movies in the catalog (existing records count); 1,500 HTTP attempts/run including retries and optional provider listing; 30-minute wall-clock run deadline. One optional provider-list operation costs one request. No find/title-search allowance. Cache each validated aggregate by TMDB key within the run, including ratings overlap, so a detail is fetched only once before retry accounting. Targeting 500–1,000 is not mandatory: stop/report when limits bind.

**H4 budget arithmetic:** 400 discovery + 600 appended detail + 1 optional list = 1,001 initial requests. The 1,500-attempt cap leaves 499 retry attempts (approximately 50% of the initial request count); each operation still permits at most two retries, but the run does not promise two retries for every operation. At 2 starts/sec, initial pacing is approximately 500.5s (8m21s), and all 1,500 attempts require approximately 750s (12m30s) of pacing. Reserve an aggregate 5-minute database-work budget, 30s setup and 30s final diagnostics/cleanup: pacing + DB + lifecycle is at most 18m30s, leaving 11m30s for response latency/backoff/other work within 30 minutes. This is scheduling headroom, not a worst-case completion guarantee: 10s timeouts on every attempt or repeated Retry-After waits can exhaust time earlier. Deadline and cumulative DB-work budget stop/checkpoint partial runs rather than claiming all 600 titles complete under arbitrary failures. Stop new work at 29m30s, bound the active operation by remaining time and reserve the last 30s for finalization. The disposable synthetic CI runner uses smaller workloads and a separate deadline, specified in section 10.

Schedule deterministic rounds across provider/cohort/sort/probe before taking second/third pages, stable by supplied provider ID/batch ID. Empty supported probes are recorded; unverified mapping probes are `not_configured`, not zero-result successes. Merge page IDs into a namespaced set; retain all batch memberships and duplicate counts. Select detail candidates in first-seen round order with ID tie-breaking within page; reserve the 100 ratings slots independently so catalog discovery cannot starve them. Exhaustion/malformed pages and totalPages smaller than next page stop that batch. Repeated identical page fingerprints with no new IDs stop with page_stalled. Changing claimed totals are diagnosed. No unbounded pagination or random sampling. A bounded rerun is repeatable in writes/order for identical inputs, not a promise that TMDB's mutable catalog yields identical candidates.

Catalog size cap is checked under the persistence lock; existing title updates do not consume new slots. No pruning or hard deletion to meet the cap. Reruns may consume new capacity until the cap, then clearly report `catalog_limit`. Results and checkpoints contain provider/batch/page completion, unique/duplicate/selected/resolved/persisted/failed counts, source vs normalized cohort counts, origin unknown/mixed counts, missing certification/runtime/date/company counts, ambiguity counts and each bound's truncation reason. Separate requested/not_configured/empty/failed/truncated groups. Report service candidate memberships without claiming verified offers, eligibility or representative proportions. PR 4–6 add availability/filter/scoring stages; PR 3 reports those as not_measured.

refresh_runs job_name `metadata_ingest_v1` records summary/checkpoint with discovery policy/asOf/mapping version and bounded page cursors/counts. A crash may leave running; no takeover lease or resume promise. Restart rediscovery with a new run, relying on idempotent title writes. Only advance committed-write counters after commit. Run/report failures cannot roll back earlier title commits and must produce a nonzero/partial result. No provider payloads or ratings content stored in general diagnostic_summary.

## 6. Identity, transactions and repeated runs

Accept canonical decimal TMDB text `[1-9][0-9]*` bounded to positive int32 because official path IDs are int32; convert validated numeric response IDs to canonical text once. Reject leading-zero TMDB input, floats, unsafe integers, negative/zero, URLs and exponent strings. Provider-supplied IMDb metadata IDs must be `tt` plus 7–10 decimal digits; never strip their leading zeros. They are not an accepted ratings input namespace. These adapter rules do not change PR 2's general external text storage. UUID parser rejects malformed internal IDs at entry.

Only exact `(source,external_id)` resolves automatically. Ratings supply TMDB IDs only: resolve the existing tmdb mapping or fetch/validate/persist the uncataloged movie within the shared 600-detail budget. A missing/invalid movie or exhausted budget leaves the ratings row unresolved and prevents personal apply. Metadata may retain provider-supplied IMDb mappings for exact-key deduplication/conflict detection, but no IMDb input/find/title lookup is implemented. Distinct TMDB IDs without a shared supported external key remain separate even when title/year match; report possible duplicates, never merge. Same namespaced ID resolves once across batches/reimports.

Each movie is one database transaction: authorize catalog capability, acquire a transaction-scoped catalog advisory lock, then read all supported keys and lock the resolved movie, validate mapping ownership, check catalog cap/freshness, write aggregate+new mappings+TMDB credits, commit. A fixed global catalog lock serializes PR 3 catalog transactions conservatively; no provider requests inside it. Read after acquiring the lock in a separate statement under READ COMMITTED to see prior commits. Lock key is an application constant, not user text. Existing UNIQUE(source,external_id), PK(movie_id,source), FK constraints remain final enforcement against writers that do not take this lock.

No matching keys: generate UUID in Postgres and atomically create movie/mappings/credits. One movie matches all known keys: update it and attach missing keys only if its namespace slot is free. Keys pointing to two movies, a different existing TMDB/IMDb slot, or mismatch between root/appended IMDb are conflict: zero mutations. Never repoint/delete mappings, merge rows, delete historical movie data or use ON CONFLICT DO NOTHING to conceal inconsistent identity. The global advisory lock prevents importer self-races: a unique violation (23505) from another writer rolls back and fails that movie as `constraint_conflict`, with no reread/retry. CHECK/permission errors are classified failures, not identity conflicts. Statement timeout 5s, lock timeout 2s and transaction deadline 10s, all capped by remaining run/DB budgets. No automatic database retry is planned: the serialized READ COMMITTED catalog path and deterministic ratings lock order provide no demonstrated importer deadlock/serialization retry requirement. If implementation proves a reachable path, propose a tested bounded retry amendment rather than adding speculative retry logic.

Metadata refresh accepts strictly newer supplied checkedAt. Older is stale; equal time/equal canonical aggregate is unchanged; equal time/different aggregate is conflict. Newer complete successful metadata may clear a previously known optional value to unknown when the provider now explicitly lacks it; warn/count changed-to-unknown, never confuse failure with absence. Retain created_at/internal UUID, other-source credits/mappings and all personal state. Replace only TMDB credit rows within the same transaction after complete validation. Identical aggregate at newer time advances metadata_refreshed_at/evidence check times but creates no duplicate identities/credits. No full metadata history table is implied; later trace/classification writers freeze actual inputs as already required.

Partial run: good movies commit independently; failed movie leaves all its previous rows intact. Ratings writes begin only after all required ratings movies resolve; discovery failures do not veto an otherwise resolved ratings batch. Cancellation/crash rolls back the current transaction, prior commits survive; rerun is safe. Concurrent same-key creation produces one UUID; equal titles with distinct keys remain distinct. Conflicting mappings produce zero partial writes, older updates cannot win over newer. Test two real pg connections with JS-controlled barriers (pause the first after lock acquisition, start the second, release the first without waiting for the blocked second), not only Promise.all against a mock. Also inject an external-writer constraint conflict and prove rollback/no retry.

## 7. Minimal ratings seed and deterministic apply

UTF-8 JSON, version `ratings-v1`, max 256 KiB/100 rows, strict keys:

```json
{
  "version": "ratings-v1",
  "synthetic": true,
  "rows": [
    {"source": "tmdb", "external_id": "900001", "watched": true,
     "taste_rating": "liked", "tired_viewing_rating": 3}
  ]
}
```

The user has no existing history; this is a small hand-written seed, not a migration from an export. Example ID/value is invented SYNTHETIC TEST DATA, not a real rating/title. Executable disposable mode requires synthetic=true. Each row requires source='tmdb', canonical decimal external_id and at least one personal field; optional fields watched:boolean, watched_on:strict date, taste_rating:loved/liked/meh/disliked, tired_viewing_rating:integer 0–4. Reject any other source. No profile/account IDs, permanent_exclusion, URLs, internal UUIDs, CSV/export parser or scale conversion. Watched/date/taste/tired signals are independent: missing is no requested change; null is rejected rather than a silent clear; ratings do not imply watched; watched=false plus watched_on is invalid; future watched_on relative to supplied asOf is invalid. A new-row date requires explicit watched=true; for an existing row with omitted watched it requires stored watched=true. Existing exclusion remains untouched. Empty rating fields do not mean dislike. Tired-scale meanings are later user input, not invented values.

Resolve exact TMDB keys first, fetching uncataloged keys through the same aggregate/detail budget as discovery. Report unresolved/conflicting row indices and counts; no private review document, title candidates, saved confirmation mapping or override workflow. Catalog mappings are ordinary movie_external_ids from metadata resolution, not personal matching decisions. Conflicting duplicate rows resolving to the same movie reject the batch; identical duplicates coalesce deterministically.

Default apply policy inserts absent profile/movie state and fills only absent taste/tired/date fields or accepts equal values. Existing watched booleans are meaningful (including false): a different value is a conflict, not a fill. If existing watched=false and a supplied date would require watched=true, report conflict. Omitted new-row watched defaults false per schema; rating import does not imply a viewing. Reimport identical input/state is unchanged with no timestamp update.

Changing an existing value later happens in-app, not by reimport. The seed has no override/--force path: differing existing values are conflicts and remain unchanged. Apply locks the authorized profile row, locks existing profile_movies rows FOR UPDATE in MovieId order and resolved mapping rows FOR SHARE, then rereads current state in a subsequent statement and verifies exact mappings and fill-absent/equal-value rules for every row before any personal write. Commit the entire max-100-row personal batch or none. These locks also protect against direct permitted personal writers that do not take the importer profile lock. An absent-row insertion race hits the existing unique constraint and rolls back the batch; never ignore/retry that conflict. Concurrent changes are evaluated from the locked state, producing unchanged/fill-absent or conflict without silent overwrite. Profile deletion before/during import denies/rolls back; creation locks synchronize with FK deletion. Different profiles remain isolated. Catalog resolutions already committed are retained if personal apply fails; state this in the report.

Authorization occurs before personal reads, reports and writes, independently of BYPASSRLS. The local composition authorizes only a synthetic profile it created in the inspected disposable database. An injected capability never means “any profile supplied by caller.” Test forged/missing capability, foreign B profile, null-owner profile and missing/deleted profile: no personal read/write or provider call. PR 7 separately verifies real Auth identity and Data API exposure; synthetic SET ROLE/claims do not prove those.

## 8. Effects, security and reusable PostgreSQL access

Choose **pg 8.23.1** (runtime) and **@types/pg 8.23.1** (dev): one checked-out client makes transaction ownership and JS-controlled concurrency explicit, with a reusable store instead of a disposable transport. Exact versions/MIT licenses were checked against public [pg metadata](https://registry.npmjs.org/pg/latest) and [@types/pg metadata](https://registry.npmjs.org/@types%2Fpg/latest) during revision; pg declares Node >=16, compatible with Node 24. Implementation reviews transitive lockfile changes/license/security findings and type compatibility; no package is installed now. No other new direct dependency, SDK/ORM/tsx/schema-validator is authorized. Retain Node 24 built-ins, existing Vitest, Docker and pinned PostgreSQL 17.11 image index `postgres:17@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`.

Node 24 [executes erasable TypeScript by default](https://nodejs.org/docs/latest-v24.x/api/typescript.html); commands use `node file.ts` without experimental flags. Explicit `.ts` relative specifiers are required throughout the Node-executed graph, including existing src/domain/movie-identity.ts (`./ids.ts`) and src/recommendation/index.ts (`../domain/movie-identity.ts`). Add allowImportingTsExtensions=true to both tsconfig.json and tsconfig.pure.json (noEmit retained); add scripts/**/*.ts and tooling/**/*.ts to root includes. Use type-only imports, no aliases/enums/parameter properties in the runtime graph. Load mapping JSON through effect-owned fs/JSON validation rather than relying on Next/bundler JSON import behavior in Node. Actual dry-run/local commands on Windows and CI, pure typechecking and next build must prove resolution; a real-config lint probe must still reject forbidden .ts-extension imports. This paragraph specifies future validation, not an execution result from planning.

**PR 2 unchanged:** tooling/db-test.mjs, its no-network/no-ports/tmpfs/marker checks, runner tests, SQL suites, released migrations and existing CI database job stay as released. Do not factor or relax that runner. PR 3 owns a separate tooling/metadata-disposable.ts lifecycle with unique bor-pr03 names/run labels, pinned image, tmpfs data, no host mounts or persistent volumes, generated bootstrap and bor_migrator login credentials, and a private per-run Docker bridge network. Publish only `127.0.0.1:<Docker-assigned-ephemeral-port>:5432`; inspect exact container ID/name/labels/network/tmpfs and exactly one live loopback TCP port mapping before opening pg connections. Teardown verifies the same identity/isolation plus the requested HostConfig.PortBindings, without requiring live mappings from an exited container. Reuse PR 2 bootstrap/migration SQL files as test inputs in documented order, including its REFERENCES prerequisite, without editing them; credentials are assigned only in disposable test setup. Bootstrap platform roles use postgres only for privileged role/auth setup; migrations/fixtures/inventory use bor_migrator, application DML never postgres. Private network/container creation and startup are bounded; try/finally closes all pools/clients, reinspects identities, removes only created container/network IDs and verifies absence on success/failure/abort. No host mounts, real database/reset mode or external target accepted by flag/env. Generated secrets must not enter command arguments/logs; feed bootstrap credentials privately through stdin with safe setup parameterization. Missing Docker, unexpected binding or teardown failure is a loud failure.

**N1 disposable SQL target guard:** the unedited tests/db/bootstrap.sql requires database `bor_pr02_test` and inserts `test_support.marker(name='bor-pr02-disposable')`. PR 3 therefore uses that database name/marker; only container/network names and run labels use bor-pr03. The pg store's test composition must verify `current_database() = 'bor_pr02_test'` and the marker row on every checked-out connection, including reused pool connections, before any application DML. Run the guard as bor_migrator before SET LOCAL ROLE service_role, since API roles cannot read test_support. Wrong database, missing/wrong marker, or a failed guard query refuses DML, rolls back any open transaction and discards the connection with a controlled diagnostic. Container inspection does not replace this SQL guard. Keep guard construction in test tooling, injected into the store's checkout path; production modules never import bootstrap/tests or require a disposable marker on a future retained target. A real negative test replaces the marker with a wrong value using test-admin setup, calls the actual store path and proves zero application DML/unchanged catalog and personal rows; restore the marker and require a permitted positive control. Also cover wrong database and checking again after pool reuse.

Use fixed reviewed SQL with pg query text and values arrays (`$1`, etc.), never interpolated values or identifiers; table/column/role names are code constants. [Transactions use one checked-out client](https://node-postgres.com/features/transactions): pool.connect, BEGIN, fixed SET LOCAL ROLE service_role, bounded statements/locks, COMMIT; on error ROLLBACK, then release or destroy an unusable connection. Never use pool.query for statements in a transaction. Return success only after COMMIT succeeds. Do not name prepared statements. No new functions or generic repository framework. Reusable pg-store construction accepts explicit trusted connection configuration; test composition supplies the inspected loopback target and generated credentials, ignoring host DATABASE_URL/PG* variables. Catalog/personal authorization checks are independent of the privileged login and service role.

Pool maximum 2 application connections, connection acquisition/connect timeout 5s, transaction deadline 10s, server statement_timeout 5s and lock_timeout 2s, capped by remaining run/DB budgets. Cancellation must stop new work, roll back active work or destroy its connection if rollback cannot complete, and close the pool; test actual server rollback after abort/connection loss. Allowlist diagnostics from SQLSTATE/constraint identity; never log raw driver error/detail/query/values/credentials or stacks. Real pg round-trip tests include quotes, backslashes, newlines, Unicode, backticks, `$()` and SQL injection text: values remain data and neighboring rows/DDL remain untouched. Docker lifecycle uses argument arrays/no shell; no subprocess payload transport/output-scrubbing layer is introduced.

These writes require **transaction-capable PostgreSQL access**, not necessarily an unpooled direct connection. PR 7 verifies Supabase pooler mode compatibility for multi-statement transactions, transaction-scoped advisory locks and unnamed parameterized statements, plus authorization, role setup/TLS and connection limits. supabase-js may still handle Auth and other operations; its inclusion or database Data API exposure is not decided here.

TMDB transport fixes origin `https://api.themoviedb.org`, `/3/` path allowlist, encoded IDs and allowlisted query keys; redirects rejected. No supplied URL fetches, credentials in query strings or logging headers. Token `TMDB_READ_ACCESS_TOKEN` read only in optional operator composition, never NEXT_PUBLIC, command arguments or fixtures; use documented [Bearer authentication](https://developer.themoviedb.org/docs/authentication-application). Secret files remain ignored; future .env.example is placeholder-only. Guard privileged provider/db imports from app/client modules through tested lint rules; importing modules never starts work or reads tokens. Ordinary app build runs without credentials.

Each attempt has 10s timeout, streamed response ceiling 2 MiB (not Content-Length alone), max concurrency 2 and start rate 2 requests/sec. Retry only network failures/timeouts, 429 and 502/503/504, at most two retries with delays 1s/2s; honor valid Retry-After up to 30s, otherwise stop that operation as throttled. 401/403 stops the run immediately without retry, 404 not_found, other 4xx invalid request/failure. Every retry consumes global attempt/deadline budget. [TMDB rate guidance](https://developer.themoviedb.org/docs/rate-limiting) describes changeable upper limits, not a promised quota; these are conservative local controls. Inject clock/sleep for deterministic tests; abort waiting/active requests on shutdown.

Input ceilings: title/company/person/job/name 500 characters, overview 20,000, poster path 256, genres 100, keywords 500, companies 100, credits 2,000 before selection, release country/event records 500/5,000 total, external keys 2; reject excess rather than silently truncate evidence. JSON object/key/type/prototype-safe parsing and numeric/date/ID checks reject malformed fields; unknown provider fields are ignored, unknown user/config fields rejected. Plain text remains text. Safe reports use fixed codes/counts/indices; ratings values/seed files are personal data, never general logs or CI artifacts, and only synthetic in executable PR 3 modes.

## 9. Proposed file inventory and sequence

Only this plan is written during planning. Future exact inventory (combine adjacent modules only if that improves clarity without weakening ownership):

| Files | Responsibility |
| --- | --- |
| src/domain/metadata.ts, metadata-evidence.ts, production-origin.ts, ratings-import.ts | Readonly normalized types, pure date/certification/origin/ratings decisions. |
| src/server/providers/metadata-provider.ts, tmdb.ts, tmdb-validation.ts | Narrow port, bounded HTTP adapter and response decoding. |
| src/server/ingestion/discovery.ts, ingest.ts, ratings.ts, origin-mapping.json, config.ts, diagnostics.ts | Deterministic batches, effect orchestration, TMDB seed resolve/fill-absent apply, curated versioned evidence/config and summaries. |
| src/server/db/metadata-store.ts, pg-store.ts, metadata-sql.ts, ratings-sql.ts | Narrow persistence port, reusable pg transactions and fixed parameterized SQL. No migrations/functions. |
| scripts/metadata.ts, scripts/ratings.ts | Argument parsing, dry-run composition; no fixture imports or retained DB mode. |
| tooling/metadata-local.ts, tooling/metadata-disposable.ts, tooling/metadata-db-test.ts | Synthetic composition, dedicated localhost-only lifecycle/bootstrap and real pg persistence/concurrency controls. These own fixture loading; PR 2 tooling stays unchanged. |
| tests/metadata/{validation,evidence,origin,discovery,ingest,ratings,security,boundary}.test.ts | Offline deterministic positives/negatives/HTTP controls and real lint configuration probes. |
| tests/fixtures/pr-03/{tmdb-synthetic,origin-synthetic,ratings-synthetic,discovery-synthetic}.json | Invented labeled payloads/mappings/input/config; never production imports. |
| tests/db/metadata.test.ts, tests/db/ratings.test.ts, tests/db/metadata-runner.test.ts | Real pg transactions, two-connection JS barriers, authorization/fault cases and lifecycle/refusal controls; explicit separate discovery. |
| tests/types/ids.typecheck.ts | Runtime constructor result types preserve all existing ID substitution controls. |
| src/domain/movie-identity.ts, src/recommendation/index.ts | Add .ts to existing relative import/export specifiers only; behavior unchanged. |
| tests/foundation/pure-boundary.test.ts | Real-config rejection probe for forbidden .ts-extension imports; existing controls remain. |
| vitest.config.ts, tsconfig.json, tsconfig.pure.json, eslint.config.mjs | Explicit offline test glob, scripts/tooling .ts typechecking, allowImportingTsExtensions in both projects and dependency direction controls. Keep pure globals/checks. |
| package.json, package-lock.json, .github/workflows/ci.yml | Pin pg/@types/pg, review reproducible resolution, add scripts/aligned metadata DB job; preserve foundation and PR 2 SQL jobs. |
| README.md, docs/plans/pr-03-metadata.md | Owning commands/ownership/setup and measured evidence/review disposition. |

No changes to released migrations, .claude, UI, recommendation behavior, PR 2 runner/isolation checks or image pin expected. Dependency lockfile and two existing import specifiers change only as listed. Existing schema fits selected metadata/evidence, both mapping uniques, mutable current credits/state and run checkpoint. No concrete schema gap is demonstrated. If implementation proves a gap, stop that part, report failing evidence and propose a separately reviewed forward migration, never edit PR 2. Every new function in any future migration explicitly revokes PUBLIC/API access in its creation transaction; platform defaults remain untouched.

Implementation sequence:

1. Reinspect baseline/guidance/worktree; record versions. Add contracts, strict decoders and pure evidence/ratings/origin logic with offline cases. Curate/review real mapping references; record unsupported coverage honestly.
2. Add provider port/HTTP adapter and bounded discovery planner with injected transport/time; test actual generated requests and all limits before persistence.
3. Add dedicated localhost-only disposable lifecycle and reusable pg store, fixed SQL/catalog resolver and real transactions; exercise constraints/role/concurrency/rollback rather than mocked-only results. Preserve PR 2 runner unchanged.
4. Add TMDB ratings-seed resolution/fill-absent apply and authorization, synthetic CLI composition; prove repeat input, conflicts and all-or-none concurrent apply. CLI dry-run reports validation/plans without persistence writes (including run-record writes). Update .ts specifiers/config and prove actual Node commands/next build.
5. Add commands/config/CI/doc ownership updates and diagnostics; run full required checks and dependency audit. Self-review full tracked/untracked inventory against exclusions, then independent review, revisions and re-review of material changes.

## 10. Commands, acceptance and review evidence

Proposed shared scripts:

```text
metadata:dry-run       node scripts/metadata.ts
ratings:dry-run        node scripts/ratings.ts
metadata:local         node tooling/metadata-local.ts
test:metadata:db       node tooling/metadata-db-test.ts
```

Dry-run scripts accept explicit --input/--config/--as-of as relevant, default to no network/no writes, reject unknown flags and load only caller-supplied files. Offline metadata dry-run prints validated batch definitions/bounds; offline ratings dry-run validates/coalesces the TMDB seed and reports that identity/state resolution needs the disposable composition, never fabricates MovieIds or applied changes. No baked-in fixture imports. metadata:local accepts only `--scenario metadata|ratings|repeat`, loads labeled fixtures itself, creates/seeds/uses/tears down its own PR 3 container/network and prints synthetic summaries. It accepts no retained target, arbitrary profile or file. test:metadata:db runs explicit metadata/ratings/lifecycle DB Vitest files with its injected inspected target; missing harness context fails loudly. Use programmatic Vitest execution with test-only harness context, not an environment variable accepting arbitrary connection URLs/container IDs. Do not let DB files enter npm test or skip when Docker is missing. The reusable store can be composed with a persistent target only by the later separately scoped step.

Local future validation (not executed during this planning task):

```powershell
node --version
npm --version
npm ci
npm run check
npm run test:db:runner
docker version
npm run test:db
npm run test:metadata:db
npm run metadata:local -- --scenario repeat
npm run metadata:dry-run -- --config tests/fixtures/pr-03/discovery-synthetic.json --as-of 2026-10-03
npm run ratings:dry-run -- --input tests/fixtures/pr-03/ratings-synthetic.json --as-of 2026-10-03
npm audit --json
npm audit --omit=dev --json
git diff --check
git status --short --untracked-files=all
```

Each nonzero exits the validation step; an expected audit finding needs recorded adjudication, not blanket ignore. Prior PR 2 development-only braces chain finding/ESLint maintenance warning is historical evidence, not a current fresh audit. Do not silently upgrade/downgrade to clear it. No browser smoke needed for unchanged UI; CLI and actual request/transport behavior require direct evidence.

CI keeps existing check and no-install PR 2 database jobs unchanged. Add `metadata-database` with same pinned actions/Node/read-only permissions, npm ci, docker version, `npm run test:metadata:db` and the same synthetic repeat/dry-run commands above, 20-minute job timeout. The PR 3 runner deadline is eight minutes including two fresh container/network cycles and teardown. Tests use at most 10 detail fixtures/16 discovery pages per scenario, injected no-wait HTTP transport and JS-controlled barriers; two startup bounds ×30s + two suite bounds ×150s + two cleanup bounds ×30s = 420s, leaving 60s runner overhead. metadata:local repeat has a separate two-minute bound; 8m DB runner + 2m repeat + 1m combined dry-runs = 11m, leaving 9m of the job for npm ci/image retrieval/setup. These are fail-loud limits, not a guaranteed CI duration on arbitrarily slow runners. No secrets, live provider tests, cached DB state or personal artifacts. npm test explicitly adds tests/metadata/*.test.ts, retains all existing 134 boundary cases plus the .ts-extension probe; pure type checks remain independent. npm run check includes next build, verifying .ts specifier compatibility. CI/local use identical commands; actual remote evidence is recorded only after publication is separately authorized.

| Acceptance | Required evidence |
| --- | --- |
| Contract/boundaries | Actual lint config rejects domain→effects, app/client→privileged modules and production/scripts→tests/tooling imports, including .ts-extension/alias/dynamic/type/re-export bypasses. Positive imports/identity constructors, both TypeScript projects, actual Node CLI resolution and next build pass without token. |
| TMDB validation | Injected-fetch tests inspect exact appended request, four named component presence/shapes and response IDs/imdb cross-check; oversized/chunked body, invalid JSON/date/numeric/arrays, absence vs wrong type, 404/auth/transient/throttle/cancellation and exact attempts/global retry headroom/deadlines. Missing appended object never becomes empty metadata or a fallback request. Zero calls on invalid input. |
| Evidence | Strict dates/leap/offset/future; US types 2/3/4 preferred, worldwide fallback explicit, old festival alone cannot produce older cohort, note text never parsed, contradictions null + release_ambiguous; US certification tiers/conflicts/blank/NR. Origin mixed/unknown and forbidden acquisition/distribution/Original/availability evidence; version/period checks. |
| Discovery | Multiple synthetic services/base/add-on IDs, both cohorts, multiple sorts/probes/pages, overlapping IDs, stalled/drifting pages, all budgets, low/zero/unconfigured coverage and normalized unknown/future titles. No offers/snapshots/eligibility claims or fixed origin quotas. |
| Real persistence | Actual service DML on one checked-out pg client, identical imports, newer/older/equal-time conflict, rollback on SQL/credit/commit failure, mapping conflicts/orphan prevention, cap, unknown overwrite warning and surviving history/personal rows. Two real pg connections/JS barriers prove same-key one UUID, distinct-key equal titles remain separate, external uniqueness violation rolls back without retry. Parameterized malicious values remain data. |
| Ratings | TMDB-only max-100 seed, uncataloged detail within shared budget, invalid/unsupported sources, full field validation; watched/taste/tired/exclusion separate; fill absent/equal only, differing watched/nonempty values conflict, identical rerun unchanged timestamps, duplicate conflicts, all-or-none batch. Forged/foreign/null-owner/deleted-profile authorization denies before personal read/report/write or provider calls; concurrent apply/direct writer/profile deletion use real DB. No override/find/title-match workflow. |
| Lifecycle/reporting | Separate PR 3 localhost ephemeral binding/generated credentials/identity/network/tmpfs checks, missing Docker failure, cancellation rollback/pool shutdown and inspected teardown for both fresh runs. Each checked-out connection verifies bor_pr02_test and bor-pr02-disposable before DML, including pool reuse; wrong-marker/wrong-database negatives refuse DML, with unchanged readbacks and restored-marker positive control. No external-target/env override; PR 2 runner/tests/SQL mutations unchanged. Safe fixed-code diagnostics contain no raw pg errors/values/secrets. Counters reflect commits/time truncation; .claude preserved. |

Meaningful mutation/negative controls: reuse the same assertions with deliberately modified injected rules/transports/configurations (not permanent source weakening): treating distribution as production must fail the named origin assertion; substituting discovery date must fail evidence assertion; removing request accounting must fail finite call-count assertion; enabling personal overwrite must fail prior-value preservation; catalog fail-after-movie-insert must leave zero aggregate changes; removing capability enforcement must fail no-read/no-call authorization assertion. Retain PR 2's existing rollback-only unique-constraint mutation and named direct duplicate-mapping assertion through test:db: weakening that constraint need not defeat the importer's independent conflict checks, so do not incorrectly demand that its resolver test turn red. Setup/parse errors do not count as expected reds. Use real non-mutated positive controls and final green; no tests that only reproduce helper output.

Retain private synthetic logs with versions/dependency disposition, resolved image/platform/server, commands/exit codes, named expected reds/green, attempt counts/arithmetic/deadline stops, readbacks, JS-controlled concurrent schedules and both container/network teardown IDs. Record intended inventory including files ordinary git diff omits. Passing checks supplement review of actual single-client transaction ordering, authorization and reference truth. PR 2 constraints remain mandatory: UUID/text distinction, classification/snapshot movie RESTRICT, session direct-delete denial/profile-account cascades, history-free unobserved track cascade, sealed snapshots and explicit function revokes. Supabase pooler/Auth/platform/Data API verification and recovery rehearsal remain PR 7.

## 11. Decisions, blockers and risks

Settled choices: pg plus @types/pg only; no migration; separate metadata provider with appended requests; US-preferred typed release policy with conservative unknowns/no note parsing; certification conflict handling; small evidence-backed origin rules; bounded fair discovery with flatrate|ads|free; exact-key identity; per-movie atomicity without speculative DB retries; serialized catalog writes; fill-absent TMDB ratings seed and all-or-none personal batches; dedicated localhost-only synthetic disposable tests/offline CI; explicit .ts resolution and next build checks. These adopt H1–H8 without expanding product behavior. PR 2 runner isolation stays unchanged.

No personal input blocks planning or synthetic implementation after authorization. The user confirmed no existing watch/ratings history and the separate real-catalog step below; no export-source/matching/override decision remains. Before that step, supply actual exact subscribed provider IDs and a private token via ignored configuration. A future optional personal seed needs TMDB IDs and target-profile authorization; tired-scale meanings are later user input. Changes to seeded values occur in-app, never through overwrite-by-reimport. Content/runtime/language preferences and anchors stay with later owning PRs; none is inferred from fixtures or requested as a credential upload.

Implementation gates: Docker engine and verified localhost isolation/credentials; actual pg transaction/rollback behavior; Node .ts resolution/typechecking/next build; reviewed origin references (disabled probes/unknowns when evidence is missing); all acceptance commands and review/adjudication. Optional credentialed compatibility checks remain outside offline acceptance and PR 3 execution: max 10 titles, 15 attempts (10 combined details plus five retry slots), two-minute deadline, read-only output. They require separately supplied token/terms/variant configuration and do not establish entitlement, completeness, production truth or platform compatibility. Missing credentials never skip required offline tests.

Risks: catalog drift/incomplete typed dates, undetected re-releases/cuts without note parsing, US/worldwide fallback differences, acquisition mistaken for production, conservative origin unknowns, bounded sampling bias, provider latency/backoff exhausting time/retry headroom, serialized catalog throughput, client/connection-loss/pooler differences, local port/credential lifecycle, no durable resume/metadata history/real Auth proof, and no real ratings baseline yet. Synthetic fixtures cannot establish live compatibility. Diagnostics expose limits without relaxing hard rules or claiming ranking readiness. Measure local pg throughput and pool/cancellation behavior; PR 7 owns actual Supabase/platform verification.

### Separate real-catalog step immediately after PR 3 (H3)

The approved scoped implementation and current acceptance evidence now live in
[the real-catalog plan](real-catalog.md). PR 3 evidence below remains historical.

The user confirms this step before PR 4/5 live validation. Scope it separately from PR 3: persistent local Postgres, retained-data setup/role configuration (not the disposable bootstrap), private TMDB_READ_ACCESS_TOKEN through an ignored env file, user-supplied exact subscribed provider IDs, supervised bounded real metadata run and readback/coverage diagnostics. Add only trusted composition/configuration around the already-tested provider, pg store, ingest and diagnostics; no new ingest/identity/evidence logic. Persistent lifecycle must never share destructive disposable reset/teardown code. Define the exact retained target/ownership authorization and safe setup before executing; personal ratings import is not implied.

Start with at most 100 titles, 40 discovery operations, one optional list, 200 attempts (141 initial + 59 retry headroom), 10-minute deadline and 1,000-record catalog cap; read back mappings/evidence/counts and report unknowns/truncation/failures. Catalog operations run with the approved service-role authorization boundary; no public API/Auth/UI/availability observations/classification/ranking is added. No paid/cloud resources are needed: local Docker Postgres has no database-service charge, and the user reports no cost blocker. TMDB noncommercial terms, required attribution and caching/retention compatibility are gates before the supervised run; commercial use needs a separate license. PR 3 does not perform this step, obtain a token or call credentialed APIs. Later live checks supplement offline acceptance rather than replace it.

## 12. Ready-to-paste independent planning review

```text
Review PR 3 planning only for Brain Off, Reel On. Do not implement, install,
obtain credentials, call credentialed APIs, import real data, publish or deploy.

Read AGENTS.md, README.md, docs/architecture.md, docs/engineering.md,
docs/plans/pr-02-schema.md and docs/plans/pr-03-metadata.md. Inspect actual
source/migrations/tooling/package-lock/test discovery/CI and applicable guidance.
Preserve existing work, especially untracked .claude/. Baseline main 73dfa57 (#2):
PR 1/CI and PR 2 merged; user confirms green CI, independent approval of all five
PR 2 corrections and independently successful DB tests; both nits fixed/validated.
Older pending review/CI prose is historical. Verify public TMDB documentation
where necessary without credentials; separate documented facts from policies.

Assess the actual plan/new-file inventory, not implementation claims. Check:
normalized contracts/pure-effect ownership; typed release/US certification
semantics; bounded fair discovery and coverage gaps without availability claims;
source-backed versioned production origin, unknowns and no quotas; exact UUID vs
namespaced identity, mapping conflicts/concurrent atomicity/partial failure;
TMDB-only max-100 hand-written seed (user has no existing history), separate
watched/taste/tired signals, fill-absent/equal-only writes and conflicts without
overrides; reusable pg store and one-client transactions; authorization,
secrets/input/request bounds/redaction; exact files/dependencies/commands/test
discovery and local/CI alignment. Check one appended request per movie with all
four components present/ID cross-checks; 1,001 initial requests, 499 retry slots,
1,500 attempt cap and honest 30-minute partial-run behavior. Check US-preferred
typed releases/worldwide fallback, festival-only unknown and no note parsing;
flatrate|ads|free candidate sourcing without verified offers. Verify explicit .ts
specifiers/config, Node default stripping and next build acceptance. Challenge
transaction/lock ordering and actual two-pg-connection JS barrier tests, no
uniqueness retry under the global importer lock, and meaningful negative controls.

Carry forward PR 2 deletion/history/cascade/seal/function-revoke constraints;
released migrations immutable, only demonstrated gaps justify forward proposals.
PR 4 availability/refresh, PR 5 classification, PR 6 ranking, PR 7 Auth/API/platform
and Data API exposure, UI/hosting and real-data execution stay excluded from PR 3.
PR 2 runner/no-port isolation stays unchanged; PR 3 has a dedicated disposable
container with inspected ephemeral 127.0.0.1 binding/generated credentials and
verified teardown, no external-target override. Its unedited bootstrap requires
bor_pr02_test / bor-pr02-disposable; verify both on every checked-out connection
before DML, including pool reuse, and prove wrong-marker refusal through the store.
Transaction-capable Postgres need
not be unpooled; PR 7 verifies pooler/unnamed statement/authorization/limits.
Review the separately confirmed persistent local real-catalog composition/config
step immediately after PR 3 and before PR 4/5 live validation; no new ingest logic
or credentialed execution belongs in this planning task or PR 3 acceptance.

For each finding give severity, file/section, concrete failure scenario, smallest
correction and acceptance evidence. Separate blockers, routine engineering choices,
user decisions, assumptions and optional improvements. State whether this plan is
independently implementable/reviewable, and list any outstanding implementation
gates without treating missing personal preferences as a planning blocker.
```

## 13. Revision change log (H1–H9)

| Item | Edited sections and disposition |
| --- | --- |
| H1 | 1–2, 6, 8–12: pg/@types/pg selected; reusable parameterized single-client transactions; separate localhost/credentialed disposable tests; PR 2 runner untouched; transaction-capable/pooler boundary explicit. |
| H2 | 1–2, 3, 5–7, 9–12: TMDB-only max-100 seed; removed find/IMDb ratings/review/override paths; fill-absent, conflicts, authorization, row-lock atomicity and unchanged reruns retained. |
| H3 | 1, 8–12: reusable store/composition boundary and separate supervised persistent real-catalog step directly after PR 3, with terms/attribution/readback gates. |
| H4 | 3, 5, 8, 10–12: one appended detail request, all-component validation; 1,001 initial/1,500 total attempts with 499 retries, timing arithmetic, separate small offline CI budgets. |
| H5 | 2, 8–10, 12: existing import files/config inventory, explicit .ts specifiers, both allowImportingTsExtensions settings, script/tooling typechecking, lint probe/default Node commands/next build. |
| H6 | 3, 5, 10–12: US 2/3/4 release preference, typed worldwide fallback, no premiere-only older cohort or note parsing, strict dates/conservative ambiguity. |
| H7 | 6, 8, 10–12: no uniqueness reread/retry or speculative DB retries; classified rollback failure and real JS-controlled two-connection concurrency evidence. |
| H8 | 5, 10–12: flatrate|ads|free discovery with exact supplied variants; per-title offers still PR 4. |
| H9 | 1–3, 5–13: contracts/files/commands/CI/acceptance/risks/review prompt reconciled; removed transport and ratings-only machinery; unaffected origin/security/PR 2 constraints retained. |
| N1 | 8, 10, 12: explicit reused database/marker identity, per-checkout pre-DML guard under bor_migrator, wrong-marker refusal/readback and positive controls; bor-pr03 container/network/labels unchanged. Plan approved by the supplied independent review. |

## 14. Implementation evidence — October 3, 2026

Implemented under the user's subsequent authorization on
`implementation/pr-03-metadata`, HEAD still `73dfa57cbcca9d21a61d83789348b7cc94c8f69f`.
The original tree had no tracked changes and only the approved untracked plan and
`.claude/settings.local.json`. The latter was never edited. No commit, push, PR,
deployment, credentials, real provider/personal data or retained infrastructure was
created. The user-confirmed PR 2 merge/CI/review/DB status remains the baseline.

### Scope and implementation choices

- H1/H7/N1: reusable pg store, fixed parameterized unnamed SQL, one checked-out
  client from guard through BEGIN, SET LOCAL ROLE service_role and confirmed COMMIT.
  An aborted transaction whose COMMIT command reports ROLLBACK is a failure.
  Global transaction advisory lock serializes catalog resolution; there is no DB
  retry or uniqueness reread. New/updated movie, missing mappings and TMDB credits
  commit together. Exact-key conflicts, equal-time disagreement, stale metadata,
  capacity and optional-value loss are explicit outcomes. Same titles remain
  separate and receive possible_duplicate information, never title matching.
- H2: max-100 TMDB seed, strict keys/bounded file reads, duplicate conflict indices,
  independent personal signals and fill-absent/equal-only decisions. The store
  snapshots exact issued operator scopes, so neither a forged context nor mutation
  of an issued context authorizes another profile. Ownership is checked before
  personal reads/resolution; profile, personal rows and mappings are locked before
  rereading and deciding the all-or-none batch. Exclusions and identical-rerun
  timestamps survive. Existing mappings resolve before detail fetches; uncataloged
  seed titles use the same per-run aggregate cache and request/detail budgets.
- H3: only reusable effects and disposable synthetic composition are implemented.
  The persistent local real-catalog composition remains the separately scoped step.
- H4/H8: one appended detail request, all four component shapes/failure states and
  supplied IDs crosschecked. Fixed TMDB origin/path/query construction, no redirects,
  streamed 2 MiB ceiling, bounded pacing/retries/Retry-After/attempts/deadline and
  immediate auth shutdown. A serialized HTTP lane intentionally operates below the
  maximum concurrency of two. Discovery has exact distinct variant IDs and
  flatrate|ads|free OR filters, disjoint sourcing cohorts, round pagination,
  stalled/totals drift checks, deduplication and provenance memberships; no offers.
- H5: explicit .ts specifiers, both allowImportingTsExtensions settings and
  erasableSyntaxOnly to catch unsupported Node syntax. Scripts/tooling receive the
  root typecheck. Constructor-result controls live in `tests/types/metadata-ids.ts`
  (root project only), preserving the existing pure-project brand/global controls;
  importing effect constructors into the existing pure typecheck file would pull
  Node/pg into the pure graph. Existing foundation tests remain intact, with one
  additional .ts-extension case per pure area.
- H6/N2: strict date/offset parsing, US types 2/3/4 preference, typed worldwide
  fallback, no primary/festival substitution or note parsing. A primary date later
  than the selected US event produces null and release_ambiguous, tested through
  the actual appended decoder into ingestion counters. Certification retains tier
  conflicts and explicit NR. Private inspection includes up to 50 normalized US
  certification records/title, with total/truncated fields; decision-making still
  validates and uses all input records. This inspection is separate from normal
  persisted count diagnostics and contains no raw provider notes or unfamiliar text.
- H9: tested pure/effect/app-client/test ownership, safe counts/codes/indices,
  committed-write progress, bounded files and CLI flags, aligned local/CI commands.
  Provider requests use the reserved work deadline. Every transaction receives a
  fresh deadline capped by remaining run and cumulative DB-work budgets; a long
  ratings resolution cannot accidentally reuse an expired ten-second apply deadline.

Origin `origin-v1` uses the explicitly approved section 4 alternative: **no verified
production rules**, all three categories declared missing, all three company probes
disabled. No real TMDB company-ID correspondence/production-period evidence was
established. Synthetic rules prove the derivation mechanics, not reference truth.
Unknowns, mixed groups, partial/conflicting evidence, period/name differences and
distribution/acquisition/marketing-only cases are tested. Future verified rules
must use a new version; do not quietly edit a mapping already used for persistence.

Public documentation was reconfirmed without credentials: [appended objects](https://developer.themoviedb.org/docs/append-to-response),
[discovery region/OR filters](https://developer.themoviedb.org/reference/discover-movie),
[typed release events](https://developer.themoviedb.org/reference/movie-release-dates)
and [one-client pg transactions](https://node-postgres.com/features/transactions).
No provider endpoint was called. Live compatibility/completeness/retention and
limited-to-wide release prevalence are unverified and belong to the real-catalog step.

### Disposable target and measured evidence

Windows Node 24.14.0/npm 11.9.0; Docker Desktop 4.93.0, client/engine 29.8.1,
desktop-linux, linux/amd64. Sandbox initially refused the Docker pipe/network cache;
authorized elevated retries enabled the local dependencies and disposable tests.
No approval rejection remained. The unchanged image pin resolved linux/amd64 and
PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2).

PR 3 creates a unique labeled bor-pr03 bridge/container, tmpfs and a Docker-assigned
loopback-only port. Random bootstrap/login secrets travel over stdin, never Docker
arguments or logs. Startup never publishes trust-authenticated TCP; the entrypoint
waits for its private bootstrap secret. Socket bootstrap/REFERENCES setup, unedited
migrations and fixtures use postgres only for platform setup, bor_migrator otherwise.
Application transactions use the service role. Every checkout verifies database
bor_pr02_test and the sole bor-pr02-disposable marker as bor_migrator. A real test
asserts the same backend PID is reused before marker replacement, then proves
refusal and unchanged catalog/personal readbacks. Missing marker and a different
database containing a valid marker also refuse; restored marker is a permitted
positive control. Guard errors discard the connection.

Startup and inspected cleanup each have a 30-second phase budget, suites 150 seconds,
DB runner eight minutes/two cycles and local composition two minutes. SIGINT/SIGTERM
cancel work; active transaction cancellation destroys the client and server rollback
is checked. Each run closes pools and verifies removal of only inspected created
container/network IDs. Logs retain exact real IDs and named assertions. Docker
absence, malformed/public bindings, label/storage/network mismatches, execution
failure and teardown failure have refusal controls; mocks do not establish SQL facts.

| Command | Local result |
| --- | --- |
| node --version / npm --version / docker version | Passed; versions above. |
| npm ci | Passed from reviewed lockfile; ESLint maintenance warning retained. |
| npm run check | Passed: strict root/pure projects, zero lint warnings, 234 offline tests (136 foundation including the extension probes), production Next build without credentials. |
| npm run test:db:runner | Passed: unchanged 11 lifecycle/refusal tests. |
| npm run test:db | Passed: released SQL constraints/access/mutations, final green and fresh reset replay with inspected teardown. |
| npm run test:metadata:db | Passed: 20 named real-pg/lifecycle cases per fresh cycle, two cycles, no unhandled errors, both container/network teardowns verified. |
| npm run test:metadata:controls | Six named source-mutation assertion reds; restored source, final offline and two-cycle DB green. Private logs in .cache/pr03. |
| npm run metadata:local -- --scenario repeat | Passed: each pass 16 discovery operations, two selected/detail/resolved titles, 18 HTTP attempts, zero failed titles; honest partial outcome from discovery cap, unchanged second personal apply, inspected teardown. |
| metadata:dry-run / ratings:dry-run with the section 10 synthetic files/as-of | Passed via actual Node .ts entry points; no network/writes, ratings counts only. |
| npm audit --json | Exit 1: five high development-chain findings, adjudication below. |
| npm audit --omit=dev --json | Exit 0: zero production findings. |
| git diff --check and full tracked/untracked inventory | Reviewed; released PR 2 paths unchanged and .claude preserved. |

The small synthetic repeat initially measured approximately 24–35 ms of cumulative
local DB work per pass, including run/profile operations and two catalog writes.
This is a composition smoke measurement, not representative catalog throughput or
a guarantee that the maximum request/DB budgets complete in thirty minutes.

The actual two-connection barriers prove same-key one UUID, different-key equal
titles separate, importer serialization, direct authenticated personal-writer
locking, profile deletion synchronization and external nonlocking uniqueness
failure without retry. SQL/credit/connection/aborted-COMMIT failures leave aggregate
counts unchanged. Existing classification/snapshot and personal graphs survive;
the unchanged PR 2 suite separately proves all released history/deletion/cascade/
seal/function-revoke constraints. No schema gap or forward migration was necessary.

Mutation names: distribution_as_production (both qualifying and ambiguity guards),
primary_as_selected_release, request_accounting_removed, personal_overwrite_enabled,
catalog_error_committed and capability_check_removed. Each requires AssertionError,
rejects parse/setup failures and restores its original source in finally. One
early final-control run failed, prompting isolated reruns and retained logging;
later complete controls and final green passed. Initial Node parameter-property,
duplicate lint diagnostic, wrong-database password spread and asynchronous
connection-loss errors were corrected and rerun; no failing assertion was skipped.

### Dependency disposition and inventory

Only pg/@types/pg 8.23.1 were added directly. The lockfile adds those plus their
transitive resolutions; existing versions were not upgraded, overridden or removed.
Added licenses are MIT/ISC, pg requires Node >=16 and root TypeScript validates the
types. Optional pg-cloudflare is resolved; pg-native is not installed. No SDK/ORM/
validator/TS runner was added. Fresh full audit reports the existing
eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces
development chain, GHSA-vfj7-8cjw-p6xm. It is not a pg/runtime finding. npm's proposed
fix downgrades the Next lint preset to 14.2.35; rejected as an unrelated/incompatible
change. Retain pins and track a compatible upstream lint fix/ESLint maintenance
update before affected releases. No blanket advisory suppression was added.

The section 9 inventory was implemented, with adjacent ratings SQL kept in pg-store
rather than a separate ratings-sql module. Additional small owning files are
scripts/arguments.ts, tooling/metadata-fixtures.ts, tooling/metadata-mutations.ts,
tooling/eslint/effect-boundary.mjs, tests/metadata/helpers.ts,
tests/db/metadata-context.ts and tests/types/metadata-ids.ts. All new files must be
included in review; ordinary git diff omits them. The approved plan itself remains
untracked, as it was at baseline. Private .cache logs/build/dependency output and
pre-existing .claude are excluded from the proposed change set. No modifications to
released migrations, PR 2 runner/image/bootstrap/SQL/fixtures, UI or recommendation
behavior; only the two approved existing runtime import specifiers changed.

Self-review covered the actual tracked diff and new-file inventory, dependency
direction, transaction ordering, authorization scope, reference truth, deadlines,
committed counters, CLI paths and exclusions. The supplied independent review requested M1-M3 corrections; the revision evidence below supersedes the original concurrency and crash-teardown claims. The subsequent supplied re-review and final ANSI-color correction are recorded below.
Remote CI is unverified because publication is not authorized. Supabase/Auth/Data
API/pooler/TLS/recovery, representative live metadata, provider entitlement and
production-origin correspondence remain unverified; no synthetic evidence claims
those gates passed.

### Review corrections - October 3, 2026

The supplied checkout review requested M1 (crash teardown/error preservation),
M2 (ratings lock evidence), M3 (readability), plus bounds diagnostics and builtin
import coverage. No commit/publication was authorized or performed.

- M1: operational inspection still requires one live loopback port. Teardown has
  its own ID/name/both-labels/network/requested-port/tmpfs identity check, which
  accepts an exited container with no live ports. A work error is rethrown unchanged
  after successful cleanup; simultaneous work/cleanup failures produce an
  AggregateError containing the original work error first and cleanup error second.
  Real execute-time docker kill now proves original-error identity and absence of
  both exact container/network IDs. Malformed stopped-container isolation still
  refuses destruction; fake removal failure proves both errors remain available.
- M2: checkout guards record each participating backend PID. Before releasing the
  first importer, direct authenticated writer or profile deletion, poll actual
  pg_stat_activity for that PID with wait_event_type=Lock and the expected blocker
  in pg_blocking_pids. Polling is bounded at 1.5 seconds below the store's two-second
  lock timeout; finally releases blockers and settles pending imports.
  The permanent seventh control, profile_lock_removed, removes only the profile
  SELECT's FOR UPDATE. It must produce assertion failures in BOTH the two-import
  and profile-deletion cases, rather than merely any database failure.
- M3: reformatted all 38 new code files into separate statements and multiline
  conditions/objects. Formatting was checked for parsed-AST equivalence (including
  TypeScript definite-assignment syntax); no formatter dependency or lockfile change
  was added. Mutation anchors were reconciled with the readable source layout.
- Diagnostics: one helper deduplicates every bounds code. detail_budget is emitted
  only when the detail count is exhausted; cancellation/deadline/database/request
  limits keep their own codes. Five orchestration regressions prove accurate,
  unique bounds, including repeated detail skips and page-limited batches.
- Import boundary: app/client files reject bare and node-prefixed fs, fs/promises
  and child_process. Actual ESLint import, dynamic-import and re-export probes
  exercise both app and use-client paths for all six specifiers.

Revision validation:

| Command/evidence | Result |
| --- | --- |
| npm run check | Passed after final code changes: both type projects, zero-warning lint, 245 offline tests, production build. |
| npm run test:metadata:db | Passed: 22 cases in each of two fresh cycles, including real container kill and exact-ID teardown. |
| npm run test:metadata:controls (alone) | Seven named assertion reds; profile-lock removal fails both required ratings tests. Sources restored in finally; final 245 offline tests and 22 DB cases in each fresh cycle passed. |
| npm run metadata:local -- --scenario repeat | Passed: synthetic 16-operation cap remains an honest partial result, zero title failures, unchanged second ratings apply, inspected teardown. |
| metadata:dry-run / ratings:dry-run (section 10 arguments) | Both actual Node entry points passed without provider calls/writes. |
| npm run test:db:runner | Unchanged PR 2 runner's 11 tests passed. |
| git diff --check / complete tracked and untracked inventory | Passed/reviewed, including all new implementation paths; .claude and released PR 2 paths preserved. |
| Docker label inventory after validation | No PR 3 containers or networks remain. |

Private evidence: .cache/pr03/revision-check-final.log, revision-db.log,
revision-controls.log, profile_lock_removed.log, controls-final-offline.log,
controls-final-database.log, revision-repeat.log and both revision dry-run logs.
The controls log requires the two named FAIL assertions, excluding parse/setup
errors; the final database log confirms restoration through green execution.
No dependency install/audit or full unchanged PR 2 SQL suite was repeated for
these corrections; their original evidence above is historical. The prior
implementation evidence remains historical; live TMDB/platform compatibility and
remote CI are still unverified. The supplied review's approval was conditional;
the subsequent supplied re-review below resolves that requirement.

### Final re-review and color-terminal correction - October 3, 2026

The supplied independent re-review verified M1-M3, both low findings and the
previous green commands, then approved conditional on one remaining correction:
ANSI color sequences prevented the profile-lock named FAIL regexes from matching.
The reviewer explicitly requires no further review after this fix and green controls.

In tooling/metadata-mutations.ts, strip ANSI SGR sequences from captured output
before the AssertionError, parse/setup-error and both named FAIL checks. Preserve
the original colored output in private logs; mutation expectations and source
restoration remain unchanged. No new dependency or test weakening was introduced.

Validation: npm run test:metadata:controls exited 0 with TERM=xterm-256color,
FORCE_COLOR=1 and inherited NO_COLOR/NODE_DISABLE_COLORS removed in the validation
shell. The profile_lock_removed log contains 415 ANSI sequences; the original
named regex does not match the raw output and does match after stripping. All
seven named assertion reds passed, followed by 245 offline tests and 22 DB cases
in each of two fresh cycles with verified teardown. npm run lint and git diff
--check passed. Private evidence: .cache/pr03/color-controls.log,
profile_lock_removed.log, controls-final-offline.log and controls-final-database.log.
An earlier rerun also passed but inherited NO_COLOR=1, so it did not establish the
color-terminal acceptance; the actual ANSI run above supersedes it.

The supplied conditional approval is now satisfied. No further review is required
by that re-review. No commit/push/PR or deployment was authorized or performed.
Remote CI, live TMDB, Supabase/platform compatibility and real-data N2 prevalence
remain unverified and outside this correction.

## 15. Ready-to-paste independent implementation review

```text
Review PR 3 implementation for Brain Off, Reel On from the branch checkout.
Do not commit, push, open/merge a PR, obtain credentials, call credentialed APIs,
import real data, provision retained/hosted infrastructure, spend money or deploy.

Read AGENTS.md, README.md, docs/architecture.md, docs/engineering.md,
docs/plans/pr-02-schema.md and docs/plans/pr-03-metadata.md (including section 14).
Inspect branch implementation/pr-03-metadata, HEAD 73dfa57, the complete tracked
diff and ALL untracked implementation files. Preserve .claude/settings.local.json.
The user confirms PR 1/2 merged with green CI, independent approval and successful
DB tests; historical pending statements are superseded. PR 3 is not committed.

Review against sections 2–10/H1–H9/N1, not just passing tests. Challenge strict
appended response/ID validation, HTTP attempt/retry/deadline/body limits, discovery
fairness/caps/provenance and honest partial diagnostics. Verify N2: primary later
than selected US event remains null and counts release_ambiguous; no discovery
date/festival/note substitution. Production origin-v1 intentionally has no verified
rules and disables all three probes under the approved missing-evidence option;
synthetic mapping rules prove no real production truth. No offers/eligibility claims.

Inspect exact namespaced resolution, runtime brand construction, canonical freshness,
global catalog lock/read ordering, one-client parameterized transactions, service
role and confirmed COMMIT; no speculative DB retry. Check mappings/credits/cap and
SQL/connection/commit failures for atomicity, orphan prevention and preserved history.
Inspect ratings authorization before personal reads/provider resolution, immutable
issued scope, existing-map resolution, shared cache/budgets, separate signals,
fill-absent/equal-only policy, row/mapping/profile locks and all-or-none conflicts.
Verify direct authenticated-writer and profile-delete concurrency evidence.

PR 2 runner/isolation/image/released migrations/bootstrap/SQL/fixtures must be
unchanged. PR 3 names/network/labels use bor-pr03, database bor_pr02_test and sole
marker bor-pr02-disposable. On EVERY checkout, including a proved reused PID,
the injected guard runs as bor_migrator before service DML. Wrong/missing marker
and a different DB with a valid marker refuse with unchanged readbacks; restored
positive works. Inspect generated-secret stdin, exact loopback binding/tmpfs/network,
startup/suite/run/cleanup bounds, cancellation and ID-specific inspected teardown.

Run npm ci, npm run check, npm run test:db:runner, npm run test:db,
npm run test:metadata:db and section 10 repeat/dry-run commands. Run
npm run test:metadata:controls ALONE (temporarily applies seven controls, restores in
finally, then requires final green); inspect ignored .cache/pr03 logs if available.
Full npm audit exits 1 for the documented existing dev braces chain; production
audit is green. Assess that disposition without unrelated upgrades or suppressed
checks. Check explicit .ts resolution, root/pure typecheck isolation, actual lint
bypasses and Node/Next execution without tokens. Review new files, not just diff.

For each finding give severity, exact file/line, concrete scenario, smallest fix
and acceptance evidence. Separate blockers from optional improvements and future
PR gates. State approval or requested changes; do not infer live/platform/remote CI
compatibility from synthetic evidence. Real-catalog execution remains a separate
step after PR 3. The supplied re-review approval and satisfied ANSI-color condition are recorded in section 14.
```
