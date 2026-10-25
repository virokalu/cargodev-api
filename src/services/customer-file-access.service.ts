// Which files a customer may download, and the signed link for them.
//
// Order is fixed: (1) the account is the verified token's, (2) the vehicle is theirs, in their org, not deleted, an
// export-track vehicle and released to the customer, (3) the file is released (photos default to yes, documents to no),
// (4) ONLY THEN a time-limited link is signed. Anything that fails is the same 404, so a customer cannot tell a file
// that exists but is private from one that does not exist.

import { computeEffectiveTrack } from "../lib/vehicle-track.js";
import { ServiceError } from "../lib/errors.js";
import { keyFromOwnedUrlForOrg, signedDownloadUrl } from "../lib/object-storage.js";
import { getPrisma } from "../lib/prisma.js";

export type CustomerFileKind = "photo" | "document";

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

/** The storage key of a file this customer may download, or a 404. Does NOT sign anything. */
export async function authorizeCustomerFile(
  customer: CustomerPrincipalLike,
  kind: CustomerFileKind,
  fileId: string
): Promise<{ key: string; downloadName: string }> {
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
  return { key, downloadName: "name" in file ? String(file.name) : key.split("/").at(-1) ?? "file" };
}

/** Authorise, then sign. The only route from a customer request to a download link. */
export async function signedUrlForCustomerFile(customer: CustomerPrincipalLike, kind: CustomerFileKind, fileId: string) {
  const { key, downloadName } = await authorizeCustomerFile(customer, kind, fileId);
  return signedDownloadUrl(customer.orgId, key, downloadName);
}
