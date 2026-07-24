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

## Table roles

- **`certificates.print_state`** — **AUTHORITATIVE** for the print lifecycle. One column,
  one lifecycle. Distinct from `status` (validity: active/voided) and `grader_status`
  (grading workflow), which it never overloads.
- **`print_batches`** — **AUTHORITATIVE** for batch identity, membership, status, and
  attribution (created_by + role). Durable; replaces the old ephemeral audit_log+R2 batch.
- **`print_events`** — **APPEND-ONLY HISTORICAL EVIDENCE**. Never updated, never deleted.
  The audit trail (actor, role, action, from→to state, reason, category, batch, timestamp).
- **`label_prints`** — **COMPATIBILITY / CACHE**. A latest-state-per-cert row that keeps
  the existing Sheet Printing console + `printedAt` working. Kept in sync by the workflow;
  it is not the lifecycle authority (it holds only the most recent print).
- **`reprint_log`** — **COMPATIBILITY / COUNT**. Append row per reprint request; drives the
  reprint-count badge. Previously orphaned (never written) — now populated by `requestReprint`.
- **`audit_log`** — unchanged global compliance log; the print renderer still writes its
  `print_batch_generated` row. Not the print-workflow authority.

## Why not derive everything from approval + label_prints?

The lifecycle has states that are not derivable from approval + a printed boolean:
`printing` (reserved, not yet confirmed), `reprint_required`, `reprinted`, and `completed`.
These require stored state. Making `print_state` the one authority — written atomically at
approval and by the workflow transitions — avoids two-sources-of-truth drift. `label_prints`
and `reprint_log` remain only as compatibility/cache surfaces for existing UI, never consulted
to decide a transition.

## Transactions

Every transition is **transactional and fail-loud** (the opposite of the legacy best-effort
print writes). A batch reserve, a mark-printed, a reprint, and a completion each run in a DB
transaction; on any failure the state is rolled back (or the reservation released) and the
error surfaces — a card never ends up `printed` because a render or write half-failed.
