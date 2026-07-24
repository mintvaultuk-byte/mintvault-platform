# Task Ledger — Approval → Printing → Printed Workflow

**Task slug:** print-workflow
**Owner:** Cornelius (non-technical founder)
**Started:** 2026-07-24

## Scope (authorised)
Build a production-grade print lifecycle queue on top of MintVault's existing
print-batch renderer. Lifecycle:
Awaiting Approval → Approved–Needs Printing → Printing → Printed →
Reprint Required → Reprinted → Completed. Filters, batches, duplicate
protection, reprint workflow with reasons, full audit log, permissions
(super admin / admin / staff). Tests. Existing MintVault admin styling — reuse,
no redesign.

## Explicitly prohibited (this task)
- NO deploy, NO merge, NO push (deliver for review).
- Do NOT touch: MVGS grading engine, certificates grade fields, Partner Network,
  Stripe/payments, submission workflow logic, authentication logic.
- Migrations may be AUTHORED but NOT applied to any DB (protected action).

## Baseline
- Main repo branch at session start: codex/super-admin-correction-mode @ 0fedce6e (NOT used).
- This feature worktree: /Users/cornelius/mintvault-print-workflow
  branch feature/print-approval-printing-workflow @ d5daecbf (origin/main).
- Tooling gates confirmed present: `npm run check` (tsc), `npm test` (vitest),
  `npm run lint` (eslint), `npm run build`.

## Existing-state facts (verified by Lead)
- `certificates.status` = varchar(10) default "active" → VALIDITY (active/voided),
  NOT a print lifecycle. Must NOT overload. New print state = new column.
- Approval today lives on `submissions.gradingStatus` ('approved') + `gradedAt`.
- Print state today: `label_prints` (certId unique, sheetRef, queuedAt, printedAt)
  — printedAt IS NULL = not printed. `reprint_log` (certId, reprintTime) — append,
  no reason/who. `audit_log` (entityType, entityId, action, adminUser, details jsonb).
- NO dedicated print_batches table — batches are ephemeral (R2 artifacts +
  deriveBatchId hash + audit_log + label_prints.sheetRef).
- Renderer: server/print-batch.ts (unchanged by this feature).

## Stage tracking
- [x] Stage 0 Baseline
- [ ] Stage 1/2 Reviewer investigation (backend/db/frontend running)
- [ ] Stage 3 Lead verification
- [ ] Stage 4 Change manifest + budget
- [ ] Stage 5 Implementation
- [ ] Stage 6 Regression
- [ ] Stage 7 Report
