# Task Ledger — Catalogue Manager Hardening

## Stage 0 — Baseline (FREEZE) — 2026-08-02
- Worktree: /Users/cornelius/mintvault-catalogue-hardening (NEW, isolated)
- Branch: fix/catalogue-manager-hardening (NEW, from main)
- HEAD: 7f4f12e7dd763141157b8ef99c5bc1f46760de54
- Worktree clean: YES (tracked files)
- Production SHA: 6f182624 — CONFIRMED live via /api/version (build MV-P5-20260225-nohalf)
- Catalogue source bytes at prod 6f182624 == main 7f4f12e7 (git diff empty)
- Concurrent writer: none detected (feat/catalogue-manager worktree clean)

### Baseline gates
- npx tsc --noEmit .............. PASS (exit 0)
- catalogue tests (3 files) ..... PASS 119/119
- npm run build ................. PASS
- eslint (catalogue scope) ...... PASS (0 problems)

BASELINE GREEN -> proceed.

## Scope
Harden Catalogue Manager only. FIX 1..10 as specified by owner.

## Prohibited (owner directive)
- No deploy, no push, no merge, no reseed of production
- No Project Control changes, no Partner Network changes
- No grading engine, no scanner
- Certificates only where validation requires

## Stage 5/6 — Implementation progress (2026-08-02)
DONE (committed, gated, mutation-proved):
- FIX 1 (archived lockout) — commit 25cfae20
- FIX 2 (legacy language) — commit 25cfae20
- provider history coverage — commit 78e0caae

NOT STARTED: FIX 3,4,5,6,7,8,9,10. All defects verified + change-manifest written.
Next authorised action: implement FIX 3 (import safety) per change-manifest.md.
NOT authorised: deploy, push, merge, reseed, any DB mutation, any migration apply,
auth-logic change (R4-F3), grader.ts change (R5-F2 workstation half).
