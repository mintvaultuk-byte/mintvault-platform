# Deployment state — Canonical grading live absorb (2026-08-14)

## Production (confirmed by identity)
- Live commit: `6f0d59df` via `https://mintvault.fly.dev/api/version` at 2026-08-14 09:20 BST.
- Live Fly release: `v1078` · app: `mintvault`.
- Machines: `83d479c745d0d8` and `683720eb5127d8`, each `started`, `1/1` checks, image `mintvault:deployment-01KZVY0SDPX77YBDVAPXNJNTHR`.
- Health: `/health` returned `200 {"status":"ok"}`. `/ready` redirects from the Fly hostname to the canonical domain; its final response will be rechecked with redirects enabled before release.
- Migration state: production journal and source checksums for 0073/0074 were independently verified before this pass; 0077/0078 remain unapplied. This workstation absorb requires no schema change unless lead verification proves otherwise.

## Staging
- Staging is intentionally schema-divergent from production in historic Partner migration identities. It is not a substitute for production migration verification.

## This task's branch
- Branch: `codex/unified-grading-live-absorb-20260814`.
- Starting commit: `90f906259992de8b326422fdece2f593d3a3b4e0`.
- Current main: `9cd9804d199138502487824ca40e10261bba64d3`.
- Live/candidate merge base: `864fadeda88e06e083bfa483a7fe33520a4570e2`; seven commits are unique to each side.
- Pre-commit recheck at 2026-08-14 09:48 BST: live remains `6f0d59df`; `/health` and redirected `/ready` return 200; both v1078 machines remain started and passing.
- `origin/main` remains `9cd9804d`; it is an ancestor of the reviewed candidate. The merge remains local and uncommitted at this point.
- Pushed: no.
- Deployed anywhere: no.

## Known divergence between environments
- Production has migrations through 0076 but not 0077/0078. Staging has separate historical identities in earlier Partner slots. No migration replay, rename or fabricated journal entry is allowed.

## Other in-flight sessions
- The shared root `psp/partner-rbac-hybrid` is dirty and behind main; it is explicitly isolated.
- The protected MVGS worktree `/Users/cornelius/mintvault-universal-grading-workstation` is dirty and must not be absorbed.
- Open overlapping PRs include #291, #288 and #287; none will be merged into this release without separate reconciliation.
