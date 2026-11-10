# RetailPulse Backend

Node.js API for the RetailPulse analytics workspace. This repository owns HTTP validation, report calculations, SQLite persistence, alert updates, synthetic sales ingestion, exports, and structured request logging. The React frontend is a separate repository.

## Run and Verify

Requires Node.js 22.13 or later. From this repository:

```sh
npm ci
npm run dev
```

The API binds to `127.0.0.1:5702`. `GET /api/v1/health` is the readiness endpoint. The frontend on port 5701 calls versioned `/api/v1` routes. `RETAILPULSE_DB_PATH` selects the local SQLite file; by default it is `data/retailpulse.sqlite` under this repository.

```sh
npm run format:check
npm run lint
npm run check
npm test
npm run test:cov
npm audit
```

Backend tests use in-memory SQLite. `npm run test:cov` enforces 90% line,
statement, function, and branch coverage for the HTTP API, route handlers,
content-model validation, query, calculation, seed, and repository modules.
The `main.mjs` process bootstrap is excluded. No GitHub Actions workflow,
SAST, or secret-history scan existed before this upgrade; CI now runs the
formatting, lint, syntax, unit/coverage, and dependency-audit gates.
The API persists only synthetic records and returns filtered CSV reports. Do
not connect real point-of-sale data.

## Security and Limitations

The API applies an explicit local origin allowlist and validates request parameters, but it does not authenticate users or enforce role/resource authorization. Keep it on loopback; add identity, server-side authorization, TLS, and managed credentials before external exposure. Request logs contain safe route/status/timing fields, not request payloads.

Canonical architecture, data ownership, workflows, and deployment boundary: [../docs/architecture.md](../docs/architecture.md).
