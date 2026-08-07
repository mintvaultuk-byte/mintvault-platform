# Migration lock safety and the staging maintenance sequence

**Status:** review-ready, pre-staging gate. Nothing in this document has been applied to staging
or production.
**Branch:** `rep/lock-safety` (worktree `/Users/cornelius/mv-locksafety`)
**Measured on:** disposable PostgreSQL 17 clusters, created and destroyed by the proof harnesses
below. No shared cluster, no staging, no production was written to.

---

## 1. The problem in one paragraph

The migration runner (`scripts/db/migrate.ts`) wraps each transaction-safe file in **one**
`BEGIN..COMMIT`. Every lock a file takes is therefore held for the **whole file**, not for the
statement that took it. Until this change there was **no `lock_timeout` anywhere** — not in the
runner, not in a migration, not in a rollback. That does not matter while the database is quiet.
It matters enormously when it is not, because of one specific PostgreSQL behaviour:

> An `ACCESS EXCLUSIVE` request that has to wait goes into the lock queue, and **every reader that
> arrives after it waits too** — even though the reader does not conflict with the lock that is
> actually held.

So a single session sitting idle in a transaction with an ordinary `SELECT` is enough to turn a
3 ms migration into an outage of unbounded length. `lock_timeout` closes that, because it bounds
only the **wait to acquire** a lock — it never interrupts a statement that already holds one.

---

## 2. Measured lock profile

| File                        | Locks taken                                                                                           | Blocks               | Duration                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------- |
| **0047** RLS repair         | `ACCESS EXCLUSIVE` on `partner_owner_invariant_tenants`                                               | reads **and** writes | 2.4–7.9 ms                                      |
| **0048** search_path repair | none                                                                                                  | nothing              | —                                               |
| **0049** grading bridge     | `ShareRowExclusive` + `Share` on `certificates`, `submissions`, `submission_items` + 9 partner tables | writes only          | 13 ms @ 3k rows, 253 ms @ 600k, ~0.9–1.6 s @ 3M |
| **0050** connector GRANT    | none                                                                                                  | nothing              | —                                               |
| **0051** runtime flag ctrl  | `ACCESS EXCLUSIVE` on `partner_feature_flags` (DROP/CREATE POLICY, 0051:139-156)                      | reads **and** writes | 3 ms                                            |
| **0052** partner management | `ACCESS EXCLUSIVE` on `partner_internal_notes`, `partner_management_audit`, `partner_service_tiers`   | reads **and** writes | 9 ms                                            |
| **rollback-0047**           | `ACCESS EXCLUSIVE` on `partner_owner_invariant_tenants`                                               | reads **and** writes | few ms                                          |
| **rollback-0049**           | `ACCESS EXCLUSIVE` on `certificates`, `submissions`, `submission_items` **and five partner tables**   | reads **and** writes | ~16 ms, does not scale with rows                |
| **rollback-0051**           | `ACCESS EXCLUSIVE` on `partner_feature_flags`                                                         | reads **and** writes | few ms                                          |
| **rollback-0052**           | `ACCESS EXCLUSIVE` on the same three tables as 0052                                                   | reads **and** writes | few ms                                          |

0051/0052 and the four rollback rows were measured by the release's hostile reviewer; the rest were
measured here (§4). 0052's file is authored on this branch by another agent — this table is the
lock contract it must satisfy.

Three of these have a blast radius wider than the table name suggests:

- **0047** — a `SECURITY INVOKER` trigger on `partner_users`, `partner_user_roles` and
  `partner_organisations` writes `partner_owner_invariant_tenants`, so partner **user management**
  stalls behind it too.
- **0049 / rollback-0049** — `certificates` is the table behind **public certificate lookup**, the
  QR/NFC verify path. 0049 takes only write-blocking locks there, so lookup keeps serving (§4.1).
  `rollback-0049` takes `ACCESS EXCLUSIVE`, so it does not.
