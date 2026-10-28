// Fake two-org vehicle data for the vehicle read-path tests. All names, serials and
// ids are invented.

import { createFakePrisma, type FakePrisma } from "./fake-prisma.js";
import { ORG_A, ORG_B } from "./fixtures.js";

export const VEHICLE_RELATIONS = {
  vehicle: {
    model: { model: "vehicleModelRef", fk: "modelId" },
    grade: { model: "grade", fk: "gradeId" },
    auctionHall: { model: "auctionHall", fk: "auctionHallId" },
    supplier: { model: "supplier", fk: "supplierId" },
    customer: { model: "user", fk: "customerId" },
    freightAgent: { model: "freightAgent", fk: "freightAgentId" },
    packingAgent: { model: "packingAgent", fk: "packingAgentId" },
    transportBy: { model: "transportCompany", fk: "transportById" },
    vehicleLocation: { model: "vehicleLocation", fk: "vehicleLocationId" },
    rowColourStatus: { model: "rowColourStatus", fk: "rowColourStatusId" },
    inspectionCompany: { model: "inspectionCompany", fk: "inspectionCompanyId" },
    inspectionBy: { model: "inspectionBy", fk: "inspectionById" },
    photos: { model: "vehiclePhoto", fk: "vehicleId", many: true },
    documents: { model: "vehicleDocument", fk: "vehicleId", many: true },
  },
  vehiclePhoto: { uploadedBy: { model: "user", fk: "uploadedById" }, vehicle: { model: "vehicle", fk: "vehicleId" } },
  vehicleDocument: { uploadedBy: { model: "user", fk: "uploadedById" }, vehicle: { model: "vehicle", fk: "vehicleId" } },
  vehicleMilestone: { recordedBy: { model: "user", fk: "recordedById" } },
  vehicleModelRef: { brand: { model: "brand", fk: "brand_id" } },
  conversation: { customer: { model: "user", fk: "customerId" } },
  statusHistory: { vehicle: { model: "vehicle", fk: "vehicleId" } },
} as const;

/** Local midnight `days` from today (negative = past). */
export const dayOffset = (days: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
};

type Row = Record<string, unknown>;

/** A vehicle with every selected column present, so projections never see undefined. */
export function vehicleRow(over: Row & { id: string; org_id: string; serial: string }): Row {
  const serialPrefix = (over["serialPrefix"] as string | undefined) ?? (over.serial.startsWith("FL") ? "FL" : "FC");
  return {
    serialNumber: Number(over.serial.replace(/\D/g, "")),
    convertedToExport: false,
    convertedToLocal: false,
    deletedAt: null,
    shipmentStatus: "PENDING",
    auctionItemNo: null, chassisNo: null, yom: null, purchaseDate: null, auctionLotNo: null,
    destination: null, hasPartnership: false, partnerName: null,
    deliveryDate: null, paidByCustomer: null, sellingPrice: null, sellingPriceCurrency: null,
    etd: null, eta: null, blNo: null, vesselName: null, shippingMethod: null, vanningDate: null,
    containerNumber: null, hasInspection: false, inspectionDate: null, massoDate: null,
    trackingNumber: null, lcNo: null, docsArrivedDate: null,
    auctionBillPaid: null, logBook: null, extraKey: null, nameChangeDeadline: null,
    docSentDate: null, docSentComment: null, recycleDate: null, jibaishake: null, vehicleRemark: null,
    modelId: null, gradeId: null, auctionHallId: null, supplierId: null, customerId: null,
    freightAgentId: null, packingAgentId: null, transportById: null, vehicleLocationId: null,
    rowColourStatusId: null, inspectionCompanyId: null, inspectionById: null,
    ...over,
    serialPrefix,
  };
}

