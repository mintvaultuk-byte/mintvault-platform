# Print Workflow — Review Notes, Rollout, Rollback, Risks

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). Everything here is built and
locally verified on branch `feature/print-approval-printing-workflow`.
**Not deployed, not merged, not pushed, migration not applied.**

## Files changed

**New**
- `shared/print-lifecycle.ts` — pure state machine (states, transitions, permissions, filters, reprint reasons, duplicate detection). No DB/React imports.
- `server/print-workflow.ts` — service layer: boot migration, actor resolution, queue read, batch/reprint/complete transitions (transactional, fail-loud).
- `server/routes/print-workflow.ts` — `/api/admin/printing/workflow/*` endpoints.
- `client/src/pages/admin-print-queue.tsx` — the lifecycle queue UI (+ reprint modal, audit drawer, batches panel).
- `migrations/add-print-workflow-schema.sql` — checked-in DDL record (additive, idempotent).
- `tests/print-lifecycle.test.ts` — 35 tests covering every brief scenario.
- `docs/print-workflow/*`, `.claude/controlled-code-lead/print-workflow/*` — docs + governance state.

**Edited (additive only)**
- `shared/schema.ts` — `certificates.print_state` column; `print_batches` + `print_events` tables; `PrintQueueRow`/`PrintBatchSummary` shared types.
- `server/routes.ts` — import + register the new router; add the boot migrate call.
- `server/routes/staff.ts` — extend the existing print-proxy whitelist with the new read/write sub-paths (complete deliberately excluded — admin-only).
- `client/src/components/admin/admin-shell.tsx` — new `print-queue` nav tab (Operations).
- `client/src/pages/admin-dashboard.tsx` — render the tab.
- `client/src/pages/staff.tsx` — mount the staff queue for `can_print` staff.

## Database changes (AUTHORED, NOT APPLIED)

| Change | Type | Notes |
|---|---|---|
| `certificates.print_state` | `ADD COLUMN` varchar(24) default `'awaiting_approval'` + index | additive; existing rows default in |
| `print_batches` | `CREATE TABLE` | durable batch records |
| `print_events` | `CREATE TABLE` | append-only audit ledger |

Applied by the idempotent boot-time `migratePrintWorkflowSchema()` (same
`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` pattern as every recent
certificates column). **No DROP, no data mutation.** Live `information_schema`
must be inventoried on the target DB before first apply (repo has a live≠code
drift history — mintvault-db-migration-discipline).

## API changes (all NEW; nothing existing modified)

| Method | Path | Who |
|---|---|---|
| GET | `/api/admin/printing/workflow/queue` | admin + can_print staff |
| GET | `/api/admin/printing/workflow/batches` | admin + can_print staff |
| GET | `/api/admin/printing/workflow/batches/:batchId` | admin + can_print staff |
| GET | `/api/admin/printing/workflow/events?certId=` | admin + can_print staff |
| POST | `/api/admin/printing/workflow/batch` | admin + can_print staff |
| POST | `/api/admin/printing/workflow/mark-printed` | admin + can_print staff |
| POST | `/api/admin/printing/workflow/reprint` | admin + can_print staff |
| POST | `/api/admin/printing/workflow/complete` | **admin only** |

Staff reach these through the existing `/api/staff/print/*` proxy (unchanged
mechanism; whitelist extended). The existing `/api/admin/print-batch*` renderer
endpoints are **untouched** and still produce the PDF bytes.

## Tests

`tests/print-lifecycle.test.ts` — 35 passing. Covers: Approval→Needs Printing
(effective-state derivation with the grader untouched), batch creation, Print
Selected, Print All Ready, Printed status (first-run vs reprint), the full
reprint loop, completion (terminal, idempotent-safe), duplicate prevention,
permissions (admin / staff_print / staff_readonly), all six queue filters, and
lifecycle regression guards (no illegal shortcut transitions).

