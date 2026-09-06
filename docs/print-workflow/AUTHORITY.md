# Print Workflow — Data Model Authority Map

The single source of truth for each fact, and the role of every table involved.
No fact is maintained in two places without one clear authority.

## Source of truth per fact

| Fact | Authority | How it's set | Derived/cache surfaces |
|---|---|---|---|
| Is the grade approved? | `certificates.grade_approved_at` (+ `grade_approved_by`) | The grader/admin approval routes (unchanged grading logic) | — |
| Does it need printing? | `certificates.print_state = 'needs_printing'` | Written **atomically in the approval transaction** (CASE promote from `awaiting_approval`); historical rows set by the 0022 backfill | The queue derives it as a read-time fallback only if an approved cert somehow still shows the default |
| Is it currently in a batch? | `certificates.print_state = 'printing'` + the `print_batches` row (`status`) | `createBatchAtomic` reserve step (state-guarded) | `label_prints.sheet_ref` (compat/sheet-history) |
| Did printing succeed (on paper)? | `certificates.print_state IN ('printed','reprinted')` + `print_batches.status='printed'` + `label_prints.printed_at` | Explicit `mark-printed` only — never on a click | `label_prints.printed_at` mirrors it for the legacy sheet UI |
| Is a reprint required? | `certificates.print_state = 'reprint_required'` | `requestReprint` (reason + category required) | `reprint_log` (count badge, now correctly populated) |
| Is the workflow completed? | `certificates.print_state = 'completed'` | `markCompleted` (admin only, terminal) | — |
| Full lifecycle history (who/why/when) | `print_events` (append-only) | Every transition writes one row | — (this IS the evidence) |
| Was a print artifact durably published/replayed? | `object_write_operations` + `object_write_items` | The `PRINT_ARTIFACT` coordinator binds one immutable manifest and committed result to the actor-scoped key | `audit_log` compliance projections |

## Table roles

- **`certificates.print_state`** — **AUTHORITATIVE** for the print lifecycle. One column,
  one lifecycle. Distinct from `status` (validity: active/voided) and `grader_status`
  (grading workflow), which it never overloads.
- **`print_batches`** — **AUTHORITATIVE** for batch identity, membership, status, and
  attribution (created_by + role). Its non-empty, well-formed `cert_ids` value is the only
  membership authority accepted before cached artifact bytes are served. Durable; replaces
  the old ephemeral audit_log+R2 batch.
- **`print_events`** — **APPEND-ONLY HISTORICAL EVIDENCE**. Never updated, never deleted.
  The audit trail (actor, role, action, from→to state, reason, category, batch, timestamp).
- **`label_prints`** — **COMPATIBILITY / CACHE**. A latest-state-per-cert row that keeps
  the existing Sheet Printing console + `printedAt` working. Kept in sync by the workflow;
  it is not lifecycle or immutable sheet-membership authority (it holds only the most
  recent print). Because a later reprint moves `sheet_ref`, it is never used to authorize
  download of an older artifact.
- **`reprint_log`** — **COMPATIBILITY / COUNT**. Append row per reprint request; drives the
  reprint-count badge. Previously orphaned (never written) — now populated by `requestReprint`.
- **`object_write_operations` / `object_write_items`** — **AUTHORITATIVE** for artifact
  publication, immutable manifest identity, committed-result replay, and reconciliation.
- **`audit_log`** — append-only global compliance and command-receipt projection. Verified
  direct reprints write per-certificate reason rows in the same finalization transaction;
  state-only reprint requests write a hashed, actor-scoped idempotency receipt. Neither use
  makes `audit_log` lifecycle, batch, or artifact authority.

## Why not derive everything from approval + label_prints?

The lifecycle has states that are not derivable from approval + a printed boolean:
`printing` (reserved, not yet confirmed), `reprint_required`, `reprinted`, and `completed`.
These require stored state. Making `print_state` the one authority — written atomically at
approval and by the workflow transitions — avoids two-sources-of-truth drift. `label_prints`
and `reprint_log` remain only as compatibility/cache surfaces for existing UI, never consulted
to decide a transition.

## Transactions

Every database transition is **transactional and fail-loud** (the opposite of the legacy
best-effort print writes). A batch reserve, a mark-printed, a reprint, and a completion each
run in a DB transaction. Proven domain abandonment restores a reservation; an ambiguous
object-store outcome becomes `RECONCILIATION_REQUIRED` and remains finalizable instead of
being guessed safe. A card never becomes `printed` because a render or write half-failed.

The state-only reprint request stores its actor/payload-bound idempotency receipt in the
append-only `audit_log`. Concurrent retries are serialized with a transaction advisory lock,
then read with ordinary `SELECT` and append with `INSERT`; the runtime role is not granted
`UPDATE` or `DELETE`. A same-key/same-payload retry replays the stored result. Reusing the key
for another payload is a typed conflict.

## Replay and current-output safety

Command replay and byte download have deliberately different time semantics:

- A validated, already-COMMITTED direct command returns its immutable recorded result before
  new mutable eligibility checks. This makes a lost-response retry exact and effect-free.
- Every PDF, PNG, and cut-SVG download revalidates the complete current output gate: the batch
  must have authoritative `print_batches.cert_ids`, and every member must still exist, be
  active/non-deleted, approved, outside grading review, printable, and Partner-eligible.
- A pre-0022 artifact with no authoritative immutable batch membership fails closed and must
  be regenerated. Mutable `label_prints` pointers cannot prove its complete contents.

Known terminal coordinator abandonment is safe to retry as a new logical attempt/key. An
unknown publication or verification outcome remains `RECONCILIATION_REQUIRED`; it must keep
the original key and must not be guessed abandoned.

During rolling compatibility, a stored legacy `legacy_unspecified` reason category is treated
as canonical `null` only while comparing/replaying an existing intent. New direct commands
write `null`; the legacy sentinel is never emitted by new evidence.

## Release readiness

The enabled print component requires migration 0022 and all runtime print relations. Its
contract checks the consumed column types/nullability, lifecycle default, unique identities,
lookup indexes, every generated integer ID with a validated single-column primary key and
the exact owned sequence/default, and every NOT NULL/defaulted value omitted by reachable
inserts. Production readiness also proves the runtime role's exact table verbs and sequence
privileges: lifecycle/cache tables receive only their required mutations, `print_events` and
`audit_log` remain SELECT+INSERT append-only, and sequences receive USAGE+SELECT but not UPDATE.
