# Classification Phase B: implementation plan

Date: October 8, 2026. Status: approved with review amendments applied.
Branch: `feat/classification-phase-b`; inspected baseline: `c9f9d26`.

## Review changes

- Implementation review amendment: every invocation after the first chains to
  the preceding same-phase report, regardless of changed settings/check dates.
  Reports carry cumulative actual/unknown spend, movie IDs, fingerprints and
  successful pairs; continuation counts and projects only unfinished pairs.
- A private phase pointer under the session run lock enforces the latest-report
  chain, including refusals with no DB rows. A guarded DB phase/legacy-model check
  also refuses fresh starts over existing model results. Pending/missing reports
  fail closed; this is not Phase C's durable per-call reservation machinery.
- Drop thinking-character measurements; compare billable output tokens with
  visible answer characters. Delay report-file creation until storage preflight;
  document exact-model matching, integer-rate limits and mild pilot titles.

- Selected native fetch; removed the SDK/dependency alternative.
- Added a separately authorized two-title/two-candidate pilot, charged to the
  same US$35 cap, with measured usage/latency/truncation and a required pilot
  report before main execution. Settings changes preserve pilot spend.
- Confirmed anchors are ordinary active catalog movies with a private additions
  report; no calibration-only flag or personal-state writes.
- Added documented zero-cost rejection gating, bounded Retry-After retries for
  well-formed 429/529, and unknown-spend halting for ambiguous failures.
- Chose individual exclusion/reporting of oversized inputs before any paid call,
  preserving the 5,000-token budget without silently truncating metadata.
- Kept stored model identity readable and settings-distinct; hash only config
  identity. Accepted realistic zero cache usage and standard service tier.
- Added a token-count compatibility fallback with pilot-measured overhead;
  no main run may use unmeasured fallback overhead.
- Corrected repository-state wording and added machine-awake operator guidance.

## 1. Authority and scope