- **0051 — the worst of the set, and it was previously documented as "grants only, no quiet
  window". That was wrong.** `server/partner/mount.ts:119,132` reads `partner_emergency_stop` and
  `partner_portal_enabled` on **every partner request**, uncached, via
  `resolveGlobalFlag` (`server/partner/flags.ts:54-64`). Verified in this repo:
  `partnerRuntimeQuery` (`server/partner/db.ts:153-161`) sets **no `statement_timeout` and no
  `lock_timeout`**, and the runtime pool is `max: 8` with **no `connectionTimeoutMillis`**
  (`db.ts:94-96`). So while `partner_feature_flags` is under `ACCESS EXCLUSIVE`, the flag `SELECT`
  **blocks rather than erroring**; after 8 concurrent partner requests the pool is exhausted and
  every further request queues on `connect()` indefinitely. As requests do start erroring,
  `resolveGlobalFlag`'s bare `catch { return false }` **fails closed**, so the portal serves its
  kill-switch 503 — and because the catch is bare, **nothing in the logs implicates the
  migration**. The runner's 5 s `lock_timeout` is what bounds this to a 5 s stall instead of an
  open-ended one.

---

## 3. What was changed, and why there

**Decision: the bound goes in the runner as a default, with per-file and per-run escape hatches.
Not per-migration only.**

| Option                                                  | Verdict                                                                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-migration only                                      | Rejected. It protects the five files we happen to have looked at and nothing written after today. The whole failure mode is "somebody added a migration and didn't think about locks". |
| Runner only                                             | Rejected. A genuinely long maintenance-window operation would have no legitimate way to opt out, so somebody would eventually delete the guard rather than work around it.             |
| **Runner default + explicit per-file/per-run override** | **Chosen.** Safe by default, and deviating from safe requires writing the deviation down in the migration file, where review can see it.                                               |

Concretely, in `scripts/db/migrate.ts`:

- `DEFAULT_LOCK_TIMEOUT_MS = 5000`.
- Transaction-safe files: `SET LOCAL lock_timeout = <ms>` is issued as the first statement inside
  the file's `BEGIN`. `SET LOCAL`, not `SET`, so it is discarded at `COMMIT`/`ROLLBACK` and cannot
  leak into the journal write or into the next file.
- `-- migrate:no-transaction` files (e.g. `CREATE INDEX CONCURRENTLY`): `SET LOCAL` would be a
  no-op there, so the GUC is set at session scope and restored with
  `SET lock_timeout = DEFAULT` in a `finally`.
- Per-file override: `-- migrate:lock-timeout 30s` or `250ms`. **A unit is mandatory** — a bare
  number used to mean milliseconds, so `30` meant 30 ms and would abort essentially always while
  looking deliberately configured. `0` means "wait forever" and has to be written deliberately.
  Declaring it twice is a hard error rather than a guess. The directive must be a comment line of
  its own.
- Per-run override: `--lock-timeout=30s` **or** `--lock-timeout 30s`, for an owner-approved
  maintenance window. The space form used to be silently ignored and fall back to 5 s.
- SQLSTATE `55P03` is reported as _contention_, not as a broken migration, with the
  `pg_stat_activity` query to find the blocker — and the wording is **path-aware**: only the
  transactional branch claims that nothing was applied, because only there is it true.
- `-- migrate:no-transaction` is detected by an **anchored** match on a comment line of its own.
  Unanchored, it matched the directive's own name in prose and had silently taken
  `0022_print_workflow_lifecycle.sql` — a 12-statement DDL migration — out of the transaction.
- `--to=<number>` applies pending migrations only up to that number. It truncates; it cannot
  reorder or skip, so the journal stays a gap-free numeric prefix. Added because the staging
  runbook's checkpointed sequence was otherwise impossible to execute (§5).
- A stale `failed`/`applying` journal row is now classified **resumable** rather than fatal when —
  and only when — the file is provably repairable (`migrate:no-transaction` +
  `migrate:ensure-valid-concurrent-index`) and its checksum is unchanged. See §4.5.

### Say plainly: this is a behaviour change for every future migration

Yes. From this commit, **any** migration that cannot acquire a lock within 5 seconds fails and
rolls back instead of queueing production traffic behind itself. Three things make that the right
default:

1. `lock_timeout` bounds only the **acquisition wait**. A migration that is genuinely slow — a big
   backfill, a large index build — is completely unaffected. Only a _contended_ one aborts.
2. The failure is **atomic and free**: nothing is applied, no journal row is written, and the fix
   is "re-run it". Proven in §4.2.
