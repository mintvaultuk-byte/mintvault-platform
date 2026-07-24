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

## Hardening pass (staging-prep) — what changed since the first draft

- **Numbered migration.** The schema now ships as `migrations/0022_print_workflow_lifecycle.sql`
  applied by the repo's numbered runner (`npm run db:migrate`). The boot-time ALTER was
  removed — there is exactly **one** schema-mutation path. 0019–0021 are claimed by unmerged
  branches, so 0022 is used to avoid the runner's duplicate-number hard-reject. Passes
  `db:lint-sql` (additive only) and the migration-governance test.
- **Approval → Needs Printing is automatic.** All five approval/publish paths now set
  `print_state='needs_printing'` **in the same transaction** as `grade_approved_at`, via a
  `CASE` that only promotes from the default (never regresses an in-flight print state). No
  manual operator step. Failed approval prints nothing; re-approval is single-fire (approve-lock).
- **Batch flow is now server-authoritative and atomic** — `createBatchAtomic`: reserve
  (race-safe, state-guarded `UPDATE … RETURNING`) → render/upload → finalise, with
  **release-on-failure** and **idempotent retry** (a re-fire of an in-flight batch returns the
  existing one). The old client two-call flow is gone. A card only becomes `printed` on an
  explicit mark-printed. Single source of truth documented in [AUTHORITY.md](./AUTHORITY.md).
- **Real database tests (Postgres 17, Docker harness).** 25 DB-backed tests across migration/
  backfill/approval-integration, service atomicity/idempotency/concurrency/release/reprint/audit,
  and route-level permissions — plus 36 pure state-machine tests. **61 total, all passing.**
  Full suite: **1876 passed, 0 failed**, 635 skipped (the 5 failing *files* are pre-existing
  setup-throws for `TEST_DATABASE_URL`/`MINTVAULT_DATABASE_URL`, unrelated to printing; the two
  `TEST_DATABASE_URL` migration tests pass once that DB is provided).
- **Reconciled with main.** Rebased onto the current `origin/main` (twice — main moved during
  the work). Canonical grading workstation untouched. Partner migration fixtures + the
  migration-inventory parity test updated to acknowledge 0022.

## Independent hostile review (3-reviewer adversarial panel) — findings & fixes

An adversarial panel (DB, backend, security) was run before staging. Two reviewers
independently converged on the same critical concurrency flaw. All Critical/High
findings are fixed; each has a regression test.

| ID | Sev | Finding | Fix | Test |
|---|---|---|---|---|
| F1 | **Critical** | Concurrent identical batch submits shared one deterministic batch id; the loser clobbered the winner's `cert_ids` and stranded certs in `printing`. | Batch id is now a **unique per-request nonce**; the batch row is created **only when certs are actually reserved**, so a losing request writes nothing. Retry idempotency preserved by the in-flight membership pre-check. | `F1 regression: concurrent IDENTICAL submits…` |
| F2 (reprint) | High | A second same-day reprint of the same certs collided with the first id and was silently swallowed. | Same unique-id fix removes the collision. | `DB-F2 regression: second same-actor reprint…` |
| F3 (durability) | High | FINALISE failure / process-crash mid-render left certs stranded in `printing`, batch stuck `rendering`, unrecoverable. | FINALISE moved **inside the try** (release on any failure) + a **boot reconciler** `reconcileStuckPrintBatches` (age-guarded) releases stale `rendering` batches. | `reconciler releases a stale 'rendering' batch…` |
| F3 (mark-printed) | High | `mark-printed` had no batch-status guard — a never-rendered `rendering` batch could be marked printed with no PDF. | `markBatchPrinted` now rejects unless `status='printing'` (finalised). | `backend-F3 regression: mark-printed rejects…` |
| F5 (CAS) | Medium | Double-fire of mark-printed/reprint/complete duplicated ledger events. | Compare-and-set (`AND print_state = <from>` + `RETURNING`); event written only on a real change. | covered by mark-printed status-guard + idempotency tests |
| PII | Medium | Queue's computed `customerName` wasn't in the staff PII-strip set → leaked to `can_print` staff. | Added `customerName` to `GRADER_PII_KEYS`. | (strip-set data; admin sees it, staff stripped) |
| resolveActor | Low | Fallback returned role `admin`. | Fail-closed to `staff_readonly`. | — |
| BATCH_STATUSES | Low | Type union omitted `rendering`. | Added. | — |

### F4 (deploy-order) — a HARD rollout gate, not a code change
The 5 approval sites reference `print_state` unconditionally. If the **code deploys
before 0022 is applied** on a host, every grade approval 500s. **Mitigation is
procedural and mandatory:** apply 0022 and verify `print_state` exists via
`information_schema` on the target DB **before** the code deploy. This is enforced
in the rollout below and is why staging migrates first, then deploys.

## Proof level reached

**Local Proof** — tsc clean, 35 unit tests green, full suite non-regressed,
production build clean with new code present in both bundles. NOT yet
Integration/Staging/Production verified (no DB applied, app not run against a live
DB — that is the owner-gated next step in the rollout plan above).
