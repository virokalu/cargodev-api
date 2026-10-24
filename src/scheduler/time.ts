// Schedule maths. UTC only: nothing here reads the machine's local time zone, so a
// server in any zone (or a daylight-saving change) cannot move the run time.

const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Today's (UTC date) run instant, e.g. 02:00:00.000Z. */
export function todaysRunTime(now: Date, utcHour: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0, 0));
}

/** The first run instant strictly after `after` (so being exactly on the boundary rolls to tomorrow). */
export function nextRunAfter(after: Date, utcHour: number): Date {
  const today = todaysRunTime(after, utcHour);
  return today.getTime() > after.getTime() ? today : new Date(today.getTime() + DAY_MS);
}

/** True when today's scheduled time has already passed, i.e. this process missed it (or just started late). */
export function shouldCatchUp(now: Date, utcHour: number): boolean {
  return todaysRunTime(now, utcHour).getTime() <= now.getTime();
}
