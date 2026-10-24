// Event bus: how the rest of the server tells connected clients something happened.
//
// Callers (the notification service) only know the EventBus interface. Today it is
// in memory, which is correct for ONE running instance. With several instances an
// event published on one would not reach streams connected to another; a Postgres
// LISTEN/NOTIFY implementation of this same interface can replace it without
// touching callers (it needs a direct, non-pooled connection, so it is not built yet).
//
// Rules for callers:
//  - Publish AFTER the database transaction has committed, never inside it.
//  - Publishing is best effort. It never throws and never blocks the caller; a failing
//    subscriber cannot affect the publisher or other subscribers. The database is the
//    truth, so a missed event is recovered by reading GET /notifications.

import { safeError } from "./redact.js";

export interface AppEvent {
  /** Event name, e.g. "notification". Becomes the SSE `event:` field. */
  type: string;
  orgId: string;
  /** The one user this event is for. */
  userId: string;
  /** Plain data only. Streams whitelist the fields they forward. */
  payload: unknown;
  /** Unique id (the SSE `id:` field). */
  id: string;
}

export type EventHandler = (event: AppEvent) => void;

export interface EventBus {
  publish(event: AppEvent): void;
  /** Returns an unsubscribe function. Delivery is scoped to BOTH userId and orgId. */
  subscribe(userId: string, orgId: string, handler: EventHandler): () => void;
}

export class InMemoryEventBus implements EventBus {
  // Keyed by org then user, so a user id from one org can never receive another org's events.
  private readonly handlers = new Map<string, Set<EventHandler>>();

  private static key(userId: string, orgId: string): string {
    return `${orgId}\u0000${userId}`;
  }

  subscribe(userId: string, orgId: string, handler: EventHandler): () => void {
    const key = InMemoryEventBus.key(userId, orgId);
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    // Wrap so subscribing the same function twice gives two independent subscriptions.
    const entry: EventHandler = (event) => handler(event);
    set.add(entry);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.handlers.get(key);
      current?.delete(entry);
      if (current && current.size === 0) this.handlers.delete(key);
    };
  }

  publish(event: AppEvent): void {
    try {
      const set = this.handlers.get(InMemoryEventBus.key(event.userId, event.orgId));
      if (!set || set.size === 0) return;
      // Snapshot: a handler that unsubscribes (or subscribes) while we deliver must not disturb the loop.
      const targets = [...set];
      // Deliver on a later microtask so publish() returns immediately and a slow or
      // throwing handler can never stall the request that triggered the event.
      queueMicrotask(() => {
        for (const handler of targets) {
          try {
            handler(event);
          } catch (error) {
            console.error("event handler failed", safeError(error));
          }
        }
      });
    } catch (error) {
      console.error("event publish failed", safeError(error));
    }
  }

  /** Number of live subscriptions. For tests and diagnostics. */
  subscriberCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
}

let current: EventBus = new InMemoryEventBus();

export function getEventBus(): EventBus {
  return current;
}

/** Swap the implementation (tests, or a future LISTEN/NOTIFY bus). */
export function setEventBus(bus: EventBus): void {
  current = bus;
}
