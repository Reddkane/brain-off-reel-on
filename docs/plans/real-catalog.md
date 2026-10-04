# Separate real-catalog step: revised implementation plan

Date: October 3, 2026.
Status: approved

Target repository: `C:\Users\Reddk\Documents\Coding\brain-off-reel-on`.
Repository destination: `docs/plans/real-catalog.md`.
Implementation is authorized by the user. Separate authorization remains required for
provisioning, credential validation, live import, commit or push.

## 1. Baseline and review disposition

The initial planning pass read AGENTS.md, README.md, docs/architecture.md,
docs/engineering.md, PR 2 schema evidence and PR 3 specification/evidence,
including §11 and §14. It inspected the relevant provider, ingest, pg store,
configuration, diagnostics, migrations, bootstrap, image pin and CI.

Historical planning check: branch baseline was `main`, HEAD
`e0cf44771aacde307ec8d31405444216fa9b9968` (#3). Existing changes remain the
AGENTS.md secret-protection edit and untracked `.claude/settings.local.json`.
Preserve both. The initial pass confirmed the private token file is ignored and
untracked without reading its contents. The user reports a TMDB API Read Access
Token is present; token validity remains unverified. The user confirms merged PR 3
and green `check`, `database`, and `metadata-database` at this SHA. The earlier
remote query was blocked by network access; remote freshness/CI have not been
independently reverified. No test suite was run during that planning revision;
implementation validation and the current branch are recorded in §§10–11.

PR 3's recorded acceptance/re-review evidence is historical, not newly executed.
`origin-v1` still has no verified production rules; all three company-origin probes
remain disabled. Synthetic evidence establishes neither live compatibility nor
subscription entitlement or Supabase compatibility.

Claude's review is adopted: this is a small, local, replaceable metadata catalog,
not an operations platform. Remove the local grants overlay, extra owner/migrator
role hierarchy, deployment UUID/label/checksum ledger, automated Windows ACL checks,
credential-rotation workflow, whole-import lock, backup/restore implementation,
recovery rehearsal/targets/retention policy and their tests. Keep a small named-volume
persistence smoke check. Backup/restore for personal data remains PR 7 work.

Keep credential protection, non-admin runtime login, correct-target checks,
loopback binding, collision refusal, retained/disposable lifecycle separation,
§11 bounds, explicit live mode, terms gate and readback/coverage report.
Unresolved subscriptions can be omitted from a clearly scoped run; IDs are never guessed.

The supplied consolidated review approves the revised scope with one required
text correction, A1, and subscription input B1. Both are incorporated below.
A1 replaces stop/start with removal and recreation of the test-owned container
on the same named volume, plus inspection of the mount. B1 records the confirmed
tiers in §6. The user's implementation request confirms A1 text and satisfies the
conditional planning approval. No further full planning review is required.
Implementation acceptance is recorded separately below.

## 2. Scope and implementation sequence

Add trusted local composition around PR 3's existing provider, pg store, ingest
and diagnostics, immediately after PR 3 and before PR 4 real-catalog validation.
Add only persistent local Postgres setup, private configuration, target checks,
a bounded import entry point and focused offline acceptance.

No personal profiles/ratings, subscription/provider rows, offers, snapshots,
arrival observations, classification, ranking, API, Auth, UI, cron, deployment,
cloud resources or paid services are added. PR 4 owns per-title offer verification
and persisted provider variants. A local Auth compatibility scaffold supplies
schema prerequisites only; it is not real authentication.

Sequence:

1. A1 text confirmed; no further full planning review is required by the supplied review.
2. Implement explicit fresh setup, private config and retained-target guard.
3. Compose PR 3 code in a default-offline CLI with explicit live mode.
4. Run focused acceptance and review the actual implementation, especially secrets
   and wrong-target writes; resolve findings and re-review material corrections.
5. After separate setup/import authorization, verify live prerequisites, perform
   one supervised bounded import, and record readbacks and coverage.

Approving this plan does not authorize step 5. If live connectivity is unavailable,
complete offline implementation/acceptance and report the live gate as pending.

## 3. Persistent local Postgres and safe setup

Use Docker Desktop Linux containers and the unchanged PostgreSQL 17 image pin in
`tooling/db-image.txt`. Record the resolved image/server version during acceptance.
Use database `bor_catalog_local`, container `bor-catalog-local`, named data volume
`bor-catalog-local-pg17` mounted at `/var/lib/postgresql/data`, and a dedicated bridge
`bor-catalog-local-net`. Publish only `127.0.0.1:55432:5432`. Refuse an occupied port
or unrelated resource with one of these names; do not stop it or choose another
port/target silently. Inspect only the relevant Docker resource fields, never its
complete environment. No public binding, tmpfs catalog storage, `--rm`, source mount
or automatic volume deletion.

Setup is a separate explicit operator action. Create an empty database, supply
the released platform prerequisites, apply the three existing migrations in order
with their transaction boundaries, then create a small read-only target marker:
`local_support.marker`, containing exactly `bor-catalog-local-v1`. Restrict marker
mutation to the setup administrator. Create/enable runtime access only after all
setup steps succeed. Keep the marker outside `app`, so the released all-app-table
service grant does not grant marker writes.

Use a minimal dedicated local prerequisite SQL file for `anon`, `authenticated`,
`service_role`, `auth.users(id)`, `auth.uid()` and the required USAGE/REFERENCES.
Do not run `tests/db/bootstrap.sql`, copy its powerful migrator, create its test
marker or insert synthetic accounts into the retained database. No additional
migration framework, checksummed ledger or production schema change is needed.

Fresh setup refuses unexpected nonempty targets. If the existing target has the
correct database/marker and completed schema, repeat setup is inspection-only;
do not replay migrations. If setup was interrupted or state is unexpected,
report the failure and require operator inspection rather than attempting reset
or repair automatically. The runtime command never provisions, migrates or resets.
Document start/stop and connection details, without backup/restore subcommands.
Stopping the container or cancelling ingestion retains its volume and data.

Keep persistent lifecycle code entirely separate from PR 2/3 destructive
reset/teardown tooling. No container/volume removal in import finally blocks,
no reset/force/prune option, and no broad resource-removal filters.

### Operator preflight and manual disposal of a failed fresh setup

Before separately authorized retained setup, cache the exact pin explicitly:

```powershell
docker pull (Get-Content -LiteralPath tooling/db-image.txt -Raw).Trim()
npm run catalog:local -- setup
```

`setup` now inspects the cached image before creating private files or Docker
resources; `docker run --pull=never` prevents an implicit pull after reservation.
An absent image reports `image_not_cached`, leaving those resources/files untouched.
Fresh creation can still fail after reservation. There is no automatic destructive
repair; do not repeat setup against partial state or reuse its credential files.

To discard a failed *fresh* setup, first obtain separate authorization to remove
that exact replaceable local target. An import failure is not a reason to discard
committed data. Inspect only each resource that actually exists, without Config.Env:

```powershell
docker container inspect bor-catalog-local --format '{{.Id}} {{json .Config.Labels}} {{json .Mounts}} {{json .HostConfig.PortBindings}}'
docker volume inspect bor-catalog-local-pg17 --format '{{.Name}} {{json .Labels}}'
docker network inspect bor-catalog-local-net --format '{{.Name}} {{json .Labels}}'
```

Verify the exact fixed names, `bor.catalog.local=v1` ownership labels, named volume
`bor-catalog-local-pg17` at `/var/lib/postgresql/data`, and only the configured
`127.0.0.1:55432` port. If any existing resource is unrelated or identity is unclear,
stop and inspect further; do not remove it. Once that exact disposal is authorized,
remove only the inspected existing resources and the two generated credential files:

```powershell
docker container rm --force bor-catalog-local
docker volume rm bor-catalog-local-pg17
docker network rm bor-catalog-local-net
Remove-Item -LiteralPath '.cache/real-catalog/private/setup.json', '.cache/real-catalog/private/runtime.json'
```

Run only the lines for resources/files confirmed present and owned by this setup.
Do not use prune, broad filters, another target or a recursive directory removal.
Keep private discovery configuration and historical reports. Confirm the three exact
resources and two files are absent, then perform a new setup only when authorized.
This is an explicit manual discard of a replaceable catalog, not a backup/recovery
framework. No such retained disposal has been executed during implementation.

## 4. Runtime login and connection guard

Keep the released migration 3 grants/RLS and the pg store's fixed
`SET LOCAL ROLE service_role` unchanged. Do not add a local permissions overlay.
The local service role retains its released broad app-table access and BYPASSRLS;
this is intentional for this trusted metadata-only composition and does not prove
future API authorization or Supabase platform compatibility.

Use a separate setup administrator and one runtime login, `bor_catalog_ingest`:
LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION,
NOBYPASSRLS, with CONNECT to the catalog database. Grant only service-role membership
with SET TRUE, INHERIT FALSE and ADMIN FALSE. It cannot switch into the setup
administrator, another privileged owner or authenticated. Give the login minimal
USAGE/SELECT on the target marker; it cannot update it. No owner/migrator login
hierarchy, runtime schema ownership or administrator credential in ingestion.

On every pg checkout, including reused pool clients, the existing `checkoutGuard`
hook verifies `current_database() = 'bor_catalog_local'`, the expected session login,
and the sole expected retained marker before BEGIN/SET LOCAL ROLE or application
DML. Missing/wrong markers, `bor_pr02_test`, and PR 2/3 disposable markers refuse.
A wrong database with a copied valid marker must also refuse. Destroy the client
on guard failure. This is an accidental-target safeguard, not an authentication
mechanism; password authentication remains required.

Use password-authenticated TCP from first startup, never published trust auth.
Bootstrap passwords use the official image's password-file mechanism or private
stdin setup, not literal command arguments/Docker environment values. Runtime
credentials are separate from setup credentials. Confirm the actual login can
perform catalog writes via service_role and cannot become administrator; do not
assert denial of app-table access that the released service role intentionally has.

## 5. Private configuration and reuse

Load the explicitly named ignored `.env.local` only for a selected live action,
reading `TMDB_READ_ACCESS_TOKEN` without shell evaluation or expansion. Bound file
size, reject duplicate/malformed required keys, validate token shape without printing
it, and reject conflicting overrides. Ignore unrelated keys rather than copying the
whole file into the process environment. Never dump or rewrite the existing file.
Keep database runtime/setup credentials in separate ignored files under
`.cache/real-catalog/private/`; the importer reads only the runtime credential.
Keep the US discovery config and run report there too. Recommend owner-private
storage in the setup instructions; no programmatic Windows ACL inspection framework.

Commit only a nonsecret configuration template. Keep `.env*` and `.cache/` ignored.
No credentials in source, fixtures, command lines, connection-string output,
NEXT_PUBLIC variables, browser imports, CI or logs. Return fixed error codes and
counts instead of raw driver/fetch/filesystem errors, headers or payloads. Test
redaction using invented secret sentinels. Token validity checks report only
success/failure; connectivity failure does not imply an invalid token.

The entry point reuses `createTmdb`, `createPgStore`, `ingest`, `decodeConfig`,
`productionMapping` and existing diagnostics. Supply a frozen catalog capability,
`operators: []`, no ratings, the retained checkout guard, and a bounded pool
(max two connections, five-second connection timeout). Forward cancellation,
close pools on exit and retain the existing transaction/time/request controls.
Default execution validates/plans supplied configuration without network or writes;
`--live` is explicit. Reject unknown flags, arbitrary target URLs, synthetic live
config, malformed provider IDs and upward limit overrides.

Use existing per-movie global catalog locking and atomic writes; no extra
whole-import lock. The documented operator workflow runs one import at a time.
An interrupted run may remain `running`; report that honestly and rerun with a new
run ID when authorized. No automatic resume, deletion or relabeling old runs.

Recovery for this scope is to recreate an explicitly selected local catalog and
rerun the bounded import when separately authorized. It is not an automatic reset
path in the importer. Refetching may yield changed upstream data and new internal
UUIDs; exact historical replay is not promised. Reassess recovery before retaining
personal data or downstream history; PR 7 owns backup/restore/deletion evidence.

## 6. Subscriptions and live gates

US and all four subscription tiers are confirmed by the supplied follow-up:

| Service | Confirmed subscription |
| --- | --- |
| Netflix | Without ads, direct subscription. |
| HBO Max | Standard, no ads, direct subscription. |
| Disney+ | Disney+/Hulu bundle with ads; no Live TV. |
| Hulu | Disney+/Hulu bundle with ads; no Live TV. |

No further tier input is currently needed. Exact TMDB provider IDs and current names
remain unverified: confirm them with one US movie-provider-list request at run time,
recording checked date and any mapping qualification. Never hardcode or guess IDs.
Do not map Netflix to an ad-tier entry or HBO Max to a channel/add-on entry.
For the bundle, use the normal Disney+ and Hulu entries unless the listing shows
separate applicable ad-tier entries; if it does, verify and use those entries.
Keep the confirmed Disney+/Hulu ad-tier status in the private configuration/run
report even when TMDB uses a normal provider entry. Ad-tier catalog restrictions
belong to PR 4's offer checks; discovery does not prove included-title access.
A list entry confirms a mapping, not entitlement. Do not assume the bundle enables
additional channels or Live TV, and do not request streaming account credentials.

A service that remains unresolved is omitted from the proposed run configuration,
with the reason displayed before execution and in the report. A scoped run can use
any nonempty resolved subset; it need not wait for all four services. The operator's
live-run authorization covers the displayed scope. No separate full-four-service
prerequisite, guessed fallback ID or claim of full subscription coverage. If no
service is resolved, refuse live discovery. All four are expected to resolve from
the supplied tiers; subset/omission handling is now a fallback for mapping or
connectivity uncertainty. PR 4 verifies actual included offers.

Token validity and connectivity may wait until immediately before ingestion.
The optional listing uses a fixed TMDB HTTPS destination, no redirects, bounded
response/time, private bearer header and safe errors; charge all attempts to the
same run budget. Reuse the existing transport policy; if its request helper cannot
be reused directly, add only a small listing wrapper, not a second ingestion engine.
401/403 stops work without authentication retries; connectivity failures remain
unverified. Do not add a mandatory separate live-detail probe.

Before the first live call, confirm applicable TMDB noncommercial terms, attribution
and local caching/retention compatibility, recording source/date and decision.
The FAQ alone does not establish unlimited retention rights. Commercial use needs
a separate licensing decision. Missing live credentials/connectivity never skip
offline acceptance.

## 7. Bounded first import and handoff (§11)

After acceptance/review and separate execution authorization, record repository SHA,
US region, included provider IDs and omitted services, explicit UTC as-of date,
`origin-v1` and bounds in the private run report. First import limits:

| Budget | Limit |
| --- | --- |
| Selected titles / combined details | 100 / 100; no ratings or additional ratings calls. |
| Discovery-page operations | 40, including failed operations. |
| Pages per batch | 2, using PR 3 deterministic rounds. |
| Optional provider list | One operation, charged to HTTP attempts. |
| HTTP attempts including retries | 200: at most 40 + 100 + 1 = 141 initial attempts and 59 retry slots. |
| Wall clock | Ten minutes including preflight/work/finalization; stop new work before the final 30 seconds. |
| Cumulative ordinary DB work | 120 seconds, lowered from PR 3 maxima; bounded finalization uses the reserved time. |
| Catalog size | 1,000 records including existing rows; no pruning. |

Retain PR 3's serialized HTTP lane, two starts/second maximum, ten-second request
timeout, at most two retries per retryable operation, and existing statement/lock/
transaction limits capped by remaining budgets. Listing/preflight shares the
absolute deadline/attempt ledger; do not reset either when ingestion starts.
Bound final run recording, readback and pool shutdown within the reserved 30 seconds;
test deadline/cancellation through the actual CLI composition. No detached work.

Four single resolved provider IDs yield 20 first-page batches and at most 16 second
pages: 36 discovery operations, below 40. A subset needs fewer. Unknown origin
probes remain disabled. This is budget arithmetic, not a live result or promise of
100 successful titles; provider latency/backoff may exhaust ten minutes earlier.

Preserve PR 3's flatrate|ads|free candidate sourcing and first-seen selection.
Candidate membership is not a verified subscription offer. The title cap can yield
uneven service coverage. Unknown origin/release/runtime/certification and honest
partial outcomes do not justify new evidence logic, quotas or raised budgets.

Read back movies, exact namespaced mappings, credit counts, release/certification
source/date tuples, company/origin evidence/version/check time and run outcome.
Check identity uniqueness, aggregate integrity and catalog cap. Verify the
composition has not written personal, availability or classification data.
Compare reported committed writes with readbacks; `persisted` includes updates
and is not a count of newly created movies.

Report included/omitted services; requested/empty/failed/truncated/not-configured
batches; source versus normalized release cohorts; unknown/mixed origins; missing/
ambiguous fields; duplicates; committed counts; attempts, elapsed/DB time and each
bound/failure reason. Keep detailed readbacks private; share a redacted summary.
Exit 0 only for completed import plus readback, 2 for bounded partial, and 1 for
refusal/operational/readback failure. Earlier title commits survive later failure;
reruns are bounded and idempotent through existing identity logic.

PR 4 receives retained metadata and honest coverage, not verified watchability.
Availability, filtering, scoring and arrival freshness remain `not_measured`.

## 8. Focused acceptance and review

Normal checks use invented fixtures/injected transport and no real credentials,
provider calls or retained database. New pg acceptance uses isolated test-owned
resources; never point destructive tests at the local catalog. Leave PR 2/3
runners, test markers, migrations, store role SQL and ingestion logic unchanged.

| Check | Required evidence |
| --- | --- |
| Config/CLI/secrets | Default mode makes no calls/writes; explicit live action required. Duplicate keys, malformed config, empty resolved subset, synthetic live input and enlarged bounds refuse. Fake token/password sentinels never appear in output/errors. Resolved subset with named omissions is a positive case. |
| Target guard | Valid target succeeds; wrong DB with copied marker, missing/wrong/disposable marker and wrong login refuse before DML. Prove checking a reused pool connection and unchanged data on refusal. |
| Setup/runtime | Published binding is loopback-only, named volume is used, occupied names/port refuse, interrupted setup cannot enable ingestion. Runtime can SET service_role and complete metadata writes, cannot SET administrator/create roles/databases or mutate marker. Released app grants stay unchanged. |
| Composition/bounds | Actual CLI with injected provider and real pg uses PR 3 code; repeat import preserves identity and credits. Listing/retries/failed operations count toward shared bounds; authentication stops; cancellation closes pools without retained-data teardown. No personal/availability/classification writes. |
| Persistence smoke (A1) | On isolated test-owned resources, inspect that `/var/lib/postgresql/data` is a volume mount whose Name is the exact test-owned named volume. Insert synthetic metadata and record data, UUIDs and counts. Remove only the inspected test-owned container, retaining that named volume; create a new container with a different container ID on the same named volume. Inspect the new mount's Type, Name and Destination again, then confirm the same data, UUIDs and counts survive. A stop/start alone is insufficient. One check; no recovery suite and no removal of the retained catalog container or volume. |

Proposed new shared command `npm run test:catalog:db` covers the focused SQL/composition
and persistence smoke checks. Docker absence fails this explicit command rather
than silently skipping it. Offline config/CLI tests belong in `npm run check`.
During implementation run `npm ci`, `npm run check`, `npm run test:db:runner`,
`npm run test:db`, `npm run test:metadata:db`, `npm run metadata:local -- --scenario repeat`,
the existing synthetic dry-runs and `npm run test:catalog:db`. Run dependency audit
and diff/new-file/secret-exclusion review; adjudicate relevant findings without
unrelated upgrades. Existing mutation controls need rerunning only if affected PR 3
code changes; this plan anticipates no such changes. Do not introduce new mutation
infrastructure for this composition step.

Keep CI credential-free and use the same new acceptance command in a bounded job
or the metadata job, with measured timeout margin. Preserve existing jobs and their
scope. No retained CI database or live token.

Focused implementation/security review inspects the complete actual change set
for credential transport/output leakage, wrong-target writes, localhost binding,
non-admin login/membership, setup completion, retained/disposable separation and
new CLI budget wiring. Passing PR 3 tests alone does not establish new composition
safety. Resolve blockers and re-review material changes before live execution.
Do not broaden this review into production Auth/operations validation.

## 9. Proposed inventory and remaining gates

| Area | Proposed change |
| --- | --- |
| `scripts/catalog-local.ts` and small prerequisite SQL | Explicit inspect/setup/start/stop; minimal local platform roles/schema/marker, no backup/reset framework. |
| `scripts/catalog-config.ts` | Bounded private file parsing, service subset/omissions and first-import limits. |
| `scripts/catalog-import.ts` | Default offline validation; explicit live composition, listing/preflight and readback/report. |
| `src/server/db/local-catalog-target.ts` | Retained checkout guard and fixed readback queries. |
| `tests/metadata/`, `tests/db/` | Focused config/secret/target/login/composition tests and one persistence smoke, with isolated resources. |
| `config/catalog-local.example.json`, package scripts, CI, README | Nonsecret template, shared checks and short operator setup/rebuild instructions. |
| `docs/plans/real-catalog.md`, PR 3 §11 link, existing AGENTS.md edit | Revised plan/evidence and the existing secret-protection rule in the eventual reviewed change. Preserve unrelated `.claude/` work. |

No new dependency is anticipated. No production grants overlay, deployment ledger,
extra importer lock, ACL automation or backup/recovery framework. Commit/push still
requires separate authorization, including the existing AGENTS.md edit.

Pending before live execution: terms decision, usable token/connectivity, at least
one verified provider mapping using the confirmed tiers, displayed service scope,
implementation acceptance/review and retained setup/import authorization.
Only exact provider IDs/names and any mapping qualifications remain unresolved;
subscription tiers are recorded in §6. No other preferences/ratings are inferred.
PR 7/8 retain Supabase/Auth/Data API/TLS/pooler, personal-data recovery and trial gates.

Official references consulted in the original planning pass, without credentialed calls:

- [PostgreSQL 17 role membership](https://www.postgresql.org/docs/17/role-membership.html): runtime SET membership is distinct from inherited privileges.
- [Official PostgreSQL Docker image](https://github.com/docker-library/docs/blob/master/postgres/README.md): password-file initialization and persistent data directory; validate against the existing pin.
- [TMDB movie provider list](https://developer.themoviedb.org/reference/watch-providers-movie-list): mapping lookup, not entitlement proof.
- [TMDB FAQ](https://developer.themoviedb.org/docs/faq): noncommercial attribution and commercial licensing; confirm intended storage terms before live use.

The architecture, engineering standards and PR 3 §11 remain the owning specifications.
This approved revision replaces the earlier plan. A1 text confirmation is satisfied
by the user's implementation authorization. Implementation evidence follows.

## 10. Implementation evidence — October 3, 2026

Implemented on `feat/real-catalog`, based on `e0cf44771aacde307ec8d31405444216fa9b9968`.
The checkout matched `main`/merged PR 3. The existing `AGENTS.md` secret-handling
edit is included in proposed review scope; untracked `.claude/settings.local.json`
is untouched. Baseline remote CI is user-reported historical evidence; this
unpublished branch has no independently verified remote CI. No commit, push, PR,
deployment, paid action, retained provisioning, credentialed call or live import
was performed.

### Composition and focused acceptance

- Retained lifecycle uses fixed names/image/loopback port, exact named-volume
  inspection, collision refusal, bootstrap stdin/password-file, and separate
  runtime credentials. It contains no removal/reset/backup command. Small local
  prerequisites plus released migrations precede the atomic marker/runtime-login
  transaction. Completed repeat setup inspects without replay; interrupted/nonempty
  state refuses automatic repair. A prerequisite-only interruption is tested.
- Real pg proves the non-admin runtime attributes, sole SET-only service membership,
  metadata writes, wrong-password rejection, and denial of administrator/authenticated
  switching, role/database creation and marker mutation. Released broad service-role
  app grants are unchanged. This is a trusted local service composition, not Auth.
- The retained guard uses the existing `checkoutGuard`. Tests prove the same backend
  PID is reused, then marker replacement/missing/disposable markers refuse without
  writes. Wrong login and wrong database with a copied valid marker also refuse.
  Guard failures discard clients.
- Bounded regular-file parsing rejects duplicate JSON/env keys, malformed tokens/
  config, conflicting token overrides, unsupported flags, synthetic config flags,
  empty import scope and enlarged budgets. Default composition makes no credential
  reads/calls/DB work/writes. Live mode reads only the named token and runtime file;
  no shell evaluation, environment copying, setup secret in import or raw errors.
- The CLI composes unchanged `createTmdb`, `createPgStore`, `ingest`, production
  mapping and diagnostics with frozen capability, `operators: []`, no ratings, max
  two pool connections and five-second connection timeout. It closes pools on exit
  without retained-data teardown.
- Optional listing is one operation without retries: fixed HTTPS, no redirects,
  streamed 2 MiB limit, ten-second timeout and safe errors. Inline listing/import
  share attempts/deadline; a pacing pause precedes PR 3's unchanged serialized lane.
  Listing-only mode supports unresolved services; the operator selects/authorizes
  mappings before import. Saved or inline decoded listing must match configured
  IDs/names/check date. Neither listing correspondence nor config proves entitlement.
- Preflight is charged to the 120-second ordinary DB budget. Lowered durations still
  reserve 30 seconds for finalization; final recording/readback/report are deadline
  bounded. CLI/real-pg tests exercise exhausted shared attempts, failed/retried
  operations, lowered deadline, immediate auth shutdown and cancellation.
- Guarded repeatable-read readbacks include full movies, canonical field/date
  aggregates, mappings, credits, run counts/outcome and excluded-area counts.
  Committed contents/credits and reported writes are crosschecked. Updates are not
  reported as newly created movies. Detailed metadata stays private; console output
  is scope/counts/codes. DB/recording/readback/report failures exit 1; bounded partial
  exits 2. Availability/filtering/scoring/arrival freshness remain `not_measured`.
- A1 inspects Type=`volume`, exact test-owned Name and Destination before and after
  removing only the inspected test-owned container and recreating a different ID
  on the same volume. Complete data/UUID/count readbacks match. Final cleanup verifies
  removal of only test-owned container/network/volume resources.

### Measured validation and corrections

Windows Node 24.14.0/npm 11.9.0, Docker engine 29.8.1, unchanged official PostgreSQL
17 pin, server 17.11 (Debian 17.11-1.pgdg13+2). Sandbox access required authorized
elevated git/Docker/install/check execution; no approval rejection remains.

| Command | Result |
| --- | --- |
| `npm ci` | Passed unchanged lockfile; no dependencies/version changes. |
| `npm run check` | Final green: strict root/pure projects, zero-warning lint, 264 offline tests and production Next build. |
| `npm run test:db:runner` | Passed 11 unchanged tests. |
| `npm run test:db` | Passed released schema/access/expected-red controls, final green, fresh reset and inspected teardown. |
| `npm run test:metadata:db` | Passed 22 cases per fresh cycle, two cycles, verified teardown. |
| `npm run metadata:local -- --scenario repeat` | Passed: two resolved titles/pass, no title failures, honest partial discovery cap, unchanged repeat personal apply, verified teardown. |
| Existing synthetic metadata/ratings dry-runs, as-of `2026-10-03` | Both exit 0 without network/writes. |
| `npm run test:catalog:db` | Final green: 13 Node cases (parent plus 12 subchecks), actual CLI/real pg and one A1 check; about 8.1 seconds, no skips. |
| `npm audit --json` | Exit 1: same five high development lint-chain findings. |
| `npm audit --omit=dev --json` | Exit 0: zero production vulnerabilities. |
| Complete diff/new-file/secret exclusion review | Reviewed; released migrations/grants, PR 3 provider/ingest/store logic, PR 2/3 runners/bootstrap/image, lockfile and `.claude/` unchanged. |

Audit disposition remains PR 3 §14: `braces`/`micromatch`/`fast-glob` and the Next
lint plugin/preset are development-chain findings. Track compatible upstream lint
fix/ESLint maintenance before affected releases; no incompatible preset downgrade,
force fix or unrelated upgrade. Existing PR 3 mutation controls were not rerun:
affected PR 3 source did not change. No new mutation infrastructure.

Private evidence in `.cache/real-catalog/`: `check-final.log`, `catalog-db-final.log`,
`db-runner.log`, `db.log`, `metadata-db.log`, `repeat.log`, both dry-run logs and
`audit.json`/`audit-runtime.json`. Credential/build/dependency/evidence output and
unrelated `.claude/` work are excluded. Full Next checks moved `.env.local` without
reading contents into an ignored holding path and restored it in `finally`; the
holding path is absent afterward. No real token was supplied to new acceptance/live
code. Synthetic sentinels test error/output redaction.

`.cache/real-catalog/review-diff.patch` includes the five tracked edits and all nine
new files; `review-inventory.json` lists included/excluded paths. Tracked and new-file
whitespace checks pass. Final Docker label inventory contains no synthetic catalog
container/network/volume leftovers, and retained catalog resources are absent.

Final A1: volume `bor-catalog-test-8be0d05ff3c32fb81c1f470e-data`,
old container `e2065cf0808ced15a0637057909693a753a08a9f5710ba5362d109d39643953b`,
new container `09a90ab8cbb0dc0d499751b5bb52c945211fe81201719554ce03d73ca976c08c`.
Same movie data/UUID, one mapping and two credits survived; full readbacks including
run/excluded counts matched. Exact test-owned teardown verified.

Initial checks found and corrected TypeScript literal inference, test cancellation
timing/double pool shutdown, optional Docker Tmpfs field lookup and composition
budget/readback gaps. One failed inspector left a test-owned startup container;
it was subsequently inspected by exact ID/labels/mount/binding and removed with
its inspected network/volume. Test IDs are now recorded before startup inspection.
Final green includes all corrections; no failing assertion was skipped or released
source mutation retained. New-file readability changes were checked for parsed-AST
equivalence using the existing TypeScript dependency, without a new formatter.

### Independent review handoff and remaining gates

Self-review covered actual secret transport/output, wrong-target refusal, requested
and actual loopback binding, login/membership, setup completion, lifecycle separation,
CLI budgets and readback. At this initial handoff, independent focused review had
not occurred. The subsequently supplied independent review and its requested
corrections are recorded in §11; focused re-review remains pending.

Review tracked edits: `.github/workflows/ci.yml`, `AGENTS.md`, `README.md`,
`docs/plans/pr-03-metadata.md`, `package.json`; plus all nine new files:

1. `config/catalog-local.example.json`
2. `docs/plans/real-catalog.md`
3. `scripts/catalog-config.ts`
4. `scripts/catalog-import.ts`
5. `scripts/catalog-local.ts`
6. `scripts/catalog-prerequisites.sql`
7. `src/server/db/local-catalog-target.ts`
8. `tests/db/catalog.test.ts`
9. `tests/metadata/catalog.test.ts`

Acceptance is §§3–8, especially actual live config/flags, fixed credential paths,
guard-before-DML/reuse, atomic runtime enablement, released grants, shared listing/
retry/failure budgets, deadline/finalization, readback and A1 exact mount/IDs. This
tiny synthetic run does not prove maximum-size live throughput, TMDB compatibility,
entitlement or Supabase/Auth. CI uses the same new command in the unchanged bounded
metadata job; the revised acceptance run in §11 fits its existing 20-minute limit.

Before retained setup/live execution: independent focused review and resolved
findings; separate retained target/displayed-scope authorization; terms/attribution/
local caching-retention decision; real token validity/connectivity; exact US provider
IDs/names/qualifications. Confirmed tiers remain §6, with no other preferences/ratings
inferred. The template contains no real IDs. Windows owner-private storage is an
operator prerequisite, not verified ACL evidence. PR 7 retains personal recovery/
Auth/Data API/TLS/pooler gates; PR 4 receives metadata and honest coverage only.

## 11. Independent review corrections and validation — October 3, 2026

The user supplied an independent review of all nine new files and five tracked
edits. The reviewer ran `test:catalog:db` successfully, verified A1 and clean
test-owned teardown, and found no security blockers. They requested operator-path
changes before retained setup. Those findings have been addressed; independent
focused re-review of the revisions and operator-path test has **not yet occurred**.

- `localCommand` accepts test-owned resources/private storage in its callable API;
  the CLI still exposes only fixed retained resources. Start waits for PostgreSQL
  readiness and succeeds on an already-running inspected container.
- Bootstrap writes its password through stdin to a private temporary file, then
  atomically renames it before the entrypoint can observe it. No password enters
  Docker arguments or environment.
- Console diagnostics allow only enumerated internal codes; unknown driver, fetch
  and filesystem messages remain generic, including lowercase secret sentinels.
  A failed post-commit readback records committed ingest counts and a safe failure
  code when report storage succeeds. It does not undo committed titles.
- Fresh setup checks the cached pinned image before creating credentials or Docker
  resources; `--pull=never` prevents an implicit pull. Section 3 documents selective
  inspection and exact, separately authorized failed-fresh-setup disposal.
- Provider listing dates use the injected execution clock, independently of
  `--as-of`. Listings are `provider-list-<execution-id>.json`; configuration selects
  that basename through `providerListing`. Imports write `run-report-<run-id>.json`.
  Exclusive writes preserve history and refuse collisions. Readback SQL now uses
  an explicit projection rather than rewriting PR 3 SQL text.
- README operator guidance is shortened and no longer recommends moving credential
  files for validation. The real `.env.local` was neither read nor moved for these
  revisions.

Revision validation:

| Command / check | Evidence |
| --- | --- |
| `npm ci --offline` then `npm run check` | Exit 0: root/pure typechecks, zero-warning lint, 266 offline tests, production build. Run in an isolated source copy with physical dependencies and no credential files. |
| `npm run test:catalog:db` | Exit 0: 16 Node cases, no skips, about 32.7 seconds; real PostgreSQL and synthetic provider data only. |
| Actual operator API acceptance | Setup, repeat setup, inspect, stop, delayed restart and already-running start; image-cache refusal precedes mutations, exclusive credential writes preserve existing files, atomic bootstrap transport asserted. |
| Failure-report acceptance | Injected readback failure after real committed ingest: title/mapping survive, report records one persisted title and `catalog_readback_failed`, raw sentinel errors are absent. |
| Immutable report acceptance | Distinct IDs create separate files; repeated IDs refuse overwrite and preserve original bytes. |

Final revised A1 inspected the exact named-volume mount before and after removing
only the test-owned container and creating a different container on the same volume:

- Volume: `bor-catalog-test-c39cc99c2dff216b3369b5dd-data`.
- Old container: `6f4e074da60833a0d08a32aa06e996350d8c3b09f6242e17702252b94025bd77`.
- New container: `f9dfb8ba85d3b208befa6cad39a9a6d3d78016fe898ae8e50b7d5d973e6a672a`.

Complete data/UUID/readback equality included two movies, two mappings and four
credits. Exact test-owned cleanup passed. Evidence is private and ignored:
`.cache/real-catalog/check-review.log`, `catalog-review-db-final.log`,
`review-check-workspace.json`, `review-diff.patch`, `review-revision.patch` and
`review-inventory.json`. The source-copy manifest records 90 copied noncredential
project files; Next did not load the original credential file. No dependencies or
released migrations/grants/PR 3 ingestion logic changed. The earlier dependency
audit disposition in §10 remains; no unrelated upgrade was made.

The isolated build emitted Next's multiple-lockfile workspace-root warning because
the copy is nested beneath the original checkout. Typechecks, lint, tests and build
all completed successfully; no root configuration was changed just to silence it.

The complete proposed change includes the existing AGENTS.md secret-handling edit;
`.claude/` work remains excluded and preserved. No retained catalog, credentialed
API call, live import, commit, push or deployment occurred. Remaining live gates
are unchanged: focused re-review, separate retained/live authorization, terms and
retention decision, actual token validity, exact US provider IDs/names and tier
qualification. Confirmed subscription tiers are §6; no IDs have been guessed.
