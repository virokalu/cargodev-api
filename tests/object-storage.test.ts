import { describe, expect, it, vi } from "vitest";
import {
  allowedPrefixesForNewFile,
  deleteObject,
  keyFromOwnedUrl,
  orgPrefix,
  setObjectDeleter,
} from "../src/lib/object-storage.js";

const BASE = "https://files.example.test";
const ORG = "org_test_a";
const OTHER = "org_test_b";
const VEHICLE = "veh_1";

const own = (url: string, prefixes: readonly string[] = orgPrefix(ORG)) => keyFromOwnedUrl(BASE, url, prefixes);

describe("keyFromOwnedUrl: accepts our own org's files", () => {
  it("returns the key for a file under the base and the org folder", () => {
    expect(own(`${BASE}/org/${ORG}/vehicles/${VEHICLE}/photos/9b2f.jpg`)).toBe(`org/${ORG}/vehicles/${VEHICLE}/photos/9b2f.jpg`);
  });
  it("accepts the generated document key shape (uuid-safe-name)", () => {
    expect(own(`${BASE}/org/${ORG}/vehicles/${VEHICLE}/documents/9b2f-Invoice-1.pdf`)).not.toBeNull();
  });
});

describe("keyFromOwnedUrl: refuses everything else", () => {
  it.each([
    ["no storage configured", null as string | null, `${BASE}/org/${ORG}/a.jpg`],
  ])("%s", (_n, base, url) => {
    expect(keyFromOwnedUrl(base, url, orgPrefix(ORG))).toBeNull();
  });

  it.each([
    ["an internal address (SSRF)", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "http://localhost:5432/"],
    ["a private network host", "http://10.0.0.5/admin"],
    ["javascript: URL", "javascript:alert(1)"],
    ["data: URL", "data:image/png;base64,AAAA"],
    ["file: URL", "file:///etc/passwd"],
    ["a different host", `https://evil.test/org/${ORG}/a.jpg`],
    ["our host as a prefix of another host", `https://files.example.test.evil.test/org/${ORG}/a.jpg`],
    ["userinfo trick (our host as the user name)", `https://files.example.test@evil.test/org/${ORG}/a.jpg`],
    ["http downgrade of our host", `http://files.example.test/org/${ORG}/a.jpg`],
    ["our host in uppercase scheme tricks", `HTTPS://files.example.test/org/${ORG}/a.jpg`],
    ["no path at all", `${BASE}`],
    ["only a slash", `${BASE}/`],
    ["an empty string", ""],
  ])("%s", (_name, url) => {
    expect(own(url)).toBeNull();
  });

  it.each([
    ["another org's file (cross-org)", `${BASE}/org/${OTHER}/vehicles/${VEHICLE}/photos/a.jpg`],
    ["a path outside any org folder", `${BASE}/other/a.jpg`],
    ["org id as a prefix of a longer id", `${BASE}/org/${ORG}x/a.jpg`],
    ["the org folder without a trailing slash", `${BASE}/org/${ORG}`],
  ])("%s", (_name, url) => {
    expect(own(url)).toBeNull();
  });

  it.each([
    ["path traversal", `${BASE}/org/${ORG}/../${OTHER}/a.jpg`],
    ["traversal into another org", `${BASE}/org/${ORG}/vehicles/../../${OTHER}/a.jpg`],
    ["encoded traversal", `${BASE}/org/${ORG}/%2e%2e/${OTHER}/a.jpg`],
    ["encoded slash", `${BASE}/org/${ORG}%2f..%2f${OTHER}/a.jpg`],
    ["a dot segment", `${BASE}/org/${ORG}/./a.jpg`],
    ["an empty segment", `${BASE}/org/${ORG}//a.jpg`],
    ["a query string", `${BASE}/org/${ORG}/a.jpg?redirect=http://evil.test`],
    ["a fragment", `${BASE}/org/${ORG}/a.jpg#x`],
    ["a backslash", `${BASE}/org/${ORG}\\..\\${OTHER}\\a.jpg`],
    ["a space", `${BASE}/org/${ORG}/a b.jpg`],
    ["a newline", `${BASE}/org/${ORG}/a.jpg\n`],
    ["a null byte", `${BASE}/org/${ORG}/a.jpg\u0000.png`],
    ["a non-ASCII look-alike", `${BASE}/org/${ORG}/а.jpg`],
    ["an over-long key", `${BASE}/org/${ORG}/${"a".repeat(1100)}.jpg`],
  ])("%s", (_name, url) => {
    expect(own(url)).toBeNull();
  });

  it("a non-string never throws", () => {
    expect(keyFromOwnedUrl(BASE, undefined as never, orgPrefix(ORG))).toBeNull();
    expect(keyFromOwnedUrl(BASE, 42 as never, orgPrefix(ORG))).toBeNull();
  });
});

