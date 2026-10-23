# ADR 0001: Standalone Node API instead of extending the Next.js app

- Status: **Proposed** (owner to confirm before the team builds on it)
- Date: 2026-10-23

## Context

CargoDev is a Next.js app whose business logic already lives in framework-free `lib/services/*`.
The earlier agreed plan was to add `/api/customer/v1/*` and `/api/public/*` inside that same app.
Other clients (staff mobile app, future customer app, new staff screens) need an HTTP API, and
today almost every mutation exists only as a Next Server Action.

## Decision

Build a standalone Node.js (TypeScript, Fastify) API that ports the services and exposes them as REST,
reusing the same database schema unchanged.

## Consequences

Good:
- Clients are not coupled to Next.js; the API can be deployed and scaled independently.
- Long-lived process makes cron, realtime and background work simpler than serverless.
- A public repo and separate team can work on it with clear boundaries.

Costs:
- A second service to host, monitor and secure.
- Ported code can drift from the Next app's services. Mitigation: acceptance test comparing responses with the Next app, and a plan for which codebase owns each service long term.
- Schema is owned by the CargoDev repo; this repo must never run migrations.

## Alternatives considered

- Add routes inside the existing Next.js app (simpler, one deploy, less duplication).

## Follow-ups

- Confirm this decision, then change Status to Accepted.
- Update `design/cargodev-final-system-design.md` to match.
- Decide the long-term ownership of shared services to avoid two diverging copies.
