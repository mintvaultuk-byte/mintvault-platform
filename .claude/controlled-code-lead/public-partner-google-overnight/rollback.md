# Rollback — Public Partner Network + Google Partner Presence

## Trigger conditions

- Any unpublished/inactive/cross-tenant location appears publicly.
- Private fields/tokens reach JSON, HTML, audit or logs.
- Dynamic public routes create soft 404/indexing defects.
- Google failure affects Partner login or any frozen operational surface.
- Error or latency budgets exceed the locally established threshold.

## Rollback steps

1. Disable `public_partner_directory_enabled` and `google_partner_presence_enabled` globally; exact scoped rows then cannot expose either feature.
2. Revert the reviewed code commit and redeploy the last known-good commit through the safe deploy path.
3. Do not delete Google schema or history during emergency rollback. Revoke provider credentials and make encrypted credentials unusable if compromise is suspected.
4. The additive migration rollback script is for pre-production/disposable verification only unless separately reviewed against live data.

## What rollback does not undo

- Google consent already granted at the provider; it must also be revoked/disconnected.
- Search engines may retain previously crawled URLs temporarily; disabled profiles return real 404/noindex and leave the sitemap immediately.
- Audit and disconnected-binding history remain intentionally retained.

## Verification after rollback

- `/api/version` equals the chosen known-good SHA.
- Directory/profile APIs fail closed and Google UI/routes are unavailable.
- Partner login/dashboard, grading, QA, stations, credits, cards and certificate routes pass smoke tests.

## Local proof

- `tests/google-partner-presence-migration.test.ts` applied 0101 to disposable PostgreSQL 17, exercised its constraints/RLS/service flow, ran the explicit rollback, and proved all five Google tables plus the three additive composite constraints were removed.
- Public containment is independently available through the global directory kill switch and exact location opt-in; cache tests prove remount revalidation removes revoked list/profile data.
