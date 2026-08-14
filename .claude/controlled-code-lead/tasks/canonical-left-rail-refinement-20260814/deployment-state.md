# Deployment state — Canonical grading left-rail refinement (2026-08-14)

## Production

- Live commit: `470699f4` via `https://mintvaultuk.com/api/version`.
- Fly release: `v1081` on app `mintvault`; `83d479c745d0d8` and `683720eb5127d8` both `started`, `1/1`, image `mintvault:deployment-01KZZXJ5D8JZ13T4S47X13PRAN`.
- Health: `/health` returns 200. No production data, migration, R2 or provider operation is in scope.

## This task branch

- Branch: `codex/canonical-left-rail-refinement-20260814` at `470699f47b2ae6e2f908367a84f2f91da630c1ef`.
- Main: `origin/main` is the same SHA at baseline.
- Pushed/deployed: no/no. Local implementation and browser proof are complete; exact-SHA PR CI is the next guard.

## Other work

- Shared root `psp/partner-rbac-hybrid` is dirty and behind main; not touched.
- Protected MVGS WIP is isolated at `/Users/cornelius/mintvault-universal-grading-workstation`; not absorbed.
