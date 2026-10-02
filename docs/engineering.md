# Engineering standards and release gates

Brain Off, Reel On is being developed toward a production product that can be sold to users. Delivery proceeds through a personal pilot, a multi-user beta, and a commercial release. Each stage must earn the next through product evidence and operational readiness.

This document defines engineering expectations and release evidence. `docs/architecture.md` owns product behavior, architecture, and the feature roadmap; the current PR plan owns implementation details and exact acceptance commands. These standards do not expand PR 1 or authorize commits, infrastructure, spending, or deployment. Requirements below apply when their corresponding behavior is introduced. They describe work to verify, not controls already implemented.

## Code and architecture

- Write focused modules with explicit inputs, outputs, and ownership. Prefer readable names and straightforward control flow. Comment on constraints and reasons that code alone cannot explain.
- Keep domain and recommendation logic pure; keep framework, storage, provider, and other effects at integration boundaries. Enforce the documented dependency direction.
- Validate untrusted data at entry points. Preserve identity distinctions and represent expected empty, stale, unavailable, and error outcomes explicitly. Avoid broad exception handling that hides failures or silently changes product rules.
- Keep changes proportionate to current requirements. Introduce abstractions after a concrete need is established; record consequential architecture decisions and tradeoffs in the owning documentation.
- Review dependency compatibility, maintenance, security, and commercial license suitability. Keep a reproducible lockfile; do not bypass incompatibilities or make unrelated upgrades to clear a check.

## Tests and acceptance

- Specify acceptance criteria before implementation. Choose tests according to behavior and risk, not a universal coverage percentage.
- Unit tests cover pure behavior and edge cases. Integration tests cover real database constraints, authorization, transactions, and provider contracts as those features land. End-to-end tests cover critical customer journeys when those journeys exist.
- For a bug fix, add a regression test that demonstrates the defect and passes after the fix when practical. Explain when direct verification is more suitable.
- Test negative paths: malformed inputs, foreign-account access, missing/stale data, provider failure, retries, and duplicate requests where applicable. Include positive controls so denial-only tests cannot mask broken functionality.
- Keep routine tests deterministic and independent of production credentials and services. Clearly distinguish synthetic data, recorded provider fixtures, and separate live compatibility checks.
- Use isolated disposable test databases for database integration tests. Never run destructive tests against customer data. A mocked database does not prove database policies or constraints.
- Verify user-facing behavior on relevant devices and browsers. Automated tests supplement actual device checks required by the architecture; they do not establish usability or accessibility by themselves.
- Record commands, outcomes, and limitations. Restore validation mutations and require a clean final result. Investigate flaky tests; do not silently skip failures.

## Git, review, and CI

- Use a branch for each cohesive change once the repository baseline is established. Keep commits and PRs small enough to review and revert; avoid mixing features, broad formatting changes, and unrelated refactors.
- Before committing, inspect the staged diff and new-file inventory for unintended changes, secrets, and generated output. Stage intended files explicitly when other work is present.
- Write commit messages that explain the change. PR descriptions explain the problem, resulting behavior, validation, and material risks; include migration or rollout notes when applicable. A particular commit-message convention is optional unless the repository adopts one.
- Review the actual change set against scope and acceptance criteria. Prioritize correctness, regressions, security, and missing evidence; resolve findings and re-review material revisions. AI review is supporting evidence, not authorization to merge.
- Add CI in a separately scoped follow-up soon after the foundation. PR 1's existing CI exclusion remains intact. CI uses the same repository commands as local validation, installs from the lockfile, and checks types, lint, tests, and the production build. Add integration and end-to-end jobs as their features land.
- Before a deployed pilot, require CI on proposed merges. Protect the main branch with required checks and enforceable review settings supported by the repository's hosting plan. Document the actual approval process for a solo maintainer; do not treat AI comments as a second authorized GitHub reviewer.
- Keep CI permissions minimal and credentials isolated. Untrusted contributions must not gain production secrets. Do not weaken checks or bypass protections to merge a failing change.

## Release and operations

- Separate development, test, and production data and credentials. Define deployment configuration and secret rotation without embedding secrets in source, client bundles, logs, or test fixtures.
- Release a traceable, tested revision. Record the release, deployment outcome, and rollback procedure; prevent overlapping changes from making the deployed revision ambiguous.
- Review schema changes for compatibility and data loss. Test migrations on disposable representative data. Plan application rollback and database recovery separately; reverting code does not undo a destructive migration.
- Before relying on stored customer data, exercise backup restoration and document retention, access, and recovery steps. Record acceptable recovery time and data-loss targets for the release stage, with evidence that the procedure meets them.
- Provide bounded operations, useful error monitoring, redacted diagnostics, and checks for critical jobs. Define who responds to failures and how users can report problems. Investigate recurring failures rather than treating a successful deploy as operational success.
- Maintain dependencies and review security findings. Track unresolved risks with an owner and disposition; access-control failures, exposed credentials, and known data-loss defects block affected releases.

