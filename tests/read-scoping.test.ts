// Dashboard, reports and organization are read-only aggregations. The fake
// returns empty results, so these tests assert the one thing that matters here:
// every query is scoped to the caller's org and never mentions another org.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma, mentionsOrg, type FakePrisma } from "./helpers/fake-prisma.js";
import { ORG_A, ORG_B } from "./helpers/fixtures.js";

const state = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  getPrisma: () => (state.fake as FakePrisma).client,
}));

import { getDashboardStats, getDashboardTrends } from "../src/services/dashboard.service.js";
import {
  getAuctionHallVehicleReport,
  getCustomerVehicleReport,
  getDestinationVehicleReport,
  getFreightAgentVehicleReport,
} from "../src/services/reports.service.js";
import { getOrganizationName } from "../src/services/organization.service.js";

let fake: FakePrisma;

beforeEach(() => {
  fake = createFakePrisma();
  state.fake = fake;
});

function expectAllQueriesScopedTo(orgId: string, otherOrgId: string) {
  const queries = fake.calls.filter((c) => c.model === "vehicle" || c.model === "user");
  expect(queries.length).toBeGreaterThan(0);
  for (const call of queries) {
    expect(mentionsOrg(call.args, orgId), `${call.model}.${call.method} must filter by org_id`).toBe(true);
    expect(mentionsOrg(call.args, otherOrgId)).toBe(false);
  }
}

describe("dashboard", () => {
  it("stats queries are all scoped to the caller's org", async () => {
    await getDashboardStats(ORG_A);
    expectAllQueriesScopedTo(ORG_A, ORG_B);
  });
  it("trends queries are all scoped to the caller's org", async () => {
    await getDashboardTrends(ORG_B);
    expectAllQueriesScopedTo(ORG_B, ORG_A);
  });
});

describe("reports", () => {
  it.each([
    ["customer", () => getCustomerVehicleReport(ORG_A, "FC")],
    ["auction hall", () => getAuctionHallVehicleReport(ORG_A, "FC")],
    ["destination", () => getDestinationVehicleReport(ORG_A, "FC")],
    ["freight agent", () => getFreightAgentVehicleReport(ORG_A)],
  ] as const)("%s report is scoped to the caller's org", async (_name, run) => {
    await run();
    expectAllQueriesScopedTo(ORG_A, ORG_B);
  });
});

describe("organization", () => {
  it("returns the org's own name", async () => {
    fake.seed("organization", { id: ORG_A, name: "Org A Name" }, { id: ORG_B, name: "Org B Name" });
    expect(await getOrganizationName(ORG_A)).toBe("Org A Name");
    expect(await getOrganizationName(ORG_B)).toBe("Org B Name");
  });
  it("falls back to a placeholder when the row is missing", async () => {
    expect(await getOrganizationName("org_test_missing")).toBe("Example Organization");
  });
});