3. The alternative failure is a silent, unbounded, customer-visible outage with no error message
   anywhere. That is strictly worse than a red migration run.

### rollback-0049 transaction control

`rollback-0049` (and `rollback-0047`) now carry `SET LOCAL lock_timeout = '5s';` as the **first
statement inside their own `BEGIN`**. They **keep** their own `BEGIN`/`COMMIT`.

Justification for keeping it, rather than dropping it to match the forward convention:

- The runner **never executes rollback files**. `FILE_RE = /^(\d{4,})_.+\.sql$/`, and
  `rollback-0049-partner-grading-work-items.sql` does not match. Rollbacks are run by an operator
  with `psql -f`. There is no runner to inherit a transaction from.
- Under `psql -f`, a file with no `BEGIN` runs in **autocommit, statement by statement**. Dropping
  the `BEGIN`/`COMMIT` would make a partial rollback possible — half of a `FORCE`-RLS table teardown
  is far worse than a bounded wait. 20 of the repo's `rollback-*.sql` files are shaped this way; the
  convention is correct for its context.
- Atomicity confirmed unchanged in §4.3: uncontended it completes in ~9–15 ms and removes both the
  bridge table and the D2 index on `certificates`; contended it aborts and drops **nothing**.

**Correction to the briefing.** The briefing states that the operator wrapper
`BEGIN; SET LOCAL lock_timeout=…; \i rollback.sql; COMMIT;` fails because "the `SET LOCAL` is
discarded at the file's own `COMMIT`". Measured with real `psql`, that is **not** what happens.
The file's own `BEGIN` is a **no-op with a warning** (`WARNING: there is already a transaction in
progress`), so the file runs inside the operator's transaction and the `SET LOCAL` **is** still in
force when the first lock is requested:

```
BEGIN
SET
BEGIN
psql:/tmp/selffile.sql:1: WARNING:  there is already a transaction in progress
 inside_file_lock_timeout
--------------------------
 2s
psql:/tmp/selffile.sql:3: ERROR:  canceling statement due to lock timeout
ROLLBACK
 after_file_lock_timeout
-------------------------
 0
psql:/tmp/wrapper.sql:5: ERROR:  LOCK TABLE can only be used in transaction blocks
psql:/tmp/wrapper.sql:6: WARNING:  there is no transaction in progress
COMMIT
elapsed_ms=2109
```

The wrapper is still broken, just not in the way described. What is actually wrong with it:

- The file's own `COMMIT` **ends the operator's transaction**, so `lock_timeout` reverts to `0`
  (see `after_file_lock_timeout = 0`) and everything the operator does after `\i` is unbounded.
- On success the file commits, so the operator's "wrap it so I can inspect before committing" is an
  illusion — it is already committed.
- The two warnings are trivially lost in a long `psql` log.

And the real unbounded case is the **documented** one: `psql -f rollback-0049…sql` with no wrapper
at all. That is what §4.3 measures. The fix is the same either way — the bound has to live inside
the file's own transaction, which is where it now is.

---

## 4. Proofs

Harnesses: `scripts/db/lock-safety-proof.ts` (real 0049 schema, real rollback file, realistic
non-superuser `pn_migrator`) and a synthetic runner fixture for §4.1–4.2.

### 4.1 Normal reads remain available where expected — the bridge does not block reads

Locks actually held by the bridge migration's transaction, and a read taken while it is held:

```
=== locks actually held on certificates by the bridge txn ===
   relname    |         mode          | granted
--------------+-----------------------+---------
 certificates | AccessShareLock       | t
 certificates | ShareLock             | t
 certificates | ShareRowExclusiveLock | t

=== READ during the bridge migration (public certificate lookup path) ===
 cert_id | grade
---------+-------
 MV42    |     9
real 0.07

=== WRITE during the bridge migration (lock_timeout 2s on the writer) ===
ERROR:  canceling statement due to lock timeout
```

Reads served in 70 ms while the migration held its locks; writes blocked, as designed. The bridge
migration also **applied successfully under live read load** in §4.2 below.

### 4.2 A timeout causes migration FAILURE AND ROLLBACK, not a prolonged outage

Real runner, real contention: one ordinary session holds `AccessShareLock` on `certificates`
inside an open transaction. `0002` is bridge-shaped (`ShareRowExclusive`/`Share`); `0003` is
`0047`-shaped (`ACCESS EXCLUSIVE`).

```
=== BEFORE ===
 created_by_0003 | lock_probe_col
