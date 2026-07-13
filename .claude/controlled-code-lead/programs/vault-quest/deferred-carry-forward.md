# Deferred carry-forward — vault-quest program

Open items that MUST carry into the next phase's Stage 0 (not re-derived from scratch).
Status vocab: Designed / Implemented / Locally-verified / Staging-verified / Activated.
Sourced from the Phase 5–8 reports + memory. Nothing is "closed" until Activated + verified.

| ID | Item | Class | Status | Unblock |
|---|---|---|---|---|
| VQ-INFRA-01 | Durable export jobs wired into live routes (7A substrate applied to staging) | C | Staging-verified (DB) | deployed 2-machine staging + route cutover |
| VQ-PROV-01 | Generation idempotency wired into all paid routes (7B) | C | Implemented | migration on staging + route wiring |
| VQ-PROV-03/04 | Persist providerJobId before upload; no-charge recovery | C/D | Designed | Higgsfield sandbox confirm (no paid call) |
| VQ-BKP | Approval→immutable revisions + B2 sibling worker (7D) | C/D | Implemented | B2 bucket provisioning + approve-site rewiring |
| VQ-REC | Orphan reconciler run vs R2 | E/G | Implemented (dry-run guard tested) | confirm local R2 = staging identity first |
| VQ-FLAGS | requireVqFeature mounted on routes + admin toggle UI (7E) | B | Implemented | migration 0011 + route wiring |
| VQ-HIGGS-A | Migrate to official Cloud API long-lived Key | F | Designed | confirm nano_banana + image_references parity |
| VQ-CEIL | Ceiling VALUES + kill-switch policy | F | Designed | owner decision |
| VQ-B2-BACKUP | VQ artwork B2 cold backup | D | Designed | bucket/credential provisioning |

## Deploy caveats (carry every phase)
Push HEAD before deploy; deploy via `scripts/safe-deploy.sh`; confirm `vq_*` tables on
prod; `--config drizzle-vq.config.ts` only; migrations owner-gated. R2 staging-vs-prod
identity UNCONFIRMED for the local toolchain — resolve before any R2-touching op.
