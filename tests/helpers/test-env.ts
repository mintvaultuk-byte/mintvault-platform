/**
 * Dummy, never-connected env so server modules that construct a pg Pool / read
 * config at IMPORT time (server/db.ts → getDatabaseUrl) can load inside the
 * isolated HTTP harness.
 *
 * These are NOT real secrets and point at a non-existent localhost DB: the
 * harness never opens a DB connection, runs a query, or calls any provider (the
 * pg Pool is lazy — it only connects on first query, which never happens). This
 * is what keeps the Phase 6 harness "cannot use production databases/providers".
 *
 * Imported FIRST (before any ../../server/* import) so the assignment runs before
 * those modules evaluate. `??=` keeps any value a CI/integration job already set.
 */
process.env.MINTVAULT_DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/mintvault_test";
process.env.SCANNER_API_TOKEN ??= "test-scanner-token-value-1234567890";
process.env.SESSION_SECRET ??= "test-session-secret-not-real";
process.env.SIGNED_URL_SECRET ??= "test-signed-url-secret-not-real";
