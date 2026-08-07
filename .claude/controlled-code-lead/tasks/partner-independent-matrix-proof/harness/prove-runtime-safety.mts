/**
 * PRE-TEST runtime-role safety proof for one matrix environment.
 *
 * The matrix is only worth running if the role the application code runs as is genuinely
 * restricted. If `partner_runtime` silently came up as a superuser or with BYPASSRLS, every
 * "tenant A cannot see tenant B" assertion in the suite would pass while proving nothing — and it
 * would pass identically in A and in B, so even the A/B comparison would not catch it.
 *
 * So this runs BEFORE any suite, on its own database, and proves five things directly:
 *   1. the effective role really is partner_runtime, and it is NOT a superuser
 *   2. it does NOT have BYPASSRLS, and row_security is ON for it
 *   3. with NO tenant context set, it sees ZERO rows — it fails CLOSED rather than falling back
 *      to "everything"
 *   4. with tenant A's context set, it sees tenant A's row and NOT tenant B's
 *   5. the tenant GUC is transaction-local, so no identity leaks into the next statement
 *
 * It uses the same helper the suites use (tests/helpers/partner-realistic-db.ts), so the role model
 * proven here is the role model the suites run under, not a hand-rolled approximation. Every
 * identifier it creates is generated fresh for this run.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { applyMigrationsRealistic, PARTNER_MIGRATIONS } from "../../../../../tests/helpers/partner-realistic-db.ts";

const label = (process.argv[2] ?? "").toUpperCase();
if (label !== "A" && label !== "B") throw new Error("usage: prove-runtime-safety.mts <A|B>");

const prefix = process.env.PARTNER_MATRIX_DB_PREFIX;
const sample = process.env.PARTNER_RLS_DB;
if (!prefix || !sample) throw new Error("PARTNER_MATRIX_DB_PREFIX and PARTNER_RLS_DB must be exported");

const adminUrl = (() => {
  const u = new URL(sample);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new Error(`refusing a non-loopback proof database: ${u.hostname}`);
  }
  u.pathname = `/${prefix}mintvault_partner_matrix_rlsproof`;
  return u.toString();
})();

const ok = (claim: string) => console.log(`  PROVEN  ${claim}`);
function fail(claim: string, detail: string): never {
  console.error(`  FAILED  ${claim}: ${detail}`);
  process.exit(1);
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
console.log(`[${label}] runtime-safety proof database: ${new URL(adminUrl).pathname.slice(1)}`);

try {
  await applyMigrationsRealistic(admin, adminUrl, PARTNER_MIGRATIONS);

  // Fresh identifiers for THIS matrix run. Nothing here is reused between A and B.
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const emailA = `matrix-${label.toLowerCase()}-a-${randomUUID()}@example.invalid`;
  const emailB = `matrix-${label.toLowerCase()}-b-${randomUUID()}@example.invalid`;
  console.log(`[${label}] fresh tenants: ${tenantA} / ${tenantB}`);

  await admin.query(
    `INSERT INTO partner_organisations (id, legal_name, status) VALUES ($1,$2,'ACTIVE'), ($3,$4,'ACTIVE')`,
    [tenantA, `Matrix ${label} Tenant A ${tenantA.slice(0, 8)}`, tenantB, `Matrix ${label} Tenant B ${tenantB.slice(0, 8)}`]
  );
  await admin.query(
    `INSERT INTO partner_customers (tenant_id, full_name, email) VALUES ($1,$2,$3), ($4,$5,$6)`,
    [tenantA, `Matrix ${label} Customer A`, emailA, tenantB, `Matrix ${label} Customer B`, emailB]
  );

  const runtime = new pg.Client({ connectionString: adminUrl });
  await runtime.connect();
  try {
    await runtime.query("SET ROLE partner_runtime");

    const who = await runtime.query<{
      user_name: string;
      superuser: string;
      row_security: string;
      bypassrls: boolean;
    }>(
      `SELECT current_user AS user_name,
              current_setting('is_superuser') AS superuser,
              current_setting('row_security') AS row_security,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`
    );
    const r = who.rows[0];
    console.log(`[${label}] effective role: ${JSON.stringify(r)}`);
    if (r.user_name !== "partner_runtime") fail("effective role is partner_runtime", r.user_name);
    if (r.superuser !== "off") fail("partner_runtime is NOT a superuser", `is_superuser=${r.superuser}`);
    if (r.bypassrls !== false) fail("partner_runtime is NOBYPASSRLS", `rolbypassrls=${r.bypassrls}`);
    if (r.row_security !== "on") fail("row_security is enforced", `row_security=${r.row_security}`);
    ok("partner_runtime: NOSUPERUSER, NOBYPASSRLS, row_security=on");

    // 3. No tenant context at all -> must see NOTHING, not everything.
    await runtime.query("BEGIN");
    const blind = await runtime.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_customers");
    await runtime.query("ROLLBACK");
    if (blind.rows[0].n !== "0") {
      fail("absent tenant context fails CLOSED", `saw ${blind.rows[0].n} customer row(s) with no app.tenant_id`);
    }
    ok("absent tenant context fails CLOSED (0 rows visible)");

    // 4. Tenant A's context -> exactly tenant A's row.
    await runtime.query("BEGIN");
    await runtime.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    const scoped = await runtime.query<{ email: string }>("SELECT email FROM partner_customers ORDER BY email");
    await runtime.query("ROLLBACK");
    const emails = scoped.rows.map((x) => x.email);
    if (emails.length !== 1 || emails[0] !== emailA) {
      fail("tenant context scopes to exactly one tenant", `saw ${JSON.stringify(emails)}`);
    }
    ok("tenant A context sees ONLY tenant A's row (tenant B invisible)");

    // 5. The GUC must not survive the transaction, or a later statement inherits an identity.
    const leaked = await runtime.query<{ t: string | null }>(
      "SELECT NULLIF(current_setting('app.tenant_id', true), '') AS t"
    );
    if (leaked.rows[0].t !== null) fail("tenant GUC is transaction-local", `leaked ${leaked.rows[0].t}`);
    ok("tenant GUC is transaction-local (does not leak past ROLLBACK)");

    console.log(
      "RUNTIME_SAFETY_JSON " +
        JSON.stringify({
          matrix: label,
          proofDatabase: new URL(adminUrl).pathname.slice(1),
          tenantA,
          tenantB,
          effectiveRole: r.user_name,
          superuser: r.superuser,
          bypassrls: r.bypassrls,
          rowSecurity: r.row_security,
        })
    );
  } finally {
    await runtime.end();
  }
} finally {
  await admin.end();
}
