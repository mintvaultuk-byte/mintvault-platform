# Rollout — Public Partner Network + Google Partner Presence

**Classification:** B/E/F/G

## Pre-rollout checklist

- [x] Stage 6 local regression gates and hostile re-review are 0 BLOCKER / 0 HIGH.
- [x] Origin/main and live production reconciliation retained at `facfd36f` during the candidate pass.
- [ ] Fresh-main migration scope is separately owner-approved before the code deploy. Current main owns Growth `0101`; Public Partner privacy is `0102`; optional Google `0103` stays independent and unapplied.
- [ ] Public directory remains off during code deploy; Partner Owner attests exact public fields, Super Admin previews and approves the exact version, then the global kill switch may be enabled.
- [ ] Google remains off until schema, separate encryption key, OAuth credentials, GBP access/quota and callback are proved.

## Steps (all protected; not authorized in this task)

1. Merge/push reviewed branch.
2. After a fresh owner decision on the changed numeric scope, apply the reviewed current-main Growth `0101` and public `0102` to staging in order; prove the public schema/RLS/consent/approval/rollback. Do not apply optional Google `0103` in this release.
3. Deploy through the project safe-deploy path.
4. Smoke `/api/version`, health and all frozen Partner/grading surfaces with both new flags off.
5. Attest and preview one location, approve its exact version, enable the public global flag, and execute the monitoring checklist in `docs/partner/PUBLIC_PARTNER_NETWORK_GOOGLE_PRESENCE_OVERNIGHT_EXECUTION.md` before expanding.
6. Configure Google staging secrets and approved callback, enable one tenant/location pilot, then two distinct legitimate Partners.
7. Production Google activation only after real connect/select/confirm/maps/revoke/disconnect pilot.

## Who/what is affected

- Unauthenticated customers, Partner Owners and Super Admin Partner operators.
- Frozen grading, QA, cards, credits, stations and Partner login must remain unaffected.
