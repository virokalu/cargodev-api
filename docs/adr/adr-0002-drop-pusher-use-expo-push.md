# ADR 0002: Drop Pusher; mobile gets Expo push and reads missed items over REST

- Status: **Accepted**
- Date: 2026-10-24

## Context

The CargoDev web app delivers live in-app notifications through a hosted realtime service
(Pusher) and mobile push through Expo. The mobile app never used the realtime service: it relies
on Expo push plus the REST endpoints. This API has no reason to depend on a third-party realtime
vendor, and each vendor adds a secret, a dependency and a channel-authorisation endpoint to secure.

## Decision

- No Pusher in this API: no dependency, no env variables, no channel-auth endpoint.
- Notifications are still written to the database inside the mutating transaction (`emit`).
- After commit, mobile devices are notified through Expo push (`expo-server-sdk`). A delivery
  failure never fails the mutation.
- Clients read anything they missed through `GET /notifications` and
  `GET /notifications/unread-count`. The database is the source of truth.
- Live in-app streaming is **deferred**. If it is added later it will be served by this API, not
  by a vendor. See ADR 0003 for that design.

## Consequences

Good:
- One fewer vendor, secret and dependency. Smaller attack surface.
- Behaviour is simple to reason about and test: write, then push, then catch up over REST.

Costs:
- Without a live stream, an open app only sees new notifications when it polls or receives a push.
- The CargoDev web app keeps its own realtime channel until it is moved onto this API.

## Alternatives considered

- Keep Pusher for parity with the web app (more moving parts, another secret to protect).
- Build a live stream immediately (done separately, see ADR 0003).
