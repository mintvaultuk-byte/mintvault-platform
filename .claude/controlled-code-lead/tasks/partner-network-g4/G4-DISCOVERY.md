# G4 Discovery — Partner Connector Operations Admin

Synthesis of four read-only specialist discovery reviews (admin auth/API, DB/audit/schema, admin UI shell, G3F service surface) against `origin/main = e0973251`. Evidence is source-level (no live DB inspected); live-DB inventory is a pre-migration owner step (see Risks).

## 1. Super-Admin auth & route conventions (reuse, don't reinvent)
- **Guard:** `requireAdmin` (`server/auth.ts:146`) is the top tier — there is NO separate "super admin" privilege; the `/api/super-admin/*` shell is gated by the same `requireAdmin`. Reuse it via `router.use(requireAdmin)`.
- **Registration template:** `server/partner/admin-routes.ts` → `express.Router()`, one `r.use(requireAdmin)`, relative routes, `registerSuperAdminPartnerRoutes(app)` mounts at `/api/super-admin/grading-partners`, called from `server/routes.ts:1416`. G4 mirrors this at `/api/super-admin/connector-ops` (or similar).
- **Acting-admin identity (audit actor):** session only — `req.session.authUserId` (users.id UUID, stamped at `routes/auth.ts:214`) + `req.session.adminEmail`. Never from request body/header.
- **CSRF/origin:** `csrfOriginCheck` is global (`index.ts:416`), already covers `/api/super-admin` — free.
- **Rate-limit GOTCHA:** global `adminRateLimit` is bound to the literal `/api/admin` prefix → does NOT cover `/api/super-admin`. G4 must add an explicit limiter. Avoid a new single-machine in-process store (Fly is multi-machine) — the existing `MemoryRateLimitStore`/attempt-Maps are per-machine (INFRA note).
- **Validation/response convention:** the existing shell uses manual validation (not Zod) + `res.json({ok:true})` / `{error:string}`, no stable machine error-code enum. G4's typed error-code set is net-new (acceptable; keep server-authored).

