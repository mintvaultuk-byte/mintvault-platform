# Current Canonical State

**Baseline captured:** 2026-08-19 21:27-21:35 BST
**Candidate reconciled:** 2026-08-19 22:35 BST
**Repository:** `/Users/cornelius/mintvault-platform`
**Clean execution worktree:** `/Users/cornelius/mintvault-growth-completion-night-20260819`

## Git and production

| Axis                                    | Evidence-backed state                                          |
| --------------------------------------- | -------------------------------------------------------------- |
| `origin/main`                           | `facfd36f4ec8f164d017aba7a4386bab04a4aa6d`                     |
| Commits after stated GB-04B SHA on main | None; the stated SHA is current `origin/main`                  |
| Controller branch                       | `codex/growth-completion-night-20260819`; runtime `c2d18aea`   |
| Production `/api/version`               | `facfd36f` via `https://mintvault.fly.dev/api/version`         |
| Fly release                             | v1109, complete, created 2026-08-19T19:58:21Z                  |
| Fly machines                            | Two version-1109 LHR machines, both started and passing health |
| Production image                        | `deployment-01M0DSJ9GTNRS0MJ5KAN0NH2JR`                        |

Several releases were created on 2026-08-19 while the served commit remained `facfd36f`. Treat production as concurrently managed and reconcile again before any release action.

Final read-only reconciliation at 2026-08-19T22:02Z found `origin/main` still at full SHA `facfd36f4ec8f164d017aba7a4386bab04a4aa6d` and `/api/version` still serving `facfd36f`. Fly had concurrently advanced to complete release v1110 and image `deployment-01M0DYQHT8R6V6QV265H918CED`; both LHR machines were started and healthy. This program did not create that release.

## Dirty work and active lineage

- The launch checkout is a dirty `fix/canonical-card-detector-20260817` branch with Partner/Scanner changes. It is preserved untouched.
- The existing `main` worktree is 106 commits behind `origin/main` and has substantial Scanner work. It is preserved untouched.
- Existing GB-03/GB-04/GB-04B worktrees are historical source evidence; GB-04B is already on main and production.
- `codex/command-centre-v1-reconciliation-20260819` is three local commits ahead of `origin/main` and overlaps the Super Admin shell. It was not silently absorbed; this candidate integrates only with the canonical main shell and its focused/shared-boundary regressions pass.
- Current canonical main is enrolled in Engineering OS via `.engineering/project.yaml`; preflight and graph build/check run honestly on this branch.
- Expired task locks exist for unrelated branches. No live Growth lock conflict was found.

## Engineering and graph state

| Capability                             | State                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Cornelius Engineering OS CLI           | Installed, v1.0.13                                                         |
| Current-main Engineering OS enrollment | Present and active via `.engineering/project.yaml`                         |
| Graphify                               | Installed, v0.9.39                                                         |
| Graph scripts                          | `graph:build`, `graph:check`, `graph:update`, `graph:architecture` present |
| Governance                             | Controlled Code Lead v1.2, No-Bullshit and Graph of Loops loaded           |
| Governance snapshot hash               | `a87b4b87340c986446937dce6ec4d37cd5471ff182d08569e1075b9746139ce4`         |

## Migration inventory and ownership

Read-only production evidence:

- `schema_migrations`: 63 applied entries;
- highest applied identity: `0100`;
- `0100_growth_commercial_attribution.sql`: applied;
- `partner_applications`: exists;
- `submission_acquisition`: exists.

| Identity | Owner                                            | State                                                                                                              |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 0095     | GB-03 Partner applications                       | Applied production                                                                                                 |
| 0099     | Immutable Partner checkout operation idempotency | Production journal-owned; deliberately absent from Growth file inventory                                           |
| 0100     | GB-04 commercial attribution                     | Applied production                                                                                                 |
| 0101     | Growth Completion Night C/F                      | Reserved for additive review lifecycle and privacy-minimised conversion events; authored locally only, not applied |

Migration `0101` has been authored and proven in throwaway local PostgreSQL only. It has not been applied to staging or production.

## Live Growth state

GB-04B is live at `/admin/growth` with Overview, Acquisition, Partners, SEO & Traffic, Conversion, Site Health and Campaigns; authoritative paid-card/revenue aggregates, Partner pipeline, campaign links, Live Pulse, deterministic insights, health/capacity semantics and aggregate-only internal read contracts are present.

Current truthful gaps from source and the GB-04B handover:

- Fly CPU/RAM/request rate/p95/5xx/machine telemetry: not connected;
- Search Console: not connected;
- submission-start and checkout-start: not instrumented;
- payment/email/Partner API/Scanner API health: not instrumented;
- external ChatGPT/MCP transport and dedicated identity: absent.

## Local candidate delta

- GB-04B dead handoff and capacity-contract inconsistencies are closed without replacing the live command centre.
- A stateless, rate-limited, audited, aggregate-only Growth MCP transport exists at `/mcp/growth`; it fails closed until a dedicated bearer hash is configured.
- Privacy-minimised submission/checkout conversion events and verified paid-stage reporting are implemented without changing Stripe authority.
- A neutral 72-hour review lifecycle has durable idempotency, suppression, bounded retries and PII-free logging; it remains `NOT_CONFIGURED` without an approved destination.
- Public population authority uses minimum sample floors, bounded/cacheable endpoints and initial-HTML Dataset structured data.
- The candidate has no remote CI, migration, configuration, deployment or live proof. Production remains the baseline described above.

## Partner and Scanner boundary

Main contains the current canonical Partner/Scanner code at the GB-04B release point. Numerous newer local branches/worktrees exist. This program will not copy or overwrite them, provision Partner tenants, change credits, change stations, or change Scanner authority. Any shared-shell or route overlap must be reconciled explicitly.

## External-provider state

Fly CLI access and read-only production status work. Read-only secret-name inspection confirms no Fly metrics credential, Search Console identity/property configuration, review destination or MCP token. No credential value was read. These remain bounded connection blockers; runtime code must stay disabled/`NOT_CONNECTED` until an owner supplies the relevant server-side authority.
