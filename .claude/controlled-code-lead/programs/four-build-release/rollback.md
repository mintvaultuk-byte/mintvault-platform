# Rollback Plan — Four-Build Integration (staging)

## Code (integration branch / staging deploy)
- The integration branch is `integration/four-build-release-candidate` off debea36b. Nothing merged to main until owner approves.
- If the integration PR is bad: close PR, delete branch. main untouched.
- If staging deploy is bad: redeploy staging to the previous SHA `debea36b` — `scripts/safe-deploy.sh staging` from a debea36b checkout (anti-clobber + /api/version verify). Staging is disposable.
- Prod is NOT touched at any point; prod stays d5daecbf.

## Migrations (staging)
- 0019 catalogue: `migrations/rollback-0019-catalogue-manager.sql` = DROP INDEX ×3 + DROP TABLE catalogue_items (additive-only reversal; nothing else affected). Then delete the journal row: `DELETE FROM schema_migrations WHERE filename='0019_catalogue_manager.sql'`.
- 0017/0018 (ride-along): additive; rollbacks exist (rollback-partner-credit-reservations.sql; 0018 index → DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_cert_correction_recent). Only roll back if they cause a problem; they are dormant with partner flags OFF.
- All rollbacks are staging-only. Do NOT run any rollback against prod.

## Worktree cleanup (after release or abandonment)
- `git worktree remove /Users/cornelius/mintvault-four-build-integration` (only once work is merged or abandoned; it holds the only copy of the integration branch until pushed).
