# cargodev-api

Standalone Node.js (TypeScript) HTTP API for the CargoDev vehicle import management system.
It reproduces the behaviour of the existing CargoDev backend so other clients (staff mobile
app, future customer app) can use it without Next.js.

> Status: early development. See `docs/adr/0001-standalone-node-service.md` for why this exists.

## Stack

Node 20+, TypeScript (strict), Fastify, zod, jose (JWT), bcryptjs, Prisma + `@prisma/adapter-pg`,
Vitest + supertest.

## Quick start (Windows / PowerShell)

```powershell
git clone <repo-url>
cd cargodev-api
npm install
Copy-Item .env.example .env   # then fill in your OWN dev values
npm run dev
```

Check it works:

```powershell
Invoke-RestMethod http://localhost:4000/health
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm run build` | Compile to `dist/` |
| `npm run typecheck` | Type-check only |
| `npm test` | Run tests once |

## Rules you must know

- Use a **separate dev database**. Never point this project at production.
- **Never run `prisma migrate`** in this repo. The schema is owned by the CargoDev repo.
- Never commit `.env` or any real secret. See `SECURITY.md`.
- Read `CLAUDE.md` (project rules) and `CONTRIBUTING.md` (workflow) before your first PR.

## Docs

- `docs/architecture.md` – layers and request lifecycle
- `docs/security-model.md` – threats and the tests that prove each defence
- `docs/api-contract.md` – envelope, error codes, endpoints
- `docs/env.md` – environment variables
- `docs/testing.md` – what every route must test
- `docs/runbook.md` – operational procedures (no live hostnames here)
- `docs/adr/` – architecture decision records

## License

Not yet decided. Until a license is added, all rights are reserved.
