// Who may use the staff tools for customers (Phase 2, slice 4). One constant per capability, used by every route that
// needs it, so the rule is never copied.

import type { StaffRole } from "@prisma/client";

/** Enable or disable a customer's sign-in, assign an agent, release vehicles / photos / documents, edit what customers
 * see, manage FAQs, see who is online. */
export const CUSTOMER_ADMIN_ROLES: readonly StaffRole[] = ["ADMINISTRATOR", "MANAGER"];

/** Approve or reject a customer's request to be linked to a vehicle. */
export const LINK_REQUEST_DECIDERS: readonly StaffRole[] = CUSTOMER_ADMIN_ROLES;

/** Mark a vehicle arrived or delivered (the same people who can record any milestone). */
export const ARRIVAL_ROLES: readonly StaffRole[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR"];