## 2. DB / migration / audit
- **Next migration = `0014_`.** Runner `scripts/db/migrate.ts` (`db:migrate`, dry-run default, `--apply` writes, advisory-locked, checksum-guarded, journal `schema_migrations`). Numeric-prefix files only; `rollback-*.sql` (no prefix) is ignored by the runner.
- **0014 recipe:** additive `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + explicit `GRANT` to a restricted role, no PUBLIC, no pg enums (use CHECK), no orphan sequences (uuid `gen_random_uuid()` PK). `partner_`-prefix auto-classifies in preflight (no registry edit). Destructive linter passes for additive DDL. Companion `rollback-partner-connector-admin-actions.sql` with `DROP TABLE ... CASCADE` + `DELETE FROM schema_migrations WHERE filename='0014_...'` + refuse-if-later-dependent.
- **Append-only grant pattern (from 0012):** `GRANT SELECT, INSERT ON <table> TO partner_connector_runtime;` — no UPDATE/DELETE/TRUNCATE, no PUBLIC. Proven by 42501 rejection tests + `role_table_grants` = exactly `['INSERT','SELECT']` + NOSUPERUSER/NOBYPASSRLS role attrs.
- **Audit-table decision:** NO existing table fits a "super-admin did X to connector Y" ledger (`partner_audit_events` forces `tenant_id NOT NULL` + no super-admin actor col + partner-runtime RLS; `partner_connector_events` is runtime-written/record-scoped). → **New `partner_connector_admin_actions`** (migration 0014), written via the privileged admin pool.
- **Execution split:** G4 reads + admin-action audit writes go via `partnerAdminQuery` (privileged, non-RLS, cross-tenant — `db.ts:107`). G4 mutations DELEGATE to G3F services, which use their own `withConnectorTx` (`partner_connector_runtime` pool). The service's own `partner_connector_events` row is the transactional per-record evidence; the admin-actions row is the supplementary admin ledger (two connections — not one cross-pool txn; design accordingly with attempt→result recording).

## 3. Connector schema & states (for read views)
- `partner_organisations` (tenant root; status, accreditation_level, health), `partner_submissions` (draft/submitted/cancelled), `partner_submission_handoffs` (pending/applied/failed), `partner_connector_records` (states below; version optimistic lock; claim fields; next_retry_at), `partner_connector_events` (append-only history), `partner_connector_validation_runs` (valid/invalid/stale/cancelled/failed) + `_findings` (warning/blocking), `partner_connector_customer_links`, `partner_connector_imports` (reserved/completed/reconciliation_required/failed; 4 UNIQUE = exactly-once), `partner_connector_import_attempts` (append-only evidence), `partner_feature_flags` (global row = tenant_id IS NULL), `partner_emergency_controls`.
- **Connector record states:** `queued, claimed, validating, ready_for_import, importing, reconciliation_required, manual_review, rejected, failed, cancelled, imported`. Terminal: `rejected/cancelled/imported`. **No `paused`/`disabled` per-record state.**

## 4. G3F service entry points (all G4 mutations MUST call these)
- Reads: `getConnectorStatus`, `listRetryableConnectorRecords`, `getLatestValidationRun`, `listValidationFindings`, `getConnectorImport`, `getImportAttempts`, `getImportedDestination`, `inspectConnectorImportConsistency`, `inspectConnectorConsistency`, `getConnectorImportsForOrg`-style listing (via admin pool SQL for org/record lists).
- Mutations (all audited + idempotent + actor/reason where noted):
  - Retry ready record → `importValidatedConnector` (already_completed on repeat = idempotent).
  - Retry interrupted/reserved → `recoverInterruptedImport` / `recoverReservedImport` (actor+reason).
  - Request reconciliation → `reconcileConnector` (actor+reason; returns none/completed_from_existing/marked_manual_review/recommendation_only).
  - Resolve reconciliation → `completeFromExistingDestination` (retain), `recoverReservedImport` (retry), `markManualReview`, `acknowledgePermanentFailure` (cancel-from-failed).
  - Manual-review decision → `markManualReview`, `resolveManualReview({resolution:'retry'|'cancel'})`.
  - Release expired/orphaned claim → `recoverExpiredImportClaim` (actor+reason; **expired lease only** — never force-release a live claim; `releaseConnectorClaim` refuses non-claimant).
- **Error surface ready-made:** `ConnectorError.code` + `IMPORT_ERROR_GUIDANCE` (`{publicMessage, operatorAction, requiresReconciliation}`) — built for a G4 admin UI. `toConnectorError` guarantees no SQL/PII leaks.

### Architecture-blocking findings → DEFERRED (documented limitations)
- **G4-DISC-01 (no global-flag write path):** the existing emergency-stop button writes a per-tenant `partner_emergency_controls` row (portal surface), NOT the global `partner_feature_flags(tenant_id IS NULL)` row that `assertConnectorActive` reads. A Super-Admin "stop the connector globally" is net-new flag-write logic bordering the owner's "don't enable connector in prod" boundary + the protected feature-flag area. → **G4 exposes global flag/emergency-stop STATE read-only; the write control is DEFERRED** pending explicit owner approval + a dedicated reviewed increment (Phase-7K compliant).
- **No per-connector pause/disable state:** adding one mutates the exactly-once state machine (new state + legal transition + schema). → **DEFERRED**; not built this pass.
- **Force-release live claim:** no safe service → G4 restricts to the expired-lease path only.

## 5. Admin UI reuse
- **Add page:** lazy import + `<Route path="/admin/partner-network">` before the `Layout` catch-all in `client/src/App.tsx`; page renders its own `AdminShell`; add a `NavLink` to the `NAV` array (`admin-shell.tsx`), don't re-sort.
- **Self-auth-gate:** `fetch("/api/admin/session")` → redirect `/admin/login?next=` (mirror `admin-sets.tsx`).
- **Primitives (`@/components/admin`):** `AdminShell, Panel, StatCard, Badge (act/neu/prog/wait/gold/red), AdminButton/adminButtonClass, Chip, AdminHeaderRow`. Table/filter/pagination hand-rolled (mirror `admin-sets.tsx`); TanStack Query + prefix `invalidateQueries` (mirror `admin/community.tsx`); `apiRequest` helper (staleTime Infinity → invalidate-on-mutation mandatory).
- **Confirmation + typed reason:** mirror the `admin-sets` modal-with-reason `<textarea>` (server rejects empty reason 400). Typed-confirmation reserved for high-risk (disable/emergency-stop/cancel-after-review) — but those are deferred this pass.
- **NO DOM/e2e harness** (vitest `.ts` only, no jsdom/RTL/Playwright). G4 "UI tests" = source-assertion (`readFileSync` + `toContain` + imported exported pure helpers) + real-HTTP integration (mirror `tests/partner-admin-control-shell-integration.test.ts`). → put G4 page logic (status derivation, reason validation, query-key builders) in exported pure functions.

## 6. Risks carried into design
- Live-DB inventory (staging `ep-purple-voice`, prod `ep-wispy-morning`) NOT done — required before ANY migration application (owner-gated; not this pass — disposable PG only).
- Rate-limit + in-process-store multi-machine caveat (add explicit limiter; prefer stateless/DB-backed).
- Two-pool split means admin-action audit is not in the same txn as the service mutation — record attempt→result, rely on the service's own in-txn event for authoritative evidence.
