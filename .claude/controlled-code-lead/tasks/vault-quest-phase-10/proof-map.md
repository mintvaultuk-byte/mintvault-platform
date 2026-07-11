# Proof map — vault-quest-phase-10

Proof levels: Designed / Implemented / Locally-verified / Staging-verified / Activated.
Local = pure + mocked + local-Postgres integration. NEVER call local mocks/2-worker sims
"staging proof"; authored/local-applied migrations are NOT production-active.

| Subsystem | Commit | Proof level | Evidence |
|---|---|---|---|
| 10A-0 prerequisites | (this) | **Locally verified** | migrations 0012/0013 applied to LOCAL DB (127.0.0.1:55432) — attempt_count≥0 + ids≤1000 CHECKs fire; vq-config resolveVqCeilings + r2-identity checkR2Identity + 7-state provider-status + tablesFilter → 35 targeted + 437 full tests green; tsc clean; lint 4452 |
| 10A-1 durable exports | pending | — | needs export-jobs rewrite + storage + routes + client + 2-worker local sims |
| 10A-2 idempotency/spend | pending | — | |
| 10A-3 provider status | pending | — | |
| 10A-4 feature controls | pending | — | |
| 10A-5 observability | pending | — | |
| 10A-6 revisions | pending | — | (gated: only after 10A-1..5 green) |
| 10A-7 reconciliation | pending | — | |
| 10A-8 B2 framework | pending | — | |

## Staging-only evidence (NOT closeable locally — 10B)
Multi-machine export routing; real Higgsfield sandbox gen; real R2/B2 bucket integration;
prod-unpooled-host write behaviour; migration application on staging/prod.