describe("a trailing slash on the configured base is ignored", () => {
  it("works the same either way", () => {
    // publicBaseUrl() strips trailing slashes before this is called; the helper itself must not double them.
    expect(keyFromOwnedUrl(BASE, `${BASE}/org/${ORG}/a.jpg`, orgPrefix(ORG))).toBe(`org/${ORG}/a.jpg`);
  });
});

describe("allowedPrefixesForNewFile: where a client may point a NEW file", () => {
  it("with no vehicle yet (create), only the org's staging area", () => {
    expect(allowedPrefixesForNewFile(ORG, "VEHICLE_PHOTO")).toEqual([`org/${ORG}/uploads/staging/`]);
    expect(own(`${BASE}/org/${ORG}/uploads/staging/abc.jpg`, allowedPrefixesForNewFile(ORG, "VEHICLE_PHOTO"))).not.toBeNull();
    // Another vehicle's folder is not allowed at create time.
    expect(own(`${BASE}/org/${ORG}/vehicles/${VEHICLE}/photos/a.jpg`, allowedPrefixesForNewFile(ORG, "VEHICLE_PHOTO"))).toBeNull();
  });

  it("for an existing vehicle, only that vehicle's folder for that kind", () => {
    const photos = allowedPrefixesForNewFile(ORG, "VEHICLE_PHOTO", VEHICLE);
    expect(own(`${BASE}/org/${ORG}/vehicles/${VEHICLE}/photos/a.jpg`, photos)).not.toBeNull();
    expect(own(`${BASE}/org/${ORG}/vehicles/${VEHICLE}/documents/a.pdf`, photos)).toBeNull(); // wrong kind
    expect(own(`${BASE}/org/${ORG}/vehicles/veh_other/photos/a.jpg`, photos)).toBeNull(); // another vehicle
    expect(own(`${BASE}/org/${ORG}/uploads/staging/a.jpg`, photos)).toBeNull(); // staging only at create
    expect(own(`${BASE}/org/${OTHER}/vehicles/${VEHICLE}/photos/a.jpg`, photos)).toBeNull(); // another org
  });

  it("each kind has its own folder", () => {
    expect(allowedPrefixesForNewFile(ORG, "VEHICLE_DOCUMENT", VEHICLE)).toEqual([`org/${ORG}/vehicles/${VEHICLE}/documents/`]);
    expect(allowedPrefixesForNewFile(ORG, "AUCTION_SHEET", VEHICLE)).toEqual([`org/${ORG}/vehicles/${VEHICLE}/auction-sheet/`]);
  });
});

describe("deleteObject seam", () => {
  it("by default leaves the object and says so, never throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(deleteObject("org/x/a.jpg")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("can be replaced by the real implementation", async () => {
    const spy = vi.fn(async () => undefined);
    setObjectDeleter(spy);
    await deleteObject("org/x/a.jpg");
    expect(spy).toHaveBeenCalledWith("org/x/a.jpg");
    setObjectDeleter(async () => undefined);
  });
});
