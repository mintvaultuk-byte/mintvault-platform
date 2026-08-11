# Production defects found by the independent Matrix A/B run

The previous mutation matrix reported **no production defects**. Two were found here, both by
building behavioural coverage where only source pins existed. Neither is fixed in this pass — both
sit behind an owner gate, and both are recorded with a proven reproduction.

---

## D-1 — A partner grading save ERASES `private_notes` (silent data loss) · HIGH

**Proof:** `tests/partner-grading-http-routes.test.ts` → `G1b`, which is written to characterise
the defect and is GREEN today because the defect is present. It goes RED the moment the defect is
fixed, and its comment says to replace it with the preservation assertion at that point.

**Reproduction (real HTTP, no mocks):**
1. A partner-origin certificate carries an admin-internal `private_notes` value.
2. An authenticated partner grader `PUT`s `/api/partner/grading/certificates/:id/grade` with an
   ordinary draft body (`card_name`, `overall_grade`) — nothing about notes at all.
3. Response `200`. `certificates.private_notes` is now **NULL**. The admin note is gone.

**Mechanism (each step verified against the source and the live schema):**
1. `server/grader.ts` writes `private_notes = ${pick(body.private_notes, cert.privateNotes)}`.
2. `pick(a, b) = a === undefined ? (b ?? null) : a`.
3. `cert` comes from `storage.getCertificate()`, a Drizzle `select()` over `shared/schema.ts` —
   and that model declares **no `privateNotes` field** (only `notes`). Verified: 0 matches for
   `private_notes`/`privateNotes` in the `certificates` table definition. So `cert.privateNotes` is
   **always `undefined`**.
4. `partnerGradeBody()` always deletes `private_notes` from a partner request — that is its purpose.
5. Therefore `pick(undefined, undefined)` → `null`, on **every** partner draft save and **every**
   partner submit-for-review.

**Blast radius.** `auth_status` and `auth_notes` sit on the identical construct
(`pick(body.auth_status, cert.authStatus)`) and are undeclared in the model in exactly the same way,
so they erase too. `auth_status` is the authenticity verdict, which makes this more than cosmetic.
The admin grading panel is likely shielded because it posts these fields back on every save — but
that is a property of one client, not of the write path.

**Why it is not fixed here.** The write lives in `server/grader.ts`, which this task is directed not
to modify and which is a protected system. The clean repair is in `shared/schema.ts` — declare
`privateNotes`, `authStatus`, `authNotes` on the `certificates` model so `cert.*` resolves — but
that changes what `getCertificate()` returns for every caller in the application. That is an
owner-approved change, not an assurance edit.

**Recommended fix (for owner approval, not applied):** add the three columns to the Drizzle
`certificates` model in `shared/schema.ts`. No grading logic, no weights, no gates change; `pick()`
then finds a real current value and preserves it. Then flip `G1b` to assert preservation.

---

## D-2 — 11 Super Admin control-shell tests had NEVER run in CI · MEDIUM (process defect)

**Proof:** Matrix A and Matrix B each reported 13 skipped tests, of which 11 were the whole of
`tests/partner-admin-control-shell-integration.test.ts`. The file gates on `PARTNER_ADMIN_TEST` and
`PARTNER_ADMIN_TEST_RUNTIME`; **neither name has ever appeared in `.github/workflows/ci.yml`**. The
similarly spelled `PARTNER_CONNECTOR_ADMIN_TEST` pair belongs to a different suite, which is what let
the omission survive review. There was no in-file CI guard and no execution floor, so vitest reported
the FILE as passed while executing nothing.

The 11 unproven tests: `requireAdmin` rejection of unauthenticated / partner-cookie / forged-body
callers; partner suspend; location suspend; user suspend; partner session revocation; the
feature-flag write path; emergency stop; MFA reset; read-endpoint authorisation; and the
suspend-concurrency proof. That is the Super Admin authorisation surface.

**This is the fourth occurrence of this exact failure class in this repository** (≈250 connector
tests, the RBAC pair, the RLS suite, now this).

**Fixed in this pass** (test/CI wiring only, no production code):
- `PARTNER_ADMIN_TEST` / `PARTNER_ADMIN_TEST_RUNTIME` wired in `ci.yml` against their own PostgreSQL
  17 database `mintvault_partner_admin_shell`, added to the database-creation loop, with a
  `CREATEROLE` precondition assertion alongside its peers;
- an in-file *"is not silently skipped in CI"* guard;
- an execution floor of 12 in `scripts/ci/assert-partner-pilot-suites-executed.mjs`, so an edited
  gate reddens the build rather than deleting the evidence.

### D-2a — and one of those 11 tests was FAILING

Wiring the suite up made it run for the first time, and it immediately failed one assertion: the
user-suspend audit row could not be found in `partner_audit_events`.

**Not a product defect — a stale test.** `POST /:partnerId/users/:userId/suspend` was consolidated
onto the canonical `setPartnerUserStatus`, whose `withAudit` wrapper writes to
**`partner_management_audit`**; the assertion still read `partner_audit_events`, matching the
route's original inline implementation. The sibling location-suspend route still uses `adminAudit`
(→ `partner_audit_events`), which is why *its* assertion passed. The action IS audited.

The assertion was corrected to read the table the code actually writes, and **not weakened**: it
still requires exactly one row, for `action_type='partner_user_suspended'`,
`entity_type='partner_user'`, the right `entity_id`, and `result='succeeded'`. Suite now 12/12.

---

## D-3 — the full pilot suite leaked 16 storage objects per run · LOW (test hygiene)

**Proof:** the A/B storage audit found exactly 16 orphaned objects in
`partner-real-r2-proof-fpilot` after **both** matrices, and 48 after three runs — i.e. it grows
every build, precisely the behaviour `tests/helpers/partner-test-storage.ts`'s own header documents
from an earlier revision.

**Cause:** `createBatchAtomic` uploads four rendered assets per batch under
`print-batches/<batchId>-…` from inside `server/print-batch.ts`. The suite only ever learns the
batch id, so `track()` cannot cover the derived keys and `cleanup()` missed all of them.

**Fixed in this pass:** `trackPrefix()` added to the storage helper — cleanup now sweeps tracked
keys, `runPrefix`, **and** registered prefixes, still one `DeleteObject` at a time, still no
`DeleteObjects`, no `DeleteBucket`, and never an unprefixed list; an empty prefix is refused
outright. The pilot suite registers `print-batches/`. Verified: storage went from 48 objects to
**0** after the fix.

---

## Observations recorded, not acted on

- **Migration-number collision across branches.** Staging has journalled
  `0046_partner_mfa_pending_lifecycle.sql`, while the primary working tree carries an untracked
  `migrations/0044_partner_mfa_pending_lifecycle.sql` and PR #288 uses `0044` for
  `partner_submission_lifecycle_and_location_snapshot`. Different branches, out of scope here.
- **Drizzle-model drift on `certificates`.** Beyond the three columns in D-1, `claim_code` was
  already known-undeclared. The model is not a complete description of the live table, and nothing
  currently asserts that it is for the raw-SQL columns.
- **A draft save without `overall_grade` fails.** `grade = ${gradeNum}` sends `''` into
  `numeric(4,1)` and Postgres rejects the whole statement. Every real client sends the field, so
  this is latent rather than live; noted because it shaped the test payloads.
