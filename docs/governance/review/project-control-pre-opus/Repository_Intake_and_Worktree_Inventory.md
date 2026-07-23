# Repository intake and worktree inventory

Date: 2026-07-22 (Europe/London). Repository: `/Users/cornelius/mintvault-platform`. Freshly fetched `origin/main` was `12139b6ce14c36381294076b5a9ac6f201ac7b82`.

The source worktree was `/Users/cornelius/mintvault-project-control-dashboard-megs-v11` on `codex/project-control-dashboard-megs-v11`, at that same commit, with uncommitted Project Control and MEGS work. Its tracked-diff SHA-256 was `0c501e00d1189fedfaac3dcf7f81ccb41fad7f0a02b2ec42dec0e515cd4e58b4` both before and after transfer. No source file was modified by this review.

An isolated candidate was created at `/Users/cornelius/mintvault-project-control-reviewed-candidate` on `integration/mintvault-project-control-reviewed-candidate`, also based on `12139b6`. Transfer used binary patch application for tracked work and a file-preserving copy for source untracked work; checksums matched before review fixes.

The repository has 202 local and 184 `origin/*` refs, plus numerous historical `/private/tmp/mintvault-*` lint/audit worktrees. They were inventoried only; none was removed or pruned. Relevant active worktrees were Project Control, the candidate, `mintvault-g6d-submission-credit-integration`, `mintvault-platform` (correction-mode, dirty), `mintvault-g6b-credit-reservations`, `mintvault-g6c-admin-credit-management`, `mintvault-partner-auth-invitations-rbac`, and unified-admin-shell candidates. The full integration assessment is in [Active_Branch_Integration_Matrix.md](Active_Branch_Integration_Matrix.md).

Migration inventory: `origin/main` contains `0001` through `0018`; Project Control introduces `0020`; G6D introduces `0019_partner_submission_credit_lifecycle.sql`. No `0020` collision was found. The required order is nevertheless a release gate: `0019` must be integrated before applying `0020`, or Project Control must be rebased/re-numbered from an approved future migration baseline.
