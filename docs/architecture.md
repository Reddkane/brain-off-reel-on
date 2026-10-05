# Low-Brain Movie Picker: Architecture Proposal

Date: October 2, 2026  
Status: Consolidated architecture with the October 4 availability-plan revisions
and October 5 merged-baseline reconciliation.
Implementation baseline is `main` at `04bf010`; foundation, schema, metadata, local
catalog and Availability: sweeps are merged through #7. Availability: evidence is
implemented and passed focused review; the retained live gate remains closed
pending the evidence plan's section 9 follow-up. User-approved trial, unseen-only, structured-data, freshness/origin and
Disney+/Hulu uncertainty policies are specified below; remaining personal inputs
still need confirmation before the trial.

## 1. Purpose and product contract

Build a personal movie picker for a mentally tired user: one button, one movie, a short explanation, and an easy way to request another pick. The objective combines likely enjoyment, low-effort viewing, and actual subscription availability.

Initial scope: movies, US availability, one viewing profile, mobile-first web interface, and an installable iPhone PWA. Additional users follow personal validation.

Exclude TV, browsing feeds, carousels, social features, payments, advertising, native apps, household ranking, embeddings, collaborative filtering, and elaborate administration tools.

Primary target: median recommendations before selection at most two among successful sessions. Also report successful sessions divided by all sessions, availability failures, abandonment, first-pick acceptance, time to selection, and post-watch enjoyment/suitability. A click is selection intent, not confirmed viewing or confirmed playback. Section 7 defines corrections for failed availability; section 9 states the limits of the experiment.

## 2. Architecture and deployment

Use TypeScript, Next.js, Supabase Postgres, and PWA distribution. One application plus ingestion/classification scripts; no microservices.

```text
TMDB metadata / Watchmode availability -> ingest/refresh -> Postgres
Offline classification/review --------------------> Postgres
Personal ratings/preferences --------------------> Postgres
                                                        |
Phone / desktop -> authenticated API -> load inputs -> pure engine
                                                        |
                           persist pick + trace <- filter and rank
                                      |
                              return one movie
                                      |
                             selection / feedback
```

### Device independence

The engine is plain TypeScript. It accepts supplied movie, profile, history, timestamp, and context inputs. It imports no React, Next.js, database clients, server modules, or provider SDKs. The server loads data and persists outcomes; the UI calls the API and displays results. Desktop, PWA, and later native clients share the same API.

Enforce the boundary with restricted-import lint rules and branded internal/external ID types. Recommendation tests require neither React rendering nor a live database. A separate engine tsconfig without DOM libraries is optional if useful without configuration sprawl.

No LLM or external movie-data API in the ordinary pick request. Batch jobs enrich stored data. The request performs bounded reads, deterministic ranking, and transactional writes.

### Host and access

Choose **Vercel for Next.js hosting and daily Vercel Cron**, with Supabase for database/Auth. The initial personal, noncommercial pilot can use Hobby within its terms and limits. Reassess plans/licenses before a commercial phase; this choice authorizes no account creation, spending, or deployment.

Vercel Hobby currently permits daily cron with an invocation window of up to an hour. That fits availability refresh, which does not require exact timing. Use the Node.js runtime with Fluid compute; current Hobby function maximum duration is 300 seconds. Benchmark refresh completion before the trial rather than assuming the whole catalog fits. Sources are linked in section 14.

No purchased domain is required; supplied HTTPS addresses suffice. A local-only prototype may use a fixed profile. Before any public phone trial, provision one Supabase Auth account with email/password, disable public signup, and enforce ownership in server code and database policies. Do not expose a fixed-profile write API. Test persistent login inside the installed iPhone PWA in phone-experience work. Do not rely on email links opening in the installed app's browser context. Document account recovery separately.

Service credentials stay server-only. Where privileged clients bypass RLS, server authorization remains mandatory. Auth and access control must be verified before the phone trial.

### Security baseline and pre-trial requirements

Treat browser requests, client IDs, provider payloads, and generated classification output as untrusted. Protect personal viewing data and credentials, prevent unauthorized writes, and bound operations that consume database/provider resources. Apply these requirements in the owning work area; this section is not a claim that controls already exist.

- **Authentication and authorization:** verify identity using the supported Supabase server integration, not an unverified session object or client-supplied profile ID. Deny access by default. Every profile/session/recommendation/feedback read or mutation verifies ownership, including child resources and diagnostic/export routes. UUIDs are identifiers, not permissions. Browser users cannot write shared catalog/classification data. Use user-scoped clients for ordinary personal operations where practical; privileged job clients require explicit server checks and narrow responsibilities.
- **Database access:** explicitly configure grants and RLS when tables are created. Anonymous callers have no personal-data access. RLS ownership policies cover reads and writes, including indirect session ownership and restricted account/profile fields. Do not allow users to reassign profile ownership. Privileged credentials can bypass RLS, so test application authorization separately from database policies. Before the personal trial, use two synthetic test identities to verify isolation even though only one real account is enabled.
- **Input and request protection:** validate schemas, ID formats, allowed fields, numeric bounds, enum values, and request-size limits; use parameterized database operations. Define per-route limits in the implementation plan. Cookie-authenticated mutations require validated same-origin requests plus framework-supported CSRF protection or explicit CSRF tokens as appropriate; SameSite cookies and CORS alone are not the complete defense. Ordinary reads are side-effect free. The bearer-authenticated cron GET is a documented scheduler exception, not a browser mutation route.
- **Session and abuse controls:** HTTPS in deployment; retain the supported Auth session flow and document cookie/storage choices rather than inventing token handling. Verify logout, expired sessions, and recovery. Rate-limit authentication through the provider and apply server-side account/IP limits to recommendation/feedback routes, using bounded shared state appropriate to serverless deployment rather than a per-process counter. Do not rely solely on disabled signup. Return controlled errors without credentials, raw queries, or stack traces.
- **Secrets and environments:** ignore local secret files, commit only placeholder examples, and separate development/test/production credentials and databases. Public browser configuration is allowlisted; service keys, provider keys, passwords, and cron secrets never enter client bundles, traces, or logs. Keep privileged modules server-only. Document credential rotation/revocation; use synthetic data outside the personal trial environment. Do not introduce a secret-management service solely for V0.
- **External data and rendering:** validate provider/LLM results before storing or using them. Render metadata/explanations as text, not untrusted HTML. Validate outbound destinations as HTTPS URLs on allowed provider hosts; never server-fetch a user-supplied URL. Establish and verify a compatible content-security policy, anti-framing policy, and referrer policy before the phone trial.
- **Logs, private caching, and diagnostics:** redact authorization headers, tokens, passwords, and unnecessary personal payloads. Traces intentionally contain viewing preferences, so protect them as personal data rather than treating them as anonymous logs. Never expose them in public errors or analytics. Personal API responses must not enter shared CDN/service-worker caches; verify cache isolation and sign-out behavior. Keep debugging/refresh administration private.
- **Dependencies and recovery:** commit a lockfile, review direct dependencies, and run vulnerability checks during implementation/review. Resolve or explicitly adjudicate relevant findings rather than blindly applying breaking upgrades. Before the trial, document and exercise a small database backup/restore procedure and an owner-operated profile-deletion procedure, including trace/feedback removal. Store backups privately and document retention; deletion must address backup expiry. Self-service export/deletion UI remains deferred to the multi-user beta.

