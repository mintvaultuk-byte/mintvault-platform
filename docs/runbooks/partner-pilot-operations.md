# Partner Pilot — operations runbook

Every command here is real and exists in this repository. Where an action is **owner-gated** it is
marked so and the command is deliberately _not_ given as a copy-paste line for production.

**Scope.** The Partner grading pilot: Scanner stations, Card Jobs, Grading Credits, grading, QA and
output. HQ-only concerns (Vault Quest, Instagram, marketplace) are covered by their own runbooks.

---

## 0. First move for any Partner incident

Check the estate-wide health signal before touching anything:

```
GET /api/super-admin/partner-ops/health      # Super Admin session required
```

Returns live counts (no cached metrics) for:

| Field           | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `qaDrift`       | Approved certificates whose Card Job never left `QA_REVIEW`. See §3.  |
| `stuckCardJobs` | Card Jobs untouched for >48h in a working state. Report-only. See §4. |
| `staleLeases`   | Grading leases expired without release. Informational. See §5.        |

`qaDrift.checked: false` means the check **could not run** — that is not the same as "nothing wrong".
Read `skippedReason`.

Server logs to grep, by tag:

```
partner-card-job-reconciliation     # QA drift redrive (every 15 min)
partner-credit-reconciliation       # Grading Credit ledger drift (hourly, READ-ONLY)
partner-credit-reservation-expiry   # reservation expiry (hourly)
scan-reconciler                     # stuck scanner pipelines
```

---

## 1. Scanner reinstall (station keeps its identity)

A station's identity is its enrolment key pair, not its Mac. Reinstalling the app does **not** need a
new station record.

1. Confirm the station still exists and is `ACTIVE`:
   ```sql
   SELECT id, station_code, status, approved_at, last_seen_at
     FROM partner_stations WHERE station_code = 'MV-STN-…';
   ```
2. Reinstall the Scanner app from a **signed release**. Unsigned/mutable updates are refused by
   design — `scripts/scanner-app/main.js` fails closed with `signed_release_required`, and
   `scripts/scanner-app/update.sh` is a retired entry point.
   **Owner-gated:** signing/notarisation and release packaging.
3. Re-enrol using the existing station code. If the key pair was lost, this becomes a **station
   replacement** (§2) — a new key pair is a new station.

**Do not** delete and recreate a station to "fix" a reinstall: Card Jobs, capture sessions and
evidence reference `station_id`, and `ON DELETE RESTRICT` will refuse it anyway.

---

## 2. Station replacement / lost or stolen Mac

Treat a lost Mac as a **credential compromise**, not a hardware swap.

1. **Revoke immediately.** Suspend or revoke the station so its signed requests stop being accepted:
   ```sql
   SELECT id, station_code, status FROM partner_stations WHERE station_code = 'MV-STN-…';
   ```
   Then suspend it through the Super Admin station surface (audited). A revoked/suspended station is
   refused at `authenticateStationRequest` before any Card Job authority runs.
2. **Confirm the blast radius is bounded.** A station can only ever reach its own tenant _and_ its own
   location — `assertStartAllowed` checks both, and `createScannerCaptureSession` re-checks the
   binding. Verify nothing else was touched:
   ```sql
   SELECT action, record_id, created_at FROM partner_audit_events
    WHERE device_id = '<station uuid>' ORDER BY created_at DESC LIMIT 50;
   ```
3. **Enrol the replacement** with a new key pair and a new station code, in the same location.
4. **Credits are unaffected.** A station cannot spend a credit without a successful NEW, and every NEW
   is idempotent on `(station_id, client_op_id)`. Confirm no unexpected spend:
   ```sql
   SELECT count(*) FROM partner_card_job_op_keys WHERE station_id = '<station uuid>';
   ```

---

## 3. QA / Card Job split-transaction drift — the one documented MEDIUM

**Symptom.** A Partner card was approved by Super Admin QA but cannot be printed.
`qaDrift.count > 0`, or the shop reports an approved card stuck in "in review".

