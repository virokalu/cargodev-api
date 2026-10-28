// Removes storage references from anything about to be returned to a client: a stored file address, a storage host, an object key,
// the bucket names and the account id. Used at READ time on the activity log, so rows written before the log stopped keeping file
// addresses are covered too, without changing stored history.
//
// What is removed:
//   - any address on a Cloudflare storage host (r2.cloudflarestorage.com, r2.dev) or on the configured public file or stock image
//     address (the whole address, including a signed query)
//   - an object key of the shapes this API makes (org/<org>/vehicles/..., org/<org>/uploads/..., stock/<hex>/<id>.<ext>)
//   - the configured account id and bucket names, wherever they appear as a word

import { loadEnv } from "../config/env.js";

export const ADDRESS_REMOVED = "[file address removed]";
export const KEY_REMOVED = "[file key removed]";
export const NAME_REMOVED = "[storage name removed]";

const ADDRESS = /https?:\/\/[^\s"'<>\\)]+/gi;
const STORAGE_HOST = /(^|\.)(r2\.cloudflarestorage\.com|r2\.dev)$/i;
const OBJECT_KEY = /(?:\borg\/[A-Za-z0-9_-]+\/(?:vehicles|uploads)\/[A-Za-z0-9._/-]*|\bstock\/[0-9a-f]{16}\/[0-9a-f-]{36}\.[A-Za-z]{3,4})/g;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Rules {
  bases: string[];
  hosts: Set<string>;
  names: RegExp | null;
}

function rules(): Rules {
  const env = loadEnv();
  const bases: string[] = [];
  const hosts = new Set<string>();
  for (const configured of [env.R2_PUBLIC_URL, env.PUBLIC_STOCK_IMAGE_BASE_URL]) {
    if (!configured) continue;
    bases.push(configured.replace(/\/+$/, "").toLowerCase());
    try {
      hosts.add(new URL(configured).hostname.toLowerCase());
    } catch {
      /* not a URL: the base prefix still applies */
    }
  }
  // Short names would damage ordinary words; real account ids and bucket names are longer than this.
  const names = [env.R2_ACCOUNT_ID, env.R2_BUCKET_NAME, env.R2_PUBLIC_STOCK_BUCKET_NAME].filter((n): n is string => typeof n === "string" && n.length >= 4);
  return { bases, hosts, names: names.length ? new RegExp(`(?<![A-Za-z0-9])(?:${names.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "gi") : null };
}

function isStorageAddress(address: string, r: Rules): boolean {
  const lower = address.toLowerCase();
  if (r.bases.some((base) => lower === base || lower.startsWith(`${base}/`) || lower.startsWith(`${base}?`))) return true;
  try {
    const host = new URL(address).hostname.toLowerCase();
    return STORAGE_HOST.test(host) || r.hosts.has(host);
  } catch {
    return false;
  }
}

function redactText(text: string, r: Rules): string {
  // Punctuation that ends a sentence is not part of the address: it is kept.
  let out = text.replace(ADDRESS, (address) => {
    const trailing = /[.,;:!?]+$/.exec(address)?.[0] ?? "";
    const core = trailing ? address.slice(0, -trailing.length) : address;
    return isStorageAddress(core, r) ? ADDRESS_REMOVED + trailing : address;
  });
  out = out.replace(OBJECT_KEY, KEY_REMOVED);
  if (r.names) out = out.replace(r.names, NAME_REMOVED);
  return out;
}

function walk(value: unknown, r: Rules): unknown {
  if (typeof value === "string") return redactText(value, r);
  if (Array.isArray(value)) return value.map((item) => walk(item, r));
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item, r)]));
  }
  return value;
}

/** A copy of `value` (strings, arrays, plain objects, any depth) with storage references removed. Dates and numbers pass through. */
export function redactStorageReferences<T>(value: T): T {
  return walk(value, rules()) as T;
}
