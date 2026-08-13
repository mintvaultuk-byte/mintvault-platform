# Rollback — Partner Pilot final-scale completion

## Trigger conditions

- A start-card request reserves more than one credit, crosses tenant/station scope, or leaves an orphaned active target.
- A non-captured, stale, wrong-station or cross-tenant certificate appears in Ready to Grade.
- A signed Scanner upgrade cannot recover its station version.
- Any regression gate or production smoke test fails.

## Rollback steps

### Before a push or deployment

- Stop at the last logical local commit, inspect `git status` and revert only the named final-scale commits. Never reset or overwrite unrelated candidate history.

### After a push/deployment (not currently authorised)

- Revert the individual final-scale commit(s) on the integration branch; do not rewrite shared history.
- Redeploy the prior verified SHA only through `scripts/safe-deploy.sh` after an owner-approved rollback record.

### Migration/secret/runtime changes (not currently authorised)

- Do not attempt improvised DDL rollback or secret rollback. Restore the precisely recorded prior runtime configuration or reverse migration only if its reviewed rollback is already validated against the target database.

## What rollback does not undo

Any issued certificate number, persisted evidence, consumed credit, or physical print must be reconciled as a recorded operational event; code rollback never silently reuses an MV identity or credit.

## Verification after rollback

- Run the focused Partner Scanner/credit/queue regressions.
- Re-read `/api/version`, `/health`, and authorised Partner probes after any deployment.
