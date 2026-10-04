# Agent guidance: Brain Off, Reel On

## Before changing code

- Read `README.md`, `docs/architecture.md`, `docs/engineering.md`, the current work's implementation plan, and applicable nested `AGENTS.md` files.
- Keep product rules, directory ownership, tool versions, commands, and PR acceptance details in their owning documents rather than duplicating them here.
- Follow the user's current instructions. Explain concrete conflicts between the architecture and plan before making a material departure; resolve routine choices autonomously.
- Inspect the actual repository state. Preserve existing edits and untracked work; never assume a clean tree or committed baseline.
- Implement the authorized scope. A roadmap describes future work; it does not authorize it.

## Engineering principles

- Keep domain logic and recommendation logic pure and independent of UI frameworks, storage, providers, and other effects. Supply time and context explicitly when needed.
- Keep integration effects and application composition outside the pure dependency graph. Enforce boundaries with meaningful automated checks.
- Preserve distinctions between internal and external identities. Compile-time types do not replace runtime validation or authorization.
- Keep production imports independent of tests and fixtures. Label synthetic data clearly and never invent real personal preferences or credentials.
- Prefer small, explicit implementations. Add dependencies, directories, and abstractions only when the current task needs them.

## Validation and security

- Keep local and CI validation aligned through shared repository commands. Do not weaken checks or skip failing tests to obtain a passing result.

- Run the checks required by the current plan and affected behavior. Verify the actual configuration and execution paths, not only examples that mirror the implementation.
- Keep pure tests independent of live services and credentials. Verify user-facing behavior directly when relevant.
- Treat external inputs as untrusted. Protect secrets and personal data; enforce authorization at effect boundaries.
- Never print or expose secrets from `.env.local` or other credential files in chat, tool output, logs, diffs, or commits. Do not dump credential files or run commands that echo secret values, including environment-variable dumps. Validate credentials without displaying them; report only presence and success/failure. Use placeholders in examples.
- Keep installs reproducible and review dependency changes. Exclude secrets and generated output from proposed changes.
- Report checks and their evidence accurately, including failures and anything unverified. Restore temporary validation mutations before handoff.

## Review and handoff

- Review the actual change set against the agreed scope and acceptance criteria. Prioritize correctness, regressions, security, and missing validation; support findings with concrete evidence. Passing checks do not replace code review.

- Provide the actual change set, acceptance criteria, and validation evidence for review. Include new files that ordinary diffs may omit.
- Address review findings, rerun affected checks, and obtain re-review when required by the agreed workflow.
- Update the owning documentation when behavior or setup changes. Explain necessary deviations and unresolved issues concisely.
- Do not commit, push, open or merge a PR, provision infrastructure, spend money, or deploy without user authorization. Authorization already given in the conversation remains valid within its scope.
