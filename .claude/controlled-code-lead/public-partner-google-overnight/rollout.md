# Rollout — Public Partner Network + Google Partner Presence

**Classification:** B/E/F/G

## Pre-rollout checklist

- [x] Stage 6 local regression gates and hostile re-review are 0 BLOCKER / 0 HIGH.
- [x] Origin/main and live production reconciliation retained at `facfd36f` during the candidate pass.
- [ ] Google migration separately owner-approved and applied to target environments.
- [ ] Public directory flags remain off during code deploy; enable global kill switch, then exact approved locations only.
- [ ] Google remains off until schema, separate encryption key, OAuth credentials, GBP access/quota and callback are proved.

## Steps (all protected; not authorized in this task)

1. Merge/push reviewed branch.
2. Apply only the reviewed Google migration to staging; prove schema/RLS/rollback contract.
3. Deploy through the project safe-deploy path.
4. Smoke `/api/version`, health and all frozen Partner/grading surfaces with both new flags off.
5. Enable public global flag and one explicitly approved location; verify profile/directory/SSR/sitemap, then expand.
6. Configure Google staging secrets and approved callback, enable one tenant/location pilot, then two distinct legitimate Partners.
7. Production Google activation only after real connect/select/confirm/maps/revoke/disconnect pilot.

## Who/what is affected

- Unauthenticated customers, Partner Owners and Super Admin Partner operators.
- Frozen grading, QA, cards, credits, stations and Partner login must remain unaffected.
