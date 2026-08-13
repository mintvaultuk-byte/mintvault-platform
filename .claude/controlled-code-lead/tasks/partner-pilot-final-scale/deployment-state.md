# Deployment state — Partner Pilot final-scale completion

## Production (read-only evidence)

- Version endpoint at 2026-08-12 14:50 UTC: `b0de088032f82c67564de4337e915649a4306019`, build `MV-P5-20260225-nohalf`.
- `/health`: HTTP 200.
- `/api/partner/me` and `/api/partner/stations/enrolment-locations`: HTTP 503 with `partner access temporarily unavailable`.
- The deployed application reports that `PARTNER_DATABASE_URL` must target the same database as `MINTVAULT_DATABASE_URL`; no secret value was read or printed.
- Exact migration journal and restricted-role identity are unproven pending an owner-authorised, redacted `BEGIN READ ONLY` query. No migration is classified as executable until then.

## Candidate

- Branch: `codex/partner-pilot-pass2`.
- SHA: `f3e90e63617f3395e29401c9aebfc2186ecddf20`.
- `origin/main`: `864fadeda88e06e083bfa483a7fe33520a4570e2`; candidate contains it.
- Production SHA `b0de0880` is an ancestor of current mainline. Historical release branches are evidence only, not deploy targets.
- Pushed: no. Deployed: no.

## Other active work

- `/Users/cornelius/mintvault-platform` is on a distinct dirty worktree/branch and is not touched by this task.
- Three reviewers are read-only and cannot modify this candidate.
