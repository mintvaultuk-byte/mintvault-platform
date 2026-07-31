# Partner RBAC — change policy

**Status:** binding repository rule. Approved by the owner on 2026-07-31.

## The rule

> **Every Partner RBAC addition, change or revocation requires a numbered migration AND a matching
> TypeScript change. Neither on its own is permitted, and neither will pass CI.**

This covers roles, permissions, and role→permission mappings.

## Why it is written down

The first Partner Shop pilot was blocked by `PARTNER_ROLE_NOT_CONFIGURED`. Migration 0001 creates
`partner_roles`, `partner_permissions` and `partner_role_permissions` but never populates them, and
the seeder `seedPartnerRbac()` was called from **thirteen test files and zero production code
paths**. Every partner suite seeded RBAC in its own `beforeAll`, so the whole suite was green while
the deployed product could never issue its first invitation. Staging was confirmed read-only on
2026-07-31 with all three tables at 0 rows.

The lesson is not "we forgot a call". It is that a catalogue defined in one place and applied in
another will drift unless something forces them together. This policy is that something.

## The architecture (hybrid)

| Concern                      | Where it lives                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical definition         | `server/partner/permissions.ts` (`PARTNER_PERMISSIONS`, `ROLE_PERMISSIONS`, `ROLE_LABELS`) and `shared/partner-schema.ts` (`PARTNER_ROLE_CODES`) |
| Initial catalogue rows       | `migrations/0034_partner_rbac_seed.sql`, applied by the numbered migration runner                                                                |
| Runtime behaviour at startup | `validatePartnerRbac()` — **read-only**, never writes                                                                                            |
| Operator visibility          | `GET /api/super-admin/partner-management/readiness`                                                                                              |
| Drift protection             | `tests/partner-rbac-parity.test.ts` — bidirectional, runs everywhere, no database needed                                                         |

### Why the runtime does not seed

Two reasons, both established with evidence rather than preference:

1. **Partial-catalogue risk.** Proved on disposable PostgreSQL 17.10: a mid-run failure of the
   autocommit startup seed leaves roles present and mappings incomplete. `PARTNER_OWNER` then
   resolves — so invitations succeed — while permission checks silently under-grant. The migration
   is wrapped in one transaction by the runner, so the same failure leaves nothing at all.
2. **Identity.** Production has **no `PARTNER_ADMIN_DATABASE_URL`**. Verified read-only on the
   production database: the only available identity is `neondb_owner` — `rolsuper=false`,
   **`rolbypassrls=true`**, and the **owner** of all three RBAC tables with full
   SELECT/INSERT/UPDATE/DELETE. Seeding at boot would let the application rewrite its own
   authorisation data through an RLS-bypassing owner role.

### Why the runtime does not reconcile or revoke either

Additive seeding never revokes: a grant deleted from `ROLE_PERMISSIONS` persists in the database
indefinitely (proved on PG17). The tempting fix — have startup delete anything not in the map — is
much worse: a single bad deploy would silently strip live partners of their permissions. Revocation
is a deliberate, reviewable act, so it belongs in a numbered migration where it can be read,
approved and rolled back.

`validatePartnerRbac()` therefore **reports** unexpected catalogue entries and **never removes**
them.

## How to make a change

1. Edit the canonical TypeScript map(s).
2. Write a **new numbered migration** that applies exactly that change — additive for a grant,
   explicit `DELETE` for a revocation. Do **not** edit `0034` once it has been applied anywhere; its
   checksum is pinned in the runner's journal.
3. Update `tests/partner-rbac-parity.test.ts` only if the _shape_ of the SQL changed — never to make
   a failing comparison pass.
4. Add the migration to the inventory pins in `tests/partner-schema-parity.test.ts` and, if suites
   need it, `tests/helpers/partner-realistic-db.ts`.
5. Apply the migration to each environment **before** deploying the code that depends on it.

## What is deliberately not allowed

- Calling `seedPartnerRbac()` from any production code path. It throws outside a test runner.
- Adding a second seeding mechanism. One canonical path only.
- Making `validatePartnerRbac()` write, reconcile, repair or revoke.
- Treating `not_configured` as healthy while any Partner flag is enabled — that is how the original
  blocker stayed invisible.
- Changing the core `/ready` probe to depend on Partner RBAC. A Partner reference-data fault must
  never take grading or certificates out of service.
