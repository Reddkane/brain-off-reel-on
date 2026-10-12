# Classification Phase B operator workflow

Building this workflow does not authorize its execution. Paid pilot/main runs,
live TMDB anchor details and retained imports each require the user's separate
go for the stated scope. Current implementation acceptance uses fake providers
and disposable PostgreSQL only.

## Preparation and offline validation

Keep inputs/config/reports beneath `.cache/classification/private/`. The CLI
rejects escaping and symlink/reparse paths. Keep the files owner-private, including
Windows NTFS ACLs; a requested POSIX file mode does not establish NTFS privacy.
Do not put keys in argv, environment variables, public config or reports.

Anthropic's fixed credential file is `anthropic.env` in that private directory:

```text
ANTHROPIC_API_KEY=<your-key>
```

The reader accepts a single quoted or unquoted key assignment and comments,
not shell evaluation or unrelated settings. On Windows it checks that Allow
entries grant access only to the current identity, SYSTEM or Administrators;
on POSIX it refuses group/other permissions. It reads the file only after the
run's terms/rate gates. Human imports and exports require no provider key.

The pilot config has this exact shape. Placeholder dates and IDs below must be
replaced after operator checks; rates are **illustrative, unverified values**.

```json
{
  "version": "classification-phase-b-v1",
  "phaseId": "your-phase-id",
  "stage": "pilot",
  "movieIds": ["<internal-movie-uuid-1>", "<internal-movie-uuid-2>"],
  "candidates": [
    { "model": "claude-sonnet-5-5", "effort": "high", "maxTokens": 10500,
      "timeoutMs": 180000, "contextTokens": 200000, "inputRate": 2, "outputRate": 10 },
    { "model": "claude-opus-5-5", "effort": "medium", "maxTokens": 10500,
      "timeoutMs": 300000, "contextTokens": 200000, "inputRate": 4, "outputRate": 20 }
  ],
  "spendCap": 35000000,
  "rates": { "url": "https://platform.claude.com/docs/en/about-claude/pricing", "checkedAt": "<UTC-check-time>" },
  "terms": { "url": "https://www.anthropic.com/legal/commercial-terms", "checkedAt": "<UTC-check-time>", "noTraining": true },
  "rejectionBilling": { "url": "https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage", "checkedAt": "<UTC-check-time>", "zeroCost": true },
  "fallbackOverhead": 256,
  "pilotReport": null,
  "continuation": false,
  "report": "pilot-report-unique.json"
}
```

`inputRate`/`outputRate` are US$/million tokens. `spendCap` and metered costs use
integer micro-USD (US$1 = 1,000,000 units). All three URL/date checks must be
current within seven days and not in the future; explicitly confirm that the
applicable API inputs are not used for training. Verify context limits too.
Use `zeroCost: false` if rejection billing cannot be verified: ambiguous errors
will reserve maximum spend and stop. No automatic price scraping or credential
loading occurs during offline validation:

```powershell
npm run classification -- run --config .cache/classification/private/pilot.json
```

## Separately authorized pilot and main

After the user's paid-pilot authorization, add `--live` to that command. It
inspects the fixed local catalog, requires schema state 7, freezes both titles'
metadata, counts every candidate request and checks total reservations before
paid dispatch. It appends model revisions and writes the configured exclusive
private report. Keep the machine awake. The theoretical ceiling is 13 hours;
measure ordinary duration with the pilot rather than assuming it.

Choose mild-content pilot titles to reduce the chance of a refusal making the
pilot incomplete. Do not invent labels or use the rubric examples as targets.
Inspect each candidate's raw counted input, actual input/output tokens, visible
answer characters, elapsed time and outcomes. Thinking is hidden by default:
compare total output tokens with visible answer length as a headroom signal,
not as a measurement of thinking tokens. Confirm sufficient
output allowance and timeout before proposing main execution. A truncated or
timed-out result is an operational failure, not a bad-label observation.

Main config changes `stage` to `main`, supplies up to 30 unique movie UUIDs,
sets `pilotReport` to the successful pilot report basename, sets `continuation`
to `true`, and chooses a fresh `report`. Pass `--prior-report` with the
immediately preceding same-phase report, even for the first main run.
Its preflight carries the pilot's actual/unknown spend, requires a successful
four-pair pilot, rederives the worst case and refuses above the shared US$35 cap.
Settings changes create a distinct readable stored candidate identity; pilot
spend still counts. Main is a separately authorized run, not an automatic next
step. Do not pool revisions from different settings.

