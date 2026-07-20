# G5 Review Checklist (7 panels)

1. **Auth/session** — single requireAdmin mount; server-derived actor; CSRF global; own rate-limiter; no partner-session confusion; no header auth; no new admin tier.
2. **Tenancy/RLS** — every tenant table: tenant_id NOT NULL + FORCE RLS + %I_tenant_isolation policy; cross-tenant denial; admin privileged reads intentional + explicit WHERE tenant_id; no unsafe pool use; internal notes not partner-readable.
3. **DB/migration/audit** — 0015 additive; rollback; grants (no PUBLIC); ownership; indexes (no speculative); append-only 42501; audit completeness; no partner_organisations ALTER; parity test unaffected.
4. **API security/redaction** — input validation; injection-safe (parameterised filter builder); bounded queries; safe projections (no SELECT *); no secret leaks; stable errors; no stack/SQL leak.
5. **Partner-domain correctness** — status transition matrix (existing 4 values); contact primary/soft-deactivate rules; branding metadata-only boundaries; note immutability; activity correctness; statistics correctness (unavailable labeled); NO wallet/slot/billing behaviour; status = label-only (no side effects).
6. **Concurrency/idempotency** — expectedVersion/row-lock; no lost updates; idempotency replay; concurrent primary-contact safety; concurrent status safety; no duplicate effects; write+audit atomicity.
7. **UI/a11y/scope/regression** — AdminShell consistency; nav additive-only (no reorder); responsive; a11y (dialog/labels/Escape/focus/no colour-only); future controls absent (negative asserts); /admin/partner-network still works; no portal mount; no flag writes; no protected-system edits; changed files within allow-list.

Fix all Critical/High/material-Medium; document accepted Low. Lead verifies every material finding against the repo.