## Abuse and cost controls

These controls apply before exposing affected endpoints or enabling paid integrations. The owning PR plan defines exact thresholds, enforcement mechanisms, failure behavior, and verification evidence.

- Enforce server-side account/IP rate limits before expensive work, with shared enforcement across instances. Bound concurrent work and request size; reject excess requests without starting recommendation processing, changing product data, or calling providers. Client-side button disabling is only a usability aid.
- Set global usage budgets for costly operations in addition to per-user limits. Reserve capacity atomically across workers before starting paid work; count retries and background jobs, and stop new costly work when the budget is exhausted or cannot be enforced. Duplicate requests must not trigger duplicate chargeable work.
- Configure provider-enforced spending or usage caps where supported, plus usage monitoring and spending alerts with a named responder. Record which controls actually stop work and which only notify. Account for metering delays and document residual hosting/database costs; alerts and application quotas alone do not guarantee a maximum bill.
- Provide an authenticated operator shutoff for costly integrations and jobs, with a documented recovery procedure. Where request floods can still generate infrastructure charges, define and verify hosting/edge abuse protections and available provider cost controls before public exposure.
- Verify burst and sustained traffic, concurrent requests across instances, duplicate submissions, retries, enforcement outages, budget exhaustion, and shutoff behavior using synthetic traffic and provider stubs. Demonstrate that rejected requests do not start costly work, alerts reach the responder, and re-enabling service does not unleash an unbounded backlog. Record applicable evidence in release gates.

## Release gates

Each release review records the exact revision, environment, gate evidence, open findings, and user's release decision. Earlier gates continue to apply at later stages. Keep evidence with the owning PR or release notes rather than copying results into this document.

### Personal pilot

- Applicable architecture pre-trial requirements pass, including private access, account isolation checks, protected credentials, recovery, and actual phone verification.
- The agreed recommendation flow works without silently relaxing preferences. Product measurement follows the architecture and reports failed/abandoned attempts honestly.
- CI, review, deployment/rollback, and backup recovery procedures are demonstrated for the deployed system. Monitoring makes recommendation, availability, and refresh failures visible.
- Remaining limitations are documented before measured sessions. The personal pilot does not establish multi-user or commercial readiness.

### Multi-user beta

- Onboarding, login/logout, account recovery, and account lifecycle work for separate users. Tests cover endpoint and database isolation, private caches, guessed identifiers, and attempts to modify another user's records.
- Retention, export/deletion, and any shared-learning participation choices are implemented and verified as applicable. Personal histories and diagnostics remain private.
- Critical journeys are tested end to end. Keyboard, screen-reader, contrast, and mobile usability checks cover the shipped flow; document the accessibility target and evidence.
- Expected usage is stated and tested. Capacity, rate limits, provider quotas, operating costs, and failure recovery are measured sufficiently to support the beta size.
- Support and incident handling have a named owner. Beta limitations, user disclosures, and unresolved findings are explicit before additional users are admitted.

### Commercial release

- Product evidence supports the promised benefit; marketing claims stay within what evaluation demonstrated. Pricing and measured operating costs support the intended customer volume.
- Confirm commercial permissions and attribution obligations for movie data, artwork, availability data, dependencies, and hosting. Resolve restrictions before selling access.
- Complete the appropriate review of customer terms, privacy disclosures, retention/deletion behavior, and applicable market obligations. Record decisions and any required professional review.
- If charging users, verify purchase, entitlement, renewal, cancellation, and applicable refund flows, including webhook authenticity, duplicates, delayed events, and provider outages. Use an established payment provider; keep payment details out of application storage.
- Production security, accessibility, capacity, monitoring, recovery, support, and release procedures pass with evidence. Explicitly assess applicable controls using a verifiable standard such as OWASP ASVS; document any accepted residual risks.
- The user approves the commercial release against recorded evidence. Completing a roadmap or passing automated checks alone does not authorize launch.

## References

- [Google code-review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html): design, functionality, complexity, tests, naming, and documentation.
- [GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): review and required-check enforcement; availability depends on the hosting plan.
- [OWASP ASVS](https://owasp.org/projects/asvs): verifiable application security requirements.
