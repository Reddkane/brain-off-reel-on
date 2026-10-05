# Retained upgrade implementation and evidence

Baseline: `main` at `19a4ff50a2a8c4cdbf4e5dec19b62c48f4029351` (#8).
Branch: `feat/retained-upgrade`. Scope: [availability evidence section 9](availability-evidence.md#9-before-the-retained-live-gate).
No commit, push, PR, retained execution or provider network call was performed.

## Change set

| Files | Result |
| --- | --- |
| `src/server/db/migration-files.ts`, `tooling/metadata-disposable.ts` | One filename discovery implementation shared by production setup/upgrade and disposable replay. Remove the obsolete catalog-fixture upgrade workaround. |
| `scripts/catalog-schema.ts` | Recognize exactly the original 17-table, sweeps 23-table and evidence 28-table inventories. Check distinguishing retirement/retention columns, enabled trigger operation bindings and their application functions. Check migration database, marker, login and schema/relation ownership. |
| `scripts/catalog-local.ts`, `scripts/catalog-config.ts` | Setup applies every SQL migration in order. Guarded `upgrade` uses the fixed setup credential and loopback pool, shares the refresh advisory lock, applies only missing migrations and reports allowlisted errors. Inspection accepts only the current schema and reports `upgrade_required` for either recognized older state. A current upgrade reports `catalog_upgrade_current`; a successful change reports `catalog_upgrade_applied`. |
| `scripts/availability-live.ts` | Prepare the function a future authorized CLI live path can call: fixed credential readers, catalog pool/guard, real Watchmode/TMDB factories and transport, exclusive `evidence-report-<run-id>.json` files, repository-root cleanup and pool shutdown. Trusted test seams replace credentials, target, transport, clock and root. |
| `src/server/ingestion/availability-sweeps.ts`, `src/server/providers/sweep-error.ts` | Execute supplied private-file cleanup immediately after lock acquisition, before even the Watchmode quota request. Cleanup failure reports `private_cleanup_failed` and prevents provider requests. Completed cleanup counts remain in the run report. |
| `tests/db/catalog.test.ts`, `tests/db/availability-live.test.ts`, `package.json` | Extend the existing shared catalog command; include the operator composition suite in `test:availability:evidence:db`, already invoked by CI. |
| `tooling/retained-upgrade-mutations.ts` | Reproducible, isolated controls; normalize mutation anchors for CRLF and restore original source bytes in `finally`. |
| `README.md`, this document | Document the separately authorized upgrade action and map acceptance evidence to section 9. |

`scripts/availability-sweeps.ts`, merged migrations and dependency versions/lockfile
are unchanged. The CLI's `--live` refusal is byte-for-byte unchanged.

## Acceptance evidence mapped to section 9

| Section 9 acceptance | Evidence |
| --- | --- |
| Fresh setup reaches the full schema | Actual `setupSchema` on an inspected test-owned catalog; compare the complete table inventory and run current-schema inspection. No manually applied upgrade workaround remains. |
| Original three-migration and sweeps four-migration upgrades | Rebuild each baseline only inside the disposable catalog, seed invented movie/mapping data, prove importer refusal and zero provider calls before upgrade, apply missing migrations, inspect the full schema, verify the sole backfill acquisition is `tmdb_metadata` at `2026-09-01T12:00:00Z`, prove repeat no-op and successful synthetic import afterwards. |
| Unknown schema refusal | Add one unexpected application table to each baseline; upgrade refuses with `upgrade_state_unknown` before migration work. Remove only the test-owned table. |
| Per-migration atomicity | A test-owned event trigger deliberately fails the evidence migration after its initial index DDL. The previously committed sweeps schema remains complete, the partial index is absent, seeded movie data survives, and the error is exactly `upgrade_failed_inspect_required`. Removing the injected failure allows the remaining migration to complete. |
| Guarded operator action | The existing operator lifecycle test runs `localCommand("upgrade", ...)` using its own inspected container/network/volume and synthetic credential directory; current schema returns `{ applied: 0, current: true }`. Existing runtime marker/login/database refusal and lifecycle tests remain green. |
| Cleanup before providers, within the refresh lock | Drive `liveSweepComposition` with the real provider factories, a fake transport, guarded disposable PostgreSQL and a temporary test-owned root. Seed one expired and one current file in each of all three inventory directories. Before the first transport call, all expired files are absent and all current files remain; an independent SQL connection proves the refresh lock is held. |
| Report and cleanup failure | The exclusive report and returned summary both contain `{ inspected: 6, deleted: 3, bounded: false }`. Malformed synthetic cleanup input reports `private_cleanup_failed`, exit 1 and zero provider calls. Composition-owned pools close and exact temporary-root and Docker teardown are verified. |
| State and ordering mutation controls | Bypass state recognition so migrations replay on current schema: exit 1, 23 tests, 6 pass / 17 fail. Move cleanup after the first provider request: exit 1, 3 tests, 0 pass / 3 fail. Both controls are restored before final green. |

Fresh-setup regression was observed failing because the evidence acquisition table
was missing. The operator cleanup tests were observed failing before the ordering
fix (22 tests in the shared evidence command: 19 pass / 3 fail). The mutation
controls independently demonstrate current-schema replay and provider-order failures.

One intermediate catalog run timed out because nested tests used their parent's
context; it ended with 6 pass / 3 cancelled, exit 1, and verified exact teardown.
The corrected nested contexts pass. The first cleanup control attempt left its
original block in place because of CRLF; the control runner rejected that green
result. Normalized anchors now execute the actual move and produce the red counts
above. Neither unsuccessful attempt is counted as acceptance evidence.

## Final shared validation

Counts include Node's parent/subtest counts where applicable. Database SQL notices
are assertion executions, not unique test cases. The review follow-up reran
`check` and `test:catalog:db`; other command rows retain the original section 9
validation evidence.

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm run check` | 0 | Typecheck, zero-warning lint, 316 offline tests (13 files), production build. |
| `npm run test:db` | 0 | 11 runner tests; 1,743 SQL PASS assertions in each of three green phases; 12 expected-red SQL controls; fresh replay and exact teardown. |
| `npm run test:metadata:db` | 0 | 22 tests per fresh cycle, two cycles (44 executions), all pass; exact teardown. |
| `npm run test:catalog:db` | 0 | 24 tests, all pass, including direct upgrades from both baselines and the separate migration-failure test; exact teardown. |
| `npm run test:availability:sweeps:db` | 0 | 43 tests, all pass; exact teardown. |
| `npm run test:availability:evidence:db` | 0 | 22 tests, all pass, including 3 operator parent/subtests; exact teardown. |
| `node tooling/retained-upgrade-mutations.ts` | 0 | Both expected-red child commands exit 1 with the counts above; original sources restored. |

Synthetic validation logs and mutation logs are under `.cache/` (including
`.cache/retained-upgrade/`). The complete tracked plus new-file review patch is
`.cache/retained-upgrade.patch`; it excludes unrelated `.claude/` work and generated
output. No files are staged.

## Limits and review

The schema detector recognizes the three released inventories and their
specified distinguishing bindings; it is not a complete schema checksum or a
migration ledger. A new schema version needs a deliberate detector update;
the migration-count test now flags a discovered migration beyond the detector's
current known count with an explicit update-detection message.
Docker publishes loopback to the container's bridge address, so the upgrade
checks the client's explicit loopback connection configuration, not the server's
internal network address.

Operator tests use invented credentials and a fake transport. Their first provider
response is deliberately 401 after the deletion/lock assertions; successful
provider ingestion remains covered by existing synthetic sweeps/evidence suites.
No production credential reader was executed by these operator tests. No retained
upgrade, retained cleanup, live-provider compatibility or runtime benchmark is
claimed. The separately authorized retained live gate remains closed, including
its existing private verification-file deletion deadline.

Reviewed the complete tracked and new-file changes against section 9, including
migration discovery, state refusal, transaction rollback, credential paths,
provider ordering, report inventory, pool shutdown and exact teardown. Focused
review approved the implementation subject to the diagnostic correction below;
the amended diagnostic passed the final check on October 5, 2026.

## Review follow-up: upgrade diagnostic and detector maintenance

The reviewer identified that `setup_incomplete` could direct an operator toward
failed-fresh-setup disposal for a valid retained catalog that only needs upgrading.
`completedSetup` now emits allowlisted `upgrade_required` for the recognized
three- and four-migration states. Unknown states retain their existing refusal;
current-schema validation remains required. The README says to preserve data and
obtain separate upgrade authorization for this code.

The existing baseline test asserts the exact `upgrade_required` error for both
older states. Before the fix it failed on both with `setup_incomplete` (shared
command exit 1, 24 tests, 20 pass / 4 fail including parent tests). After the fix,
`npm run test:catalog:db` exits 0 with 24/24, including verified exact teardown.
`npm run check` exits 0 with 316/316 offline tests, typecheck, lint and build.

The added standalone test compares the detector's exported current migration
count, used for its current-state result, with shared filename discovery. A
synthetic sixth migration file made that test fail with exit 1, 0/1 pass and the
explicit message to update `catalogSchemaState` detection and
`currentMigrationCount`. The file was removed in `finally`, then the same focused
test passed with exit 0, 1/1. No temporary migration was applied and no merged
migration was edited. The original two mutation-control counts above refer to
the initial implementation validation, before this additional test.

The complete review patch was regenerated after these amendments. Retained
resources, retained private files, `.claude/`, dependencies and the live refusal
remain untouched; no commit, push or PR was performed.
