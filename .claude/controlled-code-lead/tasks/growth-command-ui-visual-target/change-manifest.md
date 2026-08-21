# Change manifest — Growth Command approved visual target

**Date:** 2026-08-20
**Lead session:** `codex/growth-command-visual-target` at `2d776db900e66f5bb0552ea2159a6d1586226a53`

## Finding this manifest addresses

- F1 — The overview does not present the existing truthful Growth authorities at the owner-approved command-centre density — classification A.

## Explicitly deferred

- Historical traffic and SEO charts — no authoritative series exists; an unavailable state remains visible instead of drawing data.
- Capacity request action — there is no reviewed request/cost/safety/audit workflow to wire.
- All provider, production, infrastructure, payment, Partner, Scanner, AI, and migration changes — out of scope and unauthorised.

## Files to change

| File | Change | Why | Classification |
|---|---|---|---|
| `client/src/pages/admin/growth.tsx` | Recompose the Overview with compact truthful KPI, health, performance, infrastructure, provider-absence, alert, and control panels using the existing intelligence response. | F1 | A |
| `tests/growth-command-gb04b.test.ts` | Add a bounded deterministic assertion for any new client-side presentation derivation. | F1 | A |
| `client/src/App.tsx` | DEV-gate a local-only Growth visual acceptance route. | Local visual acceptance approval | A |
| `client/src/pages/dev-growth-command-visual-harness.tsx` | Mount the shipping Growth page under a synthetic in-browser Super Admin session and exact local fixture responses; unknown `/api/` paths are blocked. | Local visual acceptance approval | A |

## Files explicitly not touched

- `server/growth-intelligence-service.ts` and `server/growth-runtime-telemetry.ts` — existing authorities remain the source of truth.
- Provider, Fly, Neon, deployment, migration, payment, Partner, Scanner, and MCP code — no mutation is authorised.
- `client/src/components/admin/admin-shell.tsx` — canonical shell, navigation, auth/RBAC, and tokens remain intact.
- All production authentication and API routing — the visual route is `import.meta.env.DEV`-gated and fixture requests never leave the browser's local origin.

## Protected actions required

- [x] None. This is a Class-A client presentation change within the owner-approved visual direction.

## Order of operations

1. Add compact overview presentation helpers that preserve unavailable and low-sample states.
2. Replace only the Overview composition, retaining existing tabs and commercial controls.
3. Add a focused regression assertion, type-check, build, and perform authenticated visual checks where a local session is available.
4. Use only the DEV-gated local render harness for browser acceptance; do not use credentials, sessions, databases, or providers.

## Regression gates required (Stage 6)

- [ ] `npm run check`
- [ ] `npm test -- tests/growth-command-gb04b.test.ts`
- [ ] `npm run build`
- [ ] Authenticated 1440×900 and 390×844 browser renders of the candidate (local only; no deploy)
- [ ] Targeted hostile client/authority review

---
**Approved to proceed to Stage 5:** Owner visual-direction approval / no protected action required — 2026-08-20
