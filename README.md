# Brain Off, Reel On

One tired user. One button. One good movie.

A movie picker for low-effort viewing, with recommendations informed by taste, subscription availability, and viewing preferences. Development proceeds from a personal pilot toward a multi-user beta and a commercial product.

## Status

PR 1 foundation: a static Next.js placeholder, pure domain/recommendation boundaries, branded identities, and foundation checks. Movie picking is not implemented. No infrastructure or deployment has been created.

See [the architecture plan](docs/architecture.md) for the product scope, data model, recommendation approach, evaluation protocol, PR roadmap, and recommended coding models.

Before implementation, read [AGENTS.md](AGENTS.md), the [engineering standards and release gates](docs/engineering.md), and the [PR 1 foundation plan](docs/plans/pr-01-foundation.md).

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
No environment files, credentials, external APIs, real catalog, or database are needed.
Local `.env*` files, generated Next types, and build/dependency/cache output are ignored.
Next's `agentRules: false` preserves the repository-owned `AGENTS.md`; this is the only
Next configuration needed for PR 1.
The small local `src/app/favicon.ico` was added to resolve the browser smoke check's
missing-favicon 404. It is not a PWA asset set or a generator-added starter asset.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Generate Next types with `next typegen`, then check strict app/tooling and independent pure projects. Works before dev/build. |
| `npm run lint` | Lint source, tests, config, and tooling with zero warnings. |
| `npm test` | Run only the Node-based foundation boundary suite. |
| `npm run build` | Build the production placeholder. |
| `npm run start -- --hostname 127.0.0.1 --port 3000` | Serve the completed production build locally. |
| `npm run check` | Typecheck, lint, test, and build in order; stop on failure. |

CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm run check` on Node 24 for
pushes to `main` and for pull requests, with read-only permissions and no secrets.

Direct versions are pinned in `package.json`, with transitive resolution in
`package-lock.json`. Runtime dependencies are only Next, React, and React DOM.
TypeScript 6.0.3 stays within the parser's supported range (<6.1); ESLint 9.39.5
stays within the React plugin's peer range. npm reports ESLint 9 as unsupported:
track its replacement when the Next preset's React plugin supports ESLint 10.
Do not override incompatible peers. No additional SDK, UI framework, or validation package is installed.

## Directory ownership

| Area | Ownership |
| --- | --- |
| `src/app` | Framework entry points, static page, and local CSS. |
| `src/domain` | Pure identities/invariants; imports only domain through relative paths. |
| `src/recommendation` | Pure engine boundary; imports only recommendation/domain through relative paths. PR 1 exports a type only. |
| `tests` | Synthetic identity fixtures, compile-only type controls, and real-config boundary tests. Never imported by production source. |
| `tooling/eslint` | Lexical area containment; no filesystem resolution. Existing lint rules own packages/syntax/assertions. |

Future ownership, documented but not yet created: `src/components` for reusable UI;
`src/server/db`, `src/server/providers`, `src/server/ingestion`, and
`src/server/classification` for integration effects; `scripts` for operational entry points.

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

PR 1 deliberately defers movie data/adapters, database/Auth, ingest/classification,
filtering/ranking, APIs/sessions/feedback, settings, CLI, PWA, CI, and deployment.
The architecture and revised PR plan own those later stages and acceptance criteria.
