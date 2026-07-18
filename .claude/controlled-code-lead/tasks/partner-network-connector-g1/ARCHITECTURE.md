# Trusted Intake Connector — Phase G1: Connector Foundation

Status: Design → Implementation this pass. Scope: G1 only (foundation). G2–G5
(validation engine, real MintVault intake creation, worker activation, launch
hardening) are explicitly deferred — see "Deferred to G2–G5" below.

## 1. Existing Partner handoff table and state

`partner_submission_handoffs` (migration `0007_partner_submissions.sql:145-156`):

```
id uuid PK, tenant_id uuid NOT NULL, submission_id uuid NOT NULL UNIQUE,
status text DEFAULT 'pending' CHECK (status IN ('pending','applied','failed')),
snapshot jsonb NOT NULL, mintvault_reference text, error_detail text,
created_at timestamptz, applied_at timestamptz
```

Created by `submitSubmission()` (`server/partner/submission-service.ts:565-669`),
which inserts the handoff row with `status='pending'` and a JSON `snapshot` of
the submission+cards at that moment, then stops. **No code anywhere consumes
this table today** — confirmed by repo-wide grep outside `server/partner/`.
`submission_id` is `UNIQUE`, so a resubmit attempt can never produce a second
handoff for the same Partner submission (idempotency is already guaranteed one
layer up, before G1 even starts).

`partner_runtime` (the Partner-facing role) already has `GRANT SELECT, INSERT`
only on this table — no `UPDATE`. The migration 0007 comment is explicit that
a future "trusted connector...must use a separate, narrowly-privileged role"
to ever flip `status`, and that role "does not exist yet." **Defining that
role is G1's job.**

## 2. Existing MintVault intake/submission tables and services

`submissions` / `cards` / `certificates` in `shared/schema.ts` (lines 199,
306, 324). Creation path: `IStorage.createSubmission()` (`server/storage.ts:386+`)
called from `server/routes/submissions.ts:609` inside the
`/api/create-payment-intent` flow. **None of these tables have a tenant/partner
column** — this is a deliberate Phase 0/1 decision (documented at the top of
migration 0007) that Partner intake must stay entirely outside the existing
schema. Certificate numbers come from `cert_counter`
(`server/storage.ts:1172-1236`); payments from `stripe.paymentIntents.create()`
(`server/routes/submissions.ts:713-717`).

## 3. The exact future integration boundary

`partner_submission_handoffs.snapshot` is the boundary artefact. A future G2+
connector reads a `pending` handoff's `snapshot`, validates it, and — only
once validation and owner-approved mapping rules exist — calls
`storage.createSubmission()` (or an equivalent internal intake path) to
materialise a real MintVault `submissions` row, then writes the resulting
reference back into `handoffs.mintvault_reference` and flips
`handoffs.status` to `applied`.

**G1 does not build that last step.** G1 builds everything up to and
including "this handoff is confirmed staged, claimed, and ready for a human
or a future G2 validator to look at" (`awaiting_validation`) — and explicitly
refuses to go further. No G1 code path can reach `imported`, call
`storage.createSubmission()`, allocate a certificate, create a payment, or
create a label. This is enforced in code (§9 below), not just by omission.

## 4–6. Roles and the trust boundary

Two new, purely-internal Postgres roles, both `NOLOGIN NOSUPERUSER
NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION` (identical shape to
`partner_runtime`):

- **`partner_connector_runtime`** — the only role granted DML on the two new
  connector tables (`SELECT, INSERT, UPDATE` on
  `partner_connector_records`; `SELECT, INSERT` — append-only, no
  `UPDATE`/`DELETE` — on `partner_connector_events`). This is what a future
  trusted internal worker (G2+) connects as, via a **separate** connection
  string (`PARTNER_CONNECTOR_DATABASE_URL`, a new env var, distinct from
  `PARTNER_DATABASE_URL`) and a **separate** `pg.Pool` (`server/partner/
connector-db.ts`) — never the same pool `partner_runtime` uses. Same-pool
  reuse would collapse the role separation into a shared identity; a distinct
  pool is what makes "Partner runtime cannot insert connector records" a real,
  testable property rather than a paper one.
