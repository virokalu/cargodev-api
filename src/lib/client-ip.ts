// Where the client address comes from (CLIENT_IP_SOURCE). It decides request.ip, which the rate limiters and the logs use.
//
//   socket  the TCP peer; every forwarding header is ignored (cannot be spoofed). The default.
//   hops    X-Forwarded-For through exactly TRUST_PROXY_HOPS proxies (Fastify's trustProxy, configured in app.ts).
//   header  the one header named by CLIENT_IP_HEADER (for example the host's "true client IP" header).
//
// Header mode is safe ONLY when the host's edge overwrites that header on EVERY request, so a copy sent by a client never
// reaches this server. If the header is missing or is not an IP address, the socket address is used instead and a masked
// warning is logged (never the value, at most once a minute), so a misconfigured edge shows up without flooding the log.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { isIP } from "node:net";

const WARN_EVERY_MS = 60_000;

/** The address in a header value: the first entry of a comma list, trimmed, and only if it really is an IP address. */
export function ipFromHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const first = raw.split(",")[0]?.trim() ?? "";
  // A zone id ("fe80::1%eth0") is not an address a client can have.
  return first !== "" && first.length <= 45 && !first.includes("%") && isIP(first) !== 0 ? first : null;
}

export interface ClientIpOptions {
  header: string;
  warn?: (message: string) => void;
  now?: () => number;
}

/** Registers the hook for header mode. Register it BEFORE the rate limiter so the limiter sees the overridden address. */
export function registerClientIpHeader(app: FastifyInstance, options: ClientIpOptions): void {
  const warn = options.warn ?? ((message: string) => app.log.warn(message));
  const now = options.now ?? Date.now;
  let lastWarning = -Infinity;

  app.addHook("onRequest", (request: FastifyRequest, _reply, done) => {
    const ip = ipFromHeader(request.headers[options.header]);
    if (ip) {
      // request.ip is a getter on the request prototype; an own property shadows it for this request only.
      Object.defineProperty(request, "ip", { value: ip, configurable: true, enumerable: true });
    } else if (now() - lastWarning >= WARN_EVERY_MS) {
      lastWarning = now();
      warn(`client address header "${options.header}" is missing or not an IP address; using the socket address (the value is never logged; at most once a minute)`);
    }
    done();
  });
}