Work-area plans must specify exact mechanisms, thresholds, and evidence for applicable requirements. Security checks are part of acceptance, not deferred to a later polish PR. No extra infrastructure or paid services are implied by this baseline.

| Owning work area | Required security acceptance evidence |
|---|---|
| Foundation | Secret-file ignore rules and placeholder-only configuration; lockfile/dependency review; server/engine import boundaries verified, with no live credentials required |
| Schema | Explicit grants/RLS migrations deny anonymous personal access; ownership constraints and immutable server-owned fields documented and tested with fixtures |
| Metadata | Provider response validation, repeatable bounded ingest, server-only credentials and safe text/URL handling |
| Availability: sweeps/evidence | Advisory overlap lock, workload/credit limits, retention, safe diagnostics and provider credentials verified |
| Hosting | Protected cron handler rejects missing/invalid authorization before privileged work; scheduler/runtime configuration verified |
| Classification and ranking | Classification/input bounds and untrusted-output validation; no personal histories sent to classification providers or client-side privileged dependencies |
| API, sessions and Auth | Two-identity endpoint and RLS isolation tests; guessed foreign IDs and ownership reassignment rejected; CSRF, rate-limit, malformed/oversized payload, expired-login and idempotency checks; recovery/deletion procedure verified |
| Phone experience | Deployed HTTPS/private access, signup restriction, actual iPhone login/logout, security headers, private-cache isolation and absence of privileged secrets in browser assets verified before measured sessions |
| Settings/PWA/operations | Preserve and rerun affected security checks as settings, PWA caching and recovery change; these PRs do not postpone pre-trial protections |
| Multi-user beta | Expand authorization/onboarding tests, shared-learning controls, retention and export/deletion behavior before enabling additional real users |

**Pre-trial gate:** Phone-experience work does not start real measured sessions until all applicable preceding work-area and hosting security criteria pass and remaining findings are documented with a concrete resolution. Failed ownership or credential-protection checks block deployment of personal data. Security evidence belongs in each PR's review notes.

## 3. Proposed data model

Logical schema, not finalized SQL. Schema-work planning settles physical types, indexes, checks, and migrations.

Separate accounts from viewing profiles, with one profile initially.

| Table | Core fields and purpose |
|---|---|
| `profiles` | UUID, nullable account reference, region, runtime ceiling, known languages, subtitle/content policies, revision, timestamps |
| `movies` | UUID, title, release date with source/date semantics, runtime, original language, US certification with source/check date, overview, poster, genre/keyword arrays, production-company evidence and versioned origin classification, rating and vote count, metadata source/refresh timestamps |
| `movie_external_ids` | Movie UUID, source namespace, external ID as text |
| `movie_credits` | Movie UUID, source/person ID, name, role, billing order |
| `movie_classifications` | UUID, movie UUID, rubric version, burden attributes, pacing/tone and optional content tags, field-level provenance/uncertainty, input fingerprint, model/prompt IDs, review status, timestamp |
| `streaming_providers` | Internal UUID, display name, source mappings; exact channel/ad-tier variants remain distinct |
| `availability_snapshots` | UUID, movie UUID, region, source, checked time, refresh deadline, outcome, country-level watch-page URL |
| `movie_availability` | Snapshot UUID, provider UUID, offer type; no speculative package ID or provider playback URL |
| `profile_subscriptions` | Profile UUID, exact provider variant UUID, enabled |
| `profile_movies` | Profile/movie UUIDs, watched state/date when known, taste rating, optional tired-viewing rating, permanent exclusion, timestamps |
| `selection_sessions` | UUID, profile UUID, start/last-activity/end, outcome, nullable selected recommendation UUID, selected time, correction deadline; optional experiment arm/seed/version |
| `recommendations` | UUID, session/movie UUIDs, sequence, idempotency key, explanation, version references, immutable JSONB trace, timestamp |
| `feedback_events` | UUID, recommendation UUID, event type, optional reason/value, idempotency key, timestamp |
| `refresh_runs` | UUID, job name, start/end, outcome, processed/failed counts, checkpoint and diagnostic summary |

Constraints:

- Internal UUIDs identify movies; external IDs resolve only through adapters. Use distinct branded types.
- Unique `(source, external_id)` and normally `(movie_id, source)` mappings.
- Unique `(profile_id, movie_id)` for current personal movie state.
- Unique `(session_id, idempotency_key)` and `(session_id, sequence)` on recommendations.
- Foreign keys and numeric bounds. Selection pointer is nullable at session creation and must reference a recommendation from that same session.
- A recommendation's session determines profile ownership. Enforce authorization for all feedback.
- Successful empty availability differs from absent/failed checks. Failed refreshes do not erase prior success. Read only the newest successful snapshot for each source/region; check its age.
- Session outcome is canonical for selection metrics. Write its update and associated event in one transaction.
- Profile deletion removes personal data; shared movie data remains.
- Classification revisions are immutable. Traces retain first-party profile/context
  snapshots and references to provider evidence rather than copies of provider data.
  A revision number or catalog hash alone cannot reproduce a result. Recommendation
  work owns expiry-aware references and any legacy-copy redaction before real use.

Genre/keyword arrays are sufficient for V0. Production-company evidence may also use a compact structured field; no company-management subsystem is implied. Keep evidence source, check time, classification version, and unknown/mixed status. Separate catalogs or a generic repository framework are deferred.

Availability history must support movie/provider-variant/region/offer-type observation intervals: successful absent and present checks, last absence, first presence, episode continuity, and whether an arrival is known, observed within an interval, or unknown. Provider-supplied arrival dates retain their source and semantics separately from observation timestamps. Schema work settles storage/indexes; metadata work populates metadata and Availability: evidence implements these observations. Do not encode an initial import or failed check as a newly added event.