- No `partner_connector_definer` / `SECURITY DEFINER` role is introduced.
  Every other post-auth Partner service in this repo (`submission-service.ts`,
  `customer-service.ts`) enforces its rules in the TypeScript service layer
  over parameterised SQL, not in PL/pgSQL functions — the three existing
  `SECURITY DEFINER` functions exist ONLY because they must run
  cross-tenant _before_ a tenant context exists (pre-auth lookup). The
  connector has no such pre-auth problem: every call already carries an
  explicit `tenantId` the service validates against the row it's touching.
  Introducing a second `SECURITY DEFINER`/`BYPASSRLS` pattern here would add
  a second, less-battle-tested privilege-escalation surface for no benefit —
  matching repo convention (`shared/schema.ts`/`storage.ts`) beats inventing
  a new one blind.

**Why Partner runtime must never write directly to MintVault internal
tables**: `submissions`/`cards`/`certificates` have zero tenant modelling
(§2) — a bug or compromise in the Partner-facing surface reaching those
tables directly would have no tenant boundary to fail closed against at all
(unlike `partner_*` tables, which are `FORCE ROW LEVEL SECURITY`). The
existing architecture already refuses this by construction (`partner_runtime`
holds zero grants on any non-`partner_*` table); G1 adds nothing that
changes this, and the connector tables it does add are equally out of reach
of `partner_runtime` (zero grants — see §7 below).

## 7. Selected trust model (RLS vs. grants)

**No RLS on the two new connector tables** — a deliberate choice, not an
oversight. RLS's purpose in the rest of this schema is to fail closed a
tenant-scoped _HTTP session_ that might be tricked into cross-tenant access.
The connector has no HTTP session at all — it is called only by trusted
internal code (tests today; a G2+ worker later), and `claimNextConnectorRecord`
must legitimately see queued records **across every tenant** (it's a single
global work queue, not a per-tenant view) — a `tenant_id =
partner_current_tenant()` RLS predicate would be actively wrong for that
operation. Enforcing isolation via **grants alone** (`partner_runtime`: zero
grants; `partner_connector_runtime`: the only grants, on a table with no
tenant-context requirement) is simpler, matches how PostgreSQL privilege
checks already work for every other non-`partner_*` table in this schema,
and is fully testable (§"Trust boundary" tests: attempt every mutating
statement as `partner_runtime` and assert `permission denied`).

Every service function that a tenant-scoped caller could plausibly reach
takes an optional `tenantId` and re-validates it against the row's actual
`tenant_id` before touching it (defence in depth against a future caller
bug, independent of the grant model): `getConnectorStatus`,
`ensureConnectorRecordForHandoff` (required, not optional — see §12),
`claimConnectorRecord`, `transitionConnectorState`, `recordConnectorFailure`,
`releaseConnectorClaim`. It is **optional** on the last four because
`claimNextConnectorRecord` (the global work-queue primitive) deliberately
has no tenant identity at all — a caller already holding a specific
`connectorId` (from a prior claim, or from `listRetryableConnectorRecords`)
is trusted-internal by construction today, since no HTTP route calls any of
these functions yet. **Before any G3+ route or worker exposes a bare
`connectorId` to a tenant-scoped caller (e.g. a Super Admin screen), that
caller must always pass `tenantId`** — the parameter exists and is checked
when supplied, but omitting it is not itself a violation for a genuinely
trusted-internal caller (a G2+ worker doing global work-queue processing
has no single tenant to assert). This was corrected after independent
review found the original wording implied unconditional revalidation on
all six state-changing functions, which was not actually true for four of
them at the time of writing.

## 8. The G1 state machine

