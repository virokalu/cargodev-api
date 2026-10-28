// Graceful shutdown on SIGTERM / SIGINT. In order:
//   1. stop accepting requests, tell every open stream `event: shutdown`, and wait for a running scheduled job
//      (all of that is app.close(): its preClose hook closes the streams, its onClose hook waits for the scheduler for at
//      most SCHEDULER_SHUTDOWN_TIMEOUT_MS);
//   2. close the database pool;
//   3. exit 0.
// The whole thing has a deadline (SHUTDOWN_TIMEOUT_MS, default 30 s). If anything hangs, the process exits 1 anyway, so a
// deploy never waits forever. A second signal is ignored.

export interface ShutdownDeps {
  /** app.close(): stop accepting, close streams, wait for the scheduler. */
  close(): Promise<void>;
  /** Close the database pool. Always attempted, even if close() failed. */
  disconnect(): Promise<void>;
  exit(code: number): void;
  log: { info(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
  timeoutMs: number;
}

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let started = false;
  return async function shutdown(signal: string): Promise<void> {
    if (started) return;
    started = true;
    deps.log.info({ signal, timeoutMs: deps.timeoutMs }, "shutting down");

    const deadline = setTimeout(() => {
      deps.log.error({ signal }, "shutdown did not finish in time; exiting");
      deps.exit(1);
    }, deps.timeoutMs);

    let failed = false;
    try {
      await deps.close();
    } catch (error) {
      failed = true;
      deps.log.error({ message: error instanceof Error ? error.message : "unknown" }, "error while closing the server");
    }
    try {
      await deps.disconnect();
    } catch (error) {
      failed = true;
      deps.log.error({ message: error instanceof Error ? error.message : "unknown" }, "error while closing the database pool");
    }
    clearTimeout(deadline);
    deps.exit(failed ? 1 : 0);
  };
}
