// Which files a customer may see, and the bytes for them.
//
// Customers never receive an R2 address, an object key or a signed link. They ask this API for a photo or document by
// its database id; the API checks, in a fixed order, then reads the object itself and streams it:
//   (1) the account is the verified token's,
//   (2) the vehicle is theirs, in their org, not deleted, an export-track vehicle, and released to the customer,
//   (3) the file is released (photos AND documents are private until staff release them),
//   (4) ONLY THEN is the object store touched.
// Anything that fails is the same 404 (nothing is read from the store), so a customer cannot tell a private file
// from one that does not exist.

import type { Readable } from "node:stream";
import { computeEffectiveTrack } from "../lib/vehicle-track.js";
import { ServiceError } from "../lib/errors.js";
import {
  contentTypeForKey,
  isImageType,
  keyFromOwnedUrlForOrg,
  requireStore,
  thumbKeyFor,
  type AllowedContentType,
} from "../lib/object-storage.js";
import { getPrisma } from "../lib/prisma.js";

export type CustomerFileKind = "photo" | "document";
export type ImageSize = "thumb" | "full";

const NOT_FOUND = () => new ServiceError("NOT_FOUND", "File not found.");

export interface CustomerPrincipalLike {
  id: string;
  orgId: string;
}

/** The vehicle a customer may see, or null. FL (effective) vehicles and unreleased vehicles are never visible. */
export async function findCustomerVehicle(customer: CustomerPrincipalLike, vehicleId: string) {
  const vehicle = await getPrisma().vehicle.findFirst({
    where: { id: vehicleId, org_id: customer.orgId, customerId: customer.id, deletedAt: null, customerVisible: true },
    select: { id: true, serialPrefix: true, convertedToExport: true, convertedToLocal: true },
  });
  if (!vehicle) return null;
  return computeEffectiveTrack(vehicle.serialPrefix, vehicle.convertedToExport, vehicle.convertedToLocal) === "FC" ? vehicle : null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AuthorizedFile {
  key: string;
  contentType: AllowedContentType;
  /** Shown name for documents (staff-entered); photos have none. */
  displayName: string | null;
}

/** The file this customer may read, or a 404. Does NOT touch the object store. */
export async function authorizeCustomerFile(customer: CustomerPrincipalLike, kind: CustomerFileKind, fileId: string): Promise<AuthorizedFile> {
  if (!ID.test(fileId)) throw NOT_FOUND();
  const prisma = getPrisma();
  const file =
    kind === "photo"
      ? await prisma.vehiclePhoto.findFirst({ where: { id: fileId, visibleToCustomer: true }, select: { url: true, vehicleId: true } })
      : await prisma.vehicleDocument.findFirst({ where: { id: fileId, visibleToCustomer: true }, select: { url: true, vehicleId: true, name: true } });
  if (!file) throw NOT_FOUND();

  if (!(await findCustomerVehicle(customer, file.vehicleId))) throw NOT_FOUND();

  // The stored URL is re-checked: rows written before validation existed may hold anything.
  const key = keyFromOwnedUrlForOrg(customer.orgId, file.url);
  if (!key) throw NOT_FOUND();

  // The type comes from the key's extension and must be on the allowlist; a photo must be an image.
  const contentType = contentTypeForKey(key);
  if (!contentType || (kind === "photo" && !isImageType(contentType))) throw NOT_FOUND();

  return { key, contentType, displayName: "name" in file ? String(file.name) : null };
}

/** Header-safe Content-Disposition: inline for images, attachment for documents. */
export function contentDispositionFor(contentType: AllowedContentType, displayName: string | null): string {
  if (isImageType(contentType)) return "inline";
  const extension = contentType === "application/pdf" ? "pdf" : "bin";
  let name = (displayName ?? "document").normalize("NFC").replace(/[\u0000-\u001f\u007f"\\/]/g, "").trim() || "document";
  if (!name.toLowerCase().endsWith(`.${extension}`)) name = `${name}.${extension}`;
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** R2 returns ETags in quotes; make sure the header always is. */
function quoteEtag(etag: string | null): string | null {
  if (!etag) return null;
  return etag.startsWith('"') || etag.startsWith("W/") ? etag : `"${etag}"`;
}

export type OpenedCustomerFile =
  | { status: 304; etag: string | null }
  | {
      status: 200;
      body: Readable;
      contentType: AllowedContentType;
      contentDisposition: string;
      contentLength: number | null;
      etag: string | null;
    };

/**
 * Authorise, then read from the store and hand back what the route needs to stream. `size` only matters for photos:
 * "thumb" uses the small version when one exists and quietly serves the full image when it does not.
 */
export async function openCustomerFile(
  customer: CustomerPrincipalLike,
  kind: CustomerFileKind,
  fileId: string,
  options: { size?: ImageSize; ifNoneMatch?: string } = {}
): Promise<OpenedCustomerFile> {
  const file = await authorizeCustomerFile(customer, kind, fileId);

  // From here on the file is authorised. A missing store is a server problem, not a customer problem.
  let store;
  try {
    store = requireStore();
  } catch {
    throw new ServiceError("INTERNAL", "File storage is not available.");
  }
  const conditional = options.ifNoneMatch ? { ifNoneMatch: options.ifNoneMatch } : {};

  let result = { kind: "missing" } as Awaited<ReturnType<typeof store.getObject>>;
  const thumbKey = kind === "photo" && options.size === "thumb" ? thumbKeyFor(file.key) : null;
  if (thumbKey) result = await store.getObject({ key: thumbKey, ...conditional });
  if (result.kind === "missing") result = await store.getObject({ key: file.key, ...conditional });

  if (result.kind === "missing") throw NOT_FOUND();
  if (result.kind === "notModified") return { status: 304, etag: quoteEtag(result.etag) };
  return {
    status: 200,
    body: result.body,
    contentType: file.contentType,
    contentDisposition: contentDispositionFor(file.contentType, file.displayName),
    contentLength: result.contentLength,
    etag: quoteEtag(result.etag),
  };
}
