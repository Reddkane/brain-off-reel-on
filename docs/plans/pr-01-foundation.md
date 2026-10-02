# PR 1: Repository foundation and pure engine boundary

Date: October 2, 2026  
Status: Implementation plan; no application implementation authorized by this document.  
Source of truth: [architecture](../architecture.md), consolidated body, especially sections 2, 3, 10, and 11. Section 15 supplies historical rationale only.  
Advisory implementation model: GPT-6.1 Sol, Medium reasoning. Review: GPT-6.1 Sol, High reasoning, in a fresh context with the diff and validation evidence. Do not switch models automatically.

## 1. Goal, actual starting state, and scope

Establish the smallest runnable Next.js/TypeScript foundation that makes the future recommendation engine independent of the application framework and data providers. Preserve the product contract: one tired user, one button, one good movie. PR 1 proves the repository and dependency boundaries; it does not pick a movie.

Inspection found only `README.md`, `docs/architecture.md`, and Git metadata. There is no package manifest, lockfile, application code, test runner, or existing configuration to preserve. No applicable `AGENTS.md` was found in the repository or its parent directories. The local `main` branch has no commits; README and docs are untracked. Preserve those existing files and do not treat them as disposable generator output. This planning task creates only this document and neither commits nor pushes.

**Include:** minimal Next.js App Router and TypeScript setup; root layout and static placeholder page; explicitly owned source areas; minimal nominal ID definitions and a type-only engine entry point; synthetic fixtures; Node-based unit/check tests; strict type checks and enforced import boundaries; local development/build/start scripts; one lockfile; concise README instructions.

**Exclude:** migrations and fixture SQL; Supabase clients, Auth and ownership enforcement; metadata/availability SDKs and adapters; ingestion or refresh jobs; classification/rubrics; filters, scoring, recommendation selection or explanations; API endpoints and sessions; feedback; preference screens; finished UI and working pick button; fonts/assets fetched from services; PWA manifests/service workers; deployment/cron configuration; CI workflows, hooks, containers, monitoring, and infrastructure. The replay/pick CLI belongs with orchestration in PR 7. No later-PR feature has a concrete PR 1 need.

## 2. Proposed file tree and ownership

Files below are proposed implementation deliverables, not files to create during this planning task. Every directory has a concrete file; generated build output is omitted.

```text
README.md                         # retain; add local setup/checks/ownership instructions
docs/
  architecture.md                 # retain unchanged as specification
  plans/pr-01-foundation.md        # this plan
.gitignore
.npmrc
.nvmrc
package.json
package-lock.json
tsconfig.json
tsconfig.pure.json
eslint.config.mjs
vitest.config.ts
tooling/eslint/pure-boundary.mjs    # sole owner of lexical area containment
src/
  app/
    layout.tsx
    page.tsx
    globals.css
  domain/
    ids.ts
    movie-identity.ts
  recommendation/
    index.ts
tests/
  fixtures/synthetic-identities.ts
  foundation/pure-boundary.test.ts
  types/ids.typecheck.ts
  types/pure-globals.typecheck.ts
```

