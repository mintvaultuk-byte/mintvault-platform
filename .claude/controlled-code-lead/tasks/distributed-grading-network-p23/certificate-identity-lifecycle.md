# Certificate identity lifecycle & MV allocator — decision record

Date: 2026-08-11 · Branch `psp/partner-rbac-hybrid` · Baseline `20850ae9`

## §8 — When is the MV number issued? (the first critical architecture decision)

**Answer: it already happens at evidence intake. No lifecycle change is required.**

`createCertForScan()` (`server/scan-ingest-service.ts`) allocates the MV number and
commits the certificate row at **scan ingest** — before grading, review or
approval. The row is created with `source='admin_scan'`, `status='active'`,
`scan_status='processing'` and **no grade**. Grade, sub-grades and approval are
applied later by the grading/review/approval path, which never re-allocates a
number.

So the owner's desired architecture in §8 —

```
FRONT + BACK accepted → permanent certificate identity created
→ card progresses through grading/review → grade/status evolve → identity never changes
```

— is the behaviour the repository already implements. Per the completion
controller ("do not ask unnecessary architectural questions when the repository
already establishes the correct pattern"), this is **not** escalated as an owner
decision. §9's fallback (fabricating a temporary non-MV identity) is moot and
must not be built.

**Why this issuance point is correct:** the number is the bridge between the
physical card and the digital record, and it is needed the moment the card
physically exists in the workflow. Because the row is created pre-grade, the
grade columns are nullable and the public/label/NFC surfaces already gate on
approval state rather than on row existence — issuing early therefore costs
nothing and gives the operator the identity at the only moment they are holding
the card.

**Consequences already reconciled in-tree:** void keeps the number historical
(never reused — the counter only moves forward); recapture appends an immutable
evidence revision against the same certificate and never re-allocates; the
`certificates.certificate_number` UNIQUE constraint makes a duplicate
impossible at the database level.

## Defects found and fixed in this pass

All three were **reproduced against real PostgreSQL 17** before being fixed —
see `tests/certificate-allocator-concurrency.test.ts`. The red baseline was
captured by running that suite against the unfixed tree.

| ID | Sev | Defect | Evidence (red) | Fix |
| --- | --- | --- | --- | --- |
| CERT-01 | BLOCKER | `getNextCertId()` autocommitted the counter increment in a transaction **separate** from the certificate INSERT, so any failed insert permanently burned an MV integer. | Injected INSERT failure: counter advanced 836→837 with **zero** certificates committed. | Allocation + INSERT now share one `db.transaction` at all three call sites. |
| CERT-02 | BLOCKER | A lost idempotency race burned one integer per losing caller — the source comment called it "a harmless counter gap". | 25 concurrent same-key ingests committed **MV839**, burning 837 and 838. | Losing transaction rolls back (`IdempotencyRaceLost` sentinel), returning its integer. |
| CERT-03 | HIGH | `GET /api/admin/next-cert-id` derived the next number from `MAX(regexp_replace(certificate_number…))` — a **second formula over a different source of truth** than the allocator. This is the only number an operator sees before scanning. | Diverges after any soft-delete of the newest cert, and the staging harness's `MV900001+` band made it predict `MV900011`. | Now reads `cert_counter.last_issued + 1` via `getLastIssuedMvNumber()`; marked `advisory: true`. |
| CERT-04 | HIGH | `scripts/scanner-watcher/watcher.mjs` computed `MV${parseInt(last) + 1}` **locally on the scanner** — the exact pattern §4 forbids. Seeded from a state file across restarts. | `nextCertGuess()` at L112-120. | Derivation removed; returns null so the guide renders "—". Guarded by a permanent repo-wide test. |
| CERT-05 | HIGH | Image upload fell back to `ORDER BY created_at ASC LIMIT 1` when the target was unresolvable, silently binding a customer's photo to an **arbitrary** certificate with a 200 response. Reachable in normal operation: `_currentGradingCertId` is in-process state and production runs multiple Fly machines. | `server/routes.ts` upload handler. | Fallback removed; returns 400. The server no longer guesses which card an image belongs to. |
| CERT-06 | MEDIUM | `uploadImagesToCertUnlocked` fell back to `` `MV${certId}` `` built from the numeric **primary key**, minting a fake MV identity and writing images under another certificate's R2 prefix. | `server/scan-ingest-service.ts`. | Throws instead. |
| CERT-07 | MEDIUM | `getNextCertId(executor = db)` defaulted to autocommit, letting a future caller silently reintroduce CERT-01 while type-checking cleanly. | Optional parameter. | Executor is now **required** — the compiler enforces the invariant. |
| CERT-08 | MEDIUM | The counter row is a global mutex for certificate creation held across a small pool with no lock timeout; one stalled holder would block issuance estate-wide and park pooled connections for 30s. | `server/db.ts` pool `max: 8`. | `SET LOCAL lock_timeout = '5s'` inside the allocator transaction — a stuck waiter now fails fast and rolls back, returning its integer. |

## Proof (real PostgreSQL 17, disposable cluster, real shipped functions)

`MINTVAULT_DATABASE_URL` is redirected to a disposable cluster before
`server/db.ts` is imported, so the production module graph is what executes —
not a re-implementation. 10/10 pass.

| Requirement | Test | Result |
| --- | --- | --- |
| §92 gapless under concurrency | 200 concurrent distinct-key issuances | exactly S+1…S+200, no duplicate, no gap |
| §16 scale | 500 and 1,000 concurrent | exactly S+1…S+N at both levels |
| §38 latency | measured per-issuance under full contention | N=500 p50 337ms / p95 600ms / p99 619ms; N=1000 p50 472ms / p95 923ms / p99 1008ms (~1,000 issuances/sec) |
| §11 DB uniqueness | duplicate `certificate_number` INSERT | rejected, SQLSTATE 23505 |
| §13 idempotency | sequential replay of same key | same number, `reused=true`, one integer consumed |
| §13 concurrent idempotency | 25 concurrent same-key | one committed card, exactly one integer consumed |
| §14 crash-after-commit | commit, drop connections, re-drive same key | same number returned, no orphan identity |
| §12/§15 rollback | injected INSERT failure after allocation | counter unadvanced; next issuance still receives S+1 |
| §19 one number space | repo-wide scan of `scripts/` + `client/src` | no local `last + 1` MV derivation |

Latency is measured on a local cluster with `fsync=off`; it establishes the
serialization/ordering behaviour, **not** a production SLA (Neon adds real
network latency). Throughput is the meaningful figure.

## Deliberately NOT changed

- **Grading maths, brackets, Pristine gate, approve-lock** — untouched (protected).
- **F6 — boot-time `UPDATE certificates SET certificate_number = …`** in
  `server/routes.ts`. It re-runs on every boot of every machine and swallows its
  error, so a 23505 collision would leave the server reporting healthy with the
  migration silently unapplied. Fixing it means changing the **identity column's**
  migration behaviour, which requires owner sign-off (Golden Rule 2) **and** a
  read-only production count first
  (`SELECT count(*) FROM certificates WHERE certificate_number ~ '^MV-[0-9]+$'`),
  which needs production DB access this session does not have. → OWNER_DECISION.
- **F9 — `POST /api/admin/certificates/new` has no idempotency key**, so a
  double-click mints two real certificates for one physical card. A complete fix
  needs the client to generate and send a key (frontend change). The scanner path
  — the one in this release — is already protected by the content-derived key and
  `uq_certificates_ingest_idem`. → FOLLOW_UP.
- **Legacy `scripts/scanner-watcher/` directory removal.** The local `last + 1`
  derivation inside it is neutralised, but deleting the directory outright is a
  destructive change requiring owner sign-off. → FOLLOW_UP.
