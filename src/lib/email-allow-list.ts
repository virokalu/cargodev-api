// EMAIL_ALLOWED_RECIPIENTS: a comma-separated list of addresses ("a@example.test") and whole domains ("@example.test"). When it is set,
// ONLY matching recipients ever get an email; every other message is dropped (sendEmail logs a masked line). This keeps a staging
// deployment, which has real mail credentials and a copy of real-looking data, from writing to real customers.
//
// Pure: no environment, no network. Matching is case-insensitive and exact: "@example.test" matches "x@example.test" but not
// "x@sub.example.test" and not "x@example.test.evil.test". An address that is not a plain address (for example "Name <a@b.test>")
// never matches, so an odd value fails closed.

const ADDRESS = /^[^@\s,<>"*]+@[^@\s,<>"*]+\.[^@\s,<>"*]+$/;
const DOMAIN = /^@[^@\s,<>"*]+\.[^@\s,<>"*]+$/;

/** The list, trimmed and lower-cased, without empty entries. */
export function parseAllowList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

/** Entries that are neither an address nor a domain: the settings check refuses the start (the value itself is never printed). */
export function hasInvalidAllowListEntry(list: readonly string[]): boolean {
  return list.some((entry) => !ADDRESS.test(entry) && !DOMAIN.test(entry));
}

/** May this recipient get an email? An empty list means no restriction. */
export function isRecipientAllowed(address: string, list: readonly string[]): boolean {
  if (list.length === 0) return true;
  const normal = address.trim().toLowerCase();
  if (!ADDRESS.test(normal)) return false;
  const domain = normal.slice(normal.lastIndexOf("@"));
  return list.some((entry) => (entry.startsWith("@") ? entry === domain : entry === normal));
}