| File/area | Responsibility |
| --- | --- |
| `src/app/layout.tsx` | Required HTML/body layout, static product metadata, and local CSS. Framework concerns stay here. |
| `src/app/page.tsx` | Static product name, tagline, and brief foundation status. No movie card, carousel, preferences, API call, or pretend recommendation action. |
| `src/app/globals.css` | Small legible baseline using system fonts; no design system or CSS framework. |
| `src/domain/ids.ts` | Distinct string brands for internal `MovieId` and `StreamingProviderId`, plus `TmdbMovieId` and `TmdbProviderId`. Private unique-symbol brand discriminants; external IDs are textual, matching architecture section 3. |
| `src/domain/movie-identity.ts` | Minimal readonly identity record containing an internal movie ID. No provider response shape, database row, catalog fields, or invented scoring input schema. |
| `src/recommendation/index.ts` | Type-only export of that domain identity under the enforced engine boundary; document that future supplied movie/profile/history/time/context inputs belong here. No identity function, fake picker, throwing implementation, or speculative full engine interface. |
| `tests/fixtures/synthetic-identities.ts` | Clearly labeled invented identity values, including equal underlying text with different brands. Fixture-only assertions may construct branded values. These are neither real movie records nor recorded provider responses nor personal preferences. |
| `tests/types/ids.typecheck.ts` | Compile-only positive and negative assignments/calls, using narrowly placed `@ts-expect-error` comments. Not a Vitest runtime test. |
| `tooling/eslint/pure-boundary.mjs` | Sole owner of lexical relative-area containment for existing and nonexistent targets, including imports/re-exports. Normalize Windows filenames to repo-relative POSIX paths; use `path.posix` and segment comparison without filesystem lookup. Existing ESLint rules own other restrictions. Tooling may use Node APIs; engine/domain may not. |
| `tests/foundation/pure-boundary.test.ts` | Exercise the actual repository ESLint configuration through its API with virtual source and file paths; prove forbidden forms fail and permitted imports pass. No bad-import fixture files in production source. |
| `tests/types/pure-globals.typecheck.ts` | Compile-only references to `window`, `document`, `process`, and `fetch`, each with its own narrowly placed `@ts-expect-error`. Include only in the pure project; root application checking must exclude this file and must not import it. No compiler-API probes or temporary directories. |
| `tsconfig.pure.json` | Small independent strict/no-emit TypeScript project for domain, recommendation, and both compile-only typecheck files: ECMAScript libraries only, `types: []`, no JSX/DOM/Node/Next globals, `paths`, or `baseUrl`. |
| Remaining root config | Package/scripts and reproducible installs; application type checking; lint overrides; Node-only test discovery. `package.json` enforces Node `>=24 <25` through `.npmrc`'s `engine-strict=true`; `.nvmrc` contains `24` for compatible non-Windows tooling. nvm-windows ignores `.nvmrc`; document explicit Node 24 selection there. Record exact Node/npm versions used in README, without pinning a Node patch. `next-env.d.ts` is generated and ignored, not an authored tree entry. |

Reserve ownership in README, without creating empty folders: `src/components` for reusable UI; `src/server/db`, `providers`, `ingestion`, and `classification` for effects and integration; `scripts` for future operational entry points. Create these areas only when their owning PR adds a real file. Domain may depend only on domain; recommendation may depend only on recommendation and domain. Neither may import tests/tooling/app/components/server. Application composition and server effects stay outside the pure dependency graph.

This is a staged realization of architecture section 10, not a scope departure. A type-only entry point deliberately postpones the ranking contract and algorithm to PR 6 rather than freezing incomplete inputs now.

## 3. Dependency and configuration choices

