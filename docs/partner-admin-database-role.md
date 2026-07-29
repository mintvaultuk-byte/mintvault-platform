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

The readiness response intentionally reports only safe fields: whether the check ran, readiness,
the capability name, timestamp, and a generic failure code. It must not expose database URLs,
passwords, full connection strings, or role metadata.
