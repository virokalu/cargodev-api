# Architecture

## Layers

```
HTTP request
   |
routes/      thin: auth -> zod parse -> call service -> shape response
   |
services/    all business logic, framework-free, throws ServiceError
   |
Prisma       data access (PostgreSQL), always scoped by orgId
```

## Folder map

```
src/
  config/env.ts          validated environment (fails fast at startup)
  lib/errors.ts          ServiceError + error codes + HTTP status map
  lib/response.ts        { data } / { error } envelope helpers
  lib/error-handler.ts   one place turning any error into the envelope
  routes/                one file per resource (health, auth, vehicles, ...)
  services/              business logic (ported from CargoDev)
  app.ts                 builds the Fastify app (does not listen)
  server.ts              loads env, builds app, listens
```

`app.ts` builds, `server.ts` starts. Tests import `buildApp()` and use `app.inject()` with no open port.

## Request lifecycle

1. `onRequest` hook sets `Cache-Control: no-store`.
2. Auth hook verifies the access token and attaches `{ id, role, orgId, name, email }`.
3. Role allow-list for the route is checked (403 if not allowed).
4. Route parses input with zod.
5. Route calls a service with the user and parsed input.
6. Service runs the transaction: query (scoped by `orgId`), mutate, write `ActivityLog`.
7. Route returns `{ data }`. Any thrown error goes to the central handler.

## Key design choices

- Services are framework-free so they can be shared/ported and tested without HTTP.
- `orgId` always comes from the token, so a client cannot choose another tenant.
- The schema is owned by the CargoDev repo; this service stays schema-compatible and only runs `prisma generate`.
- File URL generation is isolated behind one function so signed URLs can replace public ones later.