Full suite: **1728 passed** (incl. these 35). The 14 failing files are
pre-existing DB/Postgres-integration tests that need `MINTVAULT_DATABASE_URL` /
`TEST_DATABASE_URL` / a local Postgres 17 — none reference this feature and they
fail identically on the base commit.

Gates: `npm run check` (tsc) clean · `npm run build` clean (new code confirmed
present in both bundles) · eslint on new files 0 errors (8 warnings, all the
repo's standard `req.session as any` / `catch (err: any)` convention).

## Review notes (findings surfaced during build)

The investigation surfaced three existing weaknesses. This feature works around
them for its own writes and flags them:
- **B-1** `reprint_log` was orphaned (the old reprint route never wrote it). The
  new reprint path now populates it, so the reprint-count badge is accurate.
- **B-2** the legacy batch/audit writes are best-effort (a batch can print with no
  record). All new lifecycle writes are **transactional and fail-loud** instead.
- **B-3** staff-proxied prints were audited as literal `"admin"`. New writes use
  `resolveActor()` → real admin **or** staff email + role. (The legacy routes are
  not modified — that's a separate, optional fix.)

## Rollout plan

1. **Review** this branch (and the DB change) with the owner.
2. On approval, **apply the migration** — run against **staging** first
   (`ep-purple-voice`), verify `print_state`, `print_batches`, `print_events`
   exist via `information_schema`, smoke-test the queue. Applying is the
   owner-gated protected action; the boot migrate self-applies on first
   staging boot/deploy, or run `migrations/add-print-workflow-schema.sql` directly.
3. **Deploy** to staging via `scripts/safe-deploy.sh staging`, exercise the full
   loop (approve → needs printing → batch → printed → reprint → completed) with
   real certs, confirm the existing Sheet Printing console still works unchanged.
4. On sign-off, **apply to prod** (`ep-wispy-morning`) + `scripts/safe-deploy.sh prod`.
5. Feature is visible immediately (new nav tab); no feature flag. If a gated
   rollout is wanted, gate the `print-queue` tab render behind a flag — say so.

## Rollback plan

- **Code:** the feature is additive and isolated. Revert the branch / redeploy the
  prior image. The new nav tab and endpoints simply disappear; the existing Sheet
  Printing console and renderer are unaffected (never modified).
- **Data:** the migration is additive (one nullable-defaulted column + two new
  tables). Rolling back the code leaves them in place, harmless and unread. If
  removal is ever required: `DROP TABLE print_events, print_batches;` and
  `ALTER TABLE certificates DROP COLUMN print_state;` — but that discards print
  history, so prefer leaving them. No existing column is altered, so there is
  nothing to restore.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Migration collides with a live column named `print_state` | Low | `ADD COLUMN IF NOT EXISTS` is a no-op on collision; inventory `information_schema` before apply (mandatory). |
| Two-call batch flow (render → persist) leaves state mid-way if the 2nd call fails | Low | Persist is idempotent on batchId; a retry re-syncs. The renderer already succeeded, so the PDF exists. Queue shows the cert still `needs_printing` until persisted — safe (no lost label). |
| `label_prints.printed_at` overwrite means per-cert printedAt reflects only the latest batch | Low | Full history lives in the new append-only `print_events` ledger; the badge/date is "latest" by design. |
| Staff-without-can_print cannot see a read-only queue | Low (product) | No capability tier exists between "none" and "can_print". Optional `can_view_printing` flag offered as a follow-up if you want a true read-only staff view. |
| Customer/submission join misses certs with neither `submission_item_id` nor a card→submission link | Low | Those fields render "—"; the row still appears and is fully actionable. |
| First boot applies the migration automatically | Medium (process) | It's owner-gated by not deploying; additive + idempotent. Documented so the first staging boot is a conscious step. |

## Proof level reached

**Local Proof** — tsc clean, 35 unit tests green, full suite non-regressed,
production build clean with new code present in both bundles. NOT yet
Integration/Staging/Production verified (no DB applied, app not run against a live
DB — that is the owner-gated next step in the rollout plan above).
