# MintVault database disaster recovery

## Current authority and release status

**Status: NOT PROVEN — EXTERNAL RELEASE GATE.**

Repository source does not prove that the live PostgreSQL service has backups,
point-in-time recovery, an acceptable retention window, or a successful restore
drill. Provider-console state, credentials, backup identifiers, and live restore
authority are outside this repository and must be verified by the owner/operator.

The Admin `backup-card-master` route is **not a disaster-recovery backup**. It
exports only active `card_master` rows as CSV, omits the rest of the database,
has no restore procedure or integrity manifest, and writes to R2. It cannot
recover certificates, certificate allocation state, customers, sessions,
submissions, payments, credit ledgers, Partner tenants, audit history, or the
migration journal.

No agent may restore, migrate, replace, or write to staging/production under this
runbook without explicit owner authorisation.

## Ownership and recovery targets

| Decision                                | Authority                              | Current value               |
| --------------------------------------- | -------------------------------------- | --------------------------- |
| Business/data owner                     | MintVault owner                        | Owner confirmation required |
| Recovery operator                       | Owner-approved infrastructure operator | UNSET                       |
| Database recovery point objective (RPO) | MintVault owner                        | UNSET                       |
| Database recovery time objective (RTO)  | MintVault owner                        | UNSET                       |
| Provider backup/PITR retention          | Provider console + owner evidence      | UNVERIFIED                  |
| Off-provider backup retention           | MintVault owner                        | UNSET                       |
| Restore-drill frequency                 | MintVault owner                        | UNSET                       |

The release gate remains external and red until the owner sets RPO/RTO and a
named operator records the evidence below. A target is not proof that the target
is met.

## Protected recovery scope

A recoverable snapshot must cover the entire canonical PostgreSQL database,
including at least:

- migration journal and every application schema;
- certificate rows, immutable certificate numbers, and allocator/counter state;
- submissions, paid fulfilment/outbox state, Stripe event receipts, credits,
  reservations, and ledgers;
- users, credential versions, sessions, Partner tenants, memberships, roles,
  tenant policies, and audit records;
- scanner capture sessions, processing jobs, evidence metadata, hashes, and
  object keys;
- append-only and immutable records without rewriting their history.

Database recovery must be coordinated with R2/B2 evidence recovery. A restored
row that points at a missing or wrong object is not recovered. R2-to-B2 evidence
archival is a separate control and does not replace PostgreSQL protection.

## Required controls before release

1. In the actual database provider account, record backup/PITR enablement,
   retention, region, encryption, latest successful recovery point, and the
   account/role allowed to restore. Capture evidence without exporting secrets.
2. Establish an encrypted, access-controlled full logical or physical backup
   outside the primary database provider. Keep immutable retention and a
   checksum/integrity manifest. Do not place credentials in the repository.
3. Protect deletion/retention changes with owner approval and independent
   operator authentication. Alert on backup failure or an ageing recovery point.
4. Perform the restore drill below into a disposable, isolated database. Never
   overwrite a live database to test recovery.
5. Record exact source backup/recovery-point identity, timestamps, tool/provider
   versions, restored database identity, candidate SHA, migration state, checks,
   duration, result, cleanup, and named approver.

## Disposable restore drill

1. Obtain explicit owner approval and select a recovery point older than a known,
   non-sensitive test marker. Record its immutable provider/backup identifier.
2. Restore into a new isolated database with no production application traffic,
   outbound email, payment webhook, object deletion, or background publishing.
3. Connect with a least-privilege validation role. Prove the restored migration
   journal and schema contract before starting application code.
4. Run the candidate's validation/readiness checks in read-only mode. Apply no
   forward migration unless that separate migration rehearsal is explicitly in
   scope and owner-approved.
5. Validate all checks below, record elapsed time against the owner-set RTO, and
   compare the selected recovery-point time against the owner-set RPO.
6. Destroy the disposable restore only after evidence is retained and the owner
   confirms the drill. Destruction is a separate approved action.

## Mandatory validation

- migration journal identities and required schema/trigger/role contracts;
- table and tenant row-count reconciliation against the source recovery point;
- no orphaned certificate/submission/payment/credit/Partner relationships;
- certificate numbers and allocator state remain unique, immutable, and
  monotonic without reseeding or renumbering;
- paid fulfilments, Stripe receipts, credit balances, reservations, and ledger
  totals reconcile without replaying external effects;
- every Partner read is tenant-isolated under the real restricted runtime role;
- append-only audit/event histories remain present and cannot be updated/deleted;
- sampled scanner evidence keys exist in the expected R2/B2 authority and match
  recorded byte lengths and hashes;
- application `/ready` refuses the incomplete restore and becomes ready only for
  the complete contract;
- authentication/session safety is explicit: restored old sessions and
  credentials are revoked or accepted only according to an owner-approved
  incident plan.

## Incident recovery boundary

During a real incident, preserve the failed database and provider logs, stop
writes before choosing a recovery point, and decide between rollback, point-in-
time restore, and forward repair with the owner. Never replay payment webhooks,
credit grants, certificate allocation, email, or object deletion merely because
the database was restored. Those effects require their own idempotency and
reconciliation evidence.

## Evidence record

Until every field below is complete, status remains `NOT PROVEN`:

- owner approval / named operator: UNSET
- owner-set RPO / RTO: UNSET / UNSET
- provider backup/PITR evidence: UNVERIFIED
- off-provider encrypted backup evidence: UNVERIFIED
- disposable restore identifier and date: UNSET
- candidate SHA and migration state: UNSET
- validation report and exact test commands: UNSET
- measured recovery point and recovery duration: UNSET
- result / owner acceptance: UNSET
