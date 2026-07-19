# Trusted Intake Connector — G3 Customer/Owner Strategy

## Architecture decision gate resolution

Question: what destination owner/user ID does a Partner-originated
submission use?

**Chosen: provenance-linked customer account, resolved deterministically by
`(partner_organisation_id, partner_customer_id)` — never by email alone.**
This is option D from the brief's preferred list, adapted: rather than
matching against `users.email` (which the brief explicitly forbids unless
"the existing data model explicitly proves it is safe" — it does not; see
below), the match key is the Partner customer's own stable identity.

### Why email-only matching is rejected

`server/storage.ts`'s existing `fulfilPaidSubmission` path (used for real,
paid MintVault checkouts) does resolve owners by `getUserByEmail` +
`createUser` fallback — but that is a single-tenant context: one MintVault
customer, one email, no cross-tenant concern. Partner is different:
multiple independent Partner organisations, each with their own customer
list, can plausibly contain the same email address for two _different_
real people (a shared family inbox, a common `info@` collection-shop
address used as the "customer" contact by more than one shop, a customer
who is genuinely a customer of two unrelated Partner shops under the same
email). Matching only by email would silently merge those into one MintVault
`users` row and one order history — a genuine cross-tenant data-mixing risk
the brief explicitly calls out ("no email-only cross-tenant linking unless
explicitly guaranteed"). Nothing in the schema guarantees email uniqueness
_per Partner organisation_ today (`partner_customers` has no such
constraint checked), so this risk is real, not hypothetical.

### Chosen mechanism

New table `partner_connector_customer_links`
(`(partner_organisation_id, partner_customer_id) → mintvault_user_id`,
UNIQUE on the pair). On first import for a given Partner customer:

1. Look up the link. If found, reuse its `mintvault_user_id` — no new
   `users` row, no rewrite of the existing one's snapshot fields.
2. If not found, INSERT a new `users` row using the _validated_ Partner
   customer snapshot (`full_name` split into `firstName`/`lastName` best-
   effort, `email`, no `passwordHash` set — this account can never log in
   via password, matching "prevent login where appropriate" for a
   Partner-sourced account without inventing a new `role` value or a
   "system account" concept the schema doesn't have), then INSERT the link
   row in the same transaction.

This is deterministic (same Partner customer → same MintVault user, every
time), tenant-safe (the match key includes `partner_organisation_id`, so
two different Partner orgs' customers — even with identical emails — always
resolve to two different `users` rows), repeatable (a second import for the
same Partner customer, whether from a retry or a genuinely new submission,
reuses the same link), and produces no arbitrary-account selection and no
garbage UUID (the `users.id` is `gen_random_uuid()` from the normal column
default, generated fresh for a genuine new row, not synthesised in
application code).

### Why not the other options

- **Option A alone (caller-supplied owner ID)** doesn't answer _who_ — the
  connector has no logged-in MintVault user to supply; it needed its own
  resolution strategy regardless, so this is folded into the chosen
  mechanism rather than being a separate option.
- **Option C (single system-owned account for all Partner imports)** was
  rejected: every Partner-sourced submission across every organisation and
  every real end customer would attribute to one shared account, destroying
  per-customer order history and traceability, and creating an operational
  hazard (an admin viewing that account's history would see every Partner
  customer's items mixed together with no way to tell them apart without
  reading the provenance mapping for every row). The brief's own
  requirement ("historical customer details preserved... repeated imports
  for the same Partner customer behave consistently") is naturally satisfied
  by per-customer accounts and actively worked against by a single shared
  one.

### Implementation correction: `users.email` is left NULL

`users.email` carries a DB-level `UNIQUE` constraint (`shared/schema.ts:71`).
If two different Partner organisations' customers happen to share an email
address, inserting the second connector-created `users` row with that same
email would fail the constraint — or, worse, an implementation that
"resolved" this by reusing the existing row would silently re-introduce the
exact cross-tenant merging this document rejects above. Neither is
acceptable, so the connector-created `users` row leaves `email` **NULL**.
The real email is preserved in two other places instead:
`partner_connector_customer_links.email_snapshot` (new column, this table
only, no uniqueness constraint) and `submissions.customerEmail` (the
existing per-submission contact-snapshot column every normal submission
already carries). Lookup of an existing link is always by
`(partner_organisation_id, partner_customer_id)`, never by email, so this
has no effect on the resolution algorithm's determinism — it only means the
`users` row itself doesn't carry a queryable email, matching the fact that
it also can't carry a password and isn't meant to be logged into directly.

## Cross-tenant protection

Enforced at the schema level: `partner_connector_customer_links` UNIQUE
constraint is on `(partner_organisation_id, partner_customer_id)`, not on
`mintvault_user_id` or email — two different orgs' customers can map to
`users` rows with the same email without conflict, and the lookup always
filters by `partner_organisation_id` first. A cross-tenant read is also
structurally impossible the same way G2's other RLS-scoped reads are: the
importer only ever looks up the link using the connector record's own
`tenant_id` (read from the non-RLS'd connector record, never from a
caller-supplied parameter directly — same trust-boundary shape G2's
database-security review already verified for `validateConnectorRecord`).

## Historical customer details

Not linked live — **snapshotted**. The `users` row created on first import
captures the Partner customer's name/email _as validated at import time_
and is never rewritten by a later Partner-side edit (the G2 validation
engine already treats any later Partner customer edit as a fingerprint
change requiring revalidation, which is a _different_ submission's concern,
not a retroactive edit to an already-imported one). This matches
`ROLLBACK-AND-RECONCILIATION.md`'s existing "completed mapping is
read-only after creation" principle, extended to the `users` row it
produced. `submissions.customerEmail`/`customerFirstName`/
`customerLastName`/`phone` (columns already on the table, used by the
normal checkout flow for point-in-time contact snapshotting) are populated
the same way — a second, submission-level snapshot independent of the
`users` row, exactly mirroring how a normal checkout submission already
carries its own contact snapshot separate from the account's current
profile.

## Repeated Partner customers

A second submission from the same real-world Partner customer (same
`partner_customer_id` within the same org) reuses the existing link → same
`users.id` → a second, independent `submissions` row under that same user,
exactly like a repeat MintVault customer placing a second order. No
special-casing needed beyond the link-table lookup already described.

## Migration implications

New table only (`partner_connector_customer_links`); no change to `users`'
own schema (no new column, no new role value). Full detail in
`SERVICE-PRICE-MAPPING.md`/`G3B` migration.
