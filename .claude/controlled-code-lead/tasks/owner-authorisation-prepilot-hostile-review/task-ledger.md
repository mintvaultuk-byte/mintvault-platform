# Task ledger — owner-authorisation-prepilot hostile landing review

**Date:** 2026-07-30
**Mode:** REVIEW ONLY (no code modified, no commit, no merge, no deploy, no migration)
**Worktree:** /Users/cornelius/mintvault-owner-authorisation-prepilot
**Branch:** codex/owner-authorisation-prepilot
**Review head:** 153ee9ee9b7d73c8b53667e2994d0987f275b9eb
**Base:** origin/main @ 7630bf19 (merge-base == origin/main; no drift)
**Commits on branch:** 628a37d9 (test matrix, tree-identical to original c027915d), 153ee9ee (fix)
**Diff:** 8 files (4 prod under server/partner/, 4 tests), +1754/−133. No migrations, no lockfile, no schema/payments/grading/auth-outside-partner changes.

## Verdict
READY FOR LANDING (recommended pre-pilot follow-ups listed in final report; none blocks merge).

## Stage log
- Stage 0 baseline: worktree clean, HEAD/base verified — done
- Stage 1/2: 5 read-only reviewers (security, backend, database, 2× controlled) — all reported
- Stage 3 Lead verification: load-bearing claims re-read from source/bundle personally — done
- Verification: check/build/lint/prettier/diff-check + 17 DB-backed & non-DB partner suites on
  disposable PG17.10 (fresh cluster, scratchpad) — 249/249 passed, 0 skipped;
  public-routes ×2 consecutive (2/2, 2/2); gitleaks branch-commits clean (full history 86 findings,
  all pre-existing; report's "45" count not reproduced — tool/version delta, branch adds 0);
  db:lint-sql failures confined to pre-existing rollback-*.sql; branch adds no SQL.
- Mutations (scratch worktree, discarded): M1 killed, M2 SURVIVED (RLS masks predicate — justified),
  M3 killed, M4 killed, M5 killed, M6 killed (deadlock→timeout), M7 SURVIVED (no prod-mode hook
  test), M8 extra barrier-removal SURVIVED (overlap-proof rests on barrier call site).
- Cleanup: PG17 stopped, mutation worktree removed, review worktree pristine at 153ee9ee.

## Accepted findings (for issue register / follow-ups)
- R1 (medium, A): post-commit delivery UPDATEs unguarded by status — revoke racing in-flight
  delivery can be overwritten back to SENT (service recordInvitationDelivery; add AND status='PENDING').
- R2 (medium→policy, A/H): failed create/invite/resend now leave ZERO audit trail (attempt row
  rolls back; withAudit 'failed' terminal row dropped). For createPartner a post-rollback row is
  structurally impossible (audit.tenant_id FK → org); for invite/resend it is possible and could be
  restored via autocommit catch. Owner policy call.
- R3 (low, A): success audit hard-codes deliveryStatus "DELIVERY_NOT_CONFIGURED"; delivery outcome
  never audited (ground truth on partner_invitations only).
- R4 (low, H): concurrent same-idempotency-key createPartner loser gets 409 IDEMPOTENCY_CONFLICT,
  not 200 alreadyCompleted (data safe via uq_partner_management_audit_idem; contract inconsistency).
- R5 (low, H): "exactly one Main location" is app-sequencing-only; optional partial unique index.
- R6 (info): org-wide switch authority applies to PARTNER_OWNER + PARTNER_MANAGER +
  PARTNER_FINANCE_VIEWER (pre-existing ORG_WIDE_ROLES; aligns with submission-service policy on
  main — NOT a new widening, but owner should be aware "OWNER" in the objective = all org-wide roles).
- R7 (test gaps): no prod-mode hook test (M7); barrier-removal survivor (M8); after_org_insert hook
  untested; accept path has no failure injection; management suite lacks CI fail-closed guard and
  can send REAL email if RESEND_API_KEY exported locally (no adapter/mock installed).
- R8 (low, H): failed switch attempts not audited; org-wide /locations listing lacks explicit
  tenant predicate (RLS-only); partner_session_lookup join lacks l.tenant_id=s.tenant_id (defence-in-depth).
- R9 (low, H): test barrier setters don't drain waiters — failure-path hangs in test files only.
- R10 (hardening, H): testHooksAllowed in prod bundle folds to VITEST-only gate; add
  NODE_ENV==='production'→false first line for dead-code elimination.

## Holds honoured
No merge, no deploy, no staging changes, no partner records, no real invitation (RESEND_API_KEY
never set; capture adapters only), no production change, no migration, no Gate 4.
