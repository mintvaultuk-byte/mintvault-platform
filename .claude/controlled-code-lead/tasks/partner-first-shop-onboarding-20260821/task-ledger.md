# Task ledger — First-shop Partner onboarding simplification

## Owner outcome

One guided Super Admin flow creates and completes a first Partner shop using the
existing Partner, location, contact, owner, station and wallet authorities. The
same server readiness contract then drives the Partner portal, Supplies and the
onboarding workspace. This pass is staging-only; it never changes production.

## Scope

- Collect a legal/shop name and create the Partner only once.
- Collect a structured Main-location delivery address on `partner_locations`.
- Collect one ACTIVE PRIMARY `operations` contact on `partner_contacts`.
- Invite the Partner Owner through the existing invitation authority.
- Reuse the existing station enrolment and step-up approval authorities.
- Reuse the existing zero-balance wallet and Partner billing route.
- Render a direct, truthful readiness checklist with deep links to correctable
  actions, including the current Partner and Main location context.

## Non-goals

- No production deployment, migration or data write.
- No changes to scanner evidence, grading maths, Stripe charging, or historical
  Partner/location/contact records.
- No duplicate address, contact, readiness or onboarding authority.

## Stages

| Stage | Status | Notes |
| --- | --- | --- |
| 0 — Baseline and authority map | complete | Current staging Supplies failure established the real split: location text address + profile postcode/country + tenant contact. |
| 1 — Design and issue register | complete | Guided flow writes the existing records and supports explicit legacy-valid address compatibility. |
| 2 — Implementation | complete | One Super Admin flow and one Owner confirmation workspace use the same Partner/location/contact/readiness services. |
| 3 — Behavioural, mutation and hostile proof | complete | Real PostgreSQL, route, tenant, role, idempotency, exact-Main-location, migration-lineage and UI contracts passed locally. |
| 4 — Guarded staging release | pending | |
| 5 — Fresh-shop browser rehearsal | pending | Requires a controlled staging Owner invite/login/MFA and a physical station enrolment request. |

## Proof ledger

| Claim | Authority | Proof | Result | Invalidation | Status |
| --- | --- | --- | --- | --- | --- |
| One first-shop request creates one canonical Partner aggregate | `createFirstShopOnboarding` transaction and audit key | Real PostgreSQL replay and two-tab/different-key duplicate-name tests | Pass | Partner management service or audit schema change | PROVEN locally |
| Delivery address is location-owned for new shops | `partner_locations` structured fields; migration 0103 | Real PostgreSQL Supplies/readiness tests, exact location selection test | Pass | migration 0103 or location/readiness/Supplies selector change | PROVEN locally |
| Operations contact is a canonical, active primary `operations` contact | `partner_contacts` + shared predicate | Active/inactive/invalid/cross-tenant real PostgreSQL tests | Pass | contact schema, predicate, or readiness selector change | PROVEN locally |
| Owner can confirm only their own shop setup | session-derived `PARTNER_OWNER` actor | Real PostgreSQL Owner-allowed / manager-forbidden route helper proof | Pass | session/role route change | PROVEN locally |
| Additive migration remains explicitly guarded | migration inventory + destructive SQL linter | 0103 inventory/parity/migration-safety tests; exact CHECK vocabulary test | Pass | migration 0103 or linter rule change | PROVEN locally |
| Shipped browser outcome | guarded Staging release and real browser | Not run: no staging deployment authority yet | Pending | exact candidate SHA and staging schema | PENDING |

## Rollback

Deploy the recorded previous staging image with `scripts/safe-deploy.sh staging`
through its normal ancestry guard. The schema change is additive and old code
continues to use the preserved legacy `partner_locations.address` column.