Use **npm**, a single package, Node **24 LTS**, and one `package-lock.json`. At implementation time select compatible stable releases, record exact direct dependency versions and the Node/npm versions used, and lock transitive resolution. Verify peer compatibility before installation; do not choose prereleases or use force/legacy-peer-deps to hide incompatibilities. Exact patches are routine implementation choices, not a planning blocker. Node release status should be checked against the [official release table](https://nodejs.org/en/about/previous-releases).

| Choice | Rationale |
| --- | --- |
| Runtime: `next`, `react`, `react-dom` | Minimal framework runtime. Use stable Next.js App Router and its compatible React pair; no additional runtime package. [Next.js installation](https://nextjs.org/docs/app/getting-started/installation). |
| Dev: `typescript`, `@types/node`, `@types/react`, `@types/react-dom` | Strict app/tooling type checks; Node types remain outside the independent pure project. |
| Dev: `eslint`, `eslint-config-next` | Flat configuration using Next core-web-vitals and TypeScript presets, with `eslint-config-next` aligned to Next's version. Invoke ESLint directly; keep lint separate from build. [Next.js ESLint guidance](https://nextjs.org/docs/app/api-reference/config/eslint). |
| Dev: `vitest` | Agreed Node-environment test runner, dev-only and excluded from shipped application code. No explicit `vite` dependency; Vitest manages its dependency graph. Keep readable deep-equality diffs for future PR 6 tests. No jsdom, React testing library, browser runner, or coverage plugin for this PR. The test-runner decision is settled. |
| Existing ESLint rules plus lexical area rule | `local/pure-boundary` owns area containment; core/TypeScript ESLint rules own packages and syntax. The pure boundary does not use the import plugin; do not add `eslint-plugin-import` as a direct dependency. |

Enforce the Node 24 LTS line with `"engines": { "node": ">=24 <25" }` in `package.json` and `engine-strict=true` in `.npmrc`; `.nvmrc` contains `24` for tools that support it. README records exact Node/npm versions used and Windows selection instructions. [npm engine-strict](https://docs.npmjs.com/cli/v11/using-npm/config/#engine-strict).

Root `tsconfig.json`: strict, no emit, Next-supported module resolution/JSX settings, `@/*` mapped to `src/*` for application code, generated Next types included, and tests/tooling/config checked where TypeScript supports them. Include `tests/types/ids.typecheck.ts`; explicitly exclude `tests/types/pure-globals.typecheck.ts` because the root project has DOM/Node types. Do not import that globals file into root-checked modules. Do not enable build type-error suppression. The pure config remains independent, includes both compile-only files, uses relative imports only with no `paths`/`baseUrl`, and prevents framework ambient types leaking through inheritance. [TypeScript library selection](https://www.typescriptlang.org/tsconfig/lib.html) explains ECMAScript versus browser libraries.

Apply scoped overrides to **both** `src/domain/**/*.ts` and `src/recommendation/**/*.ts`. Domain may import only domain; recommendation may import only recommendation/domain. Pure files use relative imports only: reject `@/*` and every other alias, bare package specifier, and absolute path. The app may retain `@/*`. Type-only imports and re-exports receive the same package/path restrictions. An allowlist protects against SDKs added in later PRs. [ESLint restricted-import rule](https://eslint.org/docs/latest/rules/no-restricted-imports).

Use one lexical area rule and existing rules for all other restrictions:

| Concern | Configuration |
| --- | --- |
| Forbidden relative areas | `local/pure-boundary` for domain and recommendation, regardless of target existence. |
| Built-ins/packages/aliases | `no-restricted-imports` with a `patterns` entry using regex `^(?!\.\.?/)`, represented as `{ regex: '^(?!\\.\\.?/)' }` in the JavaScript config. Reject all non-relative imports, including Node built-ins (prefixed/unprefixed), React, Next, Supabase, unknown SDKs, `server-only`/`client-only`, aliases, and absolute paths. Use `regex`, not negated gitignore-style `group` globs; verify regex option support in the pinned ESLint version. |
| Dynamic imports | `no-restricted-syntax` selecting `ImportExpression`. |
| CommonJS/import-equals | `@typescript-eslint/no-require-imports`; no import-equals exemption. |
| Import-type expressions | `@typescript-eslint/consistent-type-imports` with `disallowTypeAnnotations: true` rejects `import('x').T`. |
| Framework directives | `no-restricted-syntax` selecting directive expressions for `'use client'` and `'use server'`. |
| ID-bypassing assertions | `@typescript-eslint/consistent-type-assertions` with `assertionStyle: 'never'`; retain explicit-`any` rejection. |
| Inline waivers | `linterOptions.noInlineConfig: true` scoped to pure files. |

`local/pure-boundary` is the sole owner of area containment for imports and re-exports. Convert `context.filename` to a POSIX path relative to the repo root: normalize filename/root separators and the Windows drive prefix consistently, compute the repo-relative filename, then resolve the relative specifier with `path.posix` from its directory. Compare path segments against permitted roots, not string prefixes, without filesystem lookup. Reject app/components/server/tests/tooling and any other area outside domain/recommendation; domain also rejects recommendation. Cover normalized traversal such as `../domain/../server/db/client`, even when the target does not exist. Boundary tests build every `filePath` from the actual repository root with `path.join`; on Windows these paths contain backslashes and a drive letter while remaining inside the real flat-config base path. Use the production configuration with no separate rule root option or ESLint `cwd` override. Every lint result, including allowed-import controls, must assert it was not ignored: reject any outside-base-path or file-ignored warning. Forbidden relative imports still require `local/pure-boundary`; missing-target errors never count as boundary evidence. Lint source/tests/config/tooling; ignore only generated/cache/dependency outputs. No symlinked pure source.

Brands establish compile-time identity separation, not runtime validation, UUID validity, source resolution, or security. A **single** `"abc" as MovieId` bypasses a string brand. Require `@typescript-eslint/consistent-type-assertions` with `assertionStyle: 'never'` in pure source, and test that exact single-assertion case produces that rule ID. PR 1 pure code has no reason to mint IDs. Validated construction/resolution belongs to later adapters under `src/server/`, outside pure source. Do not export a generic cast-any-string helper. Fixture construction in `tests/` may use assertions and is outside this scoped restriction. [Assertion rule options](https://typescript-eslint.io/rules/consistent-type-assertions/).

No `next.config` is needed with defaults; add one only if a documented PR 1 requirement emerges. No `.env.example` is needed because there are no environment variables to configure. Ignore `.next`, `node_modules`, coverage/cache output, `*.tsbuildinfo`, local `.env*` secrets, and generated `next-env.d.ts`. Current [Next.js TypeScript guidance](https://nextjs.org/docs/app/api-reference/config/typescript#next-envdts) recommends ignoring `next-env.d.ts` while including it in root type checking. Recheck the pinned version's guidance; `typecheck` generates types itself, without hand-authoring that file. No Tailwind, Prettier, Zod, ORM, SDK, UI kit, telemetry client, workspace manager, or CI dependency.

## 4. Ordered implementation steps

1. Recheck repository state and any new guidance. Preserve existing untracked documentation; review this plan against the consolidated architecture. Do not reset, commit, or push as part of this plan's execution without a separate instruction.
2. Select/pin compatible stable tool versions and Node/npm baseline. Manually add the minimal package/config files; avoid generator defaults that add fonts, assets, Tailwind, deployment files, or starter widgets.
3. Add layout, static placeholder page, and minimal local CSS. Confirm development startup before introducing any product behavior.
4. Add distinct ID brands, readonly movie identity, and the type-only recommendation entry point. Add synthetic fixture IDs and compile-only assignment checks; no scoring/schema scaffolding.
5. Add independent pure type checking, `local/pure-boundary` area containment, and scoped existing package/syntax rules. Verify regex support in the pinned ESLint version. Build all boundary test file paths with `path.join` from the actual repository root, exercising native Windows paths without a separate root option or ESLint `cwd` override. Assert every lint result was not ignored as outside the config base path or otherwise file-ignored. Test existing/nonexistent forbidden targets, traversal, re-exports, type-only/package/non-static imports, alias rejection, and single assertions with their specific rule IDs.
6. Configure Vitest to discover only `tests/foundation/pure-boundary.test.ts` in Node. Keep compile-only ID tests in root and pure type checking, outside runtime discovery. Add `tests/types/pure-globals.typecheck.ts` with one `@ts-expect-error` reference each for `window`, `document`, `process`, and `fetch`; include it only in the pure project and exclude it from root. No TypeScript compiler-API probe suite or temporary-directory handling.
7. Document commands, Node/npm versions, directory ownership, synthetic-data limitations, and deferred features in README. Review package/config changes for unnecessary additions.
8. Run the commands below, check development and production HTTP/browser behavior, and inspect the complete change set for scope and secrets. Require three watched-failure mutation runs, one change at a time: (a) collapse all four brands to plain `string` and confirm `npm run typecheck` fails on the expected ID `@ts-expect-error` lines; restore; (b) remove/disable the scoped pure-boundary lint configuration and confirm `npm test` fails on the boundary assertions; restore; (c) add `"DOM"` to the pure config's `lib` and confirm `npm run typecheck` fails on the globals file's now-unused directives for `window`, `document`, and `fetch`; restore. The `process` directive should remain valid in the DOM mutation. Record each red run's exact mutation, command, exit code, and expected failing lines/assertions; unrelated errors do not count. Restore all changes and require the aggregate checks to pass again. These are required future implementation exit evidence, not mutations to perform during this planning task.

## 5. Acceptance criteria and verification

All criteria must pass for PR 1 implementation acceptance.

| ID | Concrete criterion | Verification method |
| --- | --- | --- |
| AC1 | Clean dependency installation is reproducible on the recorded Node/npm versions with no credentials. | `npm ci` succeeds from the lockfile; no dependency/lock changes afterward. Network is allowed for package installation only. Inspect direct packages against section 3. |
| AC2 | Development server serves the placeholder at `/`. | Run dev command; localhost request returns HTTP 200; browser shows product name/tagline/status and no interactive choices. Separately confirm there are no hydration/runtime errors. Stop the process after smoke check. |
| AC3 | Production build and local production serving succeed. | `npm run build` exits 0; run start command, request `/` for HTTP 200, inspect browser/terminal, then stop. No build-error suppression. |
| AC4 | Strict application and pure type checks pass independently. | `npm run typecheck` exits 0; ID positive controls compile in both projects. `pure-globals.typecheck.ts` has one expected-error line each for `window`, `document`, `process`, and `fetch`, is included only by the pure project, and is excluded from root. Required DOM mutation produces unused-directive failures for browser globals; record the red run, restore, and recheck. |
| AC5 | Lint scans real source and exits cleanly with zero warnings. | `npm run lint` exits 0; config inspection and boundary tests demonstrate overrides apply to both domain and engine paths, with inline bypasses disabled. |
| AC6 | Actual forbidden engine/domain imports and assertion bypasses are rejected, including transitively through domain. | Tests use the actual flat config and engine/domain `filePath` values built with `path.join` from the actual repository root, yielding backslashes and a drive letter on Windows. No separate root option or ESLint `cwd` override. Every lint result, including positive controls, must have no outside-base-path or file-ignored warning. Every negative case asserts the specific expected `ruleId` from section 3, not merely failed lint. Forbidden relative imports/re-exports to existing or nonexistent targets must report exactly `local/pure-boundary`; built-ins/packages/aliases must report `no-restricted-imports`, never resolution errors. Cover static/type-only React, Next subpaths, Supabase, unknown SDKs, Node built-ins, server-only, rejected `@/*`, relative paths to app/components/server/tests/tooling, normalized traversal, import-type, require/import-equals, dynamic imports, framework directives, and a single `as MovieId`. Domain-to-server/recommendation fail; engine-to-domain and domain-to-domain pass. Disable/remove the scoped boundary config and watch `npm test` fail on expected assertions; record the red run, restore, and recheck. |
| AC7 | Internal and external/provider IDs cannot substitute for one another. | Compile-only positive assignments/calls compile. Test both directions for every distinct pair among `MovieId`, `StreamingProviderId`, `TmdbMovieId`, and `TmdbProviderId` (all six pairs), plus rejection of raw string/number inputs. Narrow `@ts-expect-error` directives cover each forbidden assignment/call; equal fixture text does not weaken the brands. Collapse all four brands to plain `string` and watch `npm run typecheck` fail with unused-directive diagnostics at the expected cross-brand/raw-string lines; record that red run, restore, and recheck. Raw-number negatives still fail with plain strings and their directives remain valid. |
| AC8 | Test runner executes meaningful foundation checks. | `npm test` discovers only `tests/foundation/pure-boundary.test.ts`, executes a nonzero number of cases, and exits 0 with no skipped/only tests or pass-with-no-tests option. Allowed-import controls pass; forbidden cases match specific rule IDs, not missing files/packages. Compile-only files run through `npm run typecheck`, never Vitest. Record AC6's config-removal red run. No starter-markup snapshots, arbitrary arithmetic tests, or compiler-API probes. |
| AC9 | Runtime checks need no secrets, external API, real catalog, or database. | Chosen option: source/config review plus browser DevTools network verification; no network-adapter disablement or Firewall rule is required. After `npm ci`, run typecheck/lint/test/build and localhost checks with no product credentials or local `.env` files, and telemetry disabled. Review tests/page/build configuration for provider/database/remote-font calls. During both AC2/AC3 smoke checks, DevTools Network (including WebSocket traffic) must show no non-localhost requests attributable to the app. Record the review and browser evidence; this proves the exercised flow and static dependency review, not OS-level egress isolation. |
| AC10 | Fixtures remain synthetic and outside production dependency graph. | Read fixture labels and values; no real titles, provider payloads, subscriptions, ratings, or personal preferences. Boundary tests reject importing fixtures into pure source; inspect app imports for test data leakage. |
| AC11 | Later PR functionality and speculative structures are absent. | Inspect full candidate file list/content against scope: no routes/API, migrations, SDKs, filtering/scoring, feedback/settings, CLI, PWA, hosting or CI. No empty dirs, `.gitkeep`, fake engine implementation, generic repositories, or speculative entities. Static home contains no browsing or extra decisions. |
| AC12 | No secrets or generated artifacts enter the proposed change set. | Review candidate files including hidden files and README/config; ignore patterns cover env/build/dependency output. With an unborn branch use status/file inventory rather than assuming HEAD exists; later use the actual PR diff. Preserve original docs and do not commit/push without separate authorization. |

## 6. Exact proposed validation commands

Define these exact package scripts during implementation:

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "typecheck": "next typegen && tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.pure.json",
  "lint": "eslint . --max-warnings=0",
  "test": "vitest run",
  "check": "npm run typecheck && npm run lint && npm test && npm run build"
}
```

`&&` above is package-script shell syntax (npm's script shell on Windows), not a PowerShell command chain. No separate build-integrated lint assumption. `tests/foundation/pure-boundary.test.ts` is the only runtime test file discovered by the normal test command. Both compile-only files are checked as specified in sections 2–5.

Run in PowerShell from the repository **after implementation**, with the recorded Node/npm installed:

```powershell
Set-Location -LiteralPath 'C:\Users\Reddk\Documents\Coding\brain-off-reel-on'
node --version
npm --version
$env:NEXT_TELEMETRY_DISABLED = '1'
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Stop on any nonzero native-command exit; individual exit codes and concise output are review evidence. `typecheck` generates ignored Next types before both compiler checks, so it works after a fresh install. Verify `next typegen` exists in the pinned Next version; record the alternative type-generation command in the plan if unavailable. Current [Next CLI guidance](https://nextjs.org/docs/app/api-reference/cli/next#next-typegen-options) documents it. `npm run check` is the equivalent aggregate after install; no need to repeat both sequences unless something changed.

Development smoke check, one terminal:

```powershell
$env:NEXT_TELEMETRY_DISABLED = '1'
npm run dev -- --hostname 127.0.0.1 --port 3000
```

After the server reports ready, in a second terminal:

```powershell
(Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing).StatusCode
```

Open that localhost URL in a browser, perform AC2's visual/console/network check, and stop the dev process with Ctrl+C. Production smoke check, after the successful build:

```powershell
$env:NEXT_TELEMETRY_DISABLED = '1'
npm run start -- --hostname 127.0.0.1 --port 3000
```

Repeat the exact HTTP command and AC3 browser check, then Ctrl+C. If port 3000 is occupied, use 3001 consistently and record the change; do not stop an unrelated process.

For focused boundary evidence when needed:

```powershell
npm test -- tests/foundation/pure-boundary.test.ts
git status --short --untracked-files=all
git diff --check
```

Required mutation commands (one temporary edit at a time, then restore): run `npm run typecheck` after collapsing the four brands; run `npm test` after removing/disabling the scoped boundary lint config; run `npm run typecheck` after adding `"DOM"` to pure `lib`. Require the specific red evidence in step 8, then restore and run `npm run check` to confirm the final green state. Record results in the implementation review evidence; do not automate mutations or add mutation tooling for this PR.

`git diff --check` does not examine untracked files: inspect their contents explicitly at this repository's current starting state. Do not stage/commit merely to make a diff command useful. HTTP success alone does not substitute for browser checks, and production build alone does not substitute for lint/tests/pure checking.

## 7. Risks and decisions before implementation

- **Import escape paths:** reject aliases with the non-relative regex; `local/pure-boundary` owns normalized area containment for all targets, including transitive domain restrictions. Verify Windows paths, specific rule IDs, and the config-removal red run.
- **False confidence from types:** brands can be deliberately cast and are erased at runtime. Production bypass assertions are prohibited; tests prove compile-time separation, while runtime parsing and provider resolution remain later work.
- **Configuration growth:** the independent pure project earns its place by detecting ambient DOM/Node leakage. Avoid additional projects/plugins unless a specific acceptance criterion cannot be met with the proposed setup.
- **Tool compatibility:** exact stable versions and peer ranges must be checked at implementation time. Resolve incompatibilities before proceeding; report any necessary extra dependency or architecture departure with its concrete reason. No installations occur during planning.
- **Unborn Git history:** there is no committed baseline for a normal HEAD diff. Preserve the existing documentation and review the full new-file inventory. Creating the first commit or publishing a PR requires a subsequent instruction.
- **Personal inputs:** subscriptions, runtime/language/content preferences, rated movies, and anchors do not block PR 1. Do not invent them; synthetic fixture values have no product meaning.

**Blocking decisions: none identified.** npm, Node 24 LTS, App Router, Vitest, the type-only engine entry point, and documented-but-uncreated future directories are reasonable foundation defaults. Implementation must follow the repository's review workflow; acceptance of this plan does not authorize infrastructure, later-PR scope, commits, or pushes. No departure from the consolidated architecture is required.
