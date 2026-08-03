# Stage 7 — FOUR-BUILD INTEGRATION CANDIDATE — LOCAL PROOF, awaiting owner gate

**Proof level: Local Proof + Integration-verified (merge clean, all local gates green). NOT staged, NOT prod.**

origin/main before integration: debea36b · Integration branch: integration/four-build-release-candidate (tip 921fa1dd, worktree /Users/cornelius/mintvault-four-build-integration) · Prod: d5daecbf (UNTOUCHED).

Constituent PRs/commits: #239 (b69e353e, on main), #240 (merge 4f6449c9, on main, mig 0022), #242 (fa5be2fd), #243 (f97fbd03). Integration commits: 04f806c1 (#242), 00bd55ec (#243+consolidation), 921fa1dd (F2 harden).

Final migration numbering: 0019=catalogue (KEEP), 0022=print (KEEP). No renumber. Dry-run staging: 20 total/17 applied/3 pending(0017,0018,0019)/0 checksum-mismatch.

Surviving preview endpoint: POST /api/admin/certificates/label/preview (canonical). Removed: #242 inline /api/admin/label-preview + LabelPreview.tsx.

CodeQL: js/polynomial-redos labels.ts:406 — HELD for founder (codeql-decision.md). labels.ts NOT edited by Lead.

Files changed: 35 (+3012/−137). Only protected file touched = labels.ts (#242 variant-line only; 0 MVGS/pristine/centering logic).

Tests: tsc 0 · build OK · lint 0 err · MVGS 202/202 · full vitest 1822 pass / 17 DB-suites deferred to CI (env). Secret scan clean.

Hostile review (3 panels): NO Critical/High. Fixed: preview F2 (gate reads saved row). Deferred (documented): F1 medium (pre-existing stale-form on queue-Next; unsafe naive fix; focused follow-up), F2 low (import-update validation; super-admin-only; overlaps #243's own deferred Low), F3 low (preview-by-id; front-label surface only).

Confidence: Design 95% / Implementation 90% / Verification 80% (local+integration; DB-suites + full CI pending on PR) / Deployment 0% (not staged).

## OWNER GATE (protected actions — none taken):
1. CodeQL decision (A harden protected regex / C justified dismissal).
2. git push + open integration PR.
3. [after PR merge+CI] apply 0017/0018/0019 to staging + seed + deploy staging.
4. Prod: NOT this task.