## 4. Low-brain model and review workload

Use anchored ordinal levels 0–4:

| Attribute | Meaning |
|---|---|
| Narrative complexity | Nonlinearity, ambiguity, difficulty following the story |
| Attention demand | How much missing a short stretch harms comprehension |
| Emotional burden | Distress, bleakness, emotionally demanding subject matter |
| Intrinsic on-screen-text dependence | Plot-critical written messages or text, independent of subtitles |

Pacing and tone are separate taste descriptors. Runtime is metadata. Fast pacing is not automatically low effort.

Normalize levels by dividing by four:

```text
lowBrainFit = 1 - (
  0.35 * narrativeComplexity
+ 0.35 * attentionDemand
+ 0.20 * emotionalBurden
+ 0.10 * onScreenTextDependence
)
```

All weights/caps are hypotheses. Before taste ranking, require narrative complexity and attention demand each at most 2/4 initially. Calibrate caps against anchor movies before the trial. Taste cannot compensate for failing this gate.

Subtitle suitability is calculated at request time from profile languages and known audio presentation. Do not store viewer-dependent reading burden in the movie classification. Original language does not establish available dubbed tracks. If subtitles are disallowed and appropriate audio cannot be verified, exclude the title. Intrinsic text dependence remains movie-specific.

Create a personally reviewed anchor set spanning easy/demanding films and genres. Define levels with examples, evaluate classifier agreement, and measure complexity/attention correlation plus meaningful disagreements. Merge dimensions and version the rubric if they cannot be distinguished reliably; correlation alone does not prove duplicate meaning.

An overview may be insufficient evidence. Retain supplied evidence, human judgments, and model prior knowledge as separate provenance categories. Persist model outputs; a fingerprint does not expose model knowledge or guarantee regeneration. Confidence from the model is an uncalibrated signal, not an enjoyment probability.

### Boundaries and practical review load

Distinguish a hard exclusion from an ordinary preference:

| Boundary | V0 evidence and behavior |
|---|---|
| Runtime | One saved hard maximum in minutes; include only known runtimes at or below it, with no automatic relaxation |
| No Horror genre | TMDB genre exclusion; does not guarantee absence of all frightening scenes |
| US rating ceiling | Certification; missing certification excludes only when this hard rule is enabled |
| Subtitle prohibition | Request-time language/audio check; uncertainty excludes |
| Prefer emotionally lighter movies | Anchored batch-classified emotional burden affects fit and the agreed tired-mode cap; review uncertainty/borderline cases |
| Strict exclusion of a specific distressing theme | Reviewed theme evidence; unknown excludes under this explicitly strict policy |

Do not require human review of every ordinary emotional-burden classification. After anchor calibration, batch-classified non-borderline candidates can be eligible under the documented uncertainty policy. Flag disagreements, uncertainty, and titles near a cap for review. This is a recommendation heuristic, not a guarantee about every scene.

Before classification work, estimate workload from the watchable seed: anchor count, flagged fraction, uncertain fraction, expected minutes per review, and remaining eligible coverage. Begin with a review budget of roughly 30 anchors plus up to 20 flagged candidates, then inspect coverage. If a requested strict theme exclusion requires hundreds of reviews, present the actual tradeoff to the user; do not silently weaken it or collapse the pool. A strict personal theme ban remains a pending preference decision.

## 5. Taste representation

Store `loved`, `liked`, `meh`, `disliked`; watched state is separate. Haven't seen is missing taste evidence, not neutral judgment. Category-to-number mappings live in versioned configuration.

Start with genre/keyword/creative-contributor affinities. Shrink sparse evidence toward neutral; normalize feature contributions so long keyword/credit lists do not dominate. Recompute derived affinities from ratings instead of building a separate profile-maintenance system.

General ratings can inform general taste because the low-brain gate excludes demanding candidates. Tired-viewing ratings feed offline rubric/cap calibration and disagreement reports in V0. They do not automatically modify live weights.

Compare taste scoring with quality-only and genre-only rankings on held-out ratings before the trial. Report sample size/uncertainty; simplify or rebalance if additional features provide no useful signal. Historical rating prediction is not proof of better tired-evening selection.

## 6. Filtering and ranking

Trace each stage:

1. Sufficient metadata, including fields needed for enabled hard rules.
2. Successful US availability no older than the provisional 48-hour maximum.
3. Included-subscription offer matches an enabled provider variant. User-approved
   October 4 exception: Disney+/Hulu bundle-with-ads titles may pass on a current
   Watchmode US subscription listing when title-level ad-tier inclusion is unknown;
   show `Ad-tier unverified` and retain the availability-failure correction flow.
   This is accepted uncertainty, not confirmed tier entitlement. It does not extend
   to unpurchased channels, rental/purchase, Live TV or other uncertain hard gates.
4. Not watched or permanently excluded. User-approved V0 policy: unseen movies only; comfort rewatches are deferred.
5. No same-session exposure and no active cooldown (plain skips: initially seven days).
6. Runtime, certification/genre/content rules pass using section 4 evidence policies; compute subtitle suitability from current profile/audio context.
7. Complexity and attention demand each at most 2/4; agreed emotional cap and classification uncertainty policy pass.
8. Score eligible candidates.

Subscription, ad-supported, free, rental, and purchase offers remain distinct. A base subscription does not imply an add-on channel. Verify exact provider-variant semantics from real responses.

```text
baseScore =
  0.55 * tasteMatch
+ 0.30 * lowBrainFit
+ 0.10 * quality
+ 0.05 * novelty
```

Components are normalized 0–1; weights are provisional. Use vote-count-adjusted quality. Novelty has small influence. Missing taste evidence tends toward neutral.

Select deterministically using the freshness/variety policy below, with stable internal-ID tie-breaking after policy adjustments. Any later seeded exploration is a separately versioned policy.

### Freshness and production-origin variety

Prefer some recent releases and movies recently added to enabled subscriptions without excluding strong older films. Release recency and subscription-arrival recency are distinct signals; a newly licensed classic is not a new release. Apply them only after all hard gates. Missing or uncertain dates are neutral, not exclusion grounds, and future dates receive no recency boost.

Use a small, capped, decaying freshness boost within a near-equivalent shortlist formed from the arm's base score. Ranking work must specify the score-gap threshold, boost cap, decay windows, signal combination, and held-out sensitivity evidence before enabling the policy. Bound the combined release/arrival contribution; do not count the same movie multiple times because it appears on several subscribed services. This preserves taste/suitability priority in the personalized arm and quality priority in the baseline. Freshness remains separate from novelty (new to this viewer).

