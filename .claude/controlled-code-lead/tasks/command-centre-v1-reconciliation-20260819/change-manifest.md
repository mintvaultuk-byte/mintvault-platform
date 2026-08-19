# Change manifest — MintVault Command Centre V1 final reconciliation

**Date:** 2026-08-19  
**Lead session:** `codex/command-centre-v1-reconciliation-20260819` at `c50617526d454eb1911b9d4dcd819fb296844424`

## Findings this manifest addresses

- CC-HIR-001 — rebuild the candidate without foreign protected side history — classification C.
- CC-HIR-002 and CC-HIR-003 — create exact-SHA release/staging evidence — classification C.
- CC-HIR-004 — replace obsolete environment-toggle harness fixture with persisted Pilot Flag fixture — classification B.
- CC-HIR-005 — align the non-terminal status vocabulary and fixture coverage — classification B.
- CC-HIR-006 — ISO-normalise attention candidate timestamps and prove deterministic ordering — classification B.

## Files to change

| File | Change | Why | Classification |
|---|---|---|---|
| `shared/command-centre.ts` | Add the typed static Command Centre contract. | Required read-model contract; CC-HIR-001. | B |
| `server/command-centre/{auth,flag,registry,routes,dashboard-service,partner-read-adapter,core-read-adapter}.ts` | Add the guarded GET-only dashboard, static registry, Pilot Flag guard, bounded read adapters, and the two data repairs. | Core V1 scope; CC-HIR-004/005/006. | B |
| `server/routes.ts`, `server/routes/admin-config.ts`, `server/index.ts` | Register the guarded route, expose server-derived availability, and validate registry/harness test startup support. | Command Centre composition only; no auth-core change. | B |
| `server/partner/{flags,dashboard-service,dashboard-visibility,station-service}.ts` | Add the global Command Centre Pilot Flag and aggregate-only Partner/station read seams. | Minimal persisted toggle/RLS-safe read integration. | B |
| `client/src/{App.tsx,pages/admin-command-centre.tsx,pages/admin.tsx,components/admin/admin-shell.tsx,pages/admin/partner-management-helpers.ts,pages/admin/partner-management.tsx,styles/admin-tokens.css}` | Add the guarded route, snapshot dashboard, deep-link tab parser, conditional navigation, Pilot Controls presentation, and scoped contrast. | Required V1 UI and persisted toggle controls. | B |
| `scripts/command-centre-runtime-harness.ts` | Seed the global Pilot Flag instead of the retired environment toggle. | CC-HIR-004. | B |
| `tests/command-centre-*.test.ts` and `tests/partner-management-admin-ui.test.ts` | Import/reconcile V1 test coverage and add the status/timestamp/harness regressions. | CC-HIR-004/005/006 plus release contract. | B |
| `docs/command-centre/implementation/COMMAND_CENTRE_V1_IMPLEMENTATION_EVIDENCE.md`, `docs/command-centre/implementation/COMMAND_CENTRE_V1_STAGING_CONTROL_LEDGER.md`, `docs/command-centre/implementation/COMMAND_CENTRE_V1_STAGING_EVIDENCE.md` | Record exact final SHA, all release evidence, and final row-level staging results. | CC-HIR-002/003 and accurate rollback authority. | C |
| `.claude/controlled-code-lead/tasks/command-centre-v1-reconciliation-20260819/*`, `.claude/controlled-code-lead/INDEX.md` | Maintain durable task state only. | Governance traceability. | C |

## Files explicitly NOT touched (but might look related)

- `migrations/**` — no migration is permitted or required.
- `server/partner/credit-purchase-service.ts`, `server/webhookHandlers.ts`, `server/partner/routes.ts` — protected finance/credit/webhook work is foreign to this release.
- `scripts/scanner-app/**` and scanner renderer/tests — foreign Scanner work is excluded.
- `server/auth.ts`, login/PIN/session code, and all environment/secret files — no authentication or configuration change.
- Protected MVGS/grade/label files — no grading authority or calculation change.

## Protected actions required

- [x] Staging-only deploy plus Pilot Flag ON → OFF → ON proof — owner approval obtained in the 2026-08-19 reconciliation request; exact final candidate only, after local gates, expires at task completion.
- [ ] Production deploy/production flag activation — prohibited; no approval.
- [ ] Migration, dependency, environment/secret, payment/webhook, auth-core, destructive DB/storage action, or `git push` — none.

## Order of operations

1. Reapply only reviewed Command Centre/Pilot Flag hunks from the prior implementation to the fresh mainline and verify the diff has no foreign paths.
2. Repair the runtime harness, KPI vocabulary and timestamp normalisation with focused tests.
3. Run targeted and full release gates; repair only reproduced in-scope failures.
4. Commit the exact candidate locally, deploy staging only, and execute the 52-control ON → OFF → ON evidence pass.
5. Build the final evidence package and perform targeted re-verification of changed risk surfaces.

## Regression gates required (Stage 6)

- [ ] Targeted Command Centre, Pilot Flag, Partner/RLS/station, finance/credit, Scanner/station, grading immutability, and deep-link/admin-shell tests.
- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Disposable runtime harness enabled/disabled proof and red/restore mutations for the repaired invariants.
- [ ] Staging-only deploy, identity check, Pilot Flag ON → OFF → ON, and final 52-control control ledger.

---

**Approved to proceed to Stage 5:** owner request plus no additional protected local change approval required — 2026-08-19.
