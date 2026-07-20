# G5 Risk Register

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | Status change overclaims enforcement (users think SUSPENDED locks the partner out) | High | Label-only by design; NO side effects; UI states "business-status label, no accounts/devices/flags changed"; reviews assert no flag/portal/session write |
| R2 | Stale-form clobber on profile/contact/branding edits (full-state POST, no lock) | High | expectedVersion optimistic lock on every versioned aggregate; VERSION_CONFLICT; UI sends expectedVersion; test proves conflict rejection |
| R3 | Cross-tenant leakage (admin pool has no RLS context) | High | Every query filters WHERE tenant_id=$1 explicitly; FORCE RLS defense-in-depth; cross-tenant integration + RLS tests |
| R4 | Internal notes leaking to partners | Med | No partner_runtime grant on notes/audit; isolation test proves zero privilege; never a portal endpoint |
| R5 | Fake/misleading statistics (cert/grade counts) | Med | Impossible-to-join metrics returned null + "unavailable" marker; UI labels them; no cross-schema join |
| R6 | Migration collides on staging≠prod (partner_* already present with diverged shape) | Med | Live-DB inventory pre-check before any --apply (owner-gated; not this pass); additive IF NOT EXISTS; disposable-PG proof |
| R7 | Duplicate primary contact under concurrency | Med | Partial-unique (tenant_id) WHERE is_primary AND active + pre-check; 23505→DUPLICATE_PRIMARY_CONTACT |
| R8 | Rate-limit in-process store (multi-machine) | Low | Same documented caveat as G4/adminRateLimit; shared store = platform follow-up |
| R9 | Nav/route regression to existing /admin/partner-network | Low | Keep it unchanged; add-only NavLink + new routes; source-assertion the old route still declared |
| R10 | Scope creep into future phases | Low | Scope-guard allow-list + negative source-asserts + scope reviewer |
