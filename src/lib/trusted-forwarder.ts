// Trusted forwarder (ADR 0008). A server-side caller that proves itself with a shared secret may tell this API the real visitor
// address, so rate limits, lockout keys and logs see the visitor and not the caller's own address.
//
// The caller sends three headers:
//   X-Client-IP            a valid IPv4 or IPv6 address (the visitor)
//   X-Forwarder-Timestamp  unix seconds when it signed
//   X-Forwarder-Signature  base64url( HMAC-SHA256( secret, "v1|<ip>|<timestamp>" ) )
//
// The address is accepted only if the signature verifies against the current secret or the previous one (rotation), compared in
// constant time, and the timestamp is at most MAX_AGE_SECONDS old and at most MAX_FUTURE_SECONDS ahead (clock skew). Anything else
// and the three headers are ignored entirely: normal client-address resolution stands and ONE masked warning a minute is logged
// (header names and the reason only; never an address, a signature or a secret).

import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";

export const FORWARDER_IP_HEADER = "x-client-ip";
export const FORWARDER_TIMESTAMP_HEADER = "x-forwarder-timestamp";
export const FORWARDER_SIGNATURE_HEADER = "x-forwarder-signature";
export const FORWARDER_MAX_AGE_SECONDS = 60;
export const FORWARDER_MAX_FUTURE_SECONDS = 30;

const WARN_EVERY_MS = 60_000;

/** base64url(HMAC-SHA256(secret, "v1|<ip>|<timestamp>")): what a caller sends as X-Forwarder-Signature. */
export function signForwardedAddress(secret: string, ip: string, timestamp: number | string): string {
  return createHmac("sha256", secret).update(`v1|${ip}|${timestamp}`).digest("base64url");
}

/** A whole header value that is exactly one IP address: no list, no spaces, no zone id, no port. */
export function strictIp(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > 45 || value.includes("%")) return null;
  return isIP(value) !== 0 ? value : null;
}

export type ForwardedRejection = "malformed" | "expired" | "future" | "signature";

export interface ForwardedCheck {
  secrets: readonly string[];
  ip: unknown;
  timestamp: unknown;
  signature: unknown;
  nowSeconds: number;
}

/** The verified address, or the reason it was refused. Every secret is tried (no early exit on a match) so the time taken does not say which one matched. */
export function checkForwardedAddress(check: ForwardedCheck): { ok: true; ip: string } | { ok: false; reason: ForwardedRejection } {
  const ip = strictIp(check.ip);
  if (ip === null) return { ok: false, reason: "malformed" };
  if (typeof check.timestamp !== "string" || !/^\d{1,12}$/.test(check.timestamp)) return { ok: false, reason: "malformed" };
  if (typeof check.signature !== "string") return { ok: false, reason: "malformed" };

  const timestamp = Number(check.timestamp);
  if (check.nowSeconds - timestamp > FORWARDER_MAX_AGE_SECONDS) return { ok: false, reason: "expired" };
  if (timestamp - check.nowSeconds > FORWARDER_MAX_FUTURE_SECONDS) return { ok: false, reason: "future" };

  const given = Buffer.from(check.signature, "base64url");
  // Only the canonical encoding: the last character carries unused bits that Buffer would silently ignore.
  if (given.length !== 32 || given.toString("base64url") !== check.signature) return { ok: false, reason: "malformed" };
  let matched = false;
  for (const secret of check.secrets) {
    const expected = Buffer.from(signForwardedAddress(secret, ip, check.timestamp), "base64url");
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = true;
  }
  return matched ? { ok: true, ip } : { ok: false, reason: "signature" };
}

export interface TrustedForwarderOptions {
  /** Current secret first, then the previous one while rotating. Empty means the feature is off. */
  secrets: readonly string[];
  warn?: (message: string) => void;
  now?: () => number;
}

const HEADER_NAMES = [FORWARDER_IP_HEADER, FORWARDER_TIMESTAMP_HEADER, FORWARDER_SIGNATURE_HEADER] as const;

/**
 * Registers the hook. Register it AFTER the client-address hooks and BEFORE the rate limiter: a verified address replaces
 * request.ip for this request only (limits, lockout keys, logs). With no secret configured nothing is registered and the headers
 * are ignored like any other.
 */
export function registerTrustedForwarder(app: FastifyInstance, options: TrustedForwarderOptions): void {
  if (options.secrets.length === 0) return;
  const warn = options.warn ?? ((message: string) => app.log.warn(message));
  const now = options.now ?? Date.now;
  let lastWarning = -Infinity;

  app.addHook("onRequest", (request: FastifyRequest, _reply, done) => {
    const seen = HEADER_NAMES.filter((name) => request.headers[name] !== undefined);
    if (seen.length === 0) return done();

    const result = checkForwardedAddress({
      secrets: options.secrets,
      ip: request.headers[FORWARDER_IP_HEADER],
      timestamp: request.headers[FORWARDER_TIMESTAMP_HEADER],
      signature: request.headers[FORWARDER_SIGNATURE_HEADER],
      nowSeconds: Math.floor(now() / 1000),
    });
    if (result.ok) {
      // request.ip is a getter on the request prototype; an own property shadows it for this request only.
      Object.defineProperty(request, "ip", { value: result.ip, configurable: true, enumerable: true });
    } else if (now() - lastWarning >= WARN_EVERY_MS) {
      lastWarning = now();
      warn(`forwarded client address refused (${result.reason}); the headers were ignored (header names: ${seen.join(", ")}; values are never logged; at most once a minute)`);
    }
    done();
  });
}
