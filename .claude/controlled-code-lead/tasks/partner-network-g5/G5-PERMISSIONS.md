# G5 Permissions

Single tier: `requireAdmin` (server/auth.ts) — the top MintVault admin privilege; no new admin tier, no partner-facing auth. Actor identity ALWAYS server-derived from `req.session.authUserId`/`adminEmail`; never from body/header/param. Cross-tenant reads/writes via the privileged `partnerAdminQuery`, mirroring the existing shell; each query scopes by the URL `:partnerId` = `tenant_id` explicitly (admin pool has no RLS context).

| Caller | G5 endpoints | Enforced by |
|---|---|---|
| Unauthenticated | 401 | requireAdmin (no session.isAdmin) |
| Ordinary customer | 401 | requireAdmin |
| Partner user (mv.partner.sid) | 401 | different cookie/system; requireAdmin sees no isAdmin |
| Grader | 403 | requireAdmin explicit grader 403 |
| Staff (capability, not admin) | 401 | requireAdmin |
| Admin, stale credentialVersion / past absolute age | 401 | requireAdmin per-request recheck |
| Live Super-Admin | allow | requireAdmin pass |

Tenancy defense-in-depth: new tables get FORCE RLS + tenant policy; `partner_runtime` gets SELECT only on profiles/contacts/branding (RLS-scoped) and NOTHING on internal_notes/management_audit (never partner-visible). Internal notes and the management audit are DB-immutable (SELECT+INSERT to partner_connector_runtime, 42501 on UPDATE/DELETE). Client-side hiding is never security — every check is server-side.