**Cause.** QA approval publishes the certificate through the HQ grader on the Drizzle pool, then
transitions the Card Job on the partner-admin pool. Those cannot be one transaction without
restructuring protected HQ grading infrastructure. A crash or deploy between them leaves the grade
published and the Card Job in `QA_REVIEW`.

**This is fail-closed.** Output is refused (`partner_card_job_state_invalid`), no credit moves, no
identity is minted. Nothing has been published early. The card is _stuck_, not _wrong_.

**Normal resolution: none required.** The scheduled job repairs it within 15 minutes.

**Confirm the condition:**

```sql
SELECT job.id AS card_job_id, job.tenant_id, job.mv_number, job.status,
       cert.grade_approved_at, cert.grade_approved_by
  FROM partner_card_jobs job
  JOIN certificates cert ON cert.id = job.certificate_id
 WHERE job.status = 'QA_REVIEW'
   AND job.cancelled_at IS NULL
   AND cert.grade_approved_at IS NOT NULL
   AND cert.deleted_at IS NULL
 ORDER BY cert.grade_approved_at ASC;
```

**If the count is NOT falling across ticks**, the redrive is _refusing_. Refusals are logged at error
level with the reason:

```
[partner-card-job-reconciliation] DRIFT COULD NOT BE REPAIRED refused=N
  REFUSED <card_job_id>: <reason>
```

Reasons and what each means:

| Reason                                       | Meaning / action                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `certificate is no longer approved`          | QA withdrew the approval. Correct — nothing to repair. Card is back with the grader. |
| `certificate grader_status is '…'`           | The card was returned or corrected after approval. Let QA finish.                    |
| `certificate origin does not match…tenant`   | **Escalate.** Lineage inconsistency; do not repair by hand.                          |
| `Card Job has no bound certificate identity` | **Escalate.** A job reached QA_REVIEW without identity — investigate.                |

**Never** repair this with a manual `UPDATE partner_card_jobs SET status = 'APPROVED'`. It bypasses
the transition authority, the `from`-state re-assertion and the audit row, and 0080's trigger may
refuse it anyway. Use the redrive.

**Audit trail of every repair:**

```sql
SELECT record_id, action, reason, before_value, after_value, created_at
  FROM partner_audit_events
 WHERE action IN ('partner_card_job_drift_repaired', 'partner_card_job_qa_approved_redrive')
 ORDER BY created_at DESC LIMIT 50;
```

---

## 4. Stuck Card Job

Reported by `stuckCardJobs`. **Report-only by design** — a card sitting in one state for days has many
possible causes (operator went home, station broke, customer never returned) and no single safe
automatic answer.

```sql
SELECT id, tenant_id, location_id, status, mv_number, updated_at,
       round(EXTRACT(EPOCH FROM (now() - updated_at)) / 3600) AS hours_stuck
  FROM partner_card_jobs
 WHERE cancelled_at IS NULL
   AND status NOT IN ('COMPLETED','CANCELLED')
   AND updated_at < now() - interval '48 hours'
 ORDER BY updated_at ASC;
```

`updated_at` is maintained by 0080's trigger and **cannot be back-dated by an UPDATE**, so staleness
here is not spoofable.

Resolution depends on state:

| Status                         | Action                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `CREDIT_RESERVED`/`NEEDS_SCAN` | Card was never captured. Cancellation is legal from here and releases the reservation. |
| `CAPTURING`                    | Check `scanner_capture_sessions` for an expired session; the station can re-arm.       |
| `FIX_REQUIRED`                 | Awaiting a zero-credit replacement capture. Chase the shop.                            |
| `READY_TO_GRADE`/`GRADING`     | Nobody is grading it. Check for a held lease (§5), then chase the shop.                |
| `SUBMITTED`/`QA_REVIEW`        | Awaiting Super Admin QA. This is an HQ backlog, not a Partner fault.                   |
| `APPROVED`/`PRINTABLE`         | Awaiting print. Check the print queue and `print_events`.                              |

Cancellation past `CAPTURING` is deliberately **not** a partner self-service path — a credit has been
consumed or evidence exists. It is a Super Admin workflow.

---

## 5. Stale grading leases

Informational only. Correctness never depended on sweeping these: `acquireLease` releases an expired
lease inside its own transaction before taking a new one, so no background job is required.

