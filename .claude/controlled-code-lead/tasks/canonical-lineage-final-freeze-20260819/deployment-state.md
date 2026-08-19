# Deployment state — canonical lineage final freeze (2026-08-19)

## Production

- Live commit: `158dbf53768187bb4176f3de0e9c23a26cff11fd`, confirmed read-only via
  `https://mintvaultuk.com/api/version` during this task. It replaced the baseline live
  `8359e902` while the freeze was in progress.
- DB host in use: production Neon identity is protected; no connection or mutation was made.
- Migration state: read-only journal evidence shows 41 applied identities, including `0095`.
  The candidate’s remaining 21 files are unapplied and must not be treated as live.
- Provider state: no Stripe, Fly, Resend, R2, or secret mutation was made.

## This task's branch

- Branch: `codex/mintvault-final-engineering-os-reconciliation`
- Baseline: `d11579f1`
- Candidate before final release-record commit: `12c9a641`
- Pushed: no
- Deployed anywhere: no

## Known divergence and reconciliation

- Production `158dbf53` is not an ancestor of the candidate, but its location-form behavior is
  semantically included by replay `a3616f8c`; comparison is recorded in the migration ownership
  decision. A future release must make the safe-deploy lineage acknowledgement for `158dbf53`.
- Active Partner/Scanner source is `fix/canonical-card-detector-20260817` at `72f57963` until the
  final movement check. It must remain frozen; a later commit invalidates this candidate.
- Growth GB-04 source remains frozen at `d3d02dc6` and must later rebase onto the final candidate.
