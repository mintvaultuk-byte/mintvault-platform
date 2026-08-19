# Rollout — GB-04 final production Growth Command

**Classification:** B + E

## Pre-rollout checklist
- [ ] Exact canonical source and migration inventory still unchanged through `0098`
- [ ] Production-shaped `62 → 63` migration rehearsal passed
- [ ] Focused and full gates passed; hostile review has no unresolved BLOCKER/HIGH
- [ ] Exact SHA CI green
- [ ] Production baseline, journal, Fly artifact and PITR rechecked

## Steps
1. Reconcile `origin/main` and live production immediately before release.
2. Use the canonical migration runner to apply only `0099_growth_commercial_attribution.sql`.
3. Prove journal `63 applied / 0 pending / 0 checksum mismatch` and schema/index parity.
4. Deploy the exact approved SHA via `scripts/safe-deploy.sh`.
5. Prove the live artifact, both Fly machines, Super Admin Growth APIs/UI, RBAC, link generation and no-charge negative paths.

## Who is affected

Public collectors and Partner applicants continue uninterrupted if attribution fails. Super Admins gain Growth Command; no other role gains data or write access.