```sql
SELECT card_job_id, tenant_id, holder_user_id, expires_at
  FROM partner_grading_leases
 WHERE released_at IS NULL AND expires_at <= now()
 ORDER BY expires_at ASC;
```

A large or growing count is an operational signal — graders closing laptops mid-card, or a flaky
network killing heartbeats — not a fault to repair.

**A grader locked out of their own card:** they can simply reopen it; an expired lease is reacquired
safely and the generation advances. If another grader genuinely holds it, use **takeover** in the UI
(org-wide permission, reason required, audited) — not a manual DELETE.

---

## 6. Grading Credit drift

**Never silently mutate a balance to make a discrepancy disappear.** The reconciliation is
**read-only by design**; an automatic correction destroys the evidence needed to explain how the money
moved. Remediation is an audited Super Admin adjustment.

Detection is hourly and logs:

```
[partner-credit-reconciliation] LEDGER DRIFT DETECTED errors=N warnings=M <CODE>=n …
```

Any `error`-severity code means an invariant is already broken (balance mismatch, negative balance,
missing consume evidence, duplicate terminal transition, cross-tenant reference). Expected steady
state is exactly zero.

Position of one tenant:

```sql
SELECT * FROM partner_credit_availability WHERE tenant_id = '<tenant>';

SELECT status, count(*) FROM partner_credit_reservations
 WHERE tenant_id = '<tenant>' GROUP BY status;

SELECT entry_type, sum(amount), count(*) FROM partner_credit_ledger
 WHERE tenant_id = '<tenant>' GROUP BY entry_type;
```

**Settlement happens exactly once, at SUBMIT**, keyed `partner-card-job-submit:<cardJobId>`. Reprints,
NFC retries and QA returns cost nothing. To verify a specific card only ever settled once:

```sql
SELECT e.event_type, count(*)
  FROM partner_card_jobs j
  JOIN partner_credit_reservation_events e ON e.reservation_id = j.reservation_id
 WHERE j.id = '<card_job_id>'
 GROUP BY e.event_type;
```

---

## 7. Stripe webhook failure

**Owner-gated:** live Stripe keys, dashboard access and any refund.

Credits are granted by webhook. A failed webhook means a shop paid and has no credits.

1. Confirm the purchase reached us:
   ```sql
   SELECT * FROM partner_credit_ledger
    WHERE tenant_id = '<tenant>' AND entry_type = 'purchase'
    ORDER BY created_at DESC LIMIT 20;
   ```
2. Webhook grants are idempotent on their external reference, so **replaying the webhook from the
   Stripe dashboard is safe** and is the correct first action. A replay that finds the grant already
   applied is a no-op.
3. Only if the replay cannot be performed: an audited Super Admin credit adjustment, with the Stripe
   payment intent recorded as the reason.

Never grant credits without a matching Stripe record.

---

## 8. Evidence / R2 mismatch

Scanner evidence is immutable once accepted. A mismatch means the object store and the ledger
disagree, never that the ledger is wrong.

```sql
SELECT certificate_id, side, evidence_class, format, object_key, sha256, is_current, created_at
  FROM certificate_image_evidence
 WHERE certificate_id = <cert id> ORDER BY created_at DESC;
```

A card cannot reach `READY_TO_GRADE`, cannot be submitted and cannot be printed without **both** sides
present as current immutable TIFF masters bound to a terminal capture session on an ACTIVE station in
the card's own location. So a mismatch fails closed automatically.

Recovery is a **Scanner FIX** — a zero-credit replacement capture on the same Card Job, same MV, same
certificate. It is not a new card and must never be handled by starting one.

---

## 9. Printer failure / retry

A failed render **releases** the reservation and fails the batch; it never leaves a card marked
printed with no PDF behind it, and it never mints a replacement identity.

```sql
SELECT batch_id, kind, status, cert_count, failure_count, created_at
  FROM print_batches ORDER BY created_at DESC LIMIT 20;

SELECT cert_id, action, from_state, to_state, reason, created_at
  FROM print_events WHERE cert_id = 'MV…' ORDER BY created_at DESC;
```

