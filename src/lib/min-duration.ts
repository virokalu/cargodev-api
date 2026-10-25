// A floor on how long an anti-enumeration endpoint takes. Registering a new address writes rows and queues an
// email; registering a known one does neither, and a caller could time the difference. Every branch waits
// until the same minimum time has passed (the database work is far below it). Zero in tests.

let floorMs = process.env["NODE_ENV"] === "test" ? 0 : 250;

/** Test helper. */
export function setResponseFloorMs(ms: number): void {
  floorMs = ms;
}

export async function withResponseFloor<T>(work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    const remaining = floorMs - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
