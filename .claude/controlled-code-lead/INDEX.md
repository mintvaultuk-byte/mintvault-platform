# Governance task / program index

The one place to find current state without grepping the whole repo. Update on every
Stage 0 (new task) and Stage 7 (final report). Programs group multi-phase work.

## Programs

| ID          | Title                      | Status                            | Branch                                   | Baseline  | Latest    | Open High/Crit                                          | Next authorised action                          | Path                    |
| ----------- | -------------------------- | --------------------------------- | ---------------------------------------- | --------- | --------- | ------------------------------------------------------- | ----------------------------------------------- | ----------------------- |
| vault-quest | VQ hardening (Phases 1–8A) | staging-substrate; prod unchanged | `main` / `vq-phase8-staging-integration` | `1a2aeac` | `32f3f2b` | live-route wiring blocked on deployed 2-machine staging | provision deployed staging, wire routes, verify | `programs/vault-quest/` |

## Tasks

| ID                                       | Title                                                     | Status                                           | Branch                                      | Baseline   | Latest      | Open High/Crit                                                         | Next authorised action                                   | Path                                              |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| governance-phase-9                       | Governance stabilisation/enforcement/scale                | 9A+9B+9C done (local, unpushed)                  | `governance-phase-9`                        | `6439350`  | (9C commit) | none blocking; restart to fully load ask/deny + non-Bash hook matchers | health report + await owner review                       | `tasks/governance-phase-9/`                       |
| mintvault-final-integration-local-proofs | Final integration local PostgreSQL/MinIO/browser evidence | complete (local, unpushed)                       | `codex/mintvault-final-product-integration` | `cb706721` | this commit | none in scope; inherited dependency audit remains follow-up            | owner-approved scope for supplies/order commercial rules | `tasks/mintvault-final-integration-local-proofs/` |
| mintvault-supplies-orders                | Supplies/order commercial completion                      | local proof complete; Stripe TEST proof external | `codex/mintvault-final-product-integration` | `4fa849a7` | `82dd38e6`  | no actionable local HIGH; real Stripe TEST credentials unavailable     | continue remaining final product phases                  | `tasks/mintvault-supplies-orders/`                |
| mintvault-supply-operations              | Phase 22 practical supply operations                      | local proof complete                             | `codex/mintvault-final-product-integration` | `82dd38e6` | `c2af48db`  | none                                                                   | continue remaining final product phases                  | `tasks/mintvault-supply-operations/`              |
| mintvault-public-shop-map                | Phase 24 public shop map/list                             | local proof complete                             | `codex/mintvault-final-product-integration` | `c2af48db` | `031fe2f1`  | none                                                                   | continue remaining final product phases                  | `tasks/mintvault-public-shop-map/`                |
| mintvault-partner-onboarding-readiness   | Phase 27 Super Admin onboarding truthfulness              | local proof complete                             | `codex/mintvault-final-product-integration` | `031fe2f1` | `7c64ad36`  | device/scanner source unavailable (honestly rendered; no local HIGH)   | continue Phase 28 operations-surface reconciliation      | `tasks/mintvault-partner-onboarding-readiness/`   |
| mintvault-super-admin-public-listings    | Phase 28 public listing/rating operations                 | local proof complete                             | `codex/mintvault-final-product-integration` | `7c64ad36` | `c3459a9e`  | none                                                                   | continue final master reconciliation                     | `tasks/mintvault-super-admin-public-listings/`    |

| mintvault-super-admin-credit-control | Phase 29 Super Admin credit-control truthfulness | local proof complete | `codex/mintvault-final-product-integration` | `c3459a9e` | pending commit | none | continue Phase 30 credit-purchase reconciliation | `tasks/mintvault-super-admin-credit-control/` |

## Conventions

- Task slug = kebab-case, unique. Program-scoped finding IDs = `<PROG>-P<phase>-F<n>`.
- A task/program is NOT "done"/"closed" until its Definition-of-Proof level is Activated
  (or explicitly owner-accepted as design/substrate). A landed substrate ≠ closed.
