# Trusted Intake Connector — G3 Destination Boundary

Evidence gathered by a read-only audit agent against this worktree at
commit `045732e7`, cross-checked by the Lead against `shared/schema.ts` and
`server/storage.ts` directly. File:line citations below are current as of
that commit.

## Destination tables

- **Submission**: `submissions` (`shared/schema.ts:199-277`). Real columns
  used: `id` (serial), `userId` (varchar, NOT NULL, **no DB-level FK** —
  confirmed by grep, no `.references()` on this column anywhere), `status`
  (varchar, default `'draft'`), `trackingNumber` (text, NOT NULL, UNIQUE),
  `paymentStatus` (varchar, default `'unpaid'`), `serviceType`/`serviceTier`
  (free text, no enum/FK), `totalPrice`/`totalDeclaredValue`/`gradingCost`/
  `shippingCost` (money fields), `cardCount`, `customerEmail`/
  `customerFirstName`/`customerLastName`/`phone` (denormalised contact
  snapshot columns already on the table), `gradingStatus` (default
  `'unassigned'`), `scanStatus` (default `'unassigned'`).
- **Items**: `submission_items` (`shared/schema.ts:279-292`). `cards`
  (`shared/schema.ts:306-322`) is **dead** — zero write callers found
  anywhere in `server/` (grepped `insert(cards)` / `INSERT INTO cards` /
  `.from(cards)`, no matches). G3 writes only to `submission_items`, never
  to `cards`, and adds a regression test asserting this.

## Destination service methods — NOT reused by G3

`storage.createSubmission` (`server/storage.ts:386-470`) and
`storage.addSubmissionItems` (`server/storage.ts:710-725`) are the existing
methods a normal checkout uses. G3 does **not** call either of them. Two
independent reasons:

1. `createSubmission`'s raw INSERT contains, at `server/storage.ts:411`:
   `COALESCE(${data.userId || null}, (SELECT id FROM users LIMIT 1),
   gen_random_uuid()::text)` — if the caller omits `userId` it silently
   attaches the submission to an **arbitrary existing user** (no
   `ORDER BY`, so which row is undefined), or, if `users` is empty,
   generates a UUID that matches no real user at all. This is exactly the
   risk the brief prohibits ("no hidden fallback... no unrelated account
   selection"). The existing checkout flow itself relies on this fallback
   (it never passes `userId` at creation time — see
   `server/routes/submissions.ts:609-651` — and only attaches the real user
   later, post-payment, via `updateSubmission`). Modifying
   `createSubmission` to remove the fallback would change behaviour for
   that existing, unrelated caller — out of bounds per "existing public
   submission behaviour must not regress." Adding an optional bypass
   parameter to the same function was considered and rejected: it would
   still leave the unsafe path reachable by any future caller who forgets
   to pass it, which is a worse property than not touching the function at
   all.
2. `getNextSubmissionId` (`server/storage.ts:624-628`) is a
   `COUNT(*)`-based generator with no locking — race-prone under concurrent
   inserts. Fixing it generally is a repository-wide behaviour change
   outside this task's authorised scope ("do not widen scope into a general
   customer-account redesign" — the same principle applies to the general
   reference generator). G3 adds its **own**, connector-scoped,
   sequence-backed allocator instead (`connector-reference.ts`) and leaves
   the general one untouched.

**Decision**: G3's importer performs its own direct, parameterised
`INSERT INTO submissions (...) VALUES (...)` and
`INSERT INTO submission_items (...) VALUES (...)` inside its own
transaction (see `IDEMPOTENCY-AND-TRANSACTION.md`), executed by the
`partner_connector_runtime` role over the connector's existing DB pool
(`connector-db.ts`). This is the smallest-blast-radius option: zero lines
of `shared/schema.ts` or `server/storage.ts` change, zero risk to the
existing checkout flow, and the new INSERTs are shaped identically to what
`createSubmission`/`addSubmissionItems` already produce (same columns, same
defaults) so the created row is a **normal** submission indistinguishable
in shape from a checkout-created one, just with an explicit, safe `userId`
and reference instead of the risky fallback path.

## Initial status

