// What the activity log (and anything else that must not carry a storage address) keeps about a file: its id, its kind and its
// file name. Never the stored address, the object key's folders, the bucket or the account.

export type FileReferenceKind = "AUCTION_SHEET" | "VEHICLE_PHOTO" | "VEHICLE_DOCUMENT";

export interface FileReference {
  fileId: string;
  kind: FileReferenceKind;
  fileName: string;
}

/** The readable part of an object key: the last path segment without the random id uploads put in front of it. */
export function fileNameOf(addressOrKey: string): string {
  const last = addressOrKey.split("?")[0]!.split("/").filter(Boolean).at(-1) ?? "file";
  const withoutId = last.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
  return withoutId.slice(-120) || "file";
}

/** For the auction sheet (a column, not a row) the id is the vehicle's. */
export function fileReference(kind: FileReferenceKind, fileId: string, addressOrKey: string): FileReference {
  return { fileId, kind, fileName: fileNameOf(addressOrKey) };
}
