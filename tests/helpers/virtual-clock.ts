// A virtual clock for timing tests. Wall-clock assertions ("took less than 60 ms", "at least 115 ms") depend on how busy the
// machine is. Here Date and setTimeout are faked, and whenever the work is waiting on a timer the clock jumps straight to it. The
// elapsed time is therefore the sum of the timers the work really waited on, however slow or loaded the machine is: 0 ms of
// waiting costs 0 virtual ms, and a response floor of 120 ms costs exactly 120. A branch that awaits something extra (an email
// send, a retry delay) shows up as extra virtual time.

import { vi } from "vitest";

export async function onVirtualClock<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    const started = Date.now();
    let settled = false;
    const running = work().finally(() => {
      settled = true;
    });
    while (!settled) {
      // Let the real work (microtasks, I/O callbacks) run first; only when it waits on a timer does the clock move.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!settled && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    }
    const result = await running;
    const ms = Date.now() - started;
    // Whatever was left waiting (an email queued for after the response) finishes on the virtual clock too.
    await vi.runAllTimersAsync();
    return { result, ms };
  } finally {
    vi.useRealTimers();
  }
}
