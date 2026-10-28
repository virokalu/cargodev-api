// Server-Sent Events hub: owns every open notification stream on this instance.
//
// The stream is a convenience, not the source of truth. There is no replay: a client
// that reconnects calls GET /notifications to catch up on anything it missed.
//
// Guarantees:
//  - A connection only ever receives events published for its own userId AND orgId
//    (the bus enforces it; the hub never subscribes on anyone else's behalf).
//  - Only whitelisted event types and fields leave the server, never raw rows.
//  - A connection ends when its access token expires (after an `event: reauth`), so a
//    revoked or deactivated user cannot keep listening on an old connection.
//  - At most `maxPerUser` streams per user (the oldest is closed for a new one) and
//    `maxConnections` overall.
//  - Every timer and subscription is released when a connection ends, however it ends.

import { getEventBus, type AppEvent, type EventBus } from "./events.js";
import { safeError } from "./redact.js";

/** The slice of a Node ServerResponse the hub needs. Lets tests use a fake. */
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  readonly writableLength: number;
}

export interface SseHubOptions {
  maxConnections: number;
  maxPerUser?: number;
  heartbeatMs?: number;
  /** A connection with more than this many unsent bytes is a stuck client and is dropped. */
  maxBufferedBytes?: number;
  now?: () => number;
  bus?: () => EventBus;
}

export interface OpenOptions {
  userId: string;
  orgId: string;
  sink: SseSink;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

export interface SseConnection {
  readonly userId: string;
  readonly orgId: string;
  /** Ends the connection, optionally sending a final event first. Safe to call repeatedly. */
  close(finalEvent?: { event: string; data: unknown }): void;
  /** The underlying socket went away: clean up without writing. */
  dispose(): void;
}

/** Event types that may be streamed. Anything else published on the bus is ignored. */
const STREAMABLE_TYPES = new Set(["notification", "message"]);

/** Strips line breaks so a value can never inject extra SSE fields. */
function field(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, " ");
}

export function formatSseEvent(event: { id?: string; event: string; data: unknown }): string {
  return `${event.id !== undefined ? `id: ${field(event.id)}\n` : ""}event: ${field(event.event)}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** The wire shape of a notification event: explicit fields only. */
function toWireData(event: AppEvent): unknown | null {
  if (event.type !== "notification" && event.type !== "message") return null;
  const p = event.payload;
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  // A chat message event says THAT something arrived (the client fetches the text): ids and sender type only.
  if (event.type === "message") {
    return {
      conversationId: str(o["conversationId"]),
      messageId: str(o["messageId"]),
      senderType: o["senderType"] === "STAFF" ? "STAFF" : "CUSTOMER",
      createdAt: str(o["createdAt"]),
    };
  }
  return {
    id: str(o["id"]),
    event: str(o["event"]),
    title: str(o["title"]),
    body: str(o["body"]),
    vehicleId: str(o["vehicleId"]),
    createdAt: str(o["createdAt"]),
  };
}

export class SseHub {
  private readonly connections = new Set<SseConnection>();
  private readonly byUser = new Map<string, SseConnection[]>();

  private readonly maxPerUser: number;
  private readonly heartbeatMs: number;
  private readonly maxBufferedBytes: number;
  private readonly now: () => number;
  private readonly bus: () => EventBus;

  constructor(private readonly options: SseHubOptions) {
    this.maxPerUser = options.maxPerUser ?? 3;
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
    this.now = options.now ?? Date.now;
    this.bus = options.bus ?? getEventBus;
  }

  /** Open connections on this instance. */
  get size(): number {
    return this.connections.size;
  }

  /** False once the instance-wide cap is reached. */
  hasCapacity(): boolean {
    return this.connections.size < this.options.maxConnections;
  }

  private static userKey(orgId: string, userId: string): string {
    return `${orgId}\u0000${userId}`;
  }

  open(opts: OpenOptions): SseConnection {
    const { userId, orgId, sink } = opts;
    const key = SseHub.userKey(orgId, userId);

    // Make room: a user may hold at most maxPerUser streams, the oldest goes first.
    const existing = this.byUser.get(key) ?? [];
    while (existing.length >= this.maxPerUser) {
      const oldest = existing[0];
      if (!oldest) break;
      // close() releases the connection, which removes it from `existing`.
      oldest.close({ event: "closed", data: { reason: "replaced" } });
      if (existing[0] === oldest) existing.shift(); // defensive: never loop forever
    }

    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;

    const release = () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      unsubscribe?.();
      this.connections.delete(connection);
      const list = this.byUser.get(key);
      if (list) {
        const i = list.indexOf(connection);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.byUser.delete(key);
      }
    };

    const send = (text: string): boolean => {
      if (closed) return false;
      try {
        sink.write(text);
        if (sink.writableLength > this.maxBufferedBytes) {
          // The client is not reading. Drop it instead of buffering without bound.
          connection.dispose();
          try {
            sink.end();
          } catch {
            /* already gone */
          }
          return false;
        }
        return true;
      } catch {
        connection.dispose();
        return false;
      }
    };

    const connection: SseConnection = {
      userId,
      orgId,
      close: (finalEvent) => {
        if (closed) return;
        if (finalEvent) send(formatSseEvent(finalEvent));
        release();
        try {
          sink.end();
        } catch {
          /* already gone */
        }
      },
      dispose: () => {
        if (closed) return;
        release();
      },
    };

    this.connections.add(connection);
    existing.push(connection);
    this.byUser.set(key, existing);

    unsubscribe = this.bus().subscribe(userId, orgId, (event) => {
      const data = toWireData(event);
      if (data === null || !STREAMABLE_TYPES.has(event.type)) return;
      send(formatSseEvent({ id: event.id, event: event.type, data }));
    });

    heartbeat = setInterval(() => {
      send(": ping\n\n");
    }, this.heartbeatMs);
    heartbeat.unref();

    const msLeft = Math.max(0, opts.expiresAt - this.now());
    expiry = setTimeout(() => {
      connection.close({ event: "reauth", data: { reason: "token_expired" } });
    }, msLeft);
    expiry.unref();

    return connection;
  }

  /** Graceful shutdown: tell every client, then end every stream. */
  closeAll(): void {
    for (const connection of [...this.connections]) {
      try {
        connection.close({ event: "shutdown", data: { reason: "server_shutting_down" } });
      } catch (error) {
        console.error("closing stream failed", safeError(error));
      }
    }
  }
}
