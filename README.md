# Brain Off, Reel On

One tired user. One button. One good movie.

A movie picker for low-effort viewing, with recommendations informed by taste, subscription availability, and viewing preferences. Development proceeds from a personal pilot toward a multi-user beta and a commercial product.

## Status

PR 1 foundation, PR 2 schema and PR 3 metadata implementation: a static Next.js placeholder, pure boundaries, branded identities, PostgreSQL storage, bounded metadata ingestion and fill-absent ratings with synthetic validation. Movie picking is not implemented. No hosted infrastructure or deployment has been created.

See [the architecture plan](docs/architecture.md) for the product scope, data model, recommendation approach, evaluation protocol, PR roadmap, and recommended coding models.

Before implementation, read [AGENTS.md](AGENTS.md), the [engineering standards and release gates](docs/engineering.md), the [PR 2 schema evidence](docs/plans/pr-02-schema.md), and the [PR 3 plan and evidence](docs/plans/pr-03-metadata.md).

## Local setup

Use Node 24 LTS and npm. Verified with Node **24.14.0** and npm **11.9.0** on Windows.
The Node 24 line is enforced by package engines and `engine-strict=true`.
With nvm-windows, explicitly install/select a Node 24 version using `nvm install <24.x.y>`
and `nvm use <24.x.y>`; nvm-windows does not read `.nvmrc`.

From the repository in PowerShell:

```powershell
$env:NEXT_TELEMETRY_DISABLED = '1'
npm ci
npm run check
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open http://127.0.0.1:3000/ and stop the server with Ctrl+C.
No environment files, credentials, external APIs, real catalog, or database are needed for the app or foundation checks.
Local `.env*` files, generated Next types, and build/dependency/cache output are ignored.
Next's `agentRules: false` preserves the repository-owned `AGENTS.md`; this is the only
Next configuration needed for PR 1.
The small local `src/app/favicon.ico` was added to resolve the browser smoke check's
missing-favicon 404. It is not a PWA asset set or a generator-added starter asset.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Generate Next types with `next typegen`, then check strict app/tooling and independent pure projects. Works before dev/build. |
| `npm run lint` | Lint source, tests, config, and tooling with zero warnings. |
| `npm test` | Run foundation boundary and offline metadata suites; no Docker, credentials or provider network. |
| `npm run build` | Build the production placeholder. |
| `npm run start -- --hostname 127.0.0.1 --port 3000` | Serve the completed production build locally. |
| `npm run check` | Typecheck, lint, test, and build in order; stop on failure. |
| `npm run test:db:runner` | Docker-independent Node lifecycle/refusal tests; no npm dependencies needed. |
| `npm run test:db` | Runner tests, disposable PostgreSQL schema/access suites, expected-red controls, final green and fresh reset replay. |
| `npm run test:metadata:db` | Dedicated PR 3 pg integration suites, two fresh disposable container/network cycles. Requires Docker; missing harness context fails. |
| `npm run test:metadata:controls` | Seven temporary source mutation controls, restored in finally, followed by final offline and DB green. Run alone; private logs in `.cache/pr03/`. |
| `npm run metadata:local -- --scenario repeat` | Synthetic metadata/ratings composition twice, inspected teardown; scenarios `metadata`, `ratings`, `repeat` only. |
| `npm run metadata:dry-run -- --config <file> --as-of YYYY-MM-DD` | Validate explicit discovery config and print bounded batches without network/writes. |
| `npm run ratings:dry-run -- --input <file> --as-of YYYY-MM-DD` | Validate/coalesce a TMDB seed; print counts only. Identity/state resolution needs disposable composition. |

CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm run check` on Node 24 for
pushes to `main` and for pull requests, with read-only permissions and no secrets.
Its separate database job runs `docker version` and the same `npm run test:db`,
without npm installation, secrets, published ports or persistent database storage.
The additional `metadata-database` job installs the lockfile and runs the same PR 3
DB, synthetic repeat and dry-run commands as local validation. It uses no credentials
or provider calls. Remote CI evidence is pending separately authorized publication.

## Disposable database checks

Use Docker Desktop with WSL2 and Linux containers on Windows; Linux CI uses its
runner-provided Docker engine. Confirm `docker version` succeeds before running
`npm run test:db`. First use downloads the official PostgreSQL 17 image pinned to
a multi-architecture index in `tooling/db-image.txt`; the runner logs the resolved
architecture/image and server patch. Missing Docker fails the command.

