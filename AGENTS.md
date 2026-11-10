# APP-07 RetailPulse - Agent Instructions

This repository owns the RetailPulse backend. Before changes, read `~/Downloads/PORTFOLIO_COMPLETE_AGENT_PLAYBOOK.md` and `~/Downloads/APP-07_RETAILPULSE.md`; those are the full architecture, UX, security, and delivery requirements.

## Mandatory code quality
- Use supported Node.js LTS and keep handlers, application/domain logic, and repositories separated.
- Keep TS/JS/Java lines at or below 120 characters, except documented URLs, schemas, and generated code. Enforce with ESLint `max-len`, Prettier `printWidth`, or Java Checkstyle as applicable.
- Cognitive complexity is at most 15 per function. Control-flow nesting is at most 3 where feasible.
- Target at most 50 logical lines per function, 400 lines per source file except justified compositions/generated code, and 4 positional parameters. Prefer named parameter objects.
- No unused or duplicate code, unreachable branches, hard-coded credentials, production `console.log`, magic business constants, or circular dependencies.
- New-code gate: zero new blocker/critical issues, at most 3% duplication, all security hotspots reviewed, and no high-confidence leaked secrets. Verify actual Sonar rule/edition support; do not assume defaults match.

## Testing and CI
- Enforce at least 90% for each line, statement, function, and branch metric; at least 95% for critical domain logic and 90% changed-code coverage. Exclusions must be narrow, justified, and transparent.
- Test ingestion validation, aggregation correctness, authorization and ownership, input bounds, dependency failures, export permissions, and safe logs as applicable.
- CI must block on formatting, lint, syntax/typecheck, unit/integration/E2E, all four coverage thresholds, dependency and configured security/secret scans, migrations where present, and configured quality-gate failures. Report missing/skipped checks distinctly.

## Security, logging, and documentation
- RetailPulse currently has no identity or resource authorization and must remain loopback-only; CORS is not authorization. Do not claim the displayed synthetic analyst has a server identity or role. Add server-side authorization and negative ownership tests before external exposure.
- Validate filters and mutation inputs; use parameterized SQL, bounded bodies, deterministic ordering, transaction-safe updates, and spreadsheet-safe CSV output.
- Never log credentials, tokens, raw payloads, or identifying financial data. Use structured success/failure logs with request and trace IDs; verify redaction.
- Keep system design in canonical developer-facing `docs/architecture.md`, never product UI. Document actual C4/trust boundaries, data ownership, route/auth matrix, implemented use cases and recovery, existing design patterns/invariants, unavailable integrations, startup/configuration, tests/coverage, and known gaps.
- Sales are synthetic; no POS, identity, payment, carrier, or PortfolioOps integration is configured. README covers purpose, local setup, limits, and versioned integrations.
- Use synthetic records. Never claim security or compliance based only on checklists or automated scans.
