# Deployment state — Partner Pilot Pass 2

## Production

- Live commit: `b0de088032f82c67564de4337e915649a4306019`, confirmed through
  `/api/version` on 2026-08-12 12:40:53 UTC.
- Live build reported: `MV-P5-20260225-nohalf`.
- Health: `200 {"status":"ok"}`.
- Partner health: both tested Partner endpoints returned `503`, a safe refusal
  that must not be bypassed by deploying an unconfigured runtime.
- Fly release number, exact migration journal, runtime role identity and secret
  values: not yet read from an authorised production control plane. No secrets
  will be printed or changed by this task without owner approval.

## Candidate

- Branch: `codex/partner-pilot-pass2`.
- Baseline: `origin/main` `864fadeda88e06e083bfa483a7fe33520a4570e2`.
- Relationship: baseline is one descendant commit after production
  `b0de0880`; Pass 1 `7368b07e` is one descendant commit after baseline.
- Pushed: no. Deployed: no.

## Known divergence / concurrency

- Root worktree `psp/partner-rbac-hybrid` is dirty and owned by another active
  task; it will not be edited or deployed from this task.
- Multiple historical Partner/scanner worktrees exist. Their commits are not
  integration authority; source and lineage must be revalidated before reuse.
