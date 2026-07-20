# G5 Partner Management — Review Panel Findings & Dispositions

Task: Partner Network G5 — Super-Admin partner-company management.
Baseline: origin/main (branch point `4d0c370f`; origin/main has since advanced to `cb1f0402`).
Governance: controlled-code-lead v1.1. Lead verified every finding before acting; reviewers were read-only.

Severity legend: **Critical** / **High** / **Medium** / **Low** / **Accepted (documented)**.
Rule applied: fix all Critical/High/material-Medium; document accepted Low with rationale.

---

## 1. Findings fixed

| # | Sev | Panel | Finding | Fix | Evidence |
|---|-----|-------|---------|-----|----------|
| F1 | Medium | Backend / Idempotency | `createPartner` inserted into `partner_organisations` **before** the idempotency short-circuit, so a retried request with the same `idempotencyKey` could create a second organisation row. | Added a `priorSuccess(actor.idempotencyKey)` pre-check at the top of `createPartner`, before the org INSERT; a replay now returns `{ alreadyCompleted: true }` and creates nothing. | `partner-management-service.ts` `createPartner`; integration test *"create is idempotent for a repeated key: no duplicate org"* (asserts exactly one org row). |
| F2 | Low | Backend / Error surface | A `23505` unique-violation that slipped past the service guards was always mapped to `IDEMPOTENCY_CONFLICT`, mislabelling a duplicate-primary-contact race. A `23514` check-violation fell through to a raw 500. | `toG5Error` is now constraint-aware: `23505` on `uq_partner_contacts_primary` → `DUPLICATE_PRIMARY_CONTACT` (409), else `IDEMPOTENCY_CONFLICT`; `23514` → `VALIDATION_ERROR` (400). | `partner-management-errors.ts` `toG5Error`. |
| F3 | Low | Database / Atomicity | `changeStatus` bumped `partner_profiles.version` and updated `partner_organisations.status` in two statements; a crash between them could desync the optimistic-lock version from the status. | Rewrote as a single data-modifying CTE (`WITH bumped AS (UPDATE partner_profiles … WHERE version=$expected RETURNING tenant_id) UPDATE partner_organisations … FROM bumped`) — one atomic statement; `rowCount 0` → `VERSION_CONFLICT`. | `partner-management-service.ts` `changeStatus`; integration tests for valid/invalid transition + version conflict + no side effects. |
| F4 | Low | Backend / Input bounds | Optional `reason` on non-status mutations was an inline ternary with no length bound, so an oversized reason reached the DB. | Added pure `optionalReason(raw, fallback)` (trims, bounds to 2000 chars, else default) and replaced the 6 inline ternaries in the routes. | `partner-management-errors.ts` `optionalReason`; `partner-management-routes.ts` (0 remaining inline reason ternaries). |
| F5 | Low | Backend / Validation | `branding_status` was only enforced by the DB CHECK, surfacing an invalid value as a 500. | Route now calls `optionalBrandingStatus(req.body.branding_status)` up front → friendly 400 `VALIDATION_ERROR`. | `partner-management-routes.ts` branding PUT; integration test *"invalid branding_status is a friendly 400 VALIDATION_ERROR, not a 500"*. |
| F6 | Low | Backend / Audit robustness | The `withAudit` catch treated any `23505` as an idempotency replay, which could swallow an unrelated unique violation. | Narrowed to `pg.code==="23505" && pg.constraint==="uq_partner_management_audit_idem" && actor.idempotencyKey`. | `partner-management-service.ts` `withAudit`. |
| F7 | Low | UI / Accessibility | The "unavailable statistics" indicator was a no-op interactive `Chip` (`onClick={()=>{}}`), a focusable control that does nothing. | Replaced with a plain non-interactive labelled `<span>` (dashed pill). | `partner-management-detail.tsx` `pm-stat-unavailable`. |
| F8 | Low | Backend / Bounded reads | `listContacts` had no row bound. | Added `LIMIT 500` (contacts per partner are small; bound is defensive). | `partner-management-service.ts` `listContacts`. |

### Gate regression found during Phase 9 (not a review-panel item, but fixed)

| # | Sev | Finding | Fix | Evidence |
|---|-----|---------|-----|----------|
| G1 | Medium | `tests/partner-schema-parity.test.ts` inherited a **latent-stale** migration inventory from the branch point (`4d0c370f` pinned through `0013` while `0014` already existed; origin/main later fixed this in `cb1f0402`). With `0015` added, the pinned list was two entries behind. | Forward-fixed the pin to the full inventory through `0015` and retitled `(0001–0015)`. This extends origin/main's own `0014` fix. | `partner-schema-parity.test.ts` → 8/8. |

---

## 2. Accepted findings (documented, not changed)

