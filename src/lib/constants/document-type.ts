// Shared VehicleDocumentType display metadata — one source of truth for the
// labels/accepted-file-types shown next to each typed document section
// (Add/Edit form's Files panel, the read-only detail page). OTHER is the
// pre-existing generic "Add Documents" bucket, kept for anything that
// doesn't fit the named types below.
//
// `accept` is a comma-separated MIME list, same format the HTML file input
// and FileDropZone already expect. Every type is PDF-only except
// PURCHASE_INVOICE and CASH_RECEIPT, which also take a photo (a scanned
// invoice or a picture of a physical receipt) — the matching server-side
// rule lives in lib/validation/upload.schema.ts, kept in sync manually
// since one is a client constant and the other a zod schema and there's no
// good way to share a literal between them across the client/server
// boundary here.

import type { VehicleDocumentType } from "@prisma/client";

const PDF_ONLY = "application/pdf";
const PDF_OR_IMAGE = "application/pdf,image/jpeg,image/png,image/webp";

export const DOCUMENT_TYPE_META: Record<VehicleDocumentType, { label: string; accept: string }> = {
  LC: { label: "Letter of Credit (LC)", accept: PDF_ONLY },
  EC: { label: "Export Certificate (EC)", accept: PDF_ONLY },
  ED: { label: "Export Declaration (ED)", accept: PDF_ONLY },
  BL: { label: "Bill of Lading (BL)", accept: PDF_ONLY },
  INSPECTION_REPORT: { label: "Inspection Report", accept: PDF_ONLY },
  SHAKEN_SHO: { label: "Shaken-sho (車検証)", accept: PDF_ONLY },
  FREIGHT_INVOICE: { label: "Freight Invoice", accept: PDF_ONLY },
  PURCHASE_INVOICE: { label: "Purchase Invoice", accept: PDF_OR_IMAGE },
  SALES_INVOICE: { label: "Sales Invoice", accept: PDF_ONLY },
  MEGI_HENKO: { label: "Megi Henko", accept: PDF_ONLY },
  CASH_RECEIPT: { label: "Cash Receipt", accept: PDF_OR_IMAGE },
  OTHER: { label: "Other Documents", accept: PDF_ONLY },
};

/** FC's named types, in the order they're shown — OTHER is rendered
 * separately by callers since it's the catch-all, not one of "the" types. */
export const NAMED_DOCUMENT_TYPES: VehicleDocumentType[] = [
  "LC",
  "EC",
  "ED",
  "BL",
  "INSPECTION_REPORT",
  "SHAKEN_SHO",
  "FREIGHT_INVOICE",
];

/** FL's named types — a local sale has no export paperwork (LC/EC/ED/BL/
 * Inspection Report/Freight Invoice don't apply), just its own document
 * set. OTHER is still rendered separately by callers, same as FC. */
export const FL_NAMED_DOCUMENT_TYPES: VehicleDocumentType[] = [
  "PURCHASE_INVOICE",
  "SALES_INVOICE",
  "SHAKEN_SHO",
  "MEGI_HENKO",
  "CASH_RECEIPT",
];
