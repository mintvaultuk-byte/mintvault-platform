# Deployment state — Staff Admin grading inspection viewport

## Production

- Live commit: `01d5e4da` from `https://mintvaultuk.com/api/version` at 2026-08-25T04:24Z.
- Exact full Git object: `01d5e4daab30d58ad53943585ebecc972befaa8a`.
- Freshly fetched `origin/main`: identical full SHA.
- Production schema, storage, providers and grading constants: not queried or mutated; this task does not require them.

## This candidate

- Branch: `codex/staff-admin-inspection-viewport-20260825`
- Worktree: `/private/tmp/mintvault-staff-admin-inspection-viewport-20260825`
- Baseline: exact production SHA above.
- Candidate: one local commit will freeze this working tree; the final owner report records its exact SHA.
- Pushed: no.
- Deployed to staging: no.
- Deployed to production: no.

## Concurrent work

- The original checkout is `fix/claim-ownership-collection-boundary` at `df011c01`, 13 commits ahead of production; it is intentionally untouched.
- Other worktrees exist but no live task/branch lock overlaps this candidate.
- Task lock: `staff-admin-inspection-viewport-20260825`.

## Readiness decision

- Local automated candidate: green.
- Staging-safe: **no** — mandatory real Chrome zoom/anchoring and final hostile
  diff review are not complete.
- The required Chrome control channel is unavailable because the ChatGPT Chrome
  Extension is not installed/enabled. No unsupported browser automation fallback
  was used and no screenshot or browser-geometry claim is fabricated.
