// Who may do what in the customer zone. ONE place.
//
// Self sign-up (CUSTOMER_SELF_SIGNUP, default true) decides whether register creates accounts at all and
// whether verifying an email switches login on. When it is false, only customers staff created and
// enabled (loginEnabled) can use the app, setting their password through "forgot password".

import type { UserType } from "@prisma/client";
import { getPrisma } from "./prisma.js";

export interface CustomerLoginState {
  userType: UserType;
  loginEnabled: boolean;
  password: string | null;
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
}

/** May this account sign in, refresh a session, or use a customer access token right now? */
export function canCustomerLogin(user: CustomerLoginState): boolean {
  return (
    user.userType === "CUSTOMER" &&
    user.deletedAt === null &&
    user.loginEnabled &&
    user.password !== null &&
    user.emailVerifiedAt !== null
  );
}

/** May a stranger create a customer account through register? */
export function selfSignupAllowed(flag: boolean): boolean {
  return flag;
}

/** Does verifying an email switch login on (a self-registered account), or does staff have to? */
export function verificationEnablesLogin(flag: boolean): boolean {
  return flag;
}

/**
 * The customer account for this id and org if it may use the API RIGHT NOW (exists in that org, is a customer, not deleted, login
 * on, password set, email verified), otherwise null. Read from the database every time: the customer guard and the file links both
 * use it, so disabling an account takes effect at once.
 */
export async function findActiveCustomer(id: string, orgId: string): Promise<{ id: string; orgId: string; name: string } | null> {
  const user = await getPrisma().user.findFirst({
    where: { id, org_id: orgId },
    select: { id: true, org_id: true, name: true, userType: true, loginEnabled: true, password: true, emailVerifiedAt: true, deletedAt: true },
  });
  return user && canCustomerLogin(user) ? { id: user.id, orgId: user.org_id, name: user.name } : null;
}