The runner creates a unique `bor-pr02-*` container, with `--network none`, no
ports or host mounts, and tmpfs database storage. Trust authentication exists only
inside that disposable container. Every psql call targets loopback TCP inside
the recorded, inspected container ID. There is no external database/reset mode,
`.env` loading or connection URL. Host database environment variables cannot
select a SQL target. Startup is bounded to 30 seconds and the run to five minutes.
Cleanup rechecks identity/isolation, removes only the created ID, and verifies it
is gone. Each rerun recreates the database; applied migrations are never replayed
in the same database. After an unhandled process kill, inspect the recorded ID
and matching run labels/network/tmpfs before emergency removal as documented
in the plan. Never remove containers by a guessed name or broad filter.

`supabase/migrations` owns the three ordered, transactional migrations. They
require PostgreSQL 17 and the platform roles, `auth.users(id)`, `auth.uid()` and
explicit owner USAGE/REFERENCES privileges; they do not provision Auth. Tests
use a disposable shim in `tests/db/bootstrap.sql`, a non-superuser BYPASSRLS
migration owner, and invented fixtures in `tests/fixtures/pr-02-synthetic.sql`.
Ordinary-role assertions prove actual constraints/grants/RLS; SET ROLE and claim
GUCs simulate a trusted gateway and do not prove identity verification, Supabase
platform compatibility or endpoint authorization. Service credentials bypass RLS
and require application authorization in PR 7.

Classification/history/evidence records are append-only. Snapshot children must
be inserted with their server-stamped xid8 parent in the same transaction, offers
before observations. PR 7's logical-restore rehearsal must demonstrate that layout.
Plain account/profile cascades remove selected personal graphs without deferring
constraints. Direct immutable deletion is denied to the owner and service role.
Session deletion is likewise denied directly and permitted through profile/account
cascades. Movies with classification or snapshot history cannot be hard-deleted;
history-free movies may still cascade their external mappings, credits and
availability tracks without observations. Other nested FK cascades are permitted under the documented trigger-depth assumption.
The two read-free immutable validators have authenticated/service EXECUTE grants
for real named CHECKs; the four invoker trigger routines have no API EXECUTE grants.
Every future migration must explicitly revoke PUBLIC/API access on new functions
in their creation transaction: PostgreSQL defaults grant PUBLIC EXECUTE, and a
schema-scoped default revoke cannot remove it. Platform-wide defaults remain
unchanged. No SECURITY DEFINER function or API schema exposure is configured.

PR 7 must decide Data API exposure and explicitly accept or revoke the existing
personal browser-write grants if exposed. HTTP validation/rate limits/CSRF controls
would not protect direct PostgREST writes. Actual personal preferences remain
unconfirmed; fixture values carry no product meaning.

Direct versions are pinned in `package.json`, with transitive resolution in
`package-lock.json`. Runtime dependencies are Next, React, React DOM and pg.
PR 3 adds only pg **8.23.1** and development @types/pg **8.23.1**. Parameterized,
unnamed queries and transactions use one checked-out client; production imports
never start work or read credentials.
TypeScript 6.0.3 stays within the parser's supported range (<6.1); ESLint 9.39.5
stays within the React plugin's peer range. npm reports ESLint 9 as unsupported:
track its replacement when the Next preset's React plugin supports ESLint 10.
Do not override incompatible peers. No additional SDK, ORM, UI framework, or validation package is installed.

## Directory ownership

| Area | Ownership |
| --- | --- |
| `src/app` | Framework entry points, static page, and local CSS. |
| `src/domain` | Pure identities/invariants; imports only domain through relative paths. |
| `src/recommendation` | Pure engine boundary; imports only recommendation/domain through relative paths. PR 1 exports a type only. |
| `tests` | Synthetic identity fixtures, compile-only type controls, and real-config boundary tests. Never imported by production source. |
| `tooling/eslint` | Lexical area containment; no filesystem resolution. Existing lint rules own packages/syntax/assertions. |
| `supabase/migrations` | PostgreSQL schema, constraints, privileges, policies and invariant triggers. |
| `tests/db`, `tests/fixtures/pr-02-synthetic.sql` | Disposable platform shim, assertions, synthetic inserts and rollback-only controls. |
| `tooling/db-test.mjs`, `tooling/db-image.txt` | Disposable Docker lifecycle and official multi-architecture image pin. |