-----------------+----------------
                 |              0
   filename    | status
---------------+---------
 0001_base.sql | applied

=== RUNNER under live read load ===
🔒 lock_timeout for this run: 5000 ms (per-file `-- migrate:lock-timeout` overrides this)

--- lock queue on certificates while 0003 waits ---
        mode         | granted |                       q
---------------------+---------+-----------------------------------------------
 AccessShareLock     | t       | SELECT pg_sleep(25);
 AccessExclusiveLock | f       | -- Mirrors 0047's lock profile: ACCESS EXCLUS

Migration 0003_access_exclusive.sql failed and was rolled back: canceling statement due to
lock timeout — lock_timeout (5000 ms) expired while WAITING for a lock. Nothing was applied and
the transaction was rolled back. This is the guard working: a conflicting session held a lock,
and continuing to wait would have queued live traffic behind this migration. Find the blocker
(SELECT pid, state, query, state_change FROM pg_stat_activity WHERE state <> 'idle' OR
xact_start IS NOT NULL), clear it or wait for a quieter moment, then re-run. Only raise the
timeout with `-- migrate:lock-timeout <N>s` (or --lock-timeout) inside an agreed maintenance
window.
RUNNER_EXIT=1
--- runner wall time: 5s ---

=== AFTER — partial state check ===
 created_by_0003 | lock_probe_col
-----------------+----------------
                 |              0
         filename          | status
---------------------------+---------
 0001_base.sql             | applied
 0002_bridge_like_0049.sql | applied
```

- The bridge-shaped file **applied under live read load** (correct — it does not conflict with readers).
- The `ACCESS EXCLUSIVE` file aborted at exactly 5 s, exit code 1.
- **No partial state**: the added column is absent, the new table was never created, and there is
  **no journal row** for it — not `applied`, not `failed`, not `applying`. Re-running is clean.

The mechanism this defends against, isolated deterministically:

```
--- queue state ---
        mode         | granted
---------------------+---------
 AccessExclusiveLock | f
 AccessShareLock     | t
--- plain SELECT arriving BEHIND the ungranted ACCESS EXCLUSIVE (bound 3s) ---
ERROR:  canceling statement due to lock timeout
```

A plain `SELECT` — public certificate lookup — is blocked by a lock request that has not even been
granted. That is the outage.

### 4.3 The rollback-0049 wait is now bounded, and it still applies atomically

Real `migrations/rollback-0049-partner-grading-work-items.sql`, real 0049 schema, non-superuser
`pn_migrator`, `FORCE` RLS in place:

```
setup: 0049 applied, partner_grading_work_items present = true

=== 3b  NEW shape, CONTENDED (file carries its own SET LOCAL lock_timeout='5s') ===
    result: ok=false code=55P03 waited=5005ms
    message: canceling statement due to lock timeout
    partner_grading_work_items still present (nothing dropped) = true

=== 3c  NEW shape, UNCONTENDED (must still apply atomically) ===
    result: ok=true code=- took=9ms
    partner_grading_work_items present after rollback = false
    D2 index on certificates still present = false

=== 3a  CONTROL: OLD shape (no SET LOCAL), plain run, contended ===
    0049 re-applied, bridge present = true
    public certificate lookup during the wait: ok=false code=55P03 after=3002ms
        <- BLOCKED behind the ACCESS EXCLUSIVE waiter
    old-shape rollback: ok=true code=- waited=12010ms (blocker held 12000ms) elapsed=12014ms
    -> UNBOUNDED: it waited out the blocker instead of failing fast; every reader queued behind it.
