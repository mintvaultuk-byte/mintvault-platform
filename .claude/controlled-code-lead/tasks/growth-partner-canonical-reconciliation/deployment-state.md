# Deployment state — Growth / Partner canonical reconciliation

## Production

- Live code identity: `337776e6`, read from `/api/version` during the preflight preceding this reconciliation.
- Live Fly release: `v1116`, image `mintvault:deployment-01M0HEFH406VDF7DTGM8A5P8R5`; two passing LHR machines were observed in that same read-only preflight.
- Live migration evidence: the live Partner lineage includes migrations `0102_partner_public_presence.sql` and `0103_partner_google_presence.sql`. This task only validates their source/journal compatibility; it does not inspect or mutate the production database.

## Candidate

- Branch: `codex/growth-partner-canonical-reconciliation`.
- Base: canonical main `718f60e750128251fd78774616354bf7c3ebafe7`.
- Incoming live ancestor: `337776e6`.
- Deployment state: **not deployed anywhere**. No migration, provider, secret, Fly, Neon, R2, payment, Scanner or infrastructure action is authorised.

## Reconciliation rule

The candidate must retain both `718f60e7` and `337776e6` as Git ancestors before any later deployment request can be considered. This task does not grant that later deployment authority.
