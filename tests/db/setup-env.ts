// Environment for the real-database tests.
process.env["NODE_ENV"] = "test";
process.env["MOBILE_JWT_SECRET"] = "test-only-dummy-value-0123456789abcdef";
process.env["ORG_ID"] = "org_test_a";
process.env["SCHEDULER_ENABLED"] = "false";

// The application's DATABASE_URL is deliberately overwritten with an address that cannot
// resolve. These tests talk to the database ONLY through TEST_DATABASE_URL (see helpers/db.ts),
// so even a code path that forgot to use the test client could never reach a real database.
process.env["DATABASE_URL"] = "postgresql://never-used:never-used@invalid.invalid:5432/never_used";
