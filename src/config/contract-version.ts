// The version of the staff contract (docs/staff-frontend-integration.md). Sent on EVERY /api/v1 response as X-Contract-Version, so a
// client can notice a newer contract. ONE constant: tests/staff-frontend-contract.test.ts fails if it differs from the version written
// at the top of that document. Change both together (and the changelog in the document).
export const CONTRACT_VERSION = "1.7.0";
export const CONTRACT_VERSION_HEADER = "X-Contract-Version";
