# Master Rollback Plan — Partner Network

Every phase is additive, isolated on its own branch, and behind feature flags defaulting OFF.
The existing MintVault system is never modified destructively, so first-party operation is
unaffected if partner work is reverted or flags stay off.

## General rollback levers
- **Feature flags** (global + per-partner + per-location + pilot allowlist + emergency shutdown),
  all default OFF. Turning them off disables partner behaviour without a code change.
- **Branch revert** — each phase branch can be dropped or `git reset --hard <prior-phase>` before
  merge. Post-merge, revert the phase's merge commit.
- **Application rollback** — image-pin redeploy via `scripts/safe-deploy.sh` (captures the prior
  live image), same as existing practice. Partner app has its own deploy lifecycle, so a partner
  rollback does not touch the main app.
- **Migration rollback** — every numbered migration ships a paired reversing/down migration,
  tested on a disposable DB. Additive nullable columns are left in place (harmless) unless a down
  migration is explicitly required. `partner_*` tables can be dropped by an owner-approved
  destructive migration only if the partner system is being fully removed.
- **Data recovery** — Neon point-in-time recovery (must be verified enabled before pilot) +
  partner R2 bucket backup (Phase 19). Restore runbook + restore test are Phase 19 deliverables.

## Per-programme rollback

| Programme | Rollback |
|---|---|
| A (0.5,1–4) | Flags off; drop/reset phase branch. Phase 0.5 revert = `git reset --hard ac23f08b`. Partner tables not yet created on real DBs, so nothing to un-migrate in prod. |
| B (5–7) | Disable `partner_payments_enabled` / `partner_credit_bundles_enabled` / capture flags. Stripe test-mode only until go-live, so no live money to reverse. Credit ledger is append-only — a bad entry is corrected by a reversing entry, never edited. |
| C (8–11) | Disable grading/field/publish flags. A cert cannot have published without all gates, so nothing to un-publish during local build. Any grade change is already versioned. |
| D (12–18) | Disable operations flags. Stock/strike/incident tables are additive. |
| E (19–22) | Disaster mode stops all partner activity while preserving data; individual services re-enabled after investigation. |

## Emergency / disaster mode (Phase 19)
Super-admin can stop all new partner orders/payments/grading/reservations/label/NFC/publish while
keeping existing public certificate lookup online, preserving all data, showing controlled
maintenance messaging, and re-enabling services one at a time after investigation.

## Rollback discipline
- No rollback is "done" until the working tree matches the target state and gates pass.
- A destructive rollback (dropping `partner_*`, deleting objects) is a protected action requiring
  explicit owner approval and the Phase 0.5 destructive-migration workflow (linter + preflight +
  disposable-DB rehearsal + owner sign-off).
- Never roll back by editing an applied migration (checksum breaks) — write a new one.