Freshness decay windows must fit entirely within Watchmode's 30-day
cache limit and the retained supporting evidence. Expired evidence is neutral;
ranking cannot retain or reconstruct an old provider observation to extend a boost.

Production origin is metadata, not the streaming service carrying the movie. Retain evidence-backed streamer-produced/financed, traditional-studio, independent, mixed, and unknown categories. Commissioning, financing, co-production, and acquisition/distribution are distinct evidence; a platform availability or marketing label alone does not establish production origin. Version the mapping and preserve ambiguity instead of guessing. Origin is neither a quality score nor an eligibility requirement.

Within the same near-equivalent shortlist, use a small, bounded adjustment favoring origin groups underrepresented in recent recommendations relative to the eligible alternatives. Base this on recommendations shown, not just selections; snapshot the relevant history for replay. Ranking work defines the history window, minimum evidence, adjustment cap, category handling, and precedence with freshness. No mandatory 50/50 split or blanket streamer penalty; any base-score tradeoff is bounded by the documented near-equivalence threshold. Unknown/mixed data cannot cause exclusion or receive a fabricated group advantage. If good alternatives do not exist, return the best eligible movie and expose the coverage limitation in diagnostics.

Store normalization, shrinkage, quality adjustment, caps, cooldowns, base weights, freshness parameters, and origin-variety parameters in explicit versioned configuration. Generate short explanations only from actual supported features/taste evidence.

Empty results distinguish `refresh_stale`, `refresh_failed`, `backend_unavailable`, and `eligible_pool_exhausted`. Do not silently relax runtime, watched, subscription, or content rules. If runtime is preventing eligible results, explain that and link to preferences; the user can change the saved limit and request another pick. Do not offer a nightly override or extra runtime mode in V0.

## 7. API, sessions, and feedback

`POST /recommendations` creates history. Inputs include session ID and idempotency key. Profile identity comes from trusted authorization or local-only context, never an arbitrary client user ID. Return one movie, recommendation ID, matching services, country-level destination, explanation, and check time. Internal scores remain diagnostic.

Next-pick requests include `rejects: recommendationId` and optional reason. Under a session row lock, check idempotency, validate ownership/current state, and atomically record feedback plus the next pick or empty outcome. Retries return the original result. Selection events and session updates are transactional; feedback is idempotent too.

| Action | Meaning |
|---|---|
| Pick another | Same-session suppression and provisional seven-day cooldown; no lasting taste update |
| Not interested | Explicit negative evidence; distinguish movie exclusion from inferred feature dislikes |
| Seen it | Update watched state, not dislike |
| Too heavy | Suitability evidence and offline classification review |
| Not available | Flag refresh; may invalidate a prior selection as described below |
| Choose this | Selection intent; does not prove playback or viewing |
| Where to watch | Open the country-level TMDB watch page; does not itself mark selection |
| Post-watch feedback | Enjoyment and tired suitability |

Keep default skip one tap and reasons optional. The interface can present a primary `Choose this` action that records intent and opens the watch-page destination, plus a secondary `Where to watch` link that opens it without recording intent.

### Session boundaries and failed selections

Start a session on its first pick, not a page view. Expire an unselected session after two hours without a pick/feedback action. Passive views do not extend it. Enforce expiry on access and metric finalization. Before expiry, reopening resumes the current pick; afterwards start a new session. Unselected expiry is abandonment; backend/catalog failures are separate outcomes.

Choosing a movie stops additional picks for that session but records `selected_provisional` for a **30-minute correction window**. Keep `Not available` accessible on return to the app. During that window, an owned idempotent report updates the event and session atomically to `availability_failure`, clears the active selection pointer while preserving the historical event, and removes that session from successful-selection counts. Offer a replacement in a new session linked in the trace to the failed attempt. Report failure and replacement together in diagnostics so the new session does not hide the failed attempt.

After the correction deadline, finalize to `selected_intent` unless invalidated. Exclude still-provisional sessions from finalized metrics and report their count. Later availability reports remain recorded and trigger refresh, but do not rewrite the primary trial metric without an explicit documented retrospective analysis. The window is a practical default, not a claim that unreported selection implies successful playback. Confirmed watching is recorded separately.

## 8. External data, caching, and refresh operation

Use separate metadata and availability provider interfaces. Adapters resolve source IDs and return validated domain records. Ranking code never consumes TMDB response shapes.

TMDB supplies metadata; Watchmode is the user-selected availability authority as of
October 4, 2026. TMDB provider IDs are a cross-check, not entitlement evidence.
The [free-key verification](plans/watchmode-verification.md) records source IDs,
actual credit costs, returned link fields and unresolved ad-tier inclusion. The user
selected the free plan and bounded full membership scans on October 4. Target daily
scans; 2–3-day scanning does not satisfy the existing 48-hour eligibility rule.
Refresh metadata and links incrementally from stored work queues, without paid
change endpoints. The [sweeps plan](plans/availability-sweeps.md) and [evidence plan](plans/availability-evidence.md) define
completion, absence evidence, budgets and retention. No paid action is authorized.
Do not add package or playback fields unsupported by the verified source.

Metadata ingestion retains production-company identifiers/names and release-date semantics from validated metadata. Derive production-origin groups only from supported evidence, with a small versioned mapping and targeted review of ambiguity; provider availability and an acquired "Original" label do not prove who produced a movie. Unknowns remain eligible. Do not use origin as a proxy for quality.

The availability follow-up records real Watchmode responses for 5–10 subscribed-service
movies. Use exact provider variants as enabled units and verify channel/ad-tier
semantics. Service-level subscription offers with unknown ad-tier inclusion do not
confirm entitlement; the explicit Disney+/Hulu exception in section 6 permits
eligibility with a visible uncertainty label. Four initial samples are recorded in the verification evidence;
these do not complete the production availability acceptance. Watchmode web links
and paid-only mobile deep links have distinct semantics. The UI work must validate
supported destinations and implement required Watchmode/TMDB attribution. TMDB's
country-level watch-page information remains a cross-check with its own JustWatch
attribution requirements.

Watchmode sweep membership supplies observed availability, not an exact date a movie
joined a service. Omission from a complete promoted per-service sweep is absence
evidence, including for a title first appearing later. Arrival requires that complete
absence at most 48 hours before presence, with no failed/partial sweep between them.
The first sweep of a service and newly configured service generations remain unknown.
Consecutive complete `present → absent → present` is continuity consistent with
pagination drift, never a new arrival; apply that rule before interval derivation.
Partial/failed sweeps cannot prove absence. Repeated presence does not reset the
arrival clock. Availability: evidence defines the retained interval/episode inputs;
ranking owns bounded boosts, with no stacked credit for multiple subscriptions.
Explanations say "recently observed on your service" when that is the evidence.

