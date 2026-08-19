# Rollout — Public Partner Network + Google Partner Presence

**Classification:** B/E/F/G

## Pre-rollout checklist

- [x] Stage 6 local regression gates and hostile re-review are 0 BLOCKER / 0 HIGH.
- [x] Origin/main and live production reconciliation retained at `facfd36f` during the candidate pass.
- [ ] Public privacy migration 0101 separately owner-approved and applied before the code deploy; optional Google migration 0102 stays independent.
- [ ] Public directory remains off during code deploy; Partner Owner attests exact public fields, Super Admin previews and approves the exact version, then the global kill switch may be enabled.
- [ ] Google remains off until schema, separate encryption key, OAuth credentials, GBP access/quota and callback are proved.

## Steps (all protected; not authorized in this task)

1. Merge/push reviewed branch.
2. Apply reviewed public 0101 to staging first; prove schema/RLS/consent/approval/rollback. Apply optional Google 0102 only if that pilot is being prepared.
3. Deploy through the project safe-deploy path.
4. Smoke `/api/version`, health and all frozen Partner/grading surfaces with both new flags off.
5. Attest and preview one location, approve its exact version, enable the public global flag, and execute the monitoring checklist in `docs/partner/PUBLIC_PARTNER_NETWORK_GOOGLE_PRESENCE_OVERNIGHT_EXECUTION.md` before expanding.
6. Configure Google staging secrets and approved callback, enable one tenant/location pilot, then two distinct legitimate Partners.
7. Production Google activation only after real connect/select/confirm/maps/revoke/disconnect pilot.

## Who/what is affected

- Unauthenticated customers, Partner Owners and Super Admin Partner operators.
- Frozen grading, QA, cards, credits, stations and Partner login must remain unaffected.
