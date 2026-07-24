# Print Workflow — Architecture

**Feature:** Approval → Printing → Printed lifecycle queue for MintVault admin.
**Branch:** `feature/print-approval-printing-workflow` (isolated worktree).
**Status:** built locally, NOT deployed / merged / pushed / DB-applied. Awaiting owner approval to land.

## 1. What this adds (and what it deliberately reuses)

MintVault already had a **print renderer** (`server/print-batch.ts` → PDF/PNG/Cricut)
and a **Sheet Printing console** (`admin-printing.tsx`). What it lacked was an
explicit, auditable **lifecycle**: no per-cert print status beyond a boolean
`printed_at`, no persisted batch records, and reprints with no reason/actor/history.

This feature adds that lifecycle **on top of** the existing renderer — it does not
replace the renderer, the Sheet Printing console, or the grading/approval flow.

## 2. Lifecycle state machine (single source of truth: `shared/print-lifecycle.ts`, pure/testable)

```
Awaiting Approval → Approved – Needs Printing → Printing → Printed → Completed
                                                    ↑           │
                                          Reprinted ┘   Reprint Required (from Printed/Completed)
                                                    ↑___________┘
```

| State (stored `print_state`) | Meaning | Entered by |
|---|---|---|
| `awaiting_approval` | grade not yet approved | default; derived while `grade_approved_at IS NULL` |
| `needs_printing` | approved, not batched | derived when `grade_approved_at IS NOT NULL` and no advanced state set |
| `printing` | in an open batch, PDF generated, not confirmed on paper | Create/Print batch |
| `printed` | physically printed (first time) | Mark Printed on a `batch`-kind batch |
| `reprint_required` | flagged for reprint (lost/damaged/etc.) | Reprint request (needs reason) |
| `reprinted` | reprint physically done | Mark Printed on a `reprint`-kind batch |
| `completed` | terminal (slab assembled / shipped / done) | Mark Completed (admin only) |

**Approval is NOT modified.** The grader still owns `grade_approved_at`/`grader_status`.
The queue computes the *effective* state on read: advanced stored states win; otherwise
`grade_approved_at` presence decides `needs_printing` vs `awaiting_approval`. This keeps
the protected grading/approval code untouched — no hook, no edit.

## 3. Data model (authored, NOT applied — additive/idempotent)

- **`certificates.print_state`** — `varchar(24) NOT NULL DEFAULT 'awaiting_approval'` + index.
  (Distinct from `status` = validity, and from `grader_status` = grading workflow. Not overloaded.)
- **`print_batches`** — new table. Batch ID, kind (`batch`|`reprint`), status
  (`open`|`printing`|`printed`|`partial`|`failed`|`cancelled`), cert_ids (jsonb),
  cert_count, success/failure counts, created_at, created_by, printed_at, notes,
  reason, reason_category, layout_version.
- **`print_events`** — new append-only ledger (**never deleted**). cert_id, batch_id,
  actor, actor_role, action, from_state, to_state, reason, reason_category, created_at.
  This is the "never lose history" audit trail.
- `reprint_log` — unchanged shape; now correctly populated on reprint (fixes existing
  orphaned-table bug B-1).

**Migration:** boot-time idempotent `migratePrintWorkflowSchema()` (same
`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` pattern every recent
`certificates` column used), plus a checked-in SQL file
`migrations/add-print-workflow-schema.sql` for the record. **Not run against any DB**
by this task — first authorised boot/deploy applies it. Live `information_schema`
must be inventoried before applying (repo has a live≠code drift history).

## 4. Server

- `shared/print-lifecycle.ts` — pure state machine + labels + badge variants +
  permission matrix + reprint-reason categories + duplicate-detection predicate.
  Zero imports of DB/server. Fully unit-tested.
- `server/print-workflow.ts` — service layer. **Fail-loud, transactional** transitions
  (fixes the existing best-effort/silent-write class B-2). `resolveActor(req)` returns
  `adminEmail ?? staffEmail ?? "admin"` + role (fixes attribution bug B-3 for new writes).
