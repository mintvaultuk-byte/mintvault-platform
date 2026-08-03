# OPUS PACKAGE WP-3 — Connector Activation (driver + global controls)

ROLE: Implementation agent, one bounded package, reporting to the Programme Director. No scope decisions.

BASELINE: branch from origin/main @ 6b30136f9ac4507bfacf13ff8743417278d73e61.
BRANCH: psp/wp3-connector-driver — isolated worktree.
SEQUENCING: code now against baseline; the Director will integrate AFTER WP-1. Do not depend on WP-1 files; where you need the global-flag WRITE path for E2E tests, set flags via direct SQL inside the disposable test database only.

CONTEXT (verified):
- The connector chain G1–G3F is code-complete and test-proven but runtime-INERT: `ensureConnectorRecordForHandoff` (server/partner/connector-service.ts:209) and `runConnectorWorkerPool` (server/partner/connector-worker.ts) have zero production callers. A submitted handoff sits `pending` forever in a deployed system.
- The worker's claim loop already fails closed when `partner_connector_enabled` is OFF (connector-worker.ts:12–15). `importValidatedConnector` performs the exactly-once import into real submissions/submission_items (connector-import-service.ts:420–467).
- G4 super-admin can only READ global connector flag / emergency-stop state (documented deferral G4-DISC-01): there is no write path for the GLOBAL connector flag or global emergency stop in connector ops.
- Existing suites: connector service/validation/import/reconciliation/concurrency/fault-injection/scale tests, plus G4 admin tests. All must stay green unmodified.

OBJECTIVE:
1. Production driver: a new server/partner/connector-runtime.ts owning the lifecycle — start (only when PARTNER_CONNECTOR_DATABASE_URL is configured AND `partner_connector_enabled` global flag resolves ON at start AND per claim-cycle), a bounded sweep that creates connector records for unprocessed handoffs (idempotent, reusing ensureConnectorRecordForHandoff; define "unprocessed" via the existing provenance/uniqueness — do NOT invent new columns), the existing worker pool for validate/import, clean shutdown (SIGTERM drain: finish or release in-flight claims; no leaked leases), crash-safe restart (existing lease/reconciliation semantics must make restart safe — prove it with the existing fault suites).
2. Boot wiring: start the runtime from server/index.ts AFTER the server is listening, guarded so a connector failure can NEVER crash or delay the main app (isolate errors, log, retry with backoff, give up into a visible "stopped" state rather than looping hot). Keep the index.ts diff to the minimal boot-hook lines.
3. Global connector controls (closes G4-DISC-01): in the G4 connector-ops surface (server/partner/connector-admin-routes.ts / connector-admin-service.ts), add super-admin-gated, reason-required, audited endpoints to (a) write the GLOBAL `partner_connector_enabled` row and (b) write the GLOBAL `partner_emergency_stop` row — following the existing G4 action/audit/error-taxonomy patterns (partner_connector_admin_actions ledger). The worker must observe a flag flip within one claim cycle without restart.
4. Observability: a worker-status read endpoint in connector-ops (running/stopped/last-cycle stats/backlog counts) built from existing tables + in-process state; no new tables.

PROHIBITED: server/routes.ts (mount block belongs to WP-1 — if the ops endpoints need registration beyond the already-mounted connector-ops router, report instead of editing routes.ts); client/src/**; wallet/credit/reservation services; submission-service.ts; any migration; shared/schema.ts; storage.ts; MVGS/Stripe/auth files; npm install; .claude/**; push/deploy/live DBs.

REQUIRED INVARIANTS (test on disposable PG17):
- Flag OFF ⇒ runtime never claims; flag flipped ON via SQL ⇒ sweep + import proceed; flipped OFF mid-run ⇒ halts within one cycle; emergency stop ⇒ same.
- E2E: portal-created handoff (use the existing test factories from tests/partner-submission-workflow.test.ts) → record → validated → ready_for_import → imported exactly once → real submissions/submission_items rows with MV-SUB ref + resolved owner. Re-running the sweep imports nothing twice.
- Kill mid-import + restart ⇒ no duplicate submission (existing attempt/reconciliation suites re-run green, plus one new restart test).
- Main-app boot with connector env absent ⇒ identical behaviour to today (no partner env = no runtime, no log noise beyond one line).

TESTS: new suite(s) for runtime lifecycle + sweep idempotency + global-control endpoints, wired to genuinely RUN in CI (extend the PG17 pattern in .github/workflows/ci.yml; silently-skipping suite = package failure). All existing connector suites green unmodified.

STOP CONDITIONS: any prohibited file; "unprocessed handoff" not derivable from existing schema (report — do not add columns); worker lifecycle requires index.ts surgery beyond a minimal hook; scope exceeding ~1000 changed lines excluding tests.

REPORT BACK: commits, diff --stat, gate outputs, evidence per invariant (test names + key assertions), backlog/observability sample output, blockers, remaining risks, recommendation. No merge, no push, no deploy.

---
# DISPATCH ADDENDUM (owner-mandated control rules, 2026-07-30)

CONTROL RULES — binding:
- You may not choose your own work, widen scope, perform unrelated audits, redesign architecture, start another package, modify another package's files, merge, deploy, alter production, enable any Partner flag, or continue past an unexpected finding without explicit Programme Director instruction.
- On discovering drift, a dependency conflict, missing architecture, a security concern, or work outside your package: (1) STOP, (2) preserve the worktree exactly as-is, (3) record exact reproducible evidence, (4) report back, (5) wait. Do NOT fix out-of-scope findings yourself.
- Inspect only enough code to implement and test your package. No broad reviews, repo-wide refactors, historical reconstruction, or backlog work.
- No model/effort switching mid-package. No rebases after work begins. No force-push. No push at all — local commits only.

MANDATORY REPORT-BACK FORMAT — your final report must use exactly these headings:
## Package
## Starting SHA
## Final branch head
## Drift
## Scope completed
## Files changed
## Architecture used
## Tests run
## Exact pass/fail/skip counts
## PostgreSQL evidence, where applicable
## Security and tenant-isolation evidence
## CI execution evidence
## Commits
## Out-of-scope findings
## Remaining risks
## Recommended disposition

Finish with exactly one line: `READY FOR FABLE REVIEW` or `BLOCKED — FABLE DECISION REQUIRED`.
You may not declare yourself ready for merge, integration, staging, or deployment — disposition is the Programme Director's alone.
