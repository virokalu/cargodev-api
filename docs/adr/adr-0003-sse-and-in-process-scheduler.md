# ADR 0003: SSE and an in-process scheduler instead of Pusher and external cron

- Status: **Accepted**
- Date: 2026-10-24
- Builds on ADR 0002 (which dropped Pusher and deferred live streaming).

## Context

This API is a long-lived Node process, so it can do two jobs that a serverless app outsources:
push live updates to open clients, and run scheduled work. The Next.js app uses a hosted realtime
vendor and a hosted cron ping for these. Each adds a secret, a dependency or a public endpoint to
protect, and the cron ping needs a shared secret anyone could leak.

## Decision

1. **Live notifications over Server-Sent Events** at `GET /notifications/stream`, fed by a small
   `EventBus` interface. Callers (the notification service) publish only after the database
   transaction commits and only know the interface. The implementation today is in memory.
2. **An in-process scheduler** built on `setTimeout`, with no scheduling library. The daily job
   (default 02:00 UTC) runs for every org, is idempotent, and is guarded by an in-process flag plus a
   Postgres advisory lock taken with `pg_try_advisory_xact_lock` inside one transaction.
   A missed run is recovered on startup (if today's time has passed, run once), without a new table.
3. **No shared-secret endpoint.** The manual trigger is `POST /admin/jobs/daily-checks`, ADMINISTRATOR
   only, normal bearer auth, and every call is written to the activity log with who made it.

The database stays the source of truth. The stream has no replay: clients call `GET /notifications`
after reconnecting.

## Consequences

Good:
- No vendor, no cron secret, nothing extra to host. Less surface to secure.
- Streams end when the access token expires, so a deactivated user cannot keep listening.
- Scheduling and locking are plain, testable code (fake timers, no real waiting).

Costs and limits:
- **Single instance for events.** The in-memory bus does not span processes. For several instances,
  replace it with Postgres LISTEN/NOTIFY, which needs a direct (non-pooled) connection. The interface
  is shaped so callers do not change. Not built.
- **The lock only stops concurrent runs.** Two instances running one after the other (a deploy overlap)
  rely on the job being idempotent.
- **Long-lived connections** need a host that allows them, a reverse proxy that does not buffer
  (`X-Accel-Buffering: no` is sent) and a hop count set correctly (`TRUST_PROXY_HOPS`).
- **A held advisory-lock transaction** keeps one database connection busy for the length of the run
  (bounded by a 30 minute timeout), so the job body must work in short batches of its own.

## Alternatives considered

- WebSockets: bidirectional, but we only push one way, and it needs an extra dependency.
- A scheduling library (for example a cron-expression package): not needed for one daily job; avoids a dependency.
- A database table recording the last run: would be a schema change in a repo that does not own the schema.
- A session-level advisory lock on a dedicated connection: unsafe through a transaction pooler.

## Follow-ups

- Port `reminder.service` and `vehicle.service`'s shipped-transition, then register the daily job
  (`scheduler/index.ts`). Until then no job is registered and the admin trigger answers 404.
- Turn off the Next.js app's own copies of these jobs before enabling this scheduler (duplicate reminders).