| # | Sev | Finding | Rationale for acceptance |
|---|-----|---------|--------------------------|
| A1 | Low | **Global idempotency namespace.** `idempotencyKey` is unique across all G5 actions, not per-action-type. | Matches the existing G4 connector-admin idempotency contract exactly; callers already scope keys per request. Changing it would diverge from the established platform convention. |
| A2 | Low | **`window.prompt` field entry** for profile/contact/branding edits in the detail page. | The admin surface is an internal Super-Admin tool; `window.prompt` is keyboard-accessible and Escape-cancellable. A richer form is a UI-polish follow-up, out of G5 scope. Logic remains in unit-tested helpers. |
| A3 | Low | **`X-Forwarded-For` rate-limit key is spoofable**, and the limiter store is in-process (per-Fly-machine). | Consistent with the existing admin/staff in-process counters; the surface is `requireAdmin`-gated and low-volume. A shared (DB/Redis) store is the documented multi-machine follow-up (noted in the router header). |
| A4 | Low | **Admin pool runs with `BYPASSRLS`**, so tenant isolation for G5 relies on explicit `WHERE tenant_id = $1` filters rather than RLS. | Pre-existing platform pattern (`partnerAdminQuery` is the privileged admin pool with no RLS GUC). Every G5 read/write is explicitly tenant-scoped; the migration test proves the *runtime* role is still RLS-isolated and append-only. |
| A5 | Low | **No live-DB pre-apply verification** of migration 0015 against staging/prod. | Deliberate: applying migrations to staging/prod is an owner-gated protected action explicitly out of scope for G5. Proven instead on disposable real PostgreSQL (10/10 migration tests incl. rollback+reapply). |
| A6 | Low | **`upsertBranding` re-reads server state** rather than trusting a client-supplied version for the metadata merge. | Intentional lost-update-safe design for a metadata-only, low-contention resource; `expectedVersion` is honoured when supplied. |
| A7 | Low | **`createPartner` org INSERT is not transactional** (FRA-raised). The `INSERT partner_organisations` runs before `withAudit`; if the subsequent `partner_profiles` insert or the terminal-audit write fails, a `PENDING` org can persist without a success-audit. | Accepted as Low: the read layer already tolerates a profile-less org (detail LEFT-JOINs profile; `loadOrInitProfileVersion` lazily initialises it; the profile insert is `ON CONFLICT (tenant_id) DO NOTHING`, near-unfailable). The idempotency pre-check prevents duplicate-on-retry. A true fix requires threading a pooled client/transaction through `withAudit`/`recordAttempt`/`recordTerminal`; deferred as a follow-up rather than refactoring the audit path post-FRA. No prohibition breach, no cross-tenant or side-effect risk. |

---

## 3. Post-fix verification (real PostgreSQL, disposable clusters)

- `tsc --noEmit`: **0 errors**. `eslint`: **0 errors** (4 pre-existing warnings). `prettier --check`: clean.
- `npm run build`: client (3302 modules) + server + one-off scripts OK; partner-management chunks code-split and emitted.
- `partner-management-migration.test.ts`: **10/10** (fresh non-SSL cluster).
- `partner-management-integration.test.ts`: **11/11** (fresh SSL cluster; includes 2 new fix-validation tests — create-idempotency, branding-status-400).
- `partner-management-admin-ui.test.ts`: **15/15**.
- `partner-schema-parity.test.ts`: **8/8**.
- Regression: `partner-connector-migration` 14/14, `partner-connector-admin-migration` 8/8 (each on its own fresh cluster), `auth-security-migration` + `rarity-structured-migration` 17/17 (correct local DB).

### Full-suite triage (`npx vitest run`, no DB env) — 10 residual failures, all pre-existing / out-of-scope

- **3 vq suites** (`vq-backend`, `vq-fetch-art-stored-pointer`, `vq-higgsfield-observability`): throw `MINTVAULT_DATABASE_URL is not set` at import. Env-gated; **untouched by G5**.
- **5 grading guard suites** (`grading-identify-lookup`, `-stage1-rarity-usability`, `-workstation-layout-fix`, `-unified-admin-shell`, `-retire-duplicate-tab`): the **git-diff base-ref gotcha** — they assert "this pass changed no partner/migration file" by diffing a pinned/`origin/main` base to HEAD. They fire because G5 *legitimately* added `server/partner/*`, `client/src/pages/admin/partner-management*`, and `migrations/0015`. Two (`-unified-admin-shell`, `-retire-duplicate-tab`, `SCOPE_BASE=0825544a`) are red on origin/main too; the other three diff `origin/main...HEAD` (empty → green on main). **Not G5 regressions**; these are branch-scoped guard tests meaningful only on their own grading PR.
- **0** failures attributable to G5 source after the parity fix.