export function seedVehicleWorld(fake: FakePrisma) {
  fake.seed(
    "brand",
    { id: "brand_a1", org_id: ORG_A, name: "Alpha Motors" },
    { id: "brand_a2", org_id: ORG_A, name: "Beta Autos" },
    { id: "brand_b1", org_id: ORG_B, name: "Gamma Cars" }
  );
  fake.seed(
    "vehicleModelRef",
    { id: "model_a1", org_id: ORG_A, brand_id: "brand_a1", name: "Zeta One" },
    { id: "model_a2", org_id: ORG_A, brand_id: "brand_a2", name: "Eta Two" },
    { id: "model_b1", org_id: ORG_B, brand_id: "brand_b1", name: "Theta Three" }
  );
  fake.seed("grade", { id: "grade_a1", org_id: ORG_A, model_id: "model_a1", name: "Base" });
  fake.seed(
    "user",
    { id: "cust_a1", org_id: ORG_A, userType: "CUSTOMER", name: "Iota Buyer" },
    { id: "cust_a2", org_id: ORG_A, userType: "CUSTOMER", name: "Kappa Buyer" },
    { id: "cust_b1", org_id: ORG_B, userType: "CUSTOMER", name: "Lambda Buyer" },
    { id: "staff_a1", org_id: ORG_A, userType: "STAFF", name: "Staff Actor A" },
    { id: "staff_b1", org_id: ORG_B, userType: "STAFF", name: "Staff Actor B" }
  );
  fake.seed(
    "rowColourStatus",
    { id: "rc_cancel", org_id: ORG_A, name: "Unit Canceled", colour: "#ff0000", transportCellOnly: false },
    { id: "rc_resold", org_id: ORG_A, name: "Resold in Auction", colour: "#ff8800", transportCellOnly: false },
    { id: "rc_done", org_id: ORG_A, name: "Transport Complete", colour: "#00ff00", transportCellOnly: true },
    { id: "rc_b_cancel", org_id: ORG_B, name: "Unit Canceled", colour: "#ff0000", transportCellOnly: false }
  );
  fake.seed("freightAgent", { id: "fa_a1", org_id: ORG_A, name: "Agent A", offersRoro: true, offersContainer: true });

  fake.seed(
    "vehicle",
    // --- Org A ---
    vehicleRow({
      id: "v_fc_pending", org_id: ORG_A, serial: "FC101", chassisNo: "CHASSIS-AAA-1", modelId: "model_a1",
      gradeId: "grade_a1", customerId: "cust_a1", destination: "Country One", purchaseDate: dayOffset(-30),
      auctionBillPaid: null, yom: 2020, freightAgentId: "fa_a1", sellingPrice: null,
    }),
    vehicleRow({
      id: "v_fc_booked_future", org_id: ORG_A, serial: "FC102", chassisNo: "CHASSIS-AAA-2", modelId: "model_a2",
      shipmentStatus: "BOOKING_RECEIVED", etd: dayOffset(10), destination: "Country Two",
      purchaseDate: dayOffset(-20), auctionBillPaid: true, customerId: "cust_a2",
    }),
    vehicleRow({
      id: "v_fc_booked_past", org_id: ORG_A, serial: "FC103", chassisNo: "CHASSIS-AAA-3", modelId: "model_a1",
      shipmentStatus: "BOOKING_RECEIVED", etd: dayOffset(-5), destination: "Country One",
      purchaseDate: dayOffset(-10), auctionBillPaid: false,
    }),
    vehicleRow({
      id: "v_fc_shipped", org_id: ORG_A, serial: "FC104", chassisNo: "CHASSIS-AAA-4", modelId: "model_a1",
      shipmentStatus: "SHIPPED", etd: dayOffset(-40), purchaseDate: dayOffset(-60),
    }),
    vehicleRow({
      id: "v_fc_cancelled", org_id: ORG_A, serial: "FC105", chassisNo: "CHASSIS-AAA-5", modelId: "model_a1",
      shipmentStatus: "BOOKING_RECEIVED", etd: dayOffset(10), rowColourStatusId: "rc_cancel", purchaseDate: dayOffset(-3),
    }),
    vehicleRow({
      id: "v_fc_deleted", org_id: ORG_A, serial: "FC106", chassisNo: "CHASSIS-DELETED", modelId: "model_a1",
      deletedAt: dayOffset(-1),
    }),
    // Cancelled while stored PENDING / stored SHIPPED: neither filter may include them.
    vehicleRow({
      id: "v_fc_resold", org_id: ORG_A, serial: "FC108", chassisNo: "CHASSIS-AAA-8", modelId: "model_a1",
      shipmentStatus: "PENDING", rowColourStatusId: "rc_resold",
    }),
    vehicleRow({
      id: "v_fc_cancelled_shipped", org_id: ORG_A, serial: "FC109", chassisNo: "CHASSIS-AAA-9", modelId: "model_a1",
      shipmentStatus: "SHIPPED", etd: dayOffset(-30), rowColourStatusId: "rc_cancel",
    }),
    vehicleRow({
      id: "v_fl_native", org_id: ORG_A, serial: "FL201", chassisNo: "CHASSIS-LLL-1", modelId: "model_a2",
      hasPartnership: true, partnerName: "Partner One", paidByCustomer: true, sellingPrice: 12345,
      sellingPriceCurrency: "USD", customerId: "cust_a1", rowColourStatusId: "rc_cancel",
      purchaseDate: dayOffset(-15), destination: "Local Town",
    }),
    vehicleRow({
      id: "v_fl_to_export", org_id: ORG_A, serial: "FL202", chassisNo: "CHASSIS-LLL-2", modelId: "model_a1",
      convertedToExport: true, shipmentStatus: "BOOKING_RECEIVED", etd: dayOffset(7), destination: "Country Two",
    }),
    vehicleRow({
      id: "v_fc_to_local", org_id: ORG_A, serial: "FC107", chassisNo: "CHASSIS-AAA-7", modelId: "model_a1",
      convertedToLocal: true, partnerName: "Partner Two", hasPartnership: true,
    }),
    // --- Org B (same serial as one of A's, on purpose) ---
    vehicleRow({
      id: "v_b_fc", org_id: ORG_B, serial: "FC101", chassisNo: "CHASSIS-BBB-1", modelId: "model_b1",
      customerId: "cust_b1", destination: "Org B Country", partnerName: "Org B Partner",
    }),
    vehicleRow({ id: "v_b_other", org_id: ORG_B, serial: "FC900", chassisNo: "CHASSIS-BBB-9", modelId: "model_b1" })
  );

  fake.seed(
    "statusHistory",
    { id: "sh1", vehicleId: "v_fc_booked_future", fromStatus: null, toStatus: "PENDING", trigger: "LEGACY_ENTRY", triggeredBy: "staff_a1", createdAt: new Date(2026, 0, 1) },
    { id: "sh2", vehicleId: "v_fc_booked_future", fromStatus: "PENDING", toStatus: "BOOKING_RECEIVED", trigger: "ETD_SAVED", triggeredBy: "staff_a1", createdAt: new Date(2026, 0, 2) },
    { id: "sh3", vehicleId: "v_fc_booked_future", fromStatus: "BOOKING_RECEIVED", toStatus: "PENDING", trigger: "ETD_CLEARED", triggeredBy: "staff_b1", createdAt: new Date(2026, 0, 3) },
    { id: "sh4", vehicleId: "v_fc_booked_future", fromStatus: "PENDING", toStatus: "BOOKING_RECEIVED", trigger: "ETD_SAVED", triggeredBy: "staff_a1", createdAt: new Date(2026, 0, 4) },
    { id: "sh5", vehicleId: "v_fc_booked_future", fromStatus: "BOOKING_RECEIVED", toStatus: "SHIPPED", trigger: "CRON_JOB", triggeredBy: null, createdAt: new Date(2026, 0, 5) },
    { id: "sh6", vehicleId: "v_b_fc", fromStatus: null, toStatus: "PENDING", trigger: "ETD_SAVED", triggeredBy: "staff_b1", createdAt: new Date(2026, 0, 1) }
  );
}

export function newVehicleFake(): FakePrisma {
  const fake = createFakePrisma({ relations: VEHICLE_RELATIONS as never });
  seedVehicleWorld(fake);
  return fake;
}