- `status = 'draft'` — the same literal value the real checkout flow passes
  explicitly (`server/routes/submissions.ts:619`) and the schema's own
  default (`shared/schema.ts:202`). No new status value invented.
- `paymentStatus = 'unpaid'` — the schema default (`shared/schema.ts:208`);
  the real checkout flow never overrides it at creation time either (its
  raw INSERT's column list omits `payment_status` entirely — confirmed by
  audit). G3 sets it explicitly to the same value for clarity, not because
  the value differs from checkout's.
- `gradingStatus` / `scanStatus` are left at their schema defaults
  (`'unassigned'` both) — the importer does not set them, exactly matching
  what a normal new submission looks like before any grading/scanning work
  begins.

## Item creation path

`submission_items` rows, one per validated Partner card, inserted in the
same transaction as the submission row and the import-mapping completion
(see `IDEMPOTENCY-AND-TRANSACTION.md`). Field mapping:

| Partner `partner_submission_cards` column | MintVault `submission_items` column |
| --- | --- |
| `sequence_number` | `card_index` |
| `game` | `game` |
| `card_set` | `card_set` |
| `card_name` | `card_name` |
| `card_number` | `card_number` |
| `year` | `year` (stored as text on the destination, integer on source — cast) |
| `declared_value_pence` | `declared_value` |
| — (no Partner equivalent) | `declared_new` — left at schema default `false`; Partner has no "new/unopened" concept today |
| — (no Partner equivalent) | `notes` — left `NULL`; Partner card `customer_notes` is explicitly excluded from the fingerprint per `SOURCE-FINGERPRINT.md` and is not carried across (it's a free-text field, not a structural fact — carrying it would also risk leaking Partner-internal text into a MintVault-visible field without review) |

`quantity` on the Partner card is **not** a 1:1 mapping to a MintVault
`submission_items` row multiplier — `submission_items` has no `quantity`
column (one row = one physical card slot). A Partner card with
`quantity > 1` produces `quantity` separate `submission_items` rows, each
carrying the same descriptive fields and index continuing sequentially, and
`submissions.card_count` is the total row count (not the card count),
matching how `cardCount` is used elsewhere in the schema (see
`shared/schema.ts:204` — "how many rows", not "how many logical cards").

## Hidden side effects — confirmed absent for the code path G3 actually uses

Confirmed by direct grep of `server/routes/submissions.ts` and
`server/storage.ts`: `storage.createSubmission` and
`storage.addSubmissionItems`, called on their own (not through the route
handler that wraps them), trigger **no** Stripe call, **no** email send, no
certificate/cert-counter write, no label/print-batch write, no webhook call.
All of those live in the surrounding `POST /api/create-payment-intent` /
`POST /api/confirm-payment` route handlers, not inside the storage
functions themselves. Since G3 never calls those route handlers or their
storage functions — only its own direct INSERTs, shaped identically but
executed from `connector-import-service.ts` — there is nothing to suppress;
the side effects simply aren't wired to fire from this code path in the
first place. This is verified again by a dedicated forbidden-side-effect
test (see `G3-PLAN.md` test list) that snapshots every side-effect-adjacent
table's row count before and after an import and asserts no change.

## Transaction boundary

One database transaction covers: connector-record lock + precondition
checks, fresh Partner-source read + fingerprint recheck, owner resolution
(insert-or-reuse on `users` via the customer-link mapping), reference
allocation, `submissions` INSERT, `submission_items` INSERTs, import-mapping
completion, connector-record transition to `imported`, immutable event
write. See `IDEMPOTENCY-AND-TRANSACTION.md` for the full sequence and why
this is safe given `withConnectorTx` already proves cross-table
transactions work today (G1/G2 already write into both connector tables and
read Partner tables in one transaction; G3 extends the same pool/role to
also write into two more MintVault tables it's freshly granted access to).

## Public visibility behaviour

Once committed, the new `submissions` row is visible via the existing
tracking-number lookup (`getSubmissionBySubmissionId`) exactly as any other
`draft`/`unpaid` submission is today — no new visibility rule is introduced
and none is suppressed. This matches the brief's requirement that the
created destination be an indistinguishable, normal pre-grading submission.
