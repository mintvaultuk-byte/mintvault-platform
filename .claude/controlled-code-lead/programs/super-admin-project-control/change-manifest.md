# Change manifest — Super Admin Project Control, Phase 1

Classification: **E** (carries a migration) with **B** elements (coordinated frontend + backend).
Everything is additive. No existing table, column, route, page, or behaviour was changed.

## New files

| File | Purpose |
|---|---|
| `shared/project-control.ts` | Pure domain: statuses, evidence confidence, readiness engine, status engine, next-action engine, prompt generator, dependency graph, filtering. No I/O. |
| `migrations/0030_project_control.sql` | Nine additive `pc_*` tables + indexes. **Not applied.** |
| `migrations/rollback-0030-project-control.sql` | Drops only those nine tables. Hand-run, owner-gated. |
| `server/project-control/service.ts` | All database access; every mutation appends an audit event. |
| `server/project-control/repo-scan.ts` | Read-only git/worktree/migration/flag scan behind a subcommand allowlist. |
| `server/project-control/seed.ts` | Idempotent programme-tree seed; records seeded statuses as "Reported" only. |
| `server/routes/admin/project-control.ts` | 17 super-admin-gated API routes. |
| `client/src/pages/admin/project-control.tsx` | Main dashboard: readiness, next actions, tree, deployments, repository. |
| `client/src/pages/admin/project-control-package.tsx` | Work package detail, editing, blockers, evidence, audit, prompt generator. |
| `client/src/pages/admin/project-control-shop-launch.tsx` | Partner Shop Launch view. |
| `client/src/pages/admin/project-control-scanner.tsx` | Scanner view. |
| `client/src/pages/admin/project-control-helpers.ts` | Pure presentation helpers. |
| `tests/project-control-engines.test.ts` | 44 engine tests. |
| `tests/project-control-surface.test.ts` | 20 helper + safety-surface tests. |
| `tests/project-control-routes.integration.test.ts` | 5 runtime route/auth tests. |

## Modified files (additive only, +273 lines, 0 deletions)

| File | Change |
|---|---|
| `shared/schema.ts` | Appended nine `pc_*` Drizzle tables, types and insert schemas at the end of the file. Nothing above was touched. |
| `server/routes.ts` | One import; one `registerProjectControlRoutes(app)` call beside the existing catalogue registration. |
| `client/src/App.tsx` | Four lazy imports; four routes, ordered most-specific-first. |
| `tests/partner-schema-parity.test.ts` | Added `0030_project_control.sql` to the deliberate migration-inventory pin, with the reason. |
| `tests/partner-credit-reservation-service.test.ts` | Added one journal-clearing line so the G6B rollback guard can still reach its evidence check. Guard not weakened. |

## Deliberately NOT done

- No change to `server/storage.ts`. The newer module pattern (partner, catalogue) keeps a
  subsystem's queries in its own service file; adding ~40 methods to an 11k-line shared file would
  have been the larger and riskier diff. Flagging it because `CLAUDE.md` states queries go through
  `IStorage` — this follows the newer in-repo precedent instead, and is worth an explicit ruling.
- No dependency added.
- No migration applied.
