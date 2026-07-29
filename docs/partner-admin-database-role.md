# Partner Super Admin Database Role

Partner Super Admin user-management routes use `PARTNER_ADMIN_DATABASE_URL`, falling back to
`MINTVAULT_DATABASE_URL` only when the dedicated URL is not configured. This pool powers cross-tenant
partner user listing, invitation create/resend/revoke, role changes, suspend/reactivate, membership
revocation, session revocation, and the guarded legacy `/api/super-admin/grading-partners/*` user
status path.

Deployment precondition:

- The dedicated Partner Super Admin database role must have PostgreSQL `BYPASSRLS`.
- The Partner runtime role used by `PARTNER_DATABASE_URL` must not have `BYPASSRLS`.
- Partner tables must keep `FORCE ROW LEVEL SECURITY`; do not weaken RLS to make Super Admin routes
  work.

Operators can verify the subsystem through:

`GET /api/super-admin/partner-management/readiness`

Caching contract: the capability check is verified on first use and a SUCCESS is then cached for the
life of the process. Failures are never cached — they are re-checked on every request, so restoring
the grant (or the database) recovers without a restart. The corollary is that REVOKING `BYPASSRLS`
from a running process is not detected until it restarts. If you revoke the grant, restart the app.

When readiness fails:

1. Read `failureCode`. `PARTNER_ADMIN_BYPASSRLS_REQUIRED` means the role behind
   `PARTNER_ADMIN_DATABASE_URL` needs `ALTER ROLE <role> BYPASSRLS`. `PARTNER_ADMIN_DB_UNAVAILABLE`
   or `PARTNER_CAPABILITY_TIMEOUT` means the database is unreachable or slow.
   `PART_ROLE_LOOKUP_EMPTY` means the connected role is not visible in `pg_roles`.
2. Fix the cause, then re-check readiness — no redeploy is needed for a failure to clear.
3. Do NOT weaken RLS to make the routes work. Every Super Admin management route returns 503 until
   readiness passes; that is the intended behaviour, not an outage to work around.

Do not enable `partner_login_enabled` or `partner_onboarding_enabled` until readiness returns 200.
Both are global rows in `partner_feature_flags` (`tenant_id IS NULL`) and must be inserted directly;
no application route can set a global flag.

The readiness response intentionally reports only safe fields: whether the check ran, readiness,
the capability name, timestamp, and a generic failure code. It must not expose database URLs,
passwords, full connection strings, or role metadata.
