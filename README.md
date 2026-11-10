# RetailPulse Backend

[Architecture guide](docs/architecture.md) — source map, workflows, contracts, data, security, and checks.

## Repository layout and deployment boundary

This independent repository owns RetailPulse's Node.js ESM API and authoritative SQLite state. The UI is the separate [retailpulse-frontend](https://github.com/gopichand-retail-apps/retailpulse-frontend) repository. Keep the current directory names, Git histories, origins, and independent builds.

The Vercel configuration belongs to the frontend only. This API has no verified Vercel deployment adapter. The local file database is not shared durable storage for stateless function instances. Do not deploy the local simulator as a public API or point it at real records.

Use Node **24.15.0**, npm, and the committed package-lock.json. From the full Retail Apps workspace, `./scripts/Start-Apps.ps1 -App RetailPulse` uses the correct built/native entry after setup. With the required sibling frontend available, install with `npm.cmd ci` and start with `npm.cmd start`; no API build is needed.

Health: http://127.0.0.1:5702/api/v1/health. Direct startup stores data under `data/retailpulse.sqlite`; the workspace launcher can select a separate app-owned path. The [implemented API routes](src/api-routes.mjs) and [canonical architecture](docs/architecture.md) describe the existing routes and trust boundaries. No standalone OpenAPI file is configured. The architecture guide is inside this repository.

The API reads its seed/content contract from the adjacent frontend at `../retailpulse-frontend/public/retailpulse-model.json`. Clone both repositories as siblings before starting it; this existing file dependency is not a network integration. Backend configuration is read from process environment variables; creating a .env file alone does not load it.

Known release gaps: No authentication or authorization: keep the API loopback-only. Four formatting failures and desktop-to-320px Products overflow remain in the baseline; fresh mobile viewports pass.

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

Canonical architecture, data ownership, workflows, and deployment boundary: [../docs/architecture.md](docs/architecture.md).