- `server/routes/print-workflow.ts` — `registerPrintWorkflowRoutes(app)`, mounted in
  `routes.ts` alongside the other domain routers. All routes `requireAdmin`; admin-only
  terminal actions additionally reject proxied-staff (`__graderProxy`).
- `server/storage.ts` — new IStorage methods for the two new tables + the `print_state`
  column (honors the "queries go through storage" convention).
- `server/routes/staff.ts` — extend the existing explicit print-proxy whitelist with the
  new read + permitted-write sub-paths (can_print). No wildcard; terminal actions stay admin-only.

### API (all under `/api/admin/printing/*`; staff mirror at `/api/staff/print/*`)

| Method | Path | Action | Who |
|---|---|---|---|
| GET | `/api/admin/printing/workflow/queue` | lifecycle queue (filters, all columns) | admin + can_print staff (read) |
| GET | `/api/admin/printing/workflow/batches` | batch list | admin + can_print staff |
| GET | `/api/admin/printing/workflow/batches/:batchId` | batch detail + members | admin + can_print staff |
| GET | `/api/admin/printing/workflow/events?certId=` | audit history for a cert | admin + can_print staff |
| POST | `/api/admin/printing/workflow/batch` | create batch from certs (→ printing) | admin + can_print staff |
| POST | `/api/admin/printing/workflow/print-all-ready` | batch every needs_printing cert | admin + can_print staff |
| POST | `/api/admin/printing/workflow/mark-printed` | confirm a batch printed (→ printed/reprinted) | admin + can_print staff |
| POST | `/api/admin/printing/workflow/reprint` | reprint (reason+category required, confirm) | admin + can_print staff |
| POST | `/api/admin/printing/workflow/complete` | mark completed (terminal) | **admin only** |

The actual PDF/label bytes still come from the existing `POST /api/admin/print-batch`
renderer + `/api/admin/print-batch/:batchId/pdf` download — reused, not reimplemented.

## 5. Client

- `client/src/pages/admin-print-queue.tsx` — the lifecycle queue, built with the
  **design-system** primitives the grading queue uses (`Chip` filters with counts,
  `admin-cert` rows, `admin-badge` status). Mounts on both admin (`/api/admin`) and
  staff (`/api/staff/print`) via a `PrintApiBase`-style context.
  Filters: **Needs Printing · Printed Today · Printed · Reprints · Completed · All**.
  Row columns: Cert # · Card · Game · Set · Card # · Customer · Submission # ·
  Approval Date · Approved By · Print Status · Printed Date · Batch · Cert/Label/PDF exists.
  Actions: Print Selected · Print All Ready · Create Batch · Download Batch PDF ·
  Mark Printed · Reprint (modal: reason + category + duplicate confirm).
  Plus a Batches panel and a per-cert Audit drawer.
- Nav: new `"print-queue"` tab under **Operations** (`admin-shell.tsx`), rendered in
  `admin-dashboard.tsx`. Staff `print` tab gains a sub-view or link.
- `shared/schema.ts` — shared response types (`PrintQueueRow`, `PrintBatchRecord`,
  `PrintEventRecord`) imported by both sides (fixes the local-redeclare drift F5).

## 6. Permissions (mapped to the real one-admin model)

- **"Super Admin" / "Admin"** → the single admin session (`requireAdmin`). Full access,
  including the admin-only terminal `complete` and any batch cancel.
- **Staff with `can_print`** → all non-terminal print actions via the existing staff proxy.
- **Staff without `can_print`** → no printing access today (there is no capability tier
  between "none" and "can_print"). A dedicated read-only `can_view_printing` flag is
  offered as an **optional** follow-up (Class H) — see RISKS.md. Default shipped: `can_print`
  gates the queue; terminal actions are admin-only.

## 7. Safety / non-goals

Untouched: MVGS grading engine, grade/subgrade fields, the approve routes, Partner
Network, Stripe/payments, submission workflow, authentication/session logic, the
`print-batch.ts` renderer layout. This feature only adds lifecycle state, batch
records, an audit ledger, and a queue UI around them.