This plan implements `.cache/classification-phase-b-handoff.md` against
[classification sections 10–11](classification.md#10-phase-b-decisions).
[Architecture](../architecture.md) owns product behavior and
[engineering](../engineering.md) owns release expectations. Root AGENTS.md is
the only applicable guidance found. Preserve existing user work, including
`.claude/`, `.cache/` and the unrelated `docs/backlog.md`; do not edit the backlog.

The handoff explicitly requires: “Plan first … stop for Claude's review, then
implement in the same session once approved.” This document is that review gate;
approval is now recorded in `.cache/classification-phase-b-plan-review.md`.
Its amendments authorize implementation in this session without another review
unless an amendment cannot be implemented as written.

After approval, implement the Anthropic adapter, complete-request token preflight,
candidate settings/cost accounting, terms/rate gates, private credential reader,
retained storage composition, bounded anchor-detail composition, updated reports,
offline/process/disposable DB tests and mutation controls. Wiring effects does
not authorize executing them against the retained catalog.

No paid model calls, live TMDB calls, retained-catalog writes or dependency
installation are authorized. Do not read real credentials or access retained
resources during implementation/testing. A live run requires its own explicit
user go; anchor TMDB fetching and human imports require their own authorized
scope. Do not commit, push, open a PR or deploy. Ratings conversion remains with
Claude and the user. Phase C checkpoints, durable reservations, batch execution,
ranking, UI and hosting remain outside this change.

## 2. Decisions for review

| Item | Proposal |
| --- | --- |
| Transport | Native Node `fetch`, no new dependency; explicit single requests with injected transport. |
| Rates and terms age | Both checked no more than seven days before invocation; reject missing, future-dated, stale or malformed checks before reading credentials. Recheck independently on every invocation. |
| Candidate settings | Sonnet 5.5: explicit effort `high`, 10,500 total output tokens, 180,000 ms timeout. Opus 5.5: explicit effort `medium`, 10,500 total output tokens, 300,000 ms timeout. |
| Input budget | Same frozen projection/prompt/schema across candidates, with at most 5,000 budgeted input tokens after margin. Individually exclude/report a title exceeding either candidate's limit before any paid call; never abort other fitting titles or truncate per candidate. |
| Cost unit | Integer micro-USD: US$1 = 1,000,000 units; hard cap = 35,000,000. |
| Reports | Versioned Phase B policy sets complexity, attention and emotional caps to 2; seeded paired-title bootstrap adds descriptive agreement intervals. |

The token allowances leave room for thinking and all seven classified fields,
provenance and uncertainty. Timeouts include initial schema compilation. These
are proposed controls, not measured sufficiency. A truncated/timed-out answer
cannot be used to judge label quality. No automatic allowance increase or paid
settings sweep: material settings changes require a new candidate identity,
fresh arithmetic and explicit authorized continuation.

## 3. Config, identity and preflight

Keep Phase A's inert public example and v1 decoding compatible. Add an exact-key
Phase B config contract rather than making new safety fields optional on v1.
Private config includes an explicit list of at most 30 unique internal movie
UUIDs, at most two allowlisted candidates, per-candidate effort/output/time/input
limits, verified input/output rates, rate source URL/check date, provider terms
URL/check date and explicit no-training confirmation, phase cap, attempts/calls,
report destination and continuation identity. Empty/unresolved selections refuse.
No file can choose a DB URL, owner/profile identity, endpoint or fallback model.

Prices use an integer representation precise enough for micro-USD arithmetic;
calculate token products without floating-point undercharging and round the
final call charge upward. Allow only the configured ordinary direct API mode:
no prompt caching, tools, priority/fast mode, batch or other billable features.
Unknown/nonzero extra fee configuration refuses until its accounting is defined.

Candidate identity is a bounded readable composite of model ID, effort, total
output allowance, timeout and request/schema/prompt/input-budget version, e.g.
`claude-opus-5-5:effort=medium:out=10500:ms=300000:v1`. Phase config identity
also covers ordered selection, candidate identities, rates/check records, all
limits and caps; only the continuation flag is normalized. Store a bounded
candidate identity as `model_id` so different settings cannot be pooled as one
model. Reports expose the readable model/settings association privately.
Existing v1 continuation reports remain compatible for v1 only; Phase B requires
its own report v2 format. Config hashes identify/audit settings; they no longer
gate continuation. Changed settings/rates or fresh check dates retain the last
same-phase report's cumulative spend. Legacy v1 reports lack completion identity
and refuse pending explicit operator reconciliation.

Order for paid-run composition:

1. Validate arguments, private paths/config/selection, terms/rate freshness,
   prior spend and explicit effect mode. Offline commands stop here without
   calling production effects or reading credentials.
2. Inspect the fixed retained target and state 7 through existing catalog
   inspection/schema conventions, guarded pool and checkout guard. Issue a
   nonserializable object capability internally. Never accept it from JSON.
3. Validate an exclusive report destination, acquire a session advisory run
   lock distinct from the store's transaction lock, and refuse overlap. Hold
   the run lock through counting, calls, persistence and reporting. Do not hold
   a DB transaction open across model calls; detect lock-session loss and stop.
4. Load allowlisted metadata for all selected active movies into frozen input
   objects. Reject expired/unusable evidence and unresolved IDs before counting.
5. Read only the fixed ignored Anthropic credential file after the terms gate.
   Count the complete request for every item/candidate using the provider
endpoint, then derive all reservations and the invocation deadline.
6. Refuse failed/malformed counts, excessive input/context, or worst-case spend
   exceeding the remaining phase cap before the first paid request.
7. Execute one request at a time, account usage, validate output, append/read
   back model revisions, then write an exclusive private completion/partial
   report. Always close clients and release the session lock.

## 4. Token counting, spend and time

Create one request builder used by both count and classify. It supplies the
trusted prompt, separately framed metadata and `output_config.format` schema;
the counter sends all count-supported fields including system/messages/schema
and model-specific configuration. No `tiktoken` or character estimate substitutes
for `POST /v1/messages/count_tokens`. At most 60 count jobs, each with one full
request and at most one explicit compatibility fallback, bounded to 10 seconds
per request (120 HTTP requests maximum); any failure stops before paid dispatch.

Provider counts are estimates, and structured output adds prompt overhead.
Budget `ceil(count * 1.10) + 256` per request, including format overhead supported
by counting; require that value <= 5,000 and that input plus output fits the
verified model context limit. If a well-formed 400 rejects output config, count
the same system/messages without output config and add a configured overhead.
The pilot may use the conservative initial 256-token overhead already budgeted
here; record fallback counts versus actual input usage per candidate. The main
run requires a matching pilot report and overhead at least the largest measured
positive usage-minus-count difference plus 256 tokens. Exclude a title from both
candidates when either budget is oversized; report IDs/counts/reason, require at
least one fitting title, and keep the same frozen projection for fitting titles.
This margin is a planning policy, not proof of exact provider billing.

The pilot uses exactly two titles and both candidates, at most two attempts per
pair: at illustrative rates its maximum is 2 × 2 × (0.115 + 0.230) = US$1.38.
Main requires the pilot
report (including actual/unknown spend), and its 30 × 3 projection plus pilot
spend must fit US$35. Changing settings needs a readable new identity and fresh
worst-case arithmetic; pilot spend remains in the phase ledger even though
the candidate configuration changes. No pilot is executed by this task.

Using the handoff's **unverified illustrative rates**, and the proposed settings:

| Candidate | Input/output US$/million | Per-call maximum | 30 titles × 3 attempts |
| --- | --- | --- | --- |
| `claude-sonnet-5-5` | 2 / 10 | 5,000 × 2 + 10,500 × 10 = 115,000 micro-USD | US$10.35 |
| `claude-opus-5-5` | 4 / 20 | 5,000 × 4 + 10,500 × 20 = 230,000 micro-USD | US$20.70 |
| Combined | | | US$31.05; US$3.95 below US$35 |

Use actual configured verified rates and measured counts to rederive this before
execution. The reservation is candidate/request-specific: using Opus's maximum
for every Sonnet call would incorrectly project US$41.40. Before each paid
attempt require actual + unknown + that attempt's maximum <= cap. Missing or
invalid usage reserves that candidate's maximum and stops. Known over-reservation
usage charges its full metered amount and stops; never clamp or discard cost.
Actual provider billing can exceed an estimate; record that limitation and the
operator's applicable provider spending control before separately authorized
live execution. The local guard prevents new dispatch, not reversal of charges.

At most 180 paid attempts, three per title/candidate, concurrency one. Worst-case
attempt time is 90 × (180 + 300) seconds = 12 hours; bounded one/two-second retry
backoff adds at most 180 seconds, count/fallback calls at most 1,200 seconds. Propose a 13-hour
invocation ceiling including local/report overhead. Extend Phase B's deadline
validator deliberately; retain Phase A bounds. Derive the actual deadline from
selected candidates/title/attempt counts plus bounded overhead. Use injected time
in tests; tests never wait these durations.

Operator: keep the machine awake for a separately authorized run. The 13-hour
ceiling is theoretical; the review estimates ordinary runs around an hour,
which the pilot must measure rather than promise.

Every invocation after the first, including pilot-to-main and pilot reruns, uses
`continuation: true` and the immediately preceding same-phase report. Its full
actual + unknown is carried regardless of changed config/check dates. Report v2
records movie/candidate/input-fingerprint completions and cumulative measurements;
committed unchanged pairs skip counting, dispatch and worst-case projection.
Changed settings or metadata are new pairs with the same cumulative phase spend.
Only successfully persisted pairs are marked complete, never validated attempts.

Under the held session run lock, a guarded DB query refuses fresh starts if
phase-tagged model rows exist (or legacy rows match the phase's model names).
A private `phase-head-<SHA256(phaseId)>.json` pointer also blocks fresh or stale
branches when paid refusals produced no model row. It names/hashes the last
completed report. Before dispatch it is atomically changed to pending; after
the report is synced it advances to that report. Pending, missing or mismatched
state refuses further calls. Keep this directory with the local catalog; it is
single-workspace bookkeeping, not Phase C's multi-host per-call reservations or
automatic ambiguous-spend reconciliation. Each continuation still needs its own
explicit user go. A crash/report failure requires operator reconciliation;
neither switching settings nor starting fresh may imply zero previous spend.

## 5. Adapter and failure semantics

Implement `Classifier` at the server effect boundary with an injected transport.
Use fixed `https://api.anthropic.com` routes, bounded request/response bodies,
redirect refusal and AbortSignal deadlines. The transport performs exactly one
HTTP request per call with no automatic retries. Never log headers, keys,
model text, thinking, raw provider errors or personal inputs.

Use `output_config.format` JSON schema derived from the Phase A contract, with
required keys and closed objects. Keep Phase A's stricter runtime validator
authoritative for bounds, uniqueness, duplicate members and evidence consistency
when provider schema restrictions cannot encode them. No assistant prefill,
forced `tool_choice`, server tools, `fallbacks`, disabled thinking or
`budget_tokens`. Set effort explicitly; accept only the requested model's
response identity. Unexpected model identity stops with cost retained.

Extend failures with safe reason codes and report per-candidate attempted,
successful, structurally invalid, refusal, truncation, timeout, throttling,
server failure and connection-failure counts. Do not mix operational failures
into invalid-label denominators. Agreement uses only valid pairs and reports
missing/unpaired titles separately.

`end_turn` with valid text can proceed to strict validation. `refusal` is
non-retryable with metered cost; `max_tokens` is non-retryable truncation with
metered cost. Timeout/connection loss have unknown spend and stop without retry.
Well-formed Anthropic 429/529 and pre-processing 4xx errors are known zero cost
only under a fresh verified rejection-billing check (URL/date). 429/529 retry
within the attempt limit, honoring valid Retry-After only if wait plus next
attempt fits the invocation deadline and wait fits the attempt timeout. Without
that verified check, retain unknown-cost halting. Malformed errors, 500s,
timeouts and connection loss remain unknown; pre-processing 4xx do not retry.
Unexpected stops/protocol failures do not retry. Local persistence/backoff/report failures
must retain already metered spend. The orchestrator's timer race must preserve
the timeout category rather than erasing it into generic unknown spend.

Parse nonnegative safe integer input/output usage; output includes billable
thinking. Thinking text is omitted by default, so report output tokens against
visible answer characters rather than calling returned text a thinking measure.
Accept cache creation/read token counts of zero and service tier
`standard` in realistic fixtures/responses. Nonzero cache/other-tier usage refuses this ordinary-price mode
and records unknown cost unless fully accounted. Hand-computed test: 1,234 input
and 567 output tokens at Sonnet illustrative rates costs 8,138 micro-USD.

## 6. Credentials, storage and anchor details

Use a fixed `.cache/classification/private/anthropic.env` ignored private file
with exactly one `ANTHROPIC_API_KEY` assignment. Bound reads and reject malformed,
duplicate, symlink/reparse or escaping paths. Follow the existing safe TMDB/key
parser pattern; no dotenv evaluation, environment overrides, child argv/env
credential forwarding or import-time reads. Validate owner-private NTFS access
before a real run; POSIX mode requests alone do not establish Windows privacy.

`scripts/classification-effects.ts` composes catalog inspection, runtime password
reader, `catalogPool`, `localCatalogGuard` and `createClassificationStore`.
Avoid CLI import cycles; only extract a shared leaf helper if needed. Human
`--apply` and export `--read-local` open guarded storage without provider keys or
calls. Revalidate imports at the effect boundary and preserve atomic/no-op
semantics. Model persistence rechecks the frozen fingerprint and refuses changed
metadata; no anchors, notes, ratings or reviews enter provider requests.

Activate the existing `ingestAnchorIds` path behind explicit `anchors-ingest
--live` and a separately authorized metadata configuration. Fetch detail by
TMDB ID through the PR 3 provider/store only, with current TMDB terms before
credential reads. At most 50 IDs, 100 metadata attempts and 10 minutes as already
bounded; existing resolved IDs are no-ops. No title search, availability sweep,
ratings import or personal-state writes. Respect the shared metadata refresh lock
for catalog additions. Write an exclusive private additions/UUID report so the
operator can identify ordinary active catalog movies created for anchors.
Preparing this path does not execute it under the current authorization.

## 7. Reports and policy

Publish a new report-policy version for the three caps of 2, leaving explicit
Phase A snapshots interpretable under their original policy. Update snapshot
decoding/store export/report composition together; reject mismatched policy/caps.
Keep supported latest model-parent reviews effective, anchors calibration-only,
and unresolved unseen titles queued. Review imports remain bounded to 20.

Add 95% percentile bootstrap intervals for each burden's quadratic weighted
kappa: resample movie pairs with replacement, 2,000 replicates, explicit seed
and algorithm version; report paired n, undefined replicate count and null
interval reasons. Use the same sampled movie indices across dimensions and,
for comparisons, the common paired candidate set. Include selection bias,
sparse-sample caveats and overlap-excluded sensitivity already required by the
plan. Bootstrap is pure with supplied seed/context and performs no effects.
Reports compare agreement, spend, operational outcomes, flags and timing without
selecting a model automatically or changing caps.

## 8. Implementation order and acceptance evidence

1. Add observed-red offline regressions for Phase B config/preflight, request
   builder/counting, failure categories and hand-computed cost; implement the
   chosen transport with fakes only.
2. Extend orchestration reservations/identity/deadlines and outcome reports;
   prove all-item/all-candidate preflight precedes paid calls and unknown usage
   prevents retries. Keep Phase A compatibility tests.
3. Wire trusted storage and anchor composition; add disposable target tests for
   schema/guard/capability refusal, human atomic/no-op imports, model revisions,
   stale input refusal, overlap/loss and export readback. No migration expected.
4. Implement versioned caps and seeded bootstrap; verify independently computed
   examples, constant/empty pairs, reproducibility and effective review behavior.
5. Spawn real `scripts/classification.ts` processes for `run --live`,
   `anchors-ingest --live`, both imports with `--apply`, export and continuation.
   Use credential-free copies and fake transport/disposable composition from
   external test wrappers; production never imports fixtures or selects a test
   mode/environment bypass. Verify positive execution as well as refusal and
   import-cycle detection. Empty PATH cases prove refusal before child effects.

Required adapter tests cover refusal/truncation/timeouts, 429/5xx/connection loss,
bad/missing usage, actual model mismatch, schema/request shape, absent fallback/
prefill/forced tools/thinking budget, single network request/no hidden retries,
count failure before paid calls, current/missing/stale/future rates and terms,
cap/deadline refusal, credential redaction and continuation carry-over.
Prove offline suites cannot make provider network calls with throwing transports
and credential-free copies. Create `.cache/` before temp directories in tests.

Mutation controls must each be watched red for their intended assertion, restored
in `finally`, verified by file hashes, then followed by green affected suites.
Cover every added safety check: terms/rate freshness before credentials, complete
request counting, input/cap reservation, carry-over/config identity, model match,
unknown spend/no retries, forbidden request fields, credential/path redaction,
target/schema/capability checks and overlap/loss refusal. Reuse existing controls
where they already prove an unchanged check; list the mapping in the evidence.

Run alone and sequentially because DB commands share Docker resources:

```text
npm run check
npm run test:classification:db
npm run test:classification:controls
npm run test:catalog:db
npm run test:availability:evidence:db
```

Run `npm run test:metadata:db` when shared metadata/anchor composition changes,
`npm run test:availability:sweeps:db` if shared refresh locking changes, and
`npm run test:db` if migration/inventory/schema paths change. Any new control
command joins the owning package scripts; local and CI use the same offline/DB
commands. No dependency install without the separate go. Missing Docker or
dependencies is reported unverified, never a skipped pass. Review actual tracked
diffs and new files against this plan after validation.

## 9. Deliverables and present validation

After approved implementation deliver uncommitted changes on this branch,
`docs/plans/classification-phase-b-implementation.md` with decisions, limits,
scope, actual commands/exit codes, mutation observations and unresolved findings,
plus `.cache/classification-phase-b-review.patch` including all intended new files
and excluding private/untracked user data. Re-review material corrections.

This plan-only change needs whitespace, link/path and repository-state checks;
it makes no code/build/DB/provider compatibility claim. Approval and native fetch
are recorded in the review handoff. Current rate values remain unverified; no credential or
retained-catalog read was performed to prepare this plan.

Official references read on October 8, 2026 (documentation lookup only):

- [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting): provider endpoint, model-specific counts and estimate caveat.
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs): format config, schema restrictions and extra prompt overhead.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort): explicit effort and thinking/output controls.
- [API training policy](https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training): commercial/API distinction; operator must still record applicable current terms and no-training check before execution.
- [API billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage), checked October 8, 2026: failed requests aren't charged, but interrupted successful requests are charged. A fresh operator check is required to enable zero-cost rejection handling.

Phase C may consider the handoff's Batch API 50% pricing claim; verify that
pricing when its separately authorized run-scale plan is written.
