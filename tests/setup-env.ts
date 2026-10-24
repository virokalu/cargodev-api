// Dummy environment for unit tests. Fake values only; nothing here is real.
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test_dummy";
process.env["MOBILE_JWT_SECRET"] = "test-only-dummy-value-0123456789abcdef";
process.env["ORG_ID"] = "org_test_a";
