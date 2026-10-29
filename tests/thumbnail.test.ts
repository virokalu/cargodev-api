// Thumbnails: sharp on untrusted bytes, and the service that writes them next to a stored photo. Images are generated
// in the test itself (sharp can create them); nothing real is used.

import { Readable } from "node:stream";
import sharp, { type Sharp } from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePrisma } from "./helpers/fake-prisma.js";
import { actor, ORG_A } from "./helpers/fixtures.js";
import { newVehicleFake } from "./helpers/vehicle-fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({ getPrisma: () => (state.fake as FakePrisma).client }));
vi.mock("../src/config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env.js")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), R2_PUBLIC_URL: "https://files.example.test" }) };
});

import { setObjectStore, type ObjectStore } from "../src/lib/object-storage.js";
import { MAX_INPUT_PIXELS, THUMB_MAX_EDGE, makeThumbnail } from "../src/lib/thumbnail.js";
import { addVehiclePhoto, deleteVehiclePhoto } from "../src/services/file.service.js";
import { createPhotoThumbnail } from "../src/services/photo-thumbnail.service.js";

const BASE = "https://files.example.test";
const KEY = `org/${ORG_A}/vehicles/v_fc_pending/photos/11111111-1111-1111-1111-111111111111-front.jpg`;

const image = (width: number, height: number, format: "jpeg" | "png" | "webp", extra: (s: Sharp) => Sharp = (s) => s) =>
  extra(sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })).toFormat(format).toBuffer();

