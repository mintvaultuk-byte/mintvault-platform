# G4 Rollback Plan

## Code (branch)
All work on `feat/partner-network-g4-operations-admin` (unmerged). Rollback of the whole program = discard the branch / `git reset --hard e0973251`. Nothing is pushed or deployed by this pass.

## Migration 0014 (never applied to a live env this pass; disposable PG only)
- Forward: `migrations/0014_partner_connector_admin_actions.sql` — additive `CREATE TABLE IF NOT EXISTS partner_connector_admin_actions` + indexes + `GRANT SELECT,INSERT` to `partner_connector_runtime`.
- Rollback: `migrations/rollback-partner-connector-admin-actions.sql` — `BEGIN; DROP TABLE IF EXISTS partner_connector_admin_actions CASCADE; DELETE FROM schema_migrations WHERE filename='0014_partner_connector_admin_actions.sql'; COMMIT;` — refuses if a later dependent (0015+) referencing the table is present.
- The table is purely additive and referenced only by G4 code; dropping it affects nothing in G1–G3F.

## API / UI
- Routes are additive (`registerConnectorOpsRoutes` — one line in `server/routes.ts`); removing the line unmounts the surface with zero effect on existing routes.
- UI is additive lazy routes + one NavLink; removing them restores the prior admin app exactly.

## Feature safety
- No flag is enabled; the connector remains dormant. G4 read APIs only observe; G4 mutations only act on records an operator explicitly targets and only via existing audited services.
- Because nothing is deployed and no live migration is applied, production is unchanged regardless of the branch state.
