# G5 Rollback Plan

## Code (branch)
All work on `feat/partner-network-g5-partner-management` (unmerged). Whole-program rollback = discard the branch / `git reset --hard 4d0c370f`. Nothing pushed or deployed this pass.

## Migration 0015 (never applied live this pass; disposable PG only)
- Forward: `migrations/0015_partner_management.sql` (5 additive tables + indexes + RLS + grants).
- Rollback: `migrations/rollback-partner-management.sql` — refuse-if-later-dependent guard; `DROP TABLE IF EXISTS partner_profiles, partner_contacts, partner_branding, partner_internal_notes, partner_management_audit CASCADE`; `DELETE FROM schema_migrations WHERE filename='0015_partner_management.sql'`. Additive-only; dropping affects nothing in G1–G4 (no existing object references these tables).

## API / UI
- Routes additive (`registerPartnerManagementRoutes` — one line in server/routes.ts); remove the line to unmount, zero effect on existing routes.
- UI additive (2 lazy routes + one NavLink); removing restores the prior admin app exactly; `/admin/partner-network` (G4 ops) is untouched throughout.

## Feature safety
No flag enabled; portal unmounted; connector dormant. Because nothing is deployed and no live migration is applied, production is unchanged regardless of branch state.
