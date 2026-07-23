# Proposed commit plan

Do not execute this plan without founder approval and the independent review.

1. `docs(governance): add MEGS v1.1 and Project Control review record` — source `docs/governance/**` plus these review reports; requirements MEGS/PCD governance; depends on none.
2. `feat(project-control): add immutable Project Control schema and migration` — `shared/schema.ts`, `migrations/0020_project_control_dashboard.sql`, parity/reservation compatibility tests; resolves PCD-HIGH-002; depends on commit 1. Exclude unless G6D/`0019` order is approved.
3. `feat(project-control): add evidence scanners and conservative readiness engine` — `server/project-control/**`; resolves PCD-HIGH-001, PCD-MED-001/002; depends on 2.
4. `feat(project-control): add guarded Super Admin routes and dashboard` — route registration, flag config, `App.tsx`, admin shell, PCD route/UI tests; depends on 3.
5. `fix(deps): remediate Sharp security advisory` — `package.json`, lockfile, two type annotation files; resolves PCD-HIGH-003; tests typecheck/build/full suite; can be separate and earlier.
6. `test(project-control): add database, authorization and flag coverage` — new PCD tests and expanded existing PCD tests; depends on 2–4.

Exclude `.env`, database cluster files, audit/test logs, `dist`, `node_modules`, temporary fixtures and all unrelated dirty worktree changes.
