/** { before, after } limited to the listed fields whose value really differs (compared as JSON, so dates and nulls compare by value).
 * PATCH routes log this, so an activity-log entry names only what changed. */
export function changedFields(before: object, after: object, fields: readonly string[]): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const out = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const field of fields) {
    const was = (before as Record<string, unknown>)[field];
    const now = (after as Record<string, unknown>)[field];
    if (JSON.stringify(was ?? null) === JSON.stringify(now ?? null)) continue;
    out.before[field] = was ?? null;
    out.after[field] = now ?? null;
  }
  return out;
}
