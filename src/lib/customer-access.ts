// Who may do what in the customer zone. ONE place.
//
// Self sign-up (CUSTOMER_SELF_SIGNUP, default true) decides whether register creates accounts at all and
// whether verifying an email switches login on. When it is false, only customers staff created and
// enabled (loginEnabled) can use the app, setting their password through "forgot password".

import type { UserType } from "@prisma/client";

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
