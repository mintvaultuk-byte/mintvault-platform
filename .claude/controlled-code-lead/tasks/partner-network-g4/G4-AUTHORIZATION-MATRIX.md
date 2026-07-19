# G4 Authorization Matrix

Single tier: `requireAdmin` (`server/auth.ts:146`) is the top privilege — no separate super-admin role exists. All G4 routes: `router.use(requireAdmin)`. Actor identity is ALWAYS server-derived from `req.session` (`authUserId`, `adminEmail`), NEVER from body/header/param. Tenant/partner identity for cross-tenant admin reads comes from the URL param + privileged admin pool (no RLS), mirroring the existing shell — but a record's real tenant is still validated by the G3F service (`tenantId` mismatch → `unauthorised`).

| Caller | Read endpoints | Mutation endpoints | Enforced by |
|---|---|---|---|
| Unauthenticated | 401 | 401 | `requireAdmin` (no `session.isAdmin`) |
| Ordinary customer session | 401 | 401 | `requireAdmin` |
| Partner user (`mv.partner.sid`) | 401 | 401 | different cookie/system; `requireAdmin` sees no `isAdmin` |
| Grader (`isGrader`) | 403 | 403 | `requireAdmin` explicit grader 403 |
| Staff (capability flags, not admin) | 401 | 401 | `requireAdmin` (staff not admin; mutually exclusive cookie) |
| Admin with stale credentialVersion | 401 | 401 | `requireAdmin` per-request credentialVersion recheck |
| Admin past absolute session age (7d) | 401 | 401 | `requireAdmin` absolute-age recheck |
| Authenticated live Super-Admin | allow | allow | `requireAdmin` pass |

Cross-tenant safety: a G4 request cannot force access to another tenant's record by spoofing a body/param tenantId — the read path scopes by the record's own row; the mutation path passes the record's real `tenantId` to the G3F service which rejects mismatches (`unauthorised`). Tests: unauth/customer/partner/grader/staff/stale-admin denied; live admin allowed; cross-tenant param spoof cannot widen access.

Client-side hiding is not security — every check is server-side in `requireAdmin` + the service `tenantId` guard.
