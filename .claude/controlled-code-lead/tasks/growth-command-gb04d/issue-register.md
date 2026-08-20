# Issue register — GB-04D Growth Command full live activation

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GB04D-001 | MCP limiter trusts proxy-derived `req.ip` instead of Fly client authority | UI/MCP review | HIGH | HIGH | `server/routes/growth-mcp.ts` | C | YES | focused + source | worktree | pending | pending | pending | FIXED LOCAL | Uses `adminClientIpRateLimitKey`; write-denial contract retained. |
| GB04D-002 | Payment/email/Partner/Scanner aggregate outcome health is absent | owner brief + Lead | HIGH | HIGH | `server/growth-runtime-telemetry.ts` | B/F/H | YES | focused + full matrix | worktree | pending | pending | pending | FIXED LOCAL | Bounded PII-free current-process outcomes; explicit sample/completeness limits. |
| GB04D-003 | Funnel omits requested conversion rates and comparable prior period | owner brief + Lead | HIGH | HIGH | `server/growth-intelligence-service.ts` | A/B | YES | focused + full matrix | worktree | pending | pending | pending | FIXED LOCAL | Three rates, cards/order, drop-off and like-for-like prior period. |
| GB04D-004 | Growth tab URL diverges after Back/Forward | UI/MCP review | MEDIUM | HIGH | `client/src/pages/admin/growth.tsx` | A | YES | focused + source | worktree | pending | pending | pending | FIXED LOCAL | URL/search parameter is the single tab authority. |
| GB04D-005 | Generated-link copy status can claim a new link was copied | UI/MCP review | MEDIUM | HIGH | `client/src/pages/admin/growth.tsx` | A | YES | focused + source | worktree | pending | pending | pending | FIXED LOCAL | Form/generation changes reset mutation and copied state. |
| GB04D-006 | Degraded fleet can recommend memory instead of restoring redundancy | Fly review | MEDIUM | HIGH | `server/growth-intelligence-service.ts` | A/B/C | YES | focused + full matrix | worktree | pending | pending | pending | FIXED LOCAL | `RESTORE_EXPECTED_FLEET` has deterministic precedence. |
| GB04D-007 | `Gauge` is a rectangular metric tile, not requested radial status control | owner brief + Lead | MEDIUM | HIGH | `client/src/pages/admin/growth.tsx` | A | YES | focused + rendered-source contract | worktree | pending | pending | pending | FIXED LOCAL | Radial status uses server state only; no fake percentage. |
| GB04D-009 | Search Console adapter/auth boundary absent | provider review + Lead browser proof | HIGH | HIGH | `server/growth-search-console.ts` | D/F/H | YES | focused mocked authority + source/account | worktree | pending | pending | owner property/identity required | FIXED LOCAL / EXTERNAL GATE | Dormant least-privilege adapter complete; signed-in owner account has no verified property. |
| GB04D-010 | App DB latency/pool pressure is technically available but shown disconnected | provider review + Lead | HIGH | HIGH | `server/growth-intelligence-service.ts` | B/F | YES | focused + full matrix | worktree | pending | pending | pending | FIXED LOCAL | Timed readiness and current-process pg Pool pressure; no Neon provider claim. |

## Rejected findings

- None at baseline.

## Deferred findings / external gates

- FLY-AUTH: read-only organization metrics/Machines token plus exact org/app approval absent.
- FLY-CONTROL: no scale-only write identity, authoritative cost, owner budget, min/max/cooldown,
  durable action/idempotency contract or approval; manual/auto mutations remain unavailable.
- NEON-AUTH: provider consumption/project read authority and exact project/branch approval absent.
- R2-AUTH: distinct Cloudflare Account Analytics Read and billing authority absent; operational
  object credentials are not reused.
- RESEND-WEBHOOK: signed delivery-event webhook authority/schema approval absent; application send
  acceptance/errors can be instrumented without claiming final delivery.
- REVIEWS-AUTH: no approved public destination or Google Business Profile exists.
- MCP-AUTH: production bearer hash and client-side revocable token are absent.
- SESSION-LEGAL: no owner/legal consent decision for new first-party active-session tracking;
  requests are not called visitors or people.

## Fixed findings

- All nine accepted product findings are fixed locally and covered by focused/full-matrix evidence.
- Candidate commit, hostile review and activation columns remain deliberately pending.

## Open-gate summary

- BLOCKER: 0 accepted/open.
- HIGH: 0 actionable in-scope product findings open locally.
- External authority/release gates remain explicit and are not relabelled as product defects.