States: `queued, claimed, validating, awaiting_validation, rejected, failed,
cancelled, imported`. `imported` exists in the schema/CHECK constraint for
G2+ forward-compatibility but is a **hard-blocked target in every G1 service
function** — `transitionConnectorState()` throws before touching the
database if `toState === "imported"`, independent of the transition matrix
below (belt-and-braces: even a future bug in the matrix couldn't reach it).

Legal transition matrix (enforced both by an explicit map in
`connector-service.ts` and by the `WHERE state = ANY($fromStates)` guard on
every transition `UPDATE`, so an illegal transition affects 0 rows rather
than silently succeeding):

| From                  | Legal to                                                         |
| --------------------- | ---------------------------------------------------------------- |
| `queued`              | `claimed`, `cancelled`                                           |
| `claimed`             | `validating`, `queued` (explicit release), `cancelled`, `failed` |
| `validating`          | `awaiting_validation`, `rejected`, `failed`, `cancelled`         |
| `awaiting_validation` | `cancelled`                                                      |
| `failed`              | `queued` (retry), `cancelled`                                    |
| `rejected`            | _(terminal)_                                                     |
| `cancelled`           | _(terminal)_                                                     |
| `imported`            | _(terminal, unreachable by G1)_                                  |

`awaiting_validation` is G1's normal stopping point — a handoff that reaches
it is "ready for a human or G2 to look at," nothing more.

## 9. Idempotency strategy

Two independent, DB-enforced unique constraints on `partner_connector_records`:

- `UNIQUE (handoff_id)` — one canonical connector record per Partner handoff.
  `ensureConnectorRecordForHandoff` uses `INSERT ... ON CONFLICT (handoff_id)
DO NOTHING RETURNING *`, then a `SELECT` on conflict, inside one
  transaction — safe under concurrent duplicate calls, survives process
  restarts (DB-enforced, not memory-enforced).
- `UNIQUE (source_handoff_idempotency_key) WHERE source_handoff_idempotency_key
IS NOT NULL` — catches the "same key reused for a different handoff" case,
  which the `handoff_id` constraint alone would miss (different `handoff_id`
  ⇒ no conflict on that column). A reused key targeting a different handoff
  fails with `idempotency_conflict` rather than silently creating a
  second/wrong record.

## 10. Concurrency strategy

`claimNextConnectorRecord()`: `SELECT ... FROM partner_connector_records
WHERE (state='queued') OR (state='claimed' AND claim_expires_at < now())
ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, then an `UPDATE ... WHERE
id=$1 AND version=$2` in the same transaction. `SKIP LOCKED` means a second
concurrent claimer never blocks on the first — it just claims the next
distinct row, so two processors can never claim the same record.
`claimConnectorRecord(id)` (targeted claim) uses the same `FOR UPDATE`
lock + `WHERE (state='queued' OR (state='claimed' AND claim_expires_at <
now())) AND version=$expected` guard — 0 rows affected means "already
claimed by someone else," a distinguishable, safe `already_claimed` error.

## 11. Claim expiry / recovery

`claim_expires_at` (a lease, set to `now() + interval`, default lease length
a service constant) — not a background sweep. A crashed processor simply
lets its lease lapse; the next `claimNextConnectorRecord`/`claimConnectorRecord`
call naturally includes `state='claimed' AND claim_expires_at < now()` rows
as claimable, so no separate reaper process is needed for G1 (matches the
"G1 does not need to run a permanent worker" instruction). Every transition
requires the caller to pass the `version` it last read; a stale claimant
(lease expired, someone else already reclaimed and moved the state on) fails
the `WHERE version=$expected` guard and gets `stale_claim`, never silently
overwriting the newer processor's work.

## 12. Retry strategy

`attempt_count` increments on every claim. `recordConnectorFailure()` sets
`state='failed'`, `last_error_category`/`last_error_code`, and — only when
the error is marked `retryable` — a `next_retry_at`. `listRetryableConnectorRecords()`
is a read-only query (`state='failed' AND next_retry_at <= now()`); no
automatic retry loop runs in G1 (no worker exists yet) — this just proves
the query a future worker will use is correct.

## 13. Failure classification

See "Error model" in the service (`connector-errors.ts`): a fixed
`ConnectorErrorCode` union, each mapped to a `retryable: boolean`. Unknown/
unexpected DB errors map to a generic `transient_database_error` (retryable)
rather than leaking a raw Postgres error to any caller.

## 14. Audit/event strategy

`partner_connector_events` — append-only (`partner_connector_runtime` has no
`UPDATE`/`DELETE` grant on it, matching the existing
`partner_submission_events` convention), one row per successful state
transition, written in the SAME transaction as the state `UPDATE` (atomic —
a transition can never "succeed" with no history row, or vice versa). No
stack traces, no full request payloads, no customer PII — `metadata` is a
small, explicitly-constructed JSON object per call site, never
`JSON.stringify(err)` or similar.

## 15. Feature-flag and emergency-stop behaviour

New flag `partner_connector_enabled` added to the existing
`PARTNER_FLAGS` array (`server/partner/flags.ts`) — reuses the **already
fail-closed** `resolveGlobalFlag()` (absent row ⇒ `false`; any DB error ⇒
`false`). Every state-changing connector service function checks, before
touching any row: `partner_connector_enabled` must resolve `true`, AND
`partner_emergency_stop` must resolve `false` (the existing portal-wide kill
switch already covers connector work too — no separate emergency-stop key is
introduced, since the instruction's own wording says the connector flag's
check must be _overridden_ by the existing emergency stop, implying one
shared kill switch, not two). `getConnectorStatus()` (read-only) is exempt —
status remains visible even when the connector is OFF or stopped, matching
"read-only status may remain available if safe." No transition is ever
partially applied when a stop check fails — the check runs before the
transaction opens, so a failed check touches zero rows.

## 16. Transaction boundaries

Every state-changing operation (`ensureConnectorRecordForHandoff`,
`claimNextConnectorRecord`, `claimConnectorRecord`, `transitionConnectorState`,
`recordConnectorFailure`, `releaseConnectorClaim`) opens exactly one
transaction on the connector pool, does its `SELECT ... FOR UPDATE` (where
applicable) + guarded `UPDATE`/`INSERT` + event-row `INSERT`, and commits or
rolls back as a single unit — mirroring `withTenant()`'s existing pattern in
`server/partner/db.ts`, but on the separate connector pool (§4–6).

## 17. Rollback strategy

Migration `0008_partner_connector_foundation.sql` rollback (tested):
`DROP TABLE partner_connector_events`, `DROP TABLE partner_connector_records`,
`DROP ROLE partner_connector_runtime` — removes only G1 objects. No existing
Partner or MintVault table/row is touched by either the forward migration or
its rollback (the forward migration contains zero `ALTER`/`UPDATE`/`DELETE`
against any pre-existing table).

## Deferred to G2–G5 (explicitly not built this pass)

- G2: the actual validation engine that decides `validating` →
  `awaiting_validation` vs. `rejected` (G1 only proves the state CAN move
  there; it does not implement real validation rules).
- G2/G3: the code path that reads an `awaiting_validation` record and calls
  `storage.createSubmission()` / allocates a certificate / creates a payment
  / creates a label — i.e. the actual `imported` transition and everything
  it triggers.
- G3+: any background worker process that calls `claimNextConnectorRecord`
  on a schedule (G1 only provides and tests the primitive).
- G4: Super Admin connector operations screens.
- G5: launch hardening, monitoring/alerting, Partner Portal connector status
  UI.
- **G2 design note (raised by independent review, not fixed this pass):**
  `claim_expires_at` is never refreshed or re-checked once a record moves
  `claimed` → `validating` — a worker that crashes mid-validation leaves the
  record stuck in `validating` forever; neither `claimNextConnectorRecord`
  nor `claimConnectorRecord` treats `validating` as ever reclaimable, by
  design (G1 has no worker to crash, so there was nothing to lease-protect
  yet). The G2 worker design must either extend the lease periodically while
  validating, add a `validating`-specific expiry, or otherwise bound how
  long a record may sit in `validating` before something can reclaim it —
  this is a real gap in the _primitive_ as it stands today, not merely a
  hypothetical.

## Owner-approval items

None found. The integration boundary (`partner_submission_handoffs`), the
next migration number (`0008`), and the trust model (grants-only, no new
`SECURITY DEFINER` role) are all derivable from existing, already-approved
architecture (migration 0007's own header comment explicitly anticipates
this exact next step). No commercial, legal, security, or irreversible
decision is required to build the G1 foundation as scoped. **Not blocked.**
