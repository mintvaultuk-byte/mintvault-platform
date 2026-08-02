# Project Control — concurrent-session file ownership, 2026-08-02

Two sessions are working on Project Control at the same time. This file is the written boundary
between them. It exists because the second session (this one) discovered the first mid-write:
`HEAD` moved three times inside four minutes and a tracked file was importing a module that did
not exist yet. Working in the same worktree would have destroyed one side's work.

## Sessions

| | Session A (pre-existing) | Session B (this one) |
|---|---|---|
| Worktree | `/Users/cornelius/mintvault-pc-truth` | `/Users/cornelius/mintvault-pc-ui` |
| Branch | `codex/project-control-truth-reconciliation` | `codex/project-control-ui-seed-package` |
| Base | `origin/main` @ `372a98f3` | Session A @ `19c0e60b` |
| Scope | Server-side live evidence | UI, seed truth, pilot readiness |

## Ownership

**Session A owns — Session B MUST NOT touch:**

- `server/project-control/github-scan.ts`
- `server/project-control/app-probe.ts`
- `server/project-control/flag-evidence.ts`
- `server/project-control/distributed.ts`
- `server/project-control/migration-scan.ts`
- `server/routes/admin/project-control.ts`  ← **critical: no new route may be added by B**
- `tests/project-control-github-transport.test.ts`
- `tests/project-control-app-probe.test.ts`
- `tests/project-control-flag-evidence.test.ts`
- `tests/project-control-routes.integration.test.ts`  ← the route-inventory pin lives here

**Session B owns — Session A is not expected to touch:**

- `client/**` (Session A has touched **zero** client files — verified by `git diff --name-only`)
- `server/project-control/seed-data.ts`
- `server/project-control/seed.ts`
- `shared/project-control-launch.ts` (new)
- `tests/project-control-seed*.test.ts`, `tests/project-control-launch*.test.ts`,
  `tests/project-control-ui*.test.ts` (new, distinctly named)

## Consequences of the boundary, accepted deliberately

1. **Session B adds no server route.** The route-inventory tripwire lives in a Session A file, so a
   new route would force B to edit A's test and guarantee a conflict. Any behaviour B needs that
   would naturally be a route is instead placed in a pure `shared/` module the client imports.

2. **The pilot-gating rule goes in `shared/project-control-launch.ts`, not in `scopedView`.**
   Server-side would have been marginally cleaner, but `scopedView` lives in
   `server/routes/admin/project-control.ts`, which A owns. A shared pure module is the correct
   second-best: it is testable, it is not duplicated in the client, and A can adopt it server-side
   later without either side rewriting.

3. **No migration is added by B.** 29 numbered migrations exist; B adds none, so no number can
   collide. Migration 0030 is untouched by both sessions and must stay that way — it is applied to
   staging under a matching checksum.

## Merge order

Session A first, then Session B. B is based on A, so B rebases or merges cleanly if A does not
touch `client/**` or the seed. Expected conflicts: none in the owned sets; the only shared file is
`shared/schema.ts`, which neither session currently modifies.

## Verification performed before B started

- `git diff --name-only 42736c61..HEAD -- client/` → empty (A has touched no client file)
- `git diff --name-only 42736c61..HEAD -- server/project-control/seed-data.ts seed.ts` → empty
- B's worktree clean at creation, 0 changes
- Migration 0030 checksum unchanged: `7d19c87a…d316d4`, still `applied` on staging
- Staging `pc_*` seed rows: 0 / 0 / 0 — the clean-first-seed window is still open
