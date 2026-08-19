# Partner Network functional wiring — change manifest

## Proven current-state finding

- `PNW-FW-001`: The canonical implementation is present in the consolidation line, but the deploy script defaults the compile-time `VITE_PARTNER_NETWORK_CONSOLIDATION` build argument to `false`. In that mode `PartnerNetworkRoute` deliberately redirects every canonical URL to its legacy surface. Production serves a newer descendant (`e689389b`) than this worktree's original `4166102d`, so deploying the original checkout would violate the live-ancestry guard and roll back unrelated releases.

## Authorised baseline reconciliation

Fast-forward this worktree from `4166102d` to `origin/main` before any release validation. This imports the current committed baseline without resolving conflicts or editing Scanner, P2/P6, grading, connector guards, schema, or migrations. The Partner Network source must then be reverified against that exact baseline.

## Canonical control repairs

- Settings no longer sends an operator to the legacy dashboard. Its global action is now accurately named **Open Partner Credits** and opens the canonical Partner Directory, from which each Partner has a canonical Credits route.
- Partner Workspace Connector Summary opens canonical Infrastructure.
- The workspace Back control returns to canonical Directory, while retained legacy detail keeps returning to legacy Partner Management when the flag is off.

No request, authority, guard, schema, migration, Scanner, P2/P6, grading, or connector-route change is included.

## Release lineage reconciliation

Production currently serves `e689389b`, a descendant of the `origin/main` baseline. Before rollout, replay this narrowly-scoped repair onto that exact live lineage so the safe-deploy live-ancestry guard remains satisfied and no production scanner, privacy, or application work is rolled back.