| Data | Initial refresh policy |
|---|---|
| Established metadata | Roughly every 30 days |
| Recent/incomplete metadata | More frequently as needed |
| Active eligible-candidate availability | Daily target; exclude after 48 hours |
| Classification | Immutable revision when inputs/rubric change |
| Failed refresh | Bounded retry/backoff inside a run, preserve prior success/check age |

Use **daily Vercel Cron** to invoke a server refresh handler protected by `CRON_SECRET`; verify its bearer authorization before accessing privileged data. No pg_cron, pg_net, or Vault scheduler in V0. Keep refresh logic in shared server modules so a CLI can run the same job.

Cron itself does not automatically retry failed invocations. Availability workers
implement bounded transient retries, progress/checkpoints and a shared session-level
PostgreSQL advisory lock preventing overlapping manual/refresh runs. Hosting owns
the refresh worker's dedicated direct or session-mode database connection; transaction
pooling cannot preserve a session-level lock. Supabase's session pooler uses port
5432; its transaction pooler uses 6543. Verify the actual endpoint/mode and connection
lifetime before scheduling ([Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)). Hosting also owns
the protected cron handler, scheduler wiring and cron-denial tests. The
[hosting plan note](plans/hosting.md) requires bounded retry within an interrupted
sweep's six-hour resume window and preserved original failure diagnostics. The availability
plans expose local workers without adding an HTTP handler. Prioritize selected/flagged
and active eligible metadata/link work rather than the entire metadata universe.

Benchmark daily active-pool coverage below the function duration with margin. Use bounded concurrency compatible with TMDB limits and stop/checkpoint before timeout. Do not rely on detached background work after returning. If the workload cannot fit, reduce the active pool while preserving useful coverage or revisit the scheduler/plan explicitly before the trial. Initial full ingestion and classification are scripts, not cron payloads.

Persist `refresh_runs`. Log an invocation start/failure to Vercel before contacting Supabase so a paused database cannot erase the diagnostic record. Private diagnostics compare last successful run and overdue coverage; return refresh-specific errors. Document checking host job logs and manual retry/unpause. This is observability and a recovery path, not guaranteed proactive external alerting.

Supabase Free can pause projects with low user database activity over seven days. Daily refresh is not a guarantee against pausing. Vercel's external invocation can record a failed database connection but cannot automatically unpause it. A paid-tier decision, if needed for reliability, requires explicit discussion.

Seed candidates availability-first using Watchmode US movie subscription lists for
the four verified direct services. Complete per-service membership scans cover the
service lists; enrich a balanced subset of initially at most 1,000 unique movie
records through TMDB. The membership index is separate from that metadata cap.
Classify watchable candidates first. Import rated movies independently even when
unavailable. Eligible coverage and classification review budget matter more than
raw catalog size. Expand the enriched catalog only when coverage evidence calls for it.

Refresh provider destinations for the active shortlist in background jobs and cache
them within Watchmode's 30-day limit. Ordinary picks never call `/sources` or any
other provider. Membership freshness and link-cache age are distinct. A partial
scan cannot establish an absent offer or arrival; missing tracked titles need a
complete promoted per-service sweep before omission can support absence. Targeted
source checks supply links/current offers but are not an arrival prerequisite.

### Retention and replay limits

Provider retention limits apply to historical evidence and private response/report
caches as well as current catalog rows. Watchmode free-plan data expires after
30 days; TMDB data must be re-fetched or purged within six calendar months. Begin
refreshing at five calendar months, with bounded retries across the remaining
window. Updating a current
row does not renew historical copies. Provider account termination also requires
the applicable data purge.

Availability: evidence adds a time-bounded invoker guard on availability snapshots,
offers, observations, tracks and new Watchmode cache/evidence tables. It always
denies UPDATE; every DELETE, including FK cascades at any trigger depth, requires
the row's own immutable checked/observed timestamp older than the configured
retention window. A mixed-age cascade fails and rolls back; there is no nested
DELETE age bypass on these tables. Preserve grants/RLS. Use no maintenance-owner
role, SECURITY DEFINER retention function or role-aware bypass; unrelated immutable
guards remain unchanged. The additive evidence migration is implemented and
validated on disposable PostgreSQL; it has not been applied to the retained catalog.

TMDB refresh/retirement uses ordinary movie UPDATEs. Preserve the UUID and first-party
ratings, feedback and session metrics; retire and clear expired provider fields
only after the six-calendar-month deadline passes with all scheduled attempts
failed. A confirmed TMDB 404 is the only early "gone" signal; failed refreshes never
stamp successful refresh time. Keep canonical external-ID mappings separate from
acquisition provenance records, allowing independent acquisition paths and times
for the same mapping. Backfill existing mappings as TMDB acquisitions at their
movie's metadata fetch time, never as first-party input. IDs from
first-party ratings input survive TMDB retirement, as do independently fresh
Watchmode IDs subject to Watchmode's own 30-day cache limit. A later successful
refresh can restore the same UUID. Recommendation work
owns trace/classification/recommendation redaction and expiry-aware references.
Traces must reference provider data rather than copy it. Replay ends when required
evidence expires and reports `evidence_expired`; refreshing current data cannot
recreate original evidence. Availability work does not rewrite immutable personal
or classification history.

Discovery must cover subscribed services, recent and older release cohorts, and studio/independent/streamer-produced movies without relying solely on the first popularity-sorted page. Metadata work defines bounded discovery batches, deduplication, pagination limits, and coverage diagnostics; Availability: evidence verifies actual offers. Unknown production origin stays in the pool. Diagnose missing groups at discovery, availability, hard filtering, and scoring rather than forcing an arbitrary catalog quota or relaxing personal rules. All metadata/observation enrichment remains offline; no extra provider or LLM call is added to a pick request.

Respect provider limits, validate payloads, and make ingest repeatable. Verify caching/retention and licensing terms for the intended use; commercial operation requires a separate licensing assessment.

## 9. Traces, tests, and experiment

Immutable JSONB traces capture request/session, sequence, timestamp, timing;
algorithm/config/rubric versions; first-party profile/context snapshots; catalog
identities; exclusions/counts; scores/ranking; winner/tie-break; and references to
the actual versioned provider/classification evidence used. Reference provider data
rather than copying it into traces. A mutable current movie row or a fingerprint
alone cannot stand in for the original inputs. Recommendation work owns the
reference/expiry and any legacy-copy redaction design. Capture the near-equivalent
shortlist, adjustments and relevant first-party history for variety; link to retained
freshness/origin evidence. Report cohort counts and filter attrition, including
unknown/mixed values. Persist experiment arm/seed/version when enabled.

