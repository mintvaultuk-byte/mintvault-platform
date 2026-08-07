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
| **rollback-0049**           | `ACCESS EXCLUSIVE` on `certificates`                                                                  | reads **and** writes | ~16 ms, does not scale with rows                |

0047's blast radius is wider than its table name suggests: a `SECURITY INVOKER` trigger on
`partner_users`, `partner_user_roles` and `partner_organisations` writes
`partner_owner_invariant_tenants`, so partner **user management** stalls behind it too.

`certificates` is the table behind **public certificate lookup** — the QR/NFC verify path. Any
`ACCESS EXCLUSIVE` on it is customer-visible if it has to queue.

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
- Per-file override: `-- migrate:lock-timeout 30s` (also `250ms`, or bare milliseconds). `0` means
  "wait forever" and has to be written deliberately. Declaring it twice is a hard error rather
  than a guess.
- Per-run override: `--lock-timeout=30s`, for an owner-approved maintenance window.
- SQLSTATE `55P03` is reported as _contention_, not as a broken migration, with the
  `pg_stat_activity` query to find the blocker.

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

`tests/migrate-lock-timeout.test.ts` — 11 tests, all passing. `tests/migrate-advisory-lock.test.ts`,
`tests/migration-checksum-drift.test.ts`, `tests/db-migration-safety.test.ts` — 75 tests, all still
passing. `npm run check` clean, ESLint clean.

Reproduce:

```bash
npx vitest run tests/migrate-lock-timeout.test.ts
LC_ALL=C LANG=C npx tsx scripts/db/lock-safety-proof.ts   # spins up and destroys its own PG17
```

---

## 5. Staging maintenance sequence

**Nothing below has been run. Every step needs explicit owner approval before execution, per the
protected-actions policy.**

Migrations are applied with the numbered runner, which now bounds every lock wait at 5 s by default:

```bash
MINTVAULT_DATABASE_URL=<direct, NON-pooler staging URL> npx tsx scripts/db/migrate.ts            # dry-run first
MINTVAULT_DATABASE_URL=<direct, NON-pooler staging URL> npx tsx scripts/db/migrate.ts --apply
```

The runner refuses a `-pooler` endpoint outright; that is unchanged and is a precondition, not a
step.

### Order, and what each step needs

| #   | Step                                                                                                                | Quiet window?                                                                    | Expected blocking window                                                                                                                                                                                         | If it times out           |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 0   | Dry-run the plan (no `--apply`). Confirm the pending list is exactly 0047, 0048, 0049, 0050, 0051 and nothing else. | No — read-only                                                                   | none                                                                                                                                                                                                             | n/a                       |
| 1   | **0048** search_path repair                                                                                         | **No.** Run under live load.                                                     | none — takes no table locks                                                                                                                                                                                      | cannot                    |
| 2   | **0050** connector GRANT                                                                                            | **No.** Run under live load.                                                     | none — zero relation locks                                                                                                                                                                                       | cannot                    |
| 3   | **0047** RLS repair                                                                                                 | **Yes — short.** ~30 s of quiet is enough.                                       | 2.4–7.9 ms of `ACCESS EXCLUSIVE` on `partner_owner_invariant_tenants`: partner **login/session and user management** briefly stall. Public certificate lookup is unaffected.                                     | See below. Retry is free. |
| 4   | **0049** grading bridge                                                                                             | **No** at staging row counts; **prefer a low-write window** at production scale. | `certificates`/`submissions`/`submission_items` **writes** blocked for 13 ms @ 3k rows, 253 ms @ 600k, ~0.9–1.6 s @ 3M. **Reads are never blocked** (§4.1) — public certificate lookup keeps serving throughout. | See below.                |
| 5   | **0051** runtime flag control                                                                                       | No                                                                               | grants only                                                                                                                                                                                                      | cannot                    |
| 6   | Verify: journal shows all five `applied`, `/api/version`, partner login, a public `/cert/{id}` lookup.              | No                                                                               | none                                                                                                                                                                                                             | n/a                       |

0048 and 0050 are ordered first deliberately: they are free, and getting them in reduces what is
left to do inside the one window that needs quiet.

**0047 must precede 0049.** `rollback-0049`'s journal guard refuses while any migration numbered
above 49 is journalled, and the numbering was chosen (0047 RLS, 0048 search_path, 0049 bridge) so
that rolling the bridge back does **not** require rolling the two security repairs back first.
Applying them out of order forfeits that.

### If a step times out

A `55P03` abort is **not** a broken migration. Nothing was applied, no journal row was written, and
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
4. Re-run the same command. The runner picks up exactly where it stopped.
5. Only if it times out repeatedly **and** the owner agrees a maintenance window, re-run with
   `--lock-timeout=30s` for that run only. Do not commit a raised value into a migration file
   unless the migration genuinely needs it.

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
- Production. Nothing in this document is authorised for production, and the staging sequence itself
  is unapproved until the owner says otherwise.
