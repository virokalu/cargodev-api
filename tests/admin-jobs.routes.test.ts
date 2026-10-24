import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { buildApp } from "../src/app.js";
import { signAccessToken } from "../src/lib/mobile-jwt.js";
import type { LockFn } from "../src/scheduler/lock.js";
import { Scheduler, type JobResult, type ScheduledJob } from "../src/scheduler/scheduler.js";

type Role = "ADMINISTRATOR" | "MANAGER" | "OPERATOR" | "VIEWER";
const URL = "/api/v1/admin/jobs/daily-checks";
const OK: JobResult = { orgs: 2, failedOrgs: 0, counts: { reminders: 5 } };

let fake: FakePrisma;
let app: FastifyInstance;
const held = new Set<string>();
const lockCalls: string[] = [];

const lock: LockFn = async (name, work) => {
  lockCalls.push(name);
  if (held.has(name)) return { acquired: false };
  held.add(name);
  try {
    return { acquired: true, value: await work() };
  } finally {
    held.delete(name);
  }
};

const bearer = async (role: Role) => ({
  authorization: `Bearer ${await signAccessToken({ sub: `user_${role}`, orgId: ORG_A, role, name: `Test ${role}`, email: null })}`,
});

async function build(jobs: ScheduledJob[], enabled = false) {
  const scheduler = new Scheduler({
    jobs,
    utcHour: 2,
    enabled,
    lock,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  app = await buildApp({ rateLimit: false, scheduler });
}

const job = (run: () => Promise<JobResult>): ScheduledJob => ({ name: "daily-checks", run });
const post = async (role: Role, headers?: Record<string, string>) =>
  app.inject({ method: "POST", url: URL, headers: headers ?? (await bearer(role)) });

beforeEach(() => {
  fake = createFakePrisma();
  state.fake = fake;
  held.clear();
  lockCalls.length = 0;
});
afterEach(async () => {
  await app.close();
});

describe("POST /admin/jobs/daily-checks: access", () => {
  it("returns 401 without a token and for a forged one, and never runs the job", async () => {
    const run = vi.fn(async () => OK);
    await build([job(run)]);
    const none = await app.inject({ method: "POST", url: URL });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } });
    expect((await app.inject({ method: "POST", url: URL, headers: { authorization: "Bearer not.a.token" } })).statusCode).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["MANAGER", "OPERATOR", "VIEWER"] as Role[])("returns 403 for %s, and never runs the job", async (role) => {
    const run = vi.fn(async () => OK);
    await build([job(run)]);
    const res = await post(role);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(run).not.toHaveBeenCalled();
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("there is no shared-secret variant of this endpoint", async () => {
    await build([job(async () => OK)]);
    for (const url of ["/api/cron/daily-vehicle-checks", "/api/v1/cron/daily-vehicle-checks", "/api/v1/admin/jobs/daily-checks?secret=x"]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: "Bearer shared-secret-value" } });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("POST /admin/jobs/daily-checks: behaviour", () => {
  it("an ADMINISTRATOR runs the job and gets the outcome, in the success envelope", async () => {
    const run = vi.fn(async () => OK);
    await build([job(run)]);
    const res = await post("ADMINISTRATOR");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().data).toMatchObject({ status: "ran", result: OK });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("works on an instance with SCHEDULER_ENABLED=false (an explicit admin action)", async () => {
    await build([job(async () => OK)], false);
    expect((await post("ADMINISTRATOR")).json().data.status).toBe("ran");
  });

  it("takes the same cross-instance lock as the scheduled run", async () => {
    await build([job(async () => OK)]);
    await post("ADMINISTRATOR");
    expect(lockCalls).toEqual(["daily-checks"]);
  });

  it("writes an ActivityLog row recording who triggered it and what happened", async () => {
    await build([job(async () => OK)]);
    await post("ADMINISTRATOR");
    expect(fake.rows("activityLog")).toHaveLength(1);
    expect(fake.rows("activityLog")[0]).toMatchObject({
      org_id: ORG_A,
      actorId: "user_ADMINISTRATOR",
      action: "TRIGGER_JOB",
      entity: "Job",
      entityId: "daily-checks",
      after: { status: "ran", orgs: 2, failedOrgs: 0, counts: { reminders: 5 } },
    });
  });

  it("is idempotent to call: running it twice in a row is fine and each call is logged", async () => {
    const run = vi.fn(async () => OK);
    await build([job(run)]);
    expect((await post("ADMINISTRATOR")).json().data.status).toBe("ran");
    expect((await post("ADMINISTRATOR")).json().data.status).toBe("ran");
    expect(fake.rows("activityLog")).toHaveLength(2);
    expect(held.size).toBe(0); // lock released between runs
  });

  it("when another instance holds the lock the call is skipped, not an error, and is still logged", async () => {
    const run = vi.fn(async () => OK);
    await build([job(run)]);
    held.add("daily-checks");
    const res = await post("ADMINISTRATOR");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("skipped_locked");
    expect(run).not.toHaveBeenCalled();
    expect(fake.rows("activityLog")[0]).toMatchObject({ after: expect.objectContaining({ status: "skipped_locked" }) });
  });

  it("a second call while a run is in progress is skipped as an overlap", async () => {
    let release!: (value: JobResult) => void;
    const run = vi.fn(() => new Promise<JobResult>((resolve) => (release = resolve)));
    await build([job(run)]);

    const first = post("ADMINISTRATOR");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const second = await post("ADMINISTRATOR");
    expect(second.json().data.status).toBe("skipped_overlap");
    expect(run).toHaveBeenCalledTimes(1);

    release(OK);
    expect((await first).json().data.status).toBe("ran");
  });

  it("a failing job answers with status failed, and the internal error text is not returned", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await build([job(async () => Promise.reject(new Error("connection to db-host-internal failed, password=hunter2")))]);
    const res = await post("ADMINISTRATOR");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "failed" });
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("db-host-internal");
    expect(fake.rows("activityLog")[0]).toMatchObject({ after: expect.objectContaining({ status: "failed" }) });
    expect(JSON.stringify(fake.rows("activityLog"))).not.toContain("hunter2");
  });

  it("answers 404 when the job is not registered in this build, and logs nothing", async () => {
    await build([]);
    const res = await post("ADMINISTRATOR");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "NOT_FOUND", message: "That job is not available." });
    expect(fake.rows("activityLog")).toHaveLength(0);
  });

  it("the production build registers no job yet (the daily checks body is not ported)", async () => {
    app = await buildApp({ rateLimit: false });
    expect(app.scheduler.has("daily-checks")).toBe(false);
    expect((await post("ADMINISTRATOR")).statusCode).toBe(404);
  });
});

describe("app lifecycle", () => {
  it("app.close() stops the scheduler: no timer left armed", async () => {
    const scheduler = new Scheduler({ jobs: [job(async () => OK)], utcHour: 2, enabled: true, lock, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    app = await buildApp({ rateLimit: false, scheduler });
    scheduler.start();
    expect(scheduler.nextRunAt).not.toBeNull();
    await app.close();
    expect(scheduler.nextRunAt).toBeNull();
  });

  it("building an app never starts the scheduler by itself", async () => {
    const scheduler = new Scheduler({ jobs: [job(async () => OK)], utcHour: 2, enabled: true, lock, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    app = await buildApp({ rateLimit: false, scheduler });
    expect(scheduler.nextRunAt).toBeNull();
  });
});