A fingerprint detects changes but cannot reproduce overwritten input. Ranking replay uses frozen data and persisted classifier outputs, not today's database or a fresh LLM call. Exact replay ends when required provider evidence expires under section 8; never regenerate missing historical evidence from current responses or report that as the original replay.

Tests cover deterministic rankings, score behavior, watched/unavailable/rental/wrong-variant exclusions, uncertainty, hard boundaries, subtitle context, cooldown/expiry edges, empty/stale pools, provider failures, session locking, idempotency, selection correction before/after deadline, metric finalization, refresh checkpoint/lease behavior, and ownership. Use recorded provider fixtures; live checks remain separate. Tests accompany implementation before review.

Freshness tests cover decay/boundaries, unknown/future dates, initial import, observed absence-to-presence intervals, repeated refreshes, outages/gaps, removal/reappearance, multiple subscriptions without stacked boosts, and old films newly available. Origin tests cover production versus distribution, co-productions, unknown metadata, sparse/single-origin pools, repeat exposure, and deterministic replay. Prove that policy adjustments cannot breach hard gates, pull candidates from outside the configured near-equivalent shortlist, or suppress older/studio/independent candidates solely because of origin or missing evidence. Compare rankings with adjustments disabled and enabled; report concentration, fit/quality changes, and sample sizes before fixing ranking parameters. Do not assume an equal origin mix is the correct target.

### Personal trial

User-approved design: 1:1 randomized session assignment to personalized base ranking versus a quality-first base ranking without taste personalization, both using the same eligible pool. Both apply the same versioned freshness and origin-variety policy, with the same history rules and parameter values; the baseline therefore is not an unmodified quality-only argmax. Assignment is hidden in the UI and stable within the session. Both arms share interface, hard gates, cooldowns, availability rules, and explanation presentation; explanations must remain truthful and must not claim taste-based ranking in the baseline. Persist assignment and policy, freeze configuration during a measurement phase, and document learning/carryover effects.

This comparison estimates the incremental value of personalization **within the low-brain eligible pool under the shared freshness/variety policy**. It does not independently establish the benefit of freshness or origin variety; assess those through separate offline ablations and a separate measurement phase if needed. It does **not** measure whether the low-brain gate improves outcomes compared with unrestricted movies. Anchor review, classifier agreement, and post-watch tired-suitability feedback assess the gate indirectly; a direct causal gate comparison is deferred and must not be inferred from this trial.

Begin with 20–30 real phone sessions as directional evidence, roughly 10–15 per arm. This detects only large differences and remains subject to single-user/designer bias.

Report finalized successful-intent median and completion rate, provisional counts, abandonment, failed availability, corrected selections, replacement sessions, time to selection, and post-watch results. All original attempts remain in denominators. Ordinary link openings do not count as selections. Unreported playback failures remain a measurement limitation.

Offline held-out ratings and trace replay support diagnosis; they cannot reveal behavior for picks never shown. Avoid tuning and declaring success on the same tiny sample. Preserve subsequent sessions for fresh validation. Material interface/model changes start a separate evaluation phase.

### Feedback and future learning across users

V0 collects minimal first-party feedback for personal improvement and product evaluation: recommendations shown and version references, selections, skips, optional rejection reasons, availability failures, and optional post-watch enjoyment/tired-suitability ratings. Reuse the existing sessions, recommendations, and feedback events; do not introduce an additional tracking service or mandatory questions into the one-button flow.

Preserve signal meaning: a skip is exposure/cooldown evidence, not lasting dislike; selection is intent, not confirmed watching; availability failure concerns offer accuracy; tired-suitability feedback is distinct from general enjoyment. Preserve profile ownership, classification and algorithm provenance, and deletion support so later evaluation can interpret these signals correctly.

During the multi-user beta, start shared improvement with aggregate outcome evaluation, recurring availability issues, and classification-disagreement analysis. Treat subjective tired-viewing reports as evidence to review, not universal truth. Do not automatically overwrite shared movie attributes from one user's feedback. Publish changes through versioned review/calibration and assess them on fresh evaluation data.

Before reusing viewing histories for shared learning, establish clear disclosure, user controls for participation, a documented retention policy, and export/deletion behavior. Keep operational records separate from opt-in shared-learning datasets. Enforce participation choices when preparing datasets, minimize included fields, and document how deletion affects source records and derived datasets. Removing names or replacing profile IDs does not make detailed viewing histories anonymous; avoid publishing identifiable histories or tiny-user aggregate breakdowns.

Shared learning is deferred to the multi-user beta; collaborative filtering, cross-user embeddings, and automatic shared-model training remain deferred until sufficient data demonstrates a need. V0 does not train models across users or send personal viewing histories to external classification services. Any later change to that data flow requires its own design and disclosure.

## 10. Repository and PWA

```text
src/
  app/                 # Next.js entry points
  components/          # UI only
  recommendation/      # Pure filtering, features, ranking
  domain/              # Types and invariants
  server/
    db/
    providers/
    ingestion/
    classification/
scripts/
tests/
  fixtures/
docs/
```

Co-locate validation schemas with owning modules. Enforce imports/ID distinctions as described in section 2. Add a CLI such as `pick --profile X --at <timestamp> --explain` with explicit dry-run/live modes. Replay consumes stored inputs, not merely an old timestamp applied to current data. CLI DB access stays outside the engine.

PWA: manifest/icons, standalone mode, iOS safe areas, touch targets, persistent authorization, fast startup, and loading/error/offline states. Cache static assets conservatively, avoid indiscriminate private-response caching, and do not generate new offline picks from stale availability. Test install/login/outbound navigation on the actual iPhone before the trial.

Keep documentation small: architecture, recommendation/rubric/evaluation, and roadmap/decisions.

### V0 personal preference setup

Phone-experience work includes a small first-run setup/settings screen before the phone trial. Save enabled streaming services and exact add-on variants, runtime ceiling, known languages/subtitle preference, and horror/emotional preferences to the single personal profile. Distinguish ordinary preferences from strict exclusions using the evidence policies in section 4. Do not connect to streaming accounts or request their credentials.

Runtime is one saved **maximum movie length** in preferences, enforced as a hard ceiling. Show the actual runtime on the recommendation card. Keep the home screen focused on the pick button: no time-tonight prompt, runtime presets, or multiple runtime modes. Unknown runtimes are ineligible; a movie exactly at the limit is eligible. Do not favor shorter movies solely because of length within the permitted range. Record the effective saved limit in traces and cover boundary/missing-runtime behavior in engine tests. Nightly overrides, runtime modes, and runtime-based ranking adjustments are deferred until actual use justifies them.