describe("makeThumbnail", () => {
  it.each([
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ] as const)("shrinks a large %s so its longest edge is %d pixels, in the same format", async (format, type) => {
    const out = await makeThumbnail(await image(2000, 1000, format), type);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe(format);
    expect(meta.width).toBe(THUMB_MAX_EDGE);
    expect(meta.height).toBe(THUMB_MAX_EDGE / 2);
  });

  it("never enlarges a small image", async () => {
    const meta = await sharp(await makeThumbnail(await image(100, 80, "png"), "image/png")).metadata();
    expect([meta.width, meta.height]).toEqual([100, 80]);
  });

  it("applies the EXIF orientation and then drops ALL metadata (no GPS, no camera data)", async () => {
    const withMeta = await image(800, 400, "jpeg", (s) =>
      s.withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "private-owner-example" } } })
    );
    expect((await sharp(withMeta).metadata()).exif).toBeDefined();
    const out = await makeThumbnail(withMeta, "image/jpeg");
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.toString("latin1")).not.toContain("private-owner-example");
    // orientation 6 swaps the axes: the 800x400 picture is stored sideways and shown upright as 400x800 -> thumbnail 240x480
    expect([meta.width, meta.height]).toEqual([240, 480]);
  });

  it("refuses an SVG, a GIF and text that merely carry an image extension or type", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"><rect width="10" height="10"/></svg>');
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).gif().toBuffer();
    for (const bytes of [svg, gif, Buffer.from("<html><script>1</script></html>"), Buffer.from("not an image at all")]) {
      await expect(makeThumbnail(bytes, "image/jpeg")).rejects.toThrow();
      await expect(makeThumbnail(bytes, "image/png")).rejects.toThrow();
    }
  });

  it("refuses a file whose real format differs from the one claimed", async () => {
    await expect(makeThumbnail(await image(50, 50, "png"), "image/jpeg")).rejects.toThrow("not the image type");
    await expect(makeThumbnail(await image(50, 50, "jpeg"), "image/webp")).rejects.toThrow("not the image type");
  });

  it("refuses a pdf type outright", async () => {
    await expect(makeThumbnail(await image(50, 50, "png"), "application/pdf")).rejects.toThrow("Not an image type");
  });

  it("refuses an image with more pixels than the cap, before decoding it", async () => {
    expect(MAX_INPUT_PIXELS).toBe(50_000_000);
    await expect(makeThumbnail(await image(300, 300, "png"), "image/png", { maxInputPixels: 1000 })).rejects.toThrow();
  });

  it("a truncated or corrupt image gives a generic error with no library detail", async () => {
    const good = await image(400, 400, "jpeg");
    const error = await makeThumbnail(good.subarray(0, 200), "image/jpeg").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^(The image could not be processed\.|The file is not)/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("thumbnails next to stored photos", () => {
  let fake: FakePrisma;
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const puts: string[] = [];
  const deletes: string[] = [];
  const store: ObjectStore = {
    presignPut: async () => "https://upload.example.test/x",
    getObject: async ({ key }) => {
      const found = objects.get(key);
      return found ? { kind: "found", body: Readable.from([found.body]), contentLength: found.body.length, etag: '"e"' } : { kind: "missing" };
    },
    putObject: async ({ key, body, contentType }) => {
      puts.push(key);
      objects.set(key, { body, contentType });
    },
    deleteKey: async (key) => void deletes.push(key),
  };

  beforeEach(() => {
    fake = newVehicleFake();
    state.fake = fake;
    fake.seed("user", { id: "user_a_manager", org_id: ORG_A, userType: "STAFF", role: "MANAGER", loginEnabled: false, name: "Test Manager A" });
    objects.clear();
    puts.length = 0;
    deletes.length = 0;
    setObjectStore(store);
  });
  afterEach(() => {
    setObjectStore(null);
    vi.restoreAllMocks();
  });

  it("adding a photo writes a smaller copy under photos-thumb with the right content type", async () => {
    const original = await image(2400, 1600, "jpeg");
    objects.set(KEY, { body: original });
    await addVehiclePhoto(actor(), "v_fc_pending", { key: KEY });
    const thumbKey = KEY.replace("/photos/", "/photos-thumb/");
    expect(puts).toEqual([thumbKey]);
    const thumb = objects.get(thumbKey)!;
    expect(thumb.contentType).toBe("image/jpeg");
    expect(thumb.body.length).toBeLessThan(original.length);
    expect((await sharp(thumb.body).metadata()).width).toBe(THUMB_MAX_EDGE);
    // the original is untouched
    expect(objects.get(KEY)!.body).toBe(original);
  });

  it("a photo that cannot be processed is still added, with no thumbnail and no stack in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    objects.set(KEY, { body: Buffer.from("<svg onload=alert(1)/>") });
    const photo = await addVehiclePhoto(actor(), "v_fc_pending", { key: KEY });
    // staff get a signed link in the response; the stored address in the row is unchanged
    expect(photo.url).toMatch(/^https:\/\/api\.example\.test\/f\/v1\/photo\/[A-Za-z0-9_-]+\/full\?o=org_test_a&u=user_a_manager&a=staff&exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
    expect(photo.url).not.toContain(KEY);
    expect(fake.rows("vehiclePhoto")[0]!.url).toBe(`${BASE}/${KEY}`);
    expect(fake.rows("vehiclePhoto")).toHaveLength(1);
    expect(puts).toEqual([]);
    const logged = log.mock.calls.flat().map((x) => JSON.stringify(x)).join(" ");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("org/");
  });

  it("a photo whose object cannot be read afterwards (gone right after registering) is still added, with no thumbnail", async () => {
    // Registering checks the object exists (first read); the thumbnail then reads it again and finds nothing.
    vi.spyOn(store, "getObject").mockImplementationOnce(async () => ({ kind: "found", body: Readable.from([Buffer.from("x")]), contentLength: 1, etag: null }));
    await addVehiclePhoto(actor(), "v_fc_pending", { key: KEY });
    expect(fake.rows("vehiclePhoto")).toHaveLength(1);
    expect(puts).toEqual([]);
  });

  it("a key whose object was never uploaded is refused: nothing is added", async () => {
    await expect(addVehiclePhoto(actor(), "v_fc_pending", { key: KEY })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { key: expect.stringContaining("has not been uploaded") } });
    expect(fake.rows("vehiclePhoto")).toHaveLength(0);
  });

  it("an oversized original is not read into memory", async () => {
    objects.set(KEY, { body: Buffer.alloc(13 * 1024 * 1024, 1) });
    expect(await createPhotoThumbnail(ORG_A, `${BASE}/${KEY}`)).toBe(false);
    expect(puts).toEqual([]);
  });

  it("photos staged before the vehicle existed get a thumbnail in the staging-thumb folder", async () => {
    const staged = `org/${ORG_A}/uploads/staging/22222222-2222-2222-2222-222222222222-a.png`;
    objects.set(staged, { body: await image(1200, 900, "png") });
    expect(await createPhotoThumbnail(ORG_A, `${BASE}/${staged}`)).toBe(true);
    expect(puts).toEqual([`org/${ORG_A}/uploads/staging-thumb/22222222-2222-2222-2222-222222222222-a.png`]);
  });

  it("never makes a thumbnail for a pdf, a URL outside the org folder, or another org's key", async () => {
    objects.set(`org/${ORG_A}/vehicles/v/documents/a.pdf`, { body: Buffer.from("%PDF") });
    expect(await createPhotoThumbnail(ORG_A, `${BASE}/org/${ORG_A}/vehicles/v/documents/a.pdf`)).toBe(false);
    expect(await createPhotoThumbnail(ORG_A, "https://evil.test/a.jpg")).toBe(false);
    expect(await createPhotoThumbnail(ORG_A, `${BASE}/org/org_test_b/vehicles/v/photos/a.jpg`)).toBe(false);
    expect(puts).toEqual([]);
  });

  it("deleting a photo also removes its thumbnail, and only that org's", async () => {
    objects.set(KEY, { body: await image(900, 600, "jpeg") });
    const photo = await addVehiclePhoto(actor(), "v_fc_pending", { key: KEY });
    await deleteVehiclePhoto(actor(), "v_fc_pending", photo.id);
    await vi.waitFor(() => expect(deletes).toContain(KEY.replace("/photos/", "/photos-thumb/")));
    expect(deletes).toContain(KEY);
  });

  it("with no store configured nothing happens and nothing throws", async () => {
    setObjectStore(null);
    expect(await createPhotoThumbnail(ORG_A, `${BASE}/${KEY}`)).toBe(false);
  });
});
