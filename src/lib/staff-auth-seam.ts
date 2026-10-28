// A test seam, nothing more. The unit tests mint staff tokens for users that exist only in the token, not in the fake database;
// for those tests (and only when NODE_ENV is "test") the auth hook may take the token's claims instead of reading the database.
// Tests that prove the database check switch it off. It has no effect in any other environment, whatever is called.
// This file imports nothing on purpose: the test setup file loads it before any mock is registered.

let trustTokenClaims = false;

export function setTrustTokenClaimsForTests(value: boolean): void {
  if (process.env["NODE_ENV"] !== "test") throw new Error("setTrustTokenClaimsForTests is for tests only");
  trustTokenClaims = value;
}

export function tokenClaimsAreTrusted(): boolean {
  return trustTokenClaims && process.env["NODE_ENV"] === "test";
}