For local testing, use a seeded profile with clearly identified fixture values. For the deployed phone trial, associate the personal profile with the real pre-provisioned private login from API, sessions and Auth work; do not expose a dummy account. Require confirmation of the trial preferences before starting measured sessions. Keep setup outside the one-button home flow and allow later edits in settings. Record profile revisions in recommendation traces and flag changes during a measurement phase.

V1 adds broader new-user onboarding, self-service account creation, and multiple-user isolation. The basic preference screen is V0 scope; later settings work is polish rather than a prerequisite for the trial.

## 11. Work-area roadmap

Roadmap items are work areas, not GitHub PR numbers.

Workflow: scope → implementation plan → implementation with tests → checks → review → adjudication → revisions with checks → re-review → merge. This document is planning only.

| Work area | Scope and exit evidence |
|---|---|
| Foundation | Foundation, pure domain/engine boundary, ID types, fixtures/test runner, secret-file conventions and dependency checks; forbidden imports/type substitutions rejected |
| Schema | Schema, grants/RLS and fixture inserts, including storage for origin evidence and availability observations; constraints and anonymous-access denial verified without provider resolution |
| Metadata | Metadata adapter, bounded discovery/ingest across services, release cohorts and production origins; release/origin evidence and resolved personal ratings import; unknowns, coverage gaps, ambiguity and deduplication verified |
| Availability: sweeps | [Plan](plans/availability-sweeps.md): Watchmode provider, round-robin complete sweeps/checkpoints, balanced popularity-ordered TMDB enrichment, advisory lock, per-run cap and quota preflight; completeness/identity/starvation/budget/resume checks |
| Availability: evidence | [Plan](plans/availability-evidence.md): offers/variants, complete-sweep absence and drift-aware arrival intervals, background links, age-based retention migration and movie retirement; initial/gap/partial/drift/retention checks and pre-classification coverage estimate |
| Hosting | [Plan note](plans/hosting.md): protected cron handler and denial tests, scheduler/database-secret setup, timely partial-sweep recovery and bounded refresh runtime benchmark; deployment only after separate authorization |
| Classification | Anchor rubric, batch classification and targeted review; uncertainty/provenance, review budget, distinction/correlation evidence and eligible coverage |
| Ranking | Pure filters/ranking with bounded freshness and origin-variety policy; mandatory gates, replay, shared trial policy, concentration diagnostics and ablations tested; held-out comparisons and exact configuration documented |
| API, sessions and Auth | Orchestration, transactions, session expiry/selection correction, traces/replay CLI, single-user Auth, authorization/request protection/rate limits and recovery/deletion procedure; two-identity isolation and rejection/retry checks verified |
| Phone experience | Stable one-card phone flow, basic first-run preference setup/settings, minimal PWA install/login, approved randomized assignment; saved preferences and deployment/security gate verified before the trial |
| Settings and visual polish | Settings refinement and visual polish; separate evaluation phase if selection flow changes materially |
| PWA and operations | Offline/error polish and operational recovery/hardening; actual iPhone checks |
| Later | Multi-user onboarding/isolation/export/deletion, shared-learning disclosure/participation controls and aggregate evaluation; advanced shared models and commercialization only after validation |

Deploying the cron handler requires configured hosting/database secrets and protection, but does not expose personal profile writes. API, sessions and Auth work adds application-user access before the phone trial. Initial ingestion/classification can run locally before deployment.

### Recommended coding models by work area

These recommendations concern the coding agent implementing/reviewing each work area, not an LLM running in the app. They do not change the current chat's model or authorize automatic model switching. The batch movie-classification model in classification work is a separate choice made through anchor-set evaluation.

Use GPT-6.1 Sol as the usual implementation model; reserve GPT-6 Astra for ambiguous classification design, core ranking, and transaction/auth correctness. Reasoning settings and assignments below are engineering judgments informed by [official OpenAI model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection), not benchmarked guarantees for this repository. Exact model IDs are `gpt-6.1-sol` and `gpt-6-astra`, as exposed by this Codex host when the plan was written.

| Work area | Implementation model | Reasoning effort | Review model / effort | Reason |
|---|---|---|---|---|
| Foundation | GPT-6.1 Sol | Medium | GPT-6.1 Sol / High | Bounded setup, types and import boundaries |
| Schema | GPT-6.1 Sol | High | GPT-6 Astra / High | Constraints, ownership and future migration consequences |
| Metadata | GPT-6.1 Sol | High | GPT-6.1 Sol / High | Identity resolution, validation and repeatable ingest |
| Availability: sweeps | GPT-6.1 Sol | High | GPT-6 Astra / High | Provider decoding, balanced queues, lock and budget bounds |
| Availability: evidence | GPT-6.1 Sol | High | GPT-6 Astra / High | Arrival ambiguity, links, retention and retirement |
| Hosting | GPT-6.1 Sol | High | GPT-6 Astra / High | Protected scheduling and runtime configuration |
| Classification workflow | GPT-6 Astra | High | GPT-6 Astra / Extra high | Rubric ambiguity, evidence quality and review workload |
| Ranking | GPT-6 Astra | High | GPT-6 Astra / Extra high | Product-critical scoring, hard gates and evaluation validity |
| API, sessions and Auth | GPT-6 Astra | High | GPT-6 Astra / Extra high | Atomic state transitions, retries, metrics and access control |
| Personal phone experience | GPT-6.1 Sol | High | GPT-6 Astra / High | UI/server integration, saved settings and experiment behavior |
| Settings and visual polish | GPT-6.1 Sol | Medium | GPT-6.1 Sol / High | Focused presentation changes; increase effort if behavior changes |
| PWA and operations | GPT-6.1 Sol | High | GPT-6 Astra / High | Offline behavior, persistent login and failure recovery |

Run reviews in a fresh context with the actual diff, acceptance criteria and test evidence. A separate review may use the same model; model diversity alone is not verification. Claude can continue as the user's additional independent reviewer; no particular Claude version is assumed here.

Keep implementation and revisions on the same model unless a concrete failure or unresolved issue warrants escalation. Extra-high reasoning is reserved for demanding reviews rather than every routine edit. Reassess settings using observed correctness, rework and usage, and check available models before each work area. Model selection never replaces tests, actual iPhone verification or human decisions. The multi-user beta's model recommendation is chosen when its work scopes are defined.