```

- **Bounded** — aborts at the file's own 5 s bound with `55P03`.
- **Nothing dropped** — the whole rollback rolls back atomically.
- **Still atomic when it should run** — 9 ms uncontended, bridge table _and_ the D2 index on
  `certificates` both removed.
- **The control shows what it buys**: without the line the rollback waited out a 12 s blocker, and a
  public certificate lookup issued during that wait was blocked.

### 4.4 Regression cover

`tests/migrate-lock-timeout.test.ts` — 26 tests, all passing. Together with
`tests/correction-audit-index-migration.test.ts`, `tests/migrate-advisory-lock.test.ts`,
`tests/migration-checksum-drift.test.ts`, `tests/db-migration-safety.test.ts`,
`tests/print-workflow-migration.test.ts` and `tests/partner-schema-parity.test.ts` — **125 tests,
all passing**. `npm run check` clean, ESLint clean (one pre-existing unrelated warning).

`tests/correction-audit-index-migration.test.ts` changed by design: it previously asserted that a
retry after a failed concurrent build hit `/Journal inconsistent/` — the jam described in §4.5. It
now asserts the invariant that actually matters (a failing migration is **never** journalled as
applied, however many times it is retried) plus a new end-to-end test that a stale `failed` row for
a self-healing file is repaired on the next run.

Reproduce:

```bash
npx vitest run tests/migrate-lock-timeout.test.ts tests/correction-audit-index-migration.test.ts
LC_ALL=C LANG=C npx tsx scripts/db/lock-safety-proof.ts   # spins up and destroys its own PG17
```

---

### 4.5 The no-transaction path: from permanently jammed to self-repairing

The first version of this work applied the same `lock_timeout` to the `migrate:no-transaction`
path and reused one error message for both branches. Hostile review found that this converted a
routine contention event into a **permanently jammed journal**, while asserting something false.
Reproduced here on a disposable PG17 (`audit_log`, 2000 rows, one ordinary blocker holding a
conflicting lock, running the real `0018_correction_audit_index.sql`):

```
=== BEFORE THE FIX — RUN 1 (contended) ===
Non-transactional migration 0018_correction_audit_index.sql failed: canceling statement due to
lock timeout … Nothing was applied and the transaction was rolled back. …
journal: [{"filename": "0018_correction_audit_index.sql", "status": "failed"}]

=== BEFORE THE FIX — RUN 2 (blocker gone) ===
Migrations: 1 total, 0 applied, 0 pending, 1 inconsistent, 0 checksum-mismatch.
🚫 Journal inconsistent: 0018_correction_audit_index.sql=failed
```

Three defects at once: the message was **false** (there is no transaction on this path, and a
failed `CREATE INDEX CONCURRENTLY` leaves an invalid index that PostgreSQL maintains on every write
and never reads); the `failed` row tripped the fail-closed guard on **every** later run, so
recovery needed a manual `UPDATE`/`DELETE` on `schema_migrations` — a protected action, during an
incident; and the `migrate:ensure-valid-concurrent-index` self-heal was therefore **dead code in
exactly the case it was written for**, because the guard fired before the pending loop was entered.

After the fix, same scenario:

```
=== RUN 1 (contended) ===
Non-transactional migration 0018_correction_audit_index.sql failed: canceling statement due to
lock timeout — lock_timeout (5000 ms) expired while WAITING for a lock. This migration ran OUTSIDE
a transaction (migrate:no-transaction), so there was no transaction to roll back: any statement
that completed before the timeout HAS taken effect, and a failed CREATE INDEX CONCURRENTLY leaves
an INVALID index (public.idx_audit_log_cert_correction_recent) behind. PostgreSQL maintains an
invalid index on every write and never uses it for reads. The journal row is marked 'failed'. This
file declares migrate:ensure-valid-concurrent-index, so the runner will REPAIR it automatically on
the next run … No manual journal edit is needed — clear the blocker and re-run the same command.

