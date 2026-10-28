// Dummy environment for unit tests. Fake values only; nothing here is real.
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = "postgresql://user:password@localhost:5432/test_dummy";
process.env["MOBILE_JWT_SECRET"] = "test-only-dummy-value-0123456789abcdef";
process.env["ORG_ID"] = "org_test_a";
// Tests never run scheduled jobs on their own.
process.env["SCHEDULER_ENABLED"] = "false";
// Tests must never be able to send real email, even if a developer's shell has a key.
delete process.env["RESEND_API_KEY"];
delete process.env["EMAIL_FROM"];
process.env["CUSTOMER_JWT_SECRET"] = "test-only-customer-value-0123456789abcdef";
process.env["OTP_PEPPER"] = "test-only-otp-pepper-value-0123456789abcdef";
process.env["PUBLIC_STOCK_IMAGE_BASE_URL"] = "https://img.example.test";
// Most unit tests mint staff tokens for users that exist only in the token. They take the token's claims; the tests that prove the
// database check (staff-auth-freshness, route inventory, tests/db) switch this off. The seam works only when NODE_ENV is "test".
import { setTrustTokenClaimsForTests } from "../src/lib/staff-auth-seam.js";
setTrustTokenClaimsForTests(true);
