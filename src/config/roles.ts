// Who may use the staff tools for customers (Phase 2, slice 4). One constant per capability, used by every route that
// needs it, so the rule is never copied.

import type { StaffRole } from "@prisma/client";

/** Enable or disable a customer's sign-in, assign an agent, release vehicles / photos / documents, edit what customers
 * see, manage FAQs, see who is online. */
export const CUSTOMER_ADMIN_ROLES: readonly StaffRole[] = ["ADMINISTRATOR", "MANAGER"];

/** Approve or reject a customer's request to be linked to a vehicle. */
export const LINK_REQUEST_DECIDERS: readonly StaffRole[] = CUSTOMER_ADMIN_ROLES;

/**
 * Customer chat (FTJ decision).
 *  - ADMINISTRATOR and MANAGER see every conversation in their org.
 *  - OPERATOR sees ONLY the conversations of customers whose `assignedAgentId` is that operator, checked against the
 *    database on every request. Any other conversation (another agent's, an unassigned customer's, another org's) is a 404.
 *  - VIEWER (and anyone else) has no access: 403 on every chat route.
 * Link request approval and rejection stay with CUSTOMER_ADMIN_ROLES; this list does not widen them.
 */
export const CHAT_FULL_ROLES: readonly StaffRole[] = ["ADMINISTRATOR", "MANAGER"];
export const CHAT_SCOPED_ROLES: readonly StaffRole[] = ["OPERATOR"];
/** Every role that may use a chat route at all (the route guard); the scope below narrows what each can reach. */
export const CHAT_ROLES: readonly StaffRole[] = [...CHAT_FULL_ROLES, ...CHAT_SCOPED_ROLES];

export type ChatScopeKind = "ALL" | "ASSIGNED";

/** The scoping rule: how much of the chat a role may reach. null means no access. */
export function chatScopeFor(role: StaffRole | null | undefined): ChatScopeKind | null {
  if (role && CHAT_FULL_ROLES.includes(role)) return "ALL";
  if (role && CHAT_SCOPED_ROLES.includes(role)) return "ASSIGNED";
  return null;
}

/**
 * May this role see a customer's contact details (email, phone, address)? A VIEWER sees names and counts only: they cannot read
 * the customer list's contact columns, search by them, or find them in a report. Every other role is unchanged.
 */
export function canSeeCustomerContact(role: StaffRole): boolean {
  return role !== "VIEWER";
}

/** See how ready a vehicle is to be shown to its customer (booleans and counts only, nothing is changed). */
export const RELEASE_READINESS_ROLES: readonly StaffRole[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR"];

/** Manage the public stock (create, edit, publish, images) and read the website enquiries. */
export const STOCK_ROLES: readonly StaffRole[] = CUSTOMER_ADMIN_ROLES;

/** Mark a vehicle arrived or delivered (the same people who can record any milestone). */
export const ARRIVAL_ROLES: readonly StaffRole[] = ["ADMINISTRATOR", "MANAGER", "OPERATOR"];