=== RUN 2 (blocker gone) ===
↻ Resuming 1 self-healing migration(s) left mid-run: 0018_correction_audit_index.sql=failed.
✓ Applied 1: 0018_correction_audit_index.sql
journal: applied      index indisvalid: t
```

And with a genuinely **invalid** index present (the harder case — the timeout can also strike after
the build starts):

```
BEFORE indisvalid: f      BEFORE journal: failed
✓ Applied 1: 0018_correction_audit_index.sql
AFTER  indisvalid: t      AFTER  journal: applied
```

**Fail-closed is narrowed, not removed.** All three genuinely-unknown cases still abort:

```
A) transactional file left 'failed'            -> 0 resumable, 1 inconsistent  🚫 refused
B) self-healing file whose CHECKSUM drifted    -> 0 resumable, 1 inconsistent  🚫 refused
C) no-transaction file WITHOUT the directive   -> 0 resumable, 1 inconsistent  🚫 refused
```

(B) matters most: resuming at a drifted checksum would mean "resuming" a _different_ file, which is
a checksum mismatch, not a resume.

Note that only the no-transaction path ever writes an `applying` row as a separate autocommit
statement — a transaction-safe file inserts its journal row _inside_ its own transaction, so it
either commits as `applied` or leaves no row at all. The old guard was therefore firing
exclusively on files the runner already had a verified repair for.

### 4.6 `--to`, and the anchored no-transaction directive

`--to` truncates the pending tail and nothing else:

```
=== --to=0020 (pending: 0019, 0020, 0021) ===
⏸ --to=20: applying 2 of 3 pending migration(s), holding back 1 for a later run.
✓ Applied 2: 0019_a.sql, 0020_b.sql
=== no --to ===
✓ Applied 1: 0021_c.sql
journal: 0018=applied, 0019=applied, 0020=applied, 0021=applied
```

The anchored directive, measured over the real `migrations/` directory:

```
noTransaction files: [ '0018_correction_audit_index.sql' ]     (was: 0018 AND 0022)
0022's explanatory prose still present: true
```

0022 is a 12-statement DDL migration including `ALTER TABLE certificates ADD COLUMN NOT NULL
DEFAULT` and a backfill. Its atomicity had been surviving only because node-postgres sends a
multi-statement string over the simple query protocol, where PostgreSQL wraps it in an implicit
transaction — a driver property, not a design property, which would evaporate the moment such a
file contained an explicit `COMMIT` or a `CONCURRENTLY` statement.

## 5. Staging maintenance sequence

**Nothing below has been run. Every step needs explicit owner approval before execution, per the
protected-actions policy.**

Migrations are applied with the numbered runner, which now bounds every lock wait at 5 s by default:

```bash
export MINTVAULT_DATABASE_URL=<direct, NON-pooler staging URL>
npx tsx scripts/db/migrate.ts                 # dry-run: plan + lint, no writes
npx tsx scripts/db/migrate.ts --apply --to=NNNN   # apply up to and including migration NNNN
```

The runner refuses a `-pooler` endpoint outright; that is unchanged and is a precondition, not a
step.

### ⚠️ The order is NOT ours to choose — read this before the table

An earlier version of this section prescribed 0048 → 0050 → 0047 → 0049 → 0051 as six
individually-gated steps run with plain `--apply`. **That sequence could not be executed.**
`--apply` applies _every_ pending file in one run in strict numeric order, and there was no
selector. Measured from the staging-equivalent state, a single run applied
`0047, 0048, 0049, 0050, 0051, 0052` in that order — so the operator got 0047 _first_, the one step
flagged as needing a quiet window, with no opportunity to reorder. The only way to follow the old
text literally was per-file `psql -f`, which writes **no journal row and no checksum** and destroys
the ratchet the runner exists to provide.

**What I chose, and why: both a code change and a rewrite, but deliberately _not_ a reordering
selector.**

- I added `--to=<number>` to the runner. It truncates the tail of the pending list only. It
  **cannot reorder and cannot skip**, so the journal always stays a gap-free numeric prefix of the
  migration set and every existing guarantee (checksums, ordering, the advisory lock) is preserved.
  A selector that could pick individual files — `--only=` — would let an operator skip a migration
  and silently desynchronise the ratchet, so it does not exist and should not be added.
- Because `--to` cannot reorder, the old sequence remains unachievable _by design_. So this section
  is rewritten to **numeric order**, which is what the runner actually does, and `--to` is used to
  break the run into verifiable checkpoints.

The practical consequence: 0047 is first, so **the quiet window is needed at the start of the
window, not in the middle of it.**

### Order, and what each step needs

| #   | Step                                                                                                                                                                   | Quiet window?                                                                    | Expected blocking window                                                                                                                                                                                               | If it times out           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 0   | Dry-run (no `--apply`). Confirm the pending list is exactly **0047, 0048, 0049, 0050, 0051, 0052** — six files, nothing else, `0 inconsistent`, `0 checksum-mismatch`. | No — read-only                                                                   | none                                                                                                                                                                                                                   | n/a                       |
| 1   | **`--apply --to=0048`** → applies **0047** then **0048**                                                                                                               | **YES — short.** ~30 s of quiet, at the START of the window.                     | 0047: 2.4–7.9 ms `ACCESS EXCLUSIVE` on `partner_owner_invariant_tenants` — partner **login/session and user management** stall. 0048: nothing. Public certificate lookup unaffected throughout.                        | See below. Retry is free. |
| 2   | Verify checkpoint A: journal shows 0047+0048 `applied`; partner login works.                                                                                           | No                                                                               | none                                                                                                                                                                                                                   | n/a                       |
| 3   | **`--apply --to=0050`** → applies **0049** then **0050**                                                                                                               | **No** at staging row counts; prefer a low-**write** window at production scale. | 0049: `certificates`/`submissions`/`submission_items` **writes** blocked 13 ms @ 3k rows, 253 ms @ 600k, ~0.9–1.6 s @ 3M. **Reads are never blocked** (§4.1) — public certificate lookup keeps serving. 0050: nothing. | See below.                |
| 4   | Verify checkpoint B: journal shows 0049+0050 `applied`; a public `/cert/{id}` lookup returns.                                                                          | No                                                                               | none                                                                                                                                                                                                                   | n/a                       |
| 5   | **`--apply`** (no `--to`) → applies **0051** then **0052**                                                                                                             | **YES.** See the 0051 warning below — this is the riskiest step in the set.      | 0051: 3 ms `ACCESS EXCLUSIVE` on `partner_feature_flags`, read on EVERY partner request. 0052: 9 ms `ACCESS EXCLUSIVE` on `partner_internal_notes`, `partner_management_audit`, `partner_service_tiers`.               | See below.                |
| 6   | Verify: journal shows all six `applied`, `/api/version`, partner login, a public `/cert/{id}` lookup.                                                                  | No                                                                               | none                                                                                                                                                                                                                   | n/a                       |

**0051 needs a quiet window — plainly, yes.** It was previously documented as "grants only, no
quiet window", and that was the single most dangerous error in this runbook. It takes
`ACCESS EXCLUSIVE` on `partner_feature_flags`, which is read on every partner request with no
`statement_timeout`, no `lock_timeout` and an 8-connection pool with no connect timeout (§2). Under
load, partner requests **hang**, the pool exhausts, and as requests begin to fail
`resolveGlobalFlag`'s bare `catch` fails closed — the portal serves its kill-switch 503 with
**nothing in the logs pointing at the migration**. Execution is 3 ms; the exposure is entirely in
the lock _queue_. Treat step 5 exactly like step 1: get the portal quiet first, confirm
`pg_stat_activity` is clear, then run.

Steps 1, 3 and 5 are the only ones that touch the database. Steps 0, 2, 4 and 6 are verification.
The `--to` checkpoints exist so that a failure in one group cannot be confused with a failure in
another, and so the run can be stopped between groups without journal surgery.

**0047 must precede 0049.** `rollback-0049`'s journal guard refuses while any migration numbered
above 49 is journalled, and the numbering was chosen (0047 RLS, 0048 search_path, 0049 bridge) so
that rolling the bridge back does **not** require rolling the two security repairs back first.
Numeric order satisfies this for free.

### Pre-flight facts confirmed against staging

Confirmed by the release reviewer before this window was proposed:

- The journal has **36 rows**.
- **0044's checksum matches this branch exactly** (`f3f121a0…`), so the ratchet is intact and the
  window can proceed. Had it drifted, the runner would refuse at step 0 and correctly so.
- Staging carries **three orphan journal rows whose files are absent from this branch** — 0039 and
  0040 (project-control) and 0046 (partner MFA). They are journalled-but-unrepresented, so the
  runner ignores them (it only plans files it can see). ⚠️ **The consequence is for disaster
  recovery, not for this window:** a production database rebuilt _only_ from this branch's
  migration set would **not** contain whatever 0039/0040/0046 did. Before this branch is ever used
  as the sole source for a rebuild, those three must be reconciled — either recovered onto the
  branch or explicitly declared obsolete. Do not treat "staging works" as evidence that the
  branch's migration set is complete.

### If a step times out

A `55P03` abort is **not** a broken migration. **On the transactional path** — which is every
migration in this release (0047–0052) — nothing was applied, no journal row was written, and
re-running is clean. Do this, in order:

1. **Do not raise the timeout.** That converts a fast, safe failure back into the outage the bound
   exists to prevent.
2. Find the blocker:
   ```sql
   SELECT pid, usename, state, xact_start, state_change, left(query, 120) AS query
     FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND (state = 'idle in transaction' OR xact_start IS NOT NULL)
    ORDER BY xact_start;
   ```
   In practice it is almost always a session **idle in transaction** — a request that opened a
   transaction and never closed it.
3. If it is an application session, the safe clearing action is to let it finish or to roll the app
   instance. `pg_terminate_backend` is a protected action: ask the owner.
4. Re-run the same `--to=` command. The runner picks up exactly where it stopped, and the
   already-applied files in that group are skipped by the journal.
5. Only if it times out repeatedly **and** the owner agrees a maintenance window, re-run with
   `--lock-timeout=30s` for that run only (both `--lock-timeout=30s` and `--lock-timeout 30s`
   work; a value without a unit is rejected rather than silently read as milliseconds). Do not
   commit a raised value into a migration file unless the migration genuinely needs it.

#### The one case where "nothing was applied" is NOT true

A `migrate:no-transaction` migration — currently only `0018_correction_audit_index.sql`, and
**none of 0047–0052** — runs outside a transaction. If one times out, statements that completed
have taken effect, and a failed `CREATE INDEX CONCURRENTLY` leaves an **invalid** index behind,
which PostgreSQL maintains on every write and never uses for reads. The runner now says so
explicitly instead of claiming a rollback that did not happen.

Recovery is automatic for any such file that declares `migrate:ensure-valid-concurrent-index`: the
journal row is left `failed`, the runner reports it as **resumable**, and the next run drops the
invalid index with `DROP INDEX CONCURRENTLY`, rebuilds it, and verifies `indisvalid` before marking
it applied. **Clear the blocker and re-run the same command — do not edit `schema_migrations`.**

Only if the runner reports `inconsistent` (rather than `resumable`) is manual intervention needed,
and that means the runner genuinely cannot prove what survived. Inspect the database against the
file first; editing the journal is a protected action.

### Rollback

Rollbacks are `psql -f`, not the runner, and each now bounds its own lock wait:

```bash
psql -v ON_ERROR_STOP=1 "<direct staging URL>" -f migrations/rollback-0049-partner-grading-work-items.sql
```

Do **not** wrap it in your own `BEGIN … COMMIT` — the file manages its own transaction, the wrapper
does not do what it looks like it does (§3), and the bound is already inside. If it aborts with
`55P03`, nothing was dropped: clear the blocker as above and re-run.

⚠️ `rollback-0047` re-opens a high-severity tenant-isolation hole. Its own header says so. Only
for incident recovery, and re-apply 0047 immediately afterwards.

---

## 6. Not addressed here

- `statement_timeout` for migrations. Out of scope for this gate: it would interrupt a legitimately
  long backfill mid-flight, which is a different trade-off and needs its own decision.
- **The partner runtime pool has no `statement_timeout`, no `lock_timeout` and no
  `connectionTimeoutMillis`** (`server/partner/db.ts:94-96,153-161`). That is what turns 3 ms of
  `ACCESS EXCLUSIVE` on `partner_feature_flags` into hung requests and a silent fail-closed 503
  (§2). The migration-side bound limits the exposure to 5 s, but the application-side gap is the
  root cause and is **not** fixed here — it is a separate change to a file this task does not own.
  Recommend raising it as its own item before the pilot.
- `resolveGlobalFlag`'s bare `catch { return false }` (`server/partner/flags.ts:54-64`) logs
  nothing, so a database-side stall is indistinguishable from a deliberate kill switch in the
  logs. Also not fixed here; also worth its own item.
- Production. Nothing in this document is authorised for production, and the staging sequence itself
  is unapproved until the owner says otherwise.