## 12. Risks, approved decisions, and personal inputs

Risks: inaccurate burden labels; sparse taste evidence; stale offers/provider variants; strict rules reducing coverage; confusing mood skips with dislikes; selection without playback; inability to replay mutable inputs; single-user evaluation bias; premature platform complexity.

Approved product decisions:

1. Trial assignment: approved hidden session-level personalized versus quality-first base ranking, with shared freshness/origin-variety policy as specified in section 9.
2. Rewatches: approved unseen-only V0; a comfort-rewatch lane is deferred.
3. Boundary design: approved structured-data-first exclusions and targeted review. Distinguish ordinary lighter-viewing preferences from strict theme exclusions because the latter may require additional review.
4. Freshness and variety: bounded preferences for recent releases/observed subscription arrivals and production-origin variety among near-equivalent candidates; no origin exclusions or fixed quotas. Ranking work sets parameters and evaluates tradeoffs before enabling them.

Actual subscriptions/add-on variants, runtime ceiling, known languages/subtitle preference, and horror/emotional preferences will be collected through the V0 setup screen in phone-experience work and confirmed before the trial. These values do not block architecture planning. Do not invent or silently hard-code personal preferences; local fixtures must be identified as fixtures.

Also needed before prototyping: roughly 50–100 rated movies and representative easy/demanding anchors. No need to design dozens of sliders.

Engineering defaults settled without asking the user: Vercel/daily cron for the personal pilot, Supabase/email-password single-user access, deterministic ranking with stable tie-breaking, two-hour idle expiry, seven-day skip cooldown, 48-hour availability maximum age, 30-minute selection-correction window, initial complexity/attention caps 2/4. These are proposed versioned defaults, not validated optimal values or permission to purchase/deploy anything.

## 13. Requested Claude review

Review the consolidated body as the specification; section 15 is historical rationale only. Do not implement or expand scope.

Assess product focus, freshness evidence and origin-variety effects, observable/calibratable burden attributes, review workload and eligible coverage, sparse-data ranking, identity/provider semantics, session transactions and failure metrics, runtime/refresh feasibility, user isolation, experiment interpretation, and independently reviewable PRs.

For each finding: severity, section, concrete failure scenario, smallest correction. Separate blockers, tuning hypotheses and optional improvements. Flag unsupported claims. Avoid advanced infrastructure without demonstrated need.

## 14. Official references checked

- [TMDB watch providers](https://developer.themoviedb.org/reference/movie-watch-providers): country/provider availability, no full direct playback links, JustWatch attribution.
- [TMDB API schema](https://developer.themoviedb.org/openapi/tmdb-api.json): release/production-company metadata and watch-provider response fields; current offers do not establish historical service-arrival dates.
- [TMDB movie discovery](https://developer.themoviedb.org/reference/discover-movie): release-date, company and watch-provider filters; bounded queries support broader candidate coverage.
- [TMDB FAQ](https://developer.themoviedb.org/docs/faq): noncommercial attribution and commercial licensing distinction.
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security): data access boundaries.
- [Supabase custom domains](https://supabase.com/docs/guides/platform/custom-domains): supplied project addresses and optional custom domains.
- [Supabase project pausing](https://supabase.com/docs/guides/platform/free-project-pausing): low-activity Free projects can pause; daily work is not a reliability guarantee.
- [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps): manifest and PWA guidance.
- [Vercel Hobby](https://vercel.com/docs/plans/hobby): personal/noncommercial usage restriction.
- [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing): Hobby daily cadence and imprecise timing.
- [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs): bearer-secret protection, function limits and lack of automatic retries.
- [Vercel function limits](https://vercel.com/docs/functions/limitations): Fluid-compute Node.js Hobby duration; confirm actual project configuration at deployment.
- [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): deny-by-default access, ownership checks on every request and authorization tests.
- [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): explicit protection for cookie-authenticated mutations; defense beyond CORS/SameSite alone.

Verify exact response schemas, terms, limits and access settings during implementation. Host plan pages can differ by runtime/configuration; the architecture uses the function-limits reference rather than assuming legacy duration values apply.

## 15. Short decision log

This log explains changes; it does not override the body.

| Review IDs | Decision and rationale |
|---|---|
| B1, B2, S11, S12 | Schema precedes ingest; real ratings import follows resolution; single-user access and real phone flow precede measurement |
| B3; second review item 4 | User approved randomized personalization comparison; explicitly does not validate the low-brain gate causally |
| B4, S7–S9, T1 | Mandatory low-brain caps, request-time subtitles, prior-knowledge provenance, anchor distinction checks and held-out taste baselines |
| S1–S4 | Explicit expiry, atomic next-pick/selection, nullable selection pointer; skips affect cooldown only |
| S5, S6; second review item 1 | Exact provider variants and country-level destination; structured genre/certification limits, calibrated batch labels and targeted review with workload estimate |
| S10; second review item 3 | Vercel chosen now; external daily cron replaces the provisional database scheduler; benchmark runtime and expose refresh failures |
| Second review item 2 | Provisional selection with 30-minute availability correction; failed selections stay in reporting |
| T2 | Keep deterministic argmax until repetition evidence justifies exploration |
| Engineering suggestions | Availability-first seed, enforced engine/ID boundaries, diagnostic/replay CLI; tests before review |
| Structural review | Fold all rules into their owning sections; eliminate precedence appendix and stale competing specifications |
| User decision, October 2, 2026 | Approved randomized trial, unseen-only V0, and structured-data-first boundaries; personal service/content values remain needed |
| V0 setup decision, October 2, 2026 | Basic preference setup/settings moves into PR 8 before the trial; local seeded profile and deployed private login serve distinct testing contexts; broad onboarding remains V1 |
| Runtime decision, October 2, 2026 | One hard maximum in preferences, visible movie runtime, no silent relaxation; nightly overrides/modes and shorter-movie ranking are deferred to preserve the one-button flow |
| Shared-learning decision, October 2, 2026 | Reuse minimal V0 feedback for personal improvement/evaluation; prepare for controlled aggregate learning in the multi-user beta, with disclosure, participation controls, retention and deletion support; advanced cross-user models deferred |
| Security decision, October 2, 2026 | Define baseline and PR ownership now; implement/verify in each owning PR, with a pre-phone-trial gate instead of deferring security to polish |
| Freshness/origin decision, October 2, 2026 | Prefer recent releases and observed subscription arrivals with bounded ranking influence; retain older/studio/independent candidates, separate production from distribution, diagnose coverage/concentration, and apply the same policy to both trial arms; PRs 2–4 and 6 own implementation |