Batches stranded in `rendering` (a process crash during the out-of-transaction render window) are
swept automatically by `reconcileStuckPrintBatches`, which runs at boot and releases the certificates
back to `needs_printing` / `reprint_required`.

A physically damaged label is a **reprint**: same certificate, same MV, zero Grading Credits, reason
and category required, recorded in `print_events` and `reprint_log`.

---

## 10. NFC failure

A tag may only be bound to an **approved** certificate — the public scan route 404s an unapproved
certificate, so binding earlier would produce a chip that taps to nothing.

```sql
SELECT id, certificate_number, nfc_uid, nfc_enabled, nfc_locked, nfc_written_at, nfc_written_by
  FROM certificates WHERE certificate_number = 'MV…';

SELECT action, admin_user, details, created_at FROM audit_log
 WHERE entity_type = 'certificate' AND entity_id = '<cert id>'
   AND action IN ('nfc_bound','nfc_cleared') ORDER BY created_at DESC;
```

**Failed / replaced tag:** clear the binding (audited, records the outgoing UID and scan count), then
bind the replacement. Retries cost **zero** Grading Credits — no NFC path touches a wallet, ledger or
reservation.

**"UID already registered" (409 / `NFC_UID_TAKEN`)** is migration 0088's unique index refusing to let
one physical chip resolve to two graded cards. Find the other card before doing anything else:

```sql
SELECT id, certificate_number, nfc_written_at FROM certificates
 WHERE lower(nfc_uid) = lower('<uid>') AND deleted_at IS NULL;
```

---

## 11. Staff / user compromise, password and MFA recovery

1. **Revoke sessions first**, then change credentials — in that order, or the attacker keeps a live
   session through the reset.
2. Partner user suspension, session revocation and MFA reset are Super Admin actions and require
   **step-up**; all are audited.
3. MFA reset disables every method, burns recovery codes and revokes sessions for that user. It is
   Super-Admin-only precisely because it is a tenant-takeover primitive if mis-scoped.
4. Verify afterwards:

   ```sql
   SELECT action, actor_user_id, record_id, created_at FROM partner_audit_events
    WHERE tenant_id = '<tenant>' ORDER BY created_at DESC LIMIT 100;

   SELECT severity, kind, detail, created_at FROM partner_security_events
    WHERE tenant_id = '<tenant>' ORDER BY created_at DESC LIMIT 100;
   ```

---

## 12. Emergency stop

Stops **new** paid work for a partner or a single location. Grading, FIX and QA of cards already in
flight are deliberately unaffected — a shop mid-assessment is not helped by losing the card.

`isHardStopped` is checked in `assertStartAllowed`, **before** the wallet is touched, so a stopped
partner cannot spend even with credits available.

Suspending a **location** stops that shop floor only; suspending the **organisation** stops all of it.

---

## 13. Migrations and rollback

```bash
npm run db:preflight                       # compare schema against expectations
npx tsx scripts/db/lint-destructive-sql.ts migrations/00NN_*.sql
npm run db:migrate                         # apply in order, recorded in schema_migrations
```

**Owner-gated:** any migration against production. See `docs/runbooks/db-migration-safety.md`.

Rollback files exist as `migrations/rollback-*.sql`. Policy: once a table holds live MV allocations,
rollback is **forward-fix only** — never a destructive rollback on real data.

Verify the gate before and after any change:

```bash
node scripts/ci/run-partner-suite.mjs --all      # every critical Partner suite
npm run check                                     # typecheck
npm run lint
npm run build
```

A skipped critical suite is a **build failure**, not a local convenience — the runner enforces this.

---

## 14. Escalation

Escalate rather than repairing by hand when any of these appear:

- a lineage inconsistency (`origin does not match…tenant`, a Card Job with no bound identity);
- any `error`-severity credit reconciliation code that does not clear;
- two certificates sharing an MV number, or a Card Job pointing at a certificate that another job
  also claims (both are structurally prevented — if seen, something has bypassed the database);
- a negative available balance;
- any cross-tenant read or write that succeeded.

For all of these: **capture the evidence first** (the queries above), then stop. A hand-repair that
destroys the trail is worse than the fault.
