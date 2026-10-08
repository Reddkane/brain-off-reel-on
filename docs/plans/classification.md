# Classification: core offline Phase A

Date: October 7, 2026

Status: **Phase A approved** by .cache/classification-impl-handoff.md, with the
spend carry-over and latest-review amendments below. Implemented locally with
passing validation; see classification-implementation.md. Independent review is pending.

Branch: feat/classification; baseline: f708373 (#13). This plan follows
.cache/classification-handoff.md, narrowed by the user's
.cache/classification-trim-handoff.md decision. The [architecture](../architecture.md)
owns product behavior; [engineering](../engineering.md) owns release gates.

## 1. Scope and gates

Phase A keeps the core needed to store, calibrate and report low-brain scores.
Ranking, the user's 50–100 taste ratings and increased link checks proceed
separately; this plan does not authorize those implementations or executions.
Root AGENTS.md applies; no nested guidance was found in proposed work paths.
Preserve untracked .claude/, existing .cache/ artifacts and other edits.

The closed [retained batch results](retained-availability-live.md#10-results-2026-10-0607)
record 700 active titles, 99 link-ready, 29 missing certification, one missing
runtime and unknown origin for all. These are dated evidence, not a current query.
Classification cannot create links; hosting/evidence owns that bottleneck.

**Now:** approved Phase A implementation and disposable validation. No commits,
pushes, PRs, provider/LLM calls,
credential reads or retained-catalog access. Do not read .env.local or
.cache/real-catalog/private/, or touch bor-catalog-local.
Approval is recorded in .cache/classification-impl-handoff.md.
Real adapters, retained reads/writes, metadata fetching, paid work, ranking,
UI, hosting and deployment remain excluded. No new dependency is planned.

1. Review and explicitly approve this plan before implementation.
2. Implement Phase A with observed-red regressions, required checks and controls.
3. Deliver actual changes, docs/plans/classification-implementation.md and a
   complete .cache/classification-review.patch, including new files, for fresh
   review/adjudication and re-review of material revisions.
4. Obtain separate authorization and pending decisions before Phases B and C.

Architecture's coding-agent recommendations remain advisory; they do not select
the movie classifier or authorize another model call.

## 2. Rubric v1

After approval, publish this guide in docs/rubric-v1.md. Levels are ordinal
integers 0–4. Examples are provisional discussion anchors, not verified labels,
personal ratings or production seeds; the user independently calibrates them.

| Level | Narrative complexity | Example |
| --- | --- | --- |
| 0 | One direct goal, linear events, explicit causes. | The Red Balloon |
| 1 | Simple linear plot with a few clear subplots. | Paddington |
| 2 | Connected threads/modest time shifts; central story stays clear. | Back to the Future |
| 3 | Nonlinearity, hidden causes or ambiguity requires reconstruction. | Memento |
| 4 | Layered timelines/identities; interpreting causality is central. | Primer |

| Level | Attention demand | Example |
| --- | --- | --- |
| 0 | Brief gaps rarely harm understanding; visual context repeats. | Shaun the Sheep Movie |
| 1 | Occasional details matter; central action is easy to recover. | The Princess Bride |
| 2 | Recurring consequential details; a gap loses local connections. | Knives Out |
| 3 | Frequent clues/dialogue; gaps lose important connections. | Tinker Tailor Soldier Spy |
| 4 | Nearly continuous tracking; brief gaps substantially impair understanding. | Primer |

| Level | Emotional burden | Example |
| --- | --- | --- |
| 0 | Predominantly reassuring; distress is brief and mild. | The Many Adventures of Winnie the Pooh |
| 1 | Mild conflict/sadness with sustained relief. | Paddington |
| 2 | Meaningful loss/tension balanced by relief. | The Truman Show |
| 3 | Sustained distress, bleakness or disturbing material. | Manchester by the Sea |
| 4 | Severe persistent distress/trauma, little relief. | Requiem for a Dream |

| Level | Intrinsic on-screen-text dependence | Example |
| --- | --- | --- |
| 0 | Text is incidental; action/dialogue carries essential meaning. | The Red Balloon |
| 1 | Occasional text helps; essentials appear elsewhere. | Paddington |
| 2 | Several written clues/messages materially aid comprehension. | The Da Vinci Code |
| 3 | Recurring essential written evidence; skipping loses major connections. | Memento |
| 4 | Reading screens/messages/documents primarily conveys the plot. | Searching |

Attention uses a roughly 30–60-second gap. Complexity concerns story structure;
attention concerns detail density/recoverability. Proposed split examples:
Knives Out complexity 1/attention 2; Tinker Tailor Soldier Spy complexity 2/attention
3. These are hypotheses for independent ratings, not agreement targets.

Not evidence: fast pacing for low effort; runtime for complexity; genre/rating
alone for emotional burden; original language/subtitles/audio availability for
intrinsic text; popularity, origin or personal taste for any burden score.
Pacing/tone are separate descriptors. Insufficient metadata requires uncertainty.
Named-film scores stay in the human guide, **never the classifier prompt**.
Test the actual prompt builder; report anchor/example overlap and agreement
excluding overlapping movies as sensitivity evidence for human priming.
Ship explicit low-brain-v1 rubric, classification-v1 prompt and
classification-report-v1 policy constants. Changed definitions/projection need
new versions; production must not depend on test-only rubric/provider seeds.

## 3. Strict output and stored-only input

Output is one JSON object with exactly four burden keys plus pacing, tone,
content_tags, field_provenance and field_uncertainty. Burden keys are
narrative_complexity, attention_demand, emotional_burden,
on_screen_text_dependence: each integer 0–4, never coerced. Trusted composition
supplies IDs, fingerprints, model/prompt identity and review status.

- Pacing: slow, moderate, fast, variable.
- Tone: ≤4 unique values from light, warm, comic, adventurous, tense, somber,
  bleak, reflective, surreal; empty is allowed.
- Content tags: ≤8 unique values from violence, death, grief, abuse, self_harm,
  sexual_violence, substance_use, threat. Missing tags do not prove theme absence.
- Both maps have exactly the seven classified fields. Uncertainty is low,
  medium or high, uncalibrated rather than an enjoyment probability.
- Model provenance has exactly basis/evidence_refs. Basis is a nonempty unique
  subset of supplied_evidence/model_prior_knowledge; both may coexist. ≤8 unique
  refs, ≤96 characters each, to allowlisted present/nonempty input paths.
  Supplied evidence requires refs; prior-only forbids them; models cannot claim human.
- Bound UTF-8 output to 16 KiB; reject missing/extra/unsafe keys, duplicate JSON
  members at every level, wrong types, nonplain objects and excess nesting.
  Ordinary JSON.parse alone cannot detect duplicate members.

Reject/count malformed output as a whole; no repair, retry or persistence.
Diagnostics contain allowlisted codes/field names, never raw model text.
Validation establishes structure/reference consistency, not factual truth.

Select stored movie metadata/limited credits only; construct a fresh allowlisted
object, never spread rows or join profiles, ratings, subscriptions, history,
anchors or reviews. Exclude global movie rating/vote counts too. Limits: title
300 characters; nullable year; overview 6,000; 20 genres/50 keywords at 100 each;
nullable positive runtime ≤1,000 minutes; existing certification enum/null;
language ≤16 characters; 12 credits with names ≤200 and roles ≤64.
Director first, then cast billing order with stable source/person-ID tie-break.
Reject invalid types; record deterministic text/list truncation paths. Missing
fields remain null/empty. Projected metadata body is ≤32 KiB.

Fixed-key canonical serialization/deterministic ordering feed server-side SHA-256,
including input-format version. Internal movie UUID stays outside model text.
Tests prove no personal/rating/history sentinel reaches prompt **or hash**,
stable fingerprints and significant-change detection without row-order dependence.
Time/context are supplied; Node/crypto/storage stay outside pure modules.
Trusted prompt contains definitions/schema and a separately serialized untrusted
metadata block, no tools or metadata-derived instructions. Adversarial overview
tests check framing/reject extra keys; they do not prove live semantic immunity.

## 4. Phase A interface and simple limits

Provider-neutral Classifier.classify(input, context) returns unknown output and
bounded usage or typed failure. Fakes live only in tests; no production default.
run --live refuses classifier_unconfigured before credential/DB/transport effects.

Phase A's hard spend cap is zero. A simple in-memory cap interface, tested with
synthetic usage, checks conservative per-call cost before dispatch and stops on
exhaustion/unknown cost; no durable reservation ledger. Local persistence/backoff
failures retain actual metered spend and diagnostic codes; only unknown transport
cost reserves the per-call maximum. Bound synthetic execution
to 30 titles, ≤2 candidates, ≤3 attempts/title/candidate (≤180 calls), concurrency
one, configurable per-attempt timeout and total invocation deadline. Test settings
supply finite explicit limits, not allowances for a real reasoning model.
Retry transient failures only, with abortable one/two-second backoff; malformed
output is never retried. Abort/deadline stops new work and rolls back transactions.
Preflight input/config, target/schema, report destination and remaining limits.

Phase A retains body bounds and a pluggable token-counter contract only. Provider
tokenizers, reasoning/answer budgets, durable reservations, resume/checkpoints and
throughput estimation move to section 11's prerequisites.

## 5. Append-only storage and small migration

Existing migrations hold immutable classifications/grants/RLS; current JSON checks
are shallow and authenticated users can read all classification rows.
Add 20261007000001_classification.sql: nullable subject_classification_id,
composite FK (subject_classification_id,movie_id) to (id,movie_id), restrictive
deletion, no-self-parent check and versioned kind/parent CHECK. Reviews require
a parent; model/anchor rows forbid one. Use a fully validated, null-safe predicate
admitting legacy rows **without** an envelope-version key only with null parent.
With the key present, missing/null/unknown version or invalid kind/parent fails.
Do not alter legacy rows/released migrations. Store also verifies model-parent
kind/rubric. Upgrade tests preserve an actual pre-envelope legacy row unchanged.

Replace only this table's authenticated read policy with a fail-closed predicate
allowing new-format model rows. Human/unknown-kind rows remain operator-only.
Keep write denials/immutable guards; test two identities and guessed-ID reads.
The migration fixes parent integrity/anchor-existence privacy, not all JSON schema.

Model fingerprints hash metadata input. Human fingerprints hash canonical movie
UUID/rubric/labels/uncertainty/kind and review parent/action/evidence identity,
independent of metadata, private notes, timestamps and order. Pair anchors on
movie UUID + rubric, never fingerprint equality. Select model/prompt/input revision
explicitly and freeze inputs across candidates; select human revisions separately.

Keep human, supplied-evidence and model-prior-knowledge provenance distinct.
Human rows use null model/prompt IDs and human provenance. Model rows always store
unreviewed; derive flags from report policy/caps instead of stale needs_review.
Human reviewed status alone does not resolve a gate. Corrections/reviews append;
atomic import validates all rows first; identical reimport is a no-op under an
exclusive run/store lock. Use narrow capabilities, parameterized SQL and readback.
Envelopes contain bounded references/type/date, not copied source text or personal
data. References/private snapshots retain source-age expiry; expired evidence
cannot be recreated from refreshed data. Fingerprints alone cannot replay inputs.
Recommendation work still owns full expiry/redaction/replay design.

## 6. Anchors, effective reviews and privacy

Blank private anchor template, no invented ratings. Import ≤50 unique rows/
128 KiB: version, rubric, exactly one UUID or namespaced TMDB ID, four labels/
uncertainty, optional private note ≤500 characters. Validate exact keys/identities;
reject duplicates, ambiguous/missing resolution or unfilled templates before writes.
Notes/seen-state remain private.

No existing retained arbitrary-ID command avoids personal writes. Build
anchors-ingest using MetadataProvider.getMovie, MetadataStore.resolveMovie and
persistMovie, never ratings import/apply or service discovery. Separate ID-only
input: version, ≤50 unique positive TMDB IDs/16 KiB; no anchor labels/notes sent
to TMDB. Existing IDs are no-ops; conflicts/not-found are explicit. Phase A tests
this production path with fake transports/disposable stores; live dispatch refuses
anchor_ingest_live_unavailable. Later activation/fetching needs separate
authorization, existing provider terms/credentials and bounded metadata requests.

persistMovie creates ordinary active movies in counts and refresh/retirement.
Only the private preparation ID/UUID list distinguishes additions from existing
movies; absent list means additions unknown. No DB origin marker exists.
A shared movie outside sweep membership weakly suggests viewing: accepted for
single-user V0, not multi-user privacy. Revisit catalog exposure before beta.

**Anchors calibrate only; model-parent reviews can change eligibility.** Under D6,
the narrow privileged server loader selects the latest valid review for the exact
model revision/movie/rubric. Accept retains scores; replace supplies full burden
scores. Review uncertainty explicitly permits `unassessed` (the template default):
unchanged fields retain parent uncertainty; changed unassessed scores remain high.
An assessed medium/high overrides model low. Assessed low requires applicable,
fresh evidence; inadequate evidence stays high. Anchors/model output remain strictly
low/medium/high. The latest valid review wins: a later defer supersedes
accept/replace and returns gating fields to unresolved; a later accept can resolve
an earlier defer. Test both orders. Reviews never transfer to new model revisions. Phase A implements pure
effective-label resolution/coverage; ranking later reuses it. Reviews stay
operator-only under RLS; no separate publication policy. Anchors never act as labels.

D3/D6 decide unseen-title handling: assess overview/content-guide evidence,
skip/defer or exclude. Private reviews record per-field evidence type/reference/
date, score/uncertainty and action: direct observation, detailed synopsis or
content guide. Overview alone, genre or age rating cannot establish attention/
complexity; guides may establish distress without establishing other fields.
Inadequate evidence cannot resolve uncertainty; unseen review is not a seen anchor.
No automatic fetching; real external inspection needs separate authorization.
Phase A uses synthetic references. Validation checks applicability/shape, not
reviewer truth/correctness. Evidence expiry and approved item/time budgets apply.

## 7. Simple agreement and effective coverage

Per candidate: movie/rubric pairs, exact/within-one rates, quadratic weighted kappa
(weights (i-j)^2/16; 1-observed/expected), full 5×5 confusion counts including
zeros/marginals/paired n. Empty/zero-expected cases return null with reason.
Spearman with average tied ranks is primary for complexity/attention; constant/
too-small samples return null. Show ≥2-level disagreements/opposite cap outcomes.
At ~30 anchors, sparse kappa is descriptive; point estimates/correlation cannot
settle dimension merging. Bootstrap error bars move to Phase B.

Complexity/attention caps ≤2; emotional cap null/undecided. Gating fields are
complexity/attention plus emotional burden only once capped. Flags: gating
medium/high uncertainty, cap/cap+1 scores (2–3 initially), ≥2-level anchor
disagreements/opposite outcomes, invalid/missing/expired evidence. Deduplicate flags.
Descriptor/intrinsic-text uncertainty is diagnostic, not a gate. Low-uncertainty
near-cap flags alone do not block. Under D6, supported reviews resolve gating
uncertainty; effective scores can increase **or decrease** coverage. Show model-only
and effective passes/intersections, accepted/replaced/deferred/unresolved reviews.
Anchor agreement cannot resolve uncertainty; no emotional/theme policy is invented.

Report active, valid model-classified, human-only, cap-passing, flagged, reviewed,
rejected/unclassified/expired and unique link-ready counts with denominators.
Availability readback uses the same stored-row checker, counting unique valid
model movies across candidates; candidate-specific coverage still selects its
configured model/prompt. Anchors, reviews and invalid/legacy rows do not count.
Report cap_passing ∩ link_ready and effective_policy_passing ∩ link_ready.
Reuse evidence-store readiness: latest successful Watchmode snapshot, non-excluded
subscription offer, matching provider/variant unexpired allowed HTTPS link.
Availability is fresh from a ≤48-hour source check not superseded by a later
complete sweep, or membership in that later promoted sweep; missing membership
cannot be rescued by an old check. Export times/membership/link expiry for explicit
as-of calculation; deduplicate movies. Preserve Disney+/Hulu uncertainty exception.
Readiness is not entitlement/full ranking eligibility; personal/subtitle gates
come later. Even all passing classifications cannot overcome the dated 99-link limit.

## 8. CLI and ownership

Proposed npm run classification -- <action>; default offline/dry-run.

| Action | Explicit effects |
| --- | --- |
| anchors-template, reviews-template --output <path> | Print blanks; --write creates an exclusive private file. |
| anchors-import, reviews-import --input <path> | Validate/count; --apply atomically appends/readbacks through inspected store. Reviews ≤20/128 KiB. |
| anchors-ingest --input <path> --config <path> | Validate IDs/config; Phase A --live refuses. |
| run --config <path> | Validate; --live refuses classifier_unconfigured. |
| agreement, coverage --input <path> --as-of <UTC> | Calculate snapshot report; --write-report exclusively writes private output. |
| export --as-of <UTC> | Validate only; --read-local --output explicitly exports inspected store. |

Private files: .cache/classification/private/; reject traversal/symlink/reparse
escape/existing outputs. Bound reads before parse. Snapshot: exact versioned
schema, ≤1,000 movies/10,000 revisions/16 MiB, evidence dates/query/policy versions.
Missing fields fail. Verify Windows ACLs before real labels; POSIX modes do not.
Production target reuses fixed local verification/credential conventions, no
arbitrary URL/reset flags. Phase A effect tests use credential-free copied
checkouts/owned disposable targets, never retained resources.

Fixed public line: exit=<0|1|2> code=<code> action=<action> processed=<n> rejected=<n>.
Exit 0 complete/readback; 2 partial/cancelled/insufficient data; 1 invalid/adapter/
store/report failure; invalid imports atomic exit 1. SIGINT/SIGTERM stop work,
roll back open transactions, preserve commits and close clients. State Windows
delivery limits honestly. Only safe counts/codes/row indices, not raw payloads/errors.

Files: src/domain/classification.ts and classification-reports.ts (pure contracts/
projection/reports/resolver); src/server/classification/ (decoder/hash/prompt/
interface/simple orchestration); src/server/db/classification-store.ts;
src/server/ingestion/anchor-metadata.ts; scripts/classification.ts/helpers;
placeholder config; one migration; tests/classification/ and DB suite;
tooling/classification-mutations.ts. Update README/package commands/CI/evidence.
Keep pure import/type boundaries; no generic repository, SDK or UI.

## 9. Phase A acceptance

Tests first; record each regression red for intended behavior, not just import
failure. Report counts/exits/sanitized failures; restore mutations before handoff.

| Area | Required evidence |
| --- | --- |
| Validator | Exact keys/types/ranges/vocabularies/body/array bounds, duplicate JSON/unsafe nesting; no repair/append. |
| Input/prompt | Actual projection excludes personal/global ratings; sentinel absent from prompt/hash; deterministic projection/hash, injection framing, no named-film scores. |
| Provenance/store | Human/model/evidence/prior separation; actual-role append/readback/immutable denial; parent FK negatives; two-identity model-read/human-denial. |
| Creation/import | Fresh creation without classifier-only seeds; ID ingest through real store with no personal writes; atomic/no-op imports/corrections. |
| Reports | Independently derived agreement/kappa/Spearman/counts/null cases; refresh preserves anchor pairs; model review changes effective label/coverage, anchor never does; defer/unsupported/expired/old-parent review cannot resolve gates; readiness/duplicates/staleness. |
| Orchestration | Finite call/retry/time limits, zero live spend, fake cap exhaustion/unknown-cost preflight refusal, transient-only retries/cancellation. |
| Processes | Every action/effect path: both templates/imports, rollback/no-op, ID ingest, export/reports, live refusal, malformed files/args, partial/cancellation; exact summary/exit. |

Use existing catalog-local-entry.test.ts/operator-process.ts patterns.
Four controls must fail intended tests: bypass validator, collapse provenance,
leak personal sentinel, replace coverage intersection with cap-pass count. Run
alone; restore in finally, verify hashes, then focused offline/DB green.

After implementation: npm run check, npm run test:db, new test:classification:db
and test:classification:controls. Offline tests join npm test; shared inspected
DB harness applies seven migrations fresh and rehearses six-to-seven upgrade with
a real legacy row. Update catalog inventory/preflight and run test:catalog:db,
plus affected metadata/evidence suites if shared paths change. Add same DB command
to CI metadata-database job; preserve existing jobs/checks. Unavailable Docker is
unverified, not skipped pass; no retained upgrade. Plan-only checks are links/
whitespace/state, not code/build/DB behavior.

## 10. Phase B decisions

Decided 2026-10-08. Candidate token/time settings remain the section 11 candidate
controls.

| Decision | Outcome |
| --- | --- |
| D1 | Anthropic. Candidates `claude-sonnet-5-5` and `claude-opus-5-5`; Phase B hard cap US$35. Section 11 arithmetic at 5,000 input/10,500 output tokens, three attempts, 30 titles: Sonnet US$10.35 + Opus US$20.70 = US$31.05 worst case. Rates (Sonnet US$2/US$10, Opus US$4/US$20 per million) are from a 2026-09-25 cached table; re-verify live before the paid run and re-derive if they differ. |
| D2 | The TMDB AI-use deferral covers personal noncommercial transmission for classification, on condition that the provider does not train on API inputs; confirm current provider terms before the paid run. Ingestion does not establish permission. |
| D3 | Plan default: ~30 known-film anchors; at most 20 reviews (a ceiling, not a target). Phase C review budget is set after the Phase B flag rate is known. No rewatch assumption. |
| D4 | No strict themes for now; tags do not satisfy requested strict exclusions. Revisit workload/evidence if named. |
| D5 | Versioned caps: complexity 2, attention 2, emotional 2. Individual exceptions go through near-cap reviews, not cap relaxation. No automatic relaxation/merge. |
| D6 | Gating-only uncertainty plus supported model-parent reviews as effective labels; anchors calibration-only. Unseen titles may be reviewed from a detailed synopsis (complexity/attention) or content guide (emotional only). Unresolved titles stay in the review queue and are never eligible; nothing is excluded permanently. Inadequate evidence never means reassurance. |

## 11. Deferred controls and later gates

**Before Phase B: candidate controls.** Complete-prompt counting with verified
tokenizer/message overhead follows body validation, before calls. Fit the same
projection across candidates. Set reasoning/visible allowances and timeout together
per candidate; valid answers must fit without reasoning starvation. Distinguish
truncation/timeouts from label quality and missing pairs. Phase A limits are not
paid settings; no provider-specific tokenizer/allowance implementation now.

**Before Phase B: priced hard cap.** Verify rates, then derive:
cost = sum_candidates(titles × max_attempts × (input_tokens × input_price +
reasoning_tokens × reasoning_price + visible_tokens × visible_price)/1,000,000)
+ other_fees. Prices are US$/million tokens; include every candidate/retry/fee.
Check conservative charge before each call; stop on unknown spend, no automatic
ambiguous-request retry. Confirm worst-case scope fits before promising completion.
No rates were verified under this offline task; numeric caps remain a Phase B blocker.

Illustration only: 5,000 input/10,500 combined billable output, three attempts,
same output price P_out/input price P_in, no fees; not chosen allowances.

| Scope | Worst-case cost | Old ceiling breaks at zero input cost |
| --- | --- | --- |
| B: 30 titles, one candidate | 0.45 P_in + 0.945 P_out | US$5 above US$5.29/M output. |
| B: 30 titles, two candidates | 0.90 P_in + 1.89 P_out | Total US$5 above US$2.65/M output. |
| C: 700 titles, one candidate | 10.5 P_in + 22.05 P_out | US$15 above US$0.68/M output. |

Positive input lowers thresholds to (5-0.45 P_in)/0.945, (5-0.90 P_in)/1.89,
(15-10.5 P_in)/22.05; negative numerator means input alone exceeds old ceiling.
Use actual candidate/reasoning rates, add anchor titles/metadata fees as applicable;
reduce scope or obtain a new cap if needed. Old ceilings are neither fixed nor authorized.

**Phase B report: error bars.** Bootstrap kappa intervals need real anchor pairs;
report method/seed, n, undefined cases and selection bias. Phase A is descriptive.

**Before Phase C: run-scale controls.** Build bounded manifests, multi-invocation
checkpoints/resume and measured-throughput planning. Preserve input/model/version
identity, commits/retry counts; changed metadata is explicit new work. Durable
phase-wide reservations and ambiguous-spend reconciliation prevent restart/
concurrency from resetting spend or duplicating calls. Phase A claims none of this.

Phase B needs separate authorization/D1–D3/D5/D6, optional authorized anchor
metadata activation, adapter/credentials and candidate/time/price preflight.
~30 titles/≤2 models use one bounded local invocation with candidate-derived total
deadline, not the old ten-minute promise. If partial, stop/report and require
explicit continuation with the existing phase cap accounted for. Continuation
requires the prior run's exclusive report, matching phase/candidate/config, and
starts the cap at its actual + unknown spend. Missing/unreadable/mismatched reports
refuse before any call. Phase A implements the starting-balance interface and
process tests for missing reports and remaining-cap enforcement; no implicit
resume system or budget reset. Compare agreement/cost/flags/timing; user picks policy/model.

Phase C needs separate authorization, approved policies/current links and its
run-scale prerequisites. Classify authorized catalog, review within D3, report
effective coverage intersected with links. Gaps do not authorize more spend/
reviews or relaxed gates.

## 12. Review adjudication

Earlier findings retained:

| Findings | Resolution |
| --- | --- |
| 1–2 | Named metadata-only anchor path; human hash/pairing independent of refresh. |
| 3–4 | Split examples, no named-film scores in prompt, overlap sensitivity. |
| 5–7 | Near-cap 2–3, gating uncertainty only, D6. |
| 8–11 | Confusion n/caveat now; error bars/candidate/spend/scale controls in owning phases. |
| 12–14 | Same-movie FK, private human rows with effective model reviews, derived flags. |
| Follow-up | Unseen evidence/deferral, price formula, legacy-safe CHECK, filename/wording and private-list anchor tracking. |

Second adjudication: user-directed trim, October 7, 2026.

| Item | Disposition |
| --- | --- |
| Phase A core | Keep rubric/checker/input/interface/storage/migration, anchor/review workflow, simple reports/CLI/process tests/four controls. |
| Error bars | Bootstrap intervals move to Phase B; retain per-cell n/caveat. |
| Candidate controls | Token counting, reasoning/answer/timeouts/truncation move before Phase B. |
| Run-scale machinery | Manifests/checkpoints/throughput/durable reservations/reconciliation move to Phase C. |
| Simple safety | Retain finite calls/retries/time and hard zero spend; simple paid phase cap before Phase B. |
| Must-fix preservation | Reviews affect eligibility; D3/D6 unseen decision; priced D1 arithmetic; migration/legacy/privacy/wording fixes. |

Third adjudication: implementation approval and amendments.

| Item | Disposition |
| --- | --- |
| Approval | Core Phase A, review workflow and single migration are authorized; retained/provider work and publication remain excluded. |
| Spend carry-over | Phase A starting-balance interface and process tests require matching prior reports before continuation calls. |
| Latest review | Later defer cancels earlier accept/replace; both orders have report regressions. |

Phase A patch review: retain known spend after local failures; explicit review
assessment can lower confidence; availability counts checked model movies only;
Windows config paths ignore casing; invalid review parents have a dedicated code.
State-6 retained live execution requires a separately authorized upgrade to 7.
