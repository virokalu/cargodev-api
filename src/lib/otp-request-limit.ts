// Hourly caps on requesting one-time codes, per address and per IP (config/otp-limits.ts). Both counters are always
// counted, so the work and the timing do not depend on which one tripped. Logs carry a masked address only.

import { OTP_REQUEST_LIMITS } from "../config/otp-limits.js";
import { maskEmail } from "./email.js";
import { identifierLimiter } from "./identifier-limiter.js";

/** True if a code may be issued for this request. Call once per code request, before looking the account up. */
export function otpRequestAllowed(email: string, ip: string | undefined): boolean {
  const addressOk = identifierLimiter.hit("otp-address", email, OTP_REQUEST_LIMITS.perAddress);
  const ipOk = ip ? identifierLimiter.hit("otp-ip", ip, OTP_REQUEST_LIMITS.perIp) : true;
  if (addressOk && ipOk) return true;
  console.warn(`one-time code request over the hourly cap (${addressOk ? "ip" : "address"}): to=${maskEmail(email)}`);
  return false;
}
