// Work that must happen AFTER the HTTP response has been sent (customer email). A request that sends an email and
// one that does not must look identical to the caller: same answer, same status, same timing. So handlers only
// queue the work here, and it runs once the response is on the wire (or the client has gone away).
//
// Outside a request (the scheduler, scripts, tests that call a service directly) the work runs on the next tick.

import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";

type Task = () => void | Promise<void>;

interface RequestTasks {
  tasks: Task[];
  flushed: boolean;
}

const context = new AsyncLocalStorage<RequestTasks>();
const byRequest = new WeakMap<object, RequestTasks>();
const inFlight = new Set<Promise<unknown>>();

function run(task: Task): void {
  const running = Promise.resolve()
    .then(task)
    .catch(() => undefined) // a task reports its own failures (sendEmail logs masked data); it never reaches a caller
    .finally(() => inFlight.delete(running));
  inFlight.add(running);
}

/** Runs `task` after the current response is sent. Never throws; a failing task cannot change the response. */
export function afterResponse(task: Task): void {
  const store = context.getStore();
  if (store && !store.flushed) {
    store.tasks.push(task);
    return;
  }
  setImmediate(() => run(task));
}

function flush(store: RequestTasks | undefined): void {
  if (!store || store.flushed) return;
  store.flushed = true;
  for (const task of store.tasks.splice(0)) run(task);
}

/** Waits for tasks that are already running. Tests and graceful shutdown. */
export async function drainAfterResponse(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

export function registerPostResponse(app: FastifyInstance): void {
  // done() is called INSIDE run(): everything after this hook (the handler included) sees the store.
  app.addHook("onRequest", (request, _reply, done) => {
    const store: RequestTasks = { tasks: [], flushed: false };
    byRequest.set(request.raw, store);
    context.run(store, done);
  });
  app.addHook("onResponse", (request, _reply, done) => {
    flush(byRequest.get(request.raw));
    done();
  });
  // The client went away before the answer was sent: the work is still owed.
  app.addHook("onRequestAbort", (request, done) => {
    flush(byRequest.get(request.raw));
    done();
  });
}