If full schema/effort counting is unsupported, the counter performs one explicit
free compatibility count without output config. Pilot measures actual input
minus raw count. For main, `fallbackOverhead` must cover the largest measured
positive difference plus 256 tokens. Both candidates keep the same metadata;
an input exceeding either candidate's 5,000-token budget is excluded from both
and reported before any paid call. An oversized pilot must be prepared again
with two fitting titles. No automatic truncation or scope expansion.

Use a new exclusive report filename for every invocation. Only the first pilot
is fresh. Every later pilot or main passes `--prior-report` and sets
`continuation: true`. The last report's full actual plus unknown spend carries
forward, including when check dates, rates, selection or settings change. Config
hashes no longer bar legitimate continuation. Report v2's completed movie /
candidate / input-fingerprint pairs skip counting and paid dispatch; worst-case
projection covers only remaining pairs. Completed pilot pairs need not be paid
for again by main. Reports include cumulative measurements and completion history.

The private `phase-head-<SHA256(phaseId)>.json` pointer is enforced under the DB
session lock: stale reports and fresh restarts refuse even when a prior paid
refusal wrote no model rows. The DB also refuses fresh starts over phase-tagged
model rows or legacy rows for the configured models. Keep the private reports
and phase pointer with this workspace/catalog. Do not delete or edit them to
restart. Pending pointers, lost reports or interrupted/report-failed runs require
explicit operator reconciliation against existing spend before another paid go.
This is local report-chain bookkeeping, not a multi-host reservation ledger.
Legacy v1 reports require reconciliation because they lack per-movie completions.
Set and check the applicable provider spending control
before execution; local estimates cannot reverse billed usage.

Storage/schema/phase-history failures now happen before report creation, so a
down database does not reserve an empty report name. Later report/dispatch
failures retain a pending pointer and must be reconciled. The response model name
must match exactly; an echoed variant ID stops with metered cost and is a pilot
watch item. Rates currently require whole US$/million-token values: $2.50 is
refused. Current illustrative $2/$10 and $4/$20 are representable; do not round
fractional future prices to bypass this limit.

## Anchor preparation, human imports and reports

After separate authorization for bounded TMDB detail fetching, use an ID-only
file (`classification-anchor-ids-v1`, `ids`: at most 50 unique TMDB ID strings)
and this private config:

```json
{
  "version": "classification-anchor-live-v1",
  "terms": { "url": "https://www.themoviedb.org/terms-of-use", "checkedAt": "<UTC-check-time>", "accepted": true },
  "report": "anchor-additions-unique.json"
}
```

Validate with `anchors-ingest --input <private-file> --config <private-config>`;
after the separate go add `--live`. Existing resolved IDs are no-ops. Missing
titles go through the existing TMDB detail pipeline, capped at 100 metadata
attempts/10 minutes, under the shared refresh lock. Additions are ordinary active
catalog movies, listed by UUID in a private report. This writes no watched state
or ratings; the later unseen-only ranking rule excludes watched titles.

The user/Claude prepares actual anchor judgments and ratings; no synthetic
personal preferences are supplied by this implementation. `anchors-template`
and `reviews-template` remain blank. Imports validate offline; only separately
authorized `--apply` appends through the guarded retained store. Reviews are
bounded to 20 and apply only to the exact parent model revision. Unsupported
unseen evidence leaves titles unresolved in the queue.

After a separately authorized retained read, export a specific readable candidate:

```powershell
npm run classification -- export --read-local --phase-b --model-id 'claude-opus-5-5:effort=medium:out=10500:ms=300000:v1' --as-of <UTC> --output .cache/classification/private/snapshot-unique.json
```

Run `agreement` or `coverage` on the private snapshot with `--as-of <UTC>` and,
to save, `--write-report --output <private-file>`. Phase B's policy has complexity,
attention and emotional caps of 2. Agreement includes reproducible paired-title
bootstrap intervals with n, undefined replicates and overlap sensitivity. Sparse
selected anchors do not prove population accuracy or justify dimension merging.
Anchors remain calibration-only judgments; supported model-parent reviews affect
effective eligibility. No report automatically chooses a model or relaxes caps.

To compare two candidate snapshots, use `agreement --input <snapshot-1>
--compare-with <snapshot-2> --as-of <UTC>`. It reports both full paired sets and
their common movie/fingerprint set, sorted identically for paired bootstrap
sampling. Different policies/prompts or the same candidate are refused.
