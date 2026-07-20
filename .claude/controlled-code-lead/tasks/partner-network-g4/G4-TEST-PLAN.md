# G4 Test Plan

All DB tests use REAL disposable PostgreSQL (loopback, env-gated, `describe.skip` otherwise). No SQLite; no mocking of locks/txns/constraints/permissions/append-only/idempotency/concurrency.

## Groups
- **A. Migration (0014):** apply via real runner → journal `applied`; reapply = no-op; preflight ok; PUBLIC no privilege; runtime holds exactly `[INSERT,SELECT]`; rollback drops exactly the new table + removes the journal row + reapplies cleanly; append-only proven (UPDATE/DELETE/TRUNCATE → 42501; runtime not owner).
- **B. Authorization:** unauth/customer/partner/grader/staff/stale-credential-admin denied; live admin allowed; cross-tenant param spoof cannot widen. (real-HTTP integration mirroring `partner-admin-control-shell-integration.test.ts`.)
- **C. Read API:** pagination, filters, deterministic ordering, empty states, not-found, cross-tenant scoping, secret redaction (seed secret-looking config → absent from JSON).
- **D. Mutations:** every allowed + forbidden state transition per the action matrix; delegates to the real G3F service; forbidden side effects absent (no cert/label/payment/etc.).
- **E. Idempotency:** duplicate request (same idempotency key) → one logical effect + recorded result; conflicting key reuse rejected.
- **F. Concurrency:** parallel real PG connections — two admins on same record; completed cannot retry into a second destination; stale expectedVersion cannot overwrite newer state.
- **G. Exactly-once regression:** G4 retry/reconcile/resolve never create a duplicate destination (reuse the G3F duplicate-storm harness through the G4 service).
- **H. Audit:** every mutation writes ≥1 admin-actions row (attempt+terminal); failed mutation → `failed` terminal + safe code; actor identity correct + server-derived; before/after correct; runtime cannot UPDATE/DELETE audit rows; no secret in payload.
- **I. Transaction rollback / fault injection:** inject before/after service call, before/after audit insert, connection termination, lock timeout → no partial state; clean retry converges.
- **J. UI:** source-assertion (data-testid presence, disabled-when-invalid logic via exported helpers, redaction absence in rendered strings) + the API integration above.
- **K. Regression:** full G1–G3F connector suites green; protected MintVault regressions (auth, submissions, MVGS grading set, certificates, numbering, labels, print, payments/Stripe, Vault-Quest boundary) unchanged.

## Gates (Phase 16)
tsc; eslint (touched); prettier; build; focused G4; full partner; full G1–G4 connector; migration; rollback; auth; admin-permission; submissions; grading (MVGS); certificate; label/print; payment/Stripe; VQ-boundary; full suite; secret scan; changed-file inventory; git status. Any failure reproduced on pristine origin/main before labelling pre-existing.