PR 3 ownership: `src/server/providers` owns the metadata boundary/TMDB decoder and
transport; `src/server/ingestion` owns discovery/configuration/orchestration and
safe diagnostics; `src/server/db` owns the reusable pg store and fixed SQL.
`scripts` owns explicit-file offline entry points. `tooling/metadata-*.ts` owns
synthetic composition, inspected disposable targets and mutation controls;
`tests/metadata` owns offline acceptance, `tests/db/*.test.ts` owns explicitly
invoked pg acceptance, and `tests/fixtures/pr-03` contains invented data only.
Future ownership: `src/components` for reusable UI and `src/server/classification`
for classification effects.

Pure files reject packages, built-ins, aliases, absolute paths, dynamic imports,
CommonJS/import-equals, import-type expressions, framework directives, explicit
`any`, type assertions, and inline waivers. `local/pure-boundary` alone owns
relative area containment, including nonexistent targets and normalized traversal.
The lint scopes cover `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and
`.cjs` in both pure areas, but only `.ts` source is permitted. Every other script
extension is rejected even without imports. This keeps every accepted pure module
in the independent TypeScript project without JavaScript/JSX configuration or
TypeScript's same-basename extension shadowing. Triple-slash `lib`, `types`, and
`path` references are forbidden so files cannot opt back into DOM/Node globals or
bring in declarations from outside the boundary.
Ambient runtime variables/functions/classes/enums, global augmentation, and access through
`globalThis` are also forbidden. Private `declare const` unique-symbol brands
remain permitted; tests lint the actual ID declarations in both pure areas.
`eval`, string-based timer evaluation, and both calls and construction of
`Function` are forbidden in pure code.
These checks guard against accidental effects and known bypasses; they are not
a security sandbox against deliberately evasive code.

Brands distinguish internal movie/provider IDs from textual TMDB IDs at compile time.
They do not validate UUIDs, provider IDs, or authorization. Only test fixtures construct
IDs here; their equal invented text has no product meaning. Compile-only checks cover
all six brand pairs in both directions and raw string/number rejection. The independent
pure project includes global-leak checks; the app project excludes that globals file.
These files are not runtime tests.

PR 3 stores validated metadata only after exact namespaced resolution. One appended
TMDB request supplies all four components; missing/malformed components cannot
erase prior data. Discovery is candidate sourcing, with no verified offers or
eligibility. Release dates follow `tmdb-release-v1`; a later primary date than the
selected US event yields null and a counted `release_ambiguous` diagnostic. Origin
mapping `origin-v1` explicitly has no verified rules: all three production probes
are disabled and results remain unknown. Synthetic affirmative rules do not prove
real company correspondence or production truth.

The PR 3 disposable runner is separate from PR 2: unique `bor-pr03` labels/names,
private bridge network, tmpfs, random credentials supplied over stdin, and exactly
one inspected ephemeral `127.0.0.1` port. It reuses unedited bootstrap/migrations;
the database remains `bor_pr02_test`, marker `bor-pr02-disposable`. The injected
pg checkout guard verifies both as bor_migrator before every transaction, including
pool reuse. Application DML enters `SET LOCAL ROLE service_role`, and success
requires a confirmed COMMIT. Wrong-marker/database cases refuse writes. Cleanup
closes pools, reinspects created IDs and verifies container/network removal. Teardown
checks the requested loopback port binding, labels, network and tmpfs even after a
crash removes live port mappings. If work and cleanup both fail, an AggregateError
retains both errors in that order. There is no external target, retained database, environment-file or arbitrary profile mode.
After a process kill, inspect the logged exact IDs and matching run labels,
network, requested loopback HostConfig.PortBindings and tmpfs before removing only those IDs. Never use broad filters.

Ratings accept only a max-100 TMDB seed: watched/date, taste and tired signals stay
separate. The trusted composition issues an exact profile/account context; files
cannot choose ownership. Locked batches fill absent values or accept equals,
report conflicts by row indices, preserve exclusions and apply all or none.
Identical reimport leaves personal timestamps unchanged. Already committed catalog
resolutions survive a personal conflict. Offline output never logs personal values.

The separate real-catalog step, availability, Auth, classification,
recommendations, APIs, settings, PWA and deployment remain outside this implementation.
The architecture and current plan own acceptance criteria and limitations.
