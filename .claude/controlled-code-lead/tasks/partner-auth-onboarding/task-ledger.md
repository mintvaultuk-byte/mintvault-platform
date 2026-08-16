# Task ledger — Partner Pilot end-to-end auth and onboarding

## Stage 0 — Baseline (2026-08-12 22:55 BST)

- Worktree: `/Users/cornelius/mintvault-partner-pilot-pass2`, clean on `codex/partner-pilot-pass2` at `6f0d59df3ddee3513cd296c20966ad7538c82bbf` before this task record.
- Production read-only proof: `/api/version` reports `6f0d59df`; unauthenticated `/api/partner/me` returns `401 {"error":"authentication required"}`.
- `origin/main` is `864fadeda88e06e083bfa483a7fe33520a4570e2`; this candidate is seven commits ahead and live matches its top published commit.
- Scope: make Partner invite/password/reset/MFA/onboarding truth and admin/station path locally production-ready; provide an existing consumed-invite/no-credential recovery path.
- Protected systems: Partner auth/session/MFA, credentials/tokens, RLS/runtime, production database, mail delivery, station signing, migrations, deployment.
- Prohibited absent a fresh specific owner approval: production or staging DB write, email send, secret/config/role change, migration application, deploy/push, live user remediation, physical station operation.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | complete | 2026-08-12 | Candidate/live state and protected boundaries recorded. |
| 1 — Review plan | complete | 2026-08-12 | Auth, station/UI and security/runtime reviews are isolated/read-only. |
| 2 — Investigation | complete | 2026-08-12 | Three independent reviews found readiness, recovery UI, RBAC, reset lifecycle, byte-boundary, and `/me` defects. |
| 3 — Lead verification | complete | 2026-08-12 | Every finding was source-verified; one post-change Manager parity defect was fixed and re-proven. |
| 4 — Implementation authorisation | complete | 2026-08-12 | Local source/migration scope authorised by the request; all production execution remains owner-gated. |
| 5 — Implementation | complete | 2026-08-12 | Additive 0077, server/UI controls, `/me`, tests, and truthful station handoff implemented. |
| 6 — Regression | complete | 2026-08-12 | `tsc`; 165 focused tests; 22 real PostgreSQL/HTTP tests; mobile UI checks; hostile review. |
| 7 — Final report | complete | 2026-08-12 | Release package, local proof, reviewer sign-off, owner runbook, and rollback posture recorded; no production action performed. |

## Reviewer assignments

| Reviewer | Scope | State |
|---|---|---|
| `auth_onboarding_review` | Invite, password/reset and onboarding truth | complete |
| `station_ui_review` | Admin/Partner/station onboarding surfaces | complete |
| `security_runtime_review` | MFA, sessions, RBAC, migrations and live read-only state | complete |

## Links

- Issue register: `issue-register.md` (after Stage 3)
- Change manifest: `change-manifest.md` (after Stage 3)
- Rollout: `rollout.md` (after Stage 4)
- Rollback: `rollback.md` (after Stage 4)
- Final verification: `final-verification.md`
