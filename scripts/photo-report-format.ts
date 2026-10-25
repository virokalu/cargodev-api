// Formatting for the photo release report. Pure, so it is tested with fake rows. COUNTS ONLY: a serial number (the
// business identifier of a vehicle) and numbers. Never a photo URL, key, file name or content.

export interface PhotoCountRow {
  serial: string;
  total: number;
  /** null when the visibleToCustomer column does not exist yet (the slice 2 migration is not applied). */
  released: number | null;
}

export function formatPhotoReport(rows: readonly PhotoCountRow[]): string[] {
  const lines: string[] = [];
  const known = rows.every((r) => r.released !== null);
  lines.push(known ? "serial        photos  released  hidden" : "serial        photos  (release status unknown: column not created yet)");
  for (const r of rows) {
    const serial = r.serial.padEnd(12);
    lines.push(
      r.released === null ? `${serial}  ${String(r.total).padStart(6)}` : `${serial}  ${String(r.total).padStart(6)}  ${String(r.released).padStart(8)}  ${String(r.total - r.released).padStart(6)}`
    );
  }
  const total = rows.reduce((n, r) => n + r.total, 0);
  const released = rows.reduce((n, r) => n + (r.released ?? 0), 0);
  lines.push(
    known
      ? `${rows.length} vehicle(s) with photos, ${total} photo(s): ${released} released, ${total - released} hidden`
      : `${rows.length} vehicle(s) with photos, ${total} photo(s)`
  );
  return lines;
}
