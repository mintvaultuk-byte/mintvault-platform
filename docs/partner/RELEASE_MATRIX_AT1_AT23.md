# Partner Pilot — AT-1…AT-23 release matrix (RTM)

**Commit:** see `git log -1` at the time of reading. **Migration high-water:** 0088.
**Critical Partner gate:** 36 suites / 690 assertions / 0 failed / **0 skipped**.

Run the gate with:

```bash
node scripts/ci/run-partner-suite.mjs --all          # every critical suite, isolated
```

**Rule applied throughout: documentation is not proof.** Every row below is either backed by an
executable test that runs in the critical gate, or is marked **NOT RUN** with the reason. No row is
marked green on the strength of a design argument alone.

---

## Status key

| Status          | Meaning                                                                        |
| --------------- | ------------------------------------------------------------------------------ |
| **GREEN**       | Executable proof, running inside the critical Partner gate.                    |
| **GREEN (adj)** | Executable proof exists and runs, but in a suite outside the pinned gate.      |
| **PARTIAL**     | The core is proven; a named sub-case is not.                                   |
| **NOT RUN**     | Cannot be executed in this environment. Reason given. Owner-gated where noted. |

---

## The matrix

| AT        | Requirement                                                       | Executable proof                                                                                                        | Status      | Evidence                                                                                                           |
| --------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| **AT-1**  | One credit, two simultaneous NEW → exactly one winner             | `L1` 12 parallel NEW vs 5 credits → exactly 5; `partner-station-new-card` last-credit race                              | **GREEN**   | `tests/partner-pilot-concurrency.test.ts` L1; `partner-station-new-card.test.ts`                                   |
| **AT-2**  | One NEW Card Job ⇔ exactly one credit reservation                 | Reservation + job in one transaction; `uq_partner_card_jobs_reservation` proven                                         | **GREEN**   | `partner-card-job-authority.test.ts`; concurrency invariant sweep                                                  |
| **AT-3**  | Zero-credit wallet refuses NEW server-side                        | `INSUFFICIENT_CREDITS` from the engine, refused before any job is minted                                                | **GREEN**   | `partner-station-new-card.test.ts`; L1 refusals                                                                    |
| **AT-4**  | Two tabs / two stations racing                                    | `L1` (12 parallel presses), `L3` (8 graders one card)                                                                   | **GREEN**   | `partner-pilot-concurrency.test.ts` L1, L3                                                                         |
| **AT-5**  | Restart / retry / double-click idempotency                        | `L2` same client op id ×10 concurrently → one job, one MV, one credit                                                   | **GREEN**   | `partner-pilot-concurrency.test.ts` L2; `partner-station-new-card.test.ts` replay                                  |
| **AT-6**  | FRONT+BACK belong to the same job/session/side                    | Evidence bound to a terminal session on an ACTIVE station in the card's own location                                    | **GREEN**   | `partner-card-job-grading-bridge.test.ts` AT-B1, AT-B1b                                                            |
| **AT-7**  | A consumed credit is never released                               | Reservation status transitions; `RESERVATION_NOT_ACTIVE` on a terminal row                                              | **GREEN**   | `partner-credit-reservation-service.test.ts`                                                                       |
| **AT-8**  | One Card Job ↔ one MV forever; MV never reused                    | `uq_partner_card_jobs_mv_number`; immutability trigger; rollback burns no MV                                            | **GREEN**   | `partner-station-new-card.test.ts`; concurrency invariant sweep                                                    |
| **AT-9**  | Credit stress; ledger exact                                       | `L1`/`L9`: debits == consumed reservations after a sustained mixed workload                                             | **GREEN**   | `partner-pilot-concurrency.test.ts` L1, L9                                                                         |
| **AT-10** | Full cross-tenant matrix, including known-MV probes               | Cross-tenant by Card Job id, certificate id and MV — all resolve to not-found                                           | **GREEN**   | `partner-card-job-grading-bridge.test.ts` AT-B4; `partner-rls-isolation.test.ts`; `L5`                             |
| **AT-11** | Suspension overrides remaining balance                            | `assertStartAllowed` checks org **and** location before the wallet is touched                                           | **GREEN**   | `partner-multi-location.test.ts`; `partner-admin-control-shell-integration.test.ts`                                |
| **AT-12** | FIX never creates a reservation or an MV                          | Zero-credit replacement on the same job/MV/certificate                                                                  | **GREEN**   | `partner-scanner-fix.test.ts`                                                                                      |
| **AT-13** | Invalidated side unusable; Ready requires both                    | READY_TO_GRADE only once both sides are current immutable masters                                                       | **GREEN**   | `partner-card-job-grading-bridge.test.ts` AT-B1; `partner-scanner-fix.test.ts`                                     |
| **AT-14** | Grading isolation and role separation                             | SCANNER_OPERATOR cannot acquire/heartbeat/takeover/write; tenant + location isolation                                   | **GREEN**   | `partner-card-job-grading-bridge.test.ts` AT-B3, AT-B5; `partner-scanner-operator-role.test.ts`                    |
| **AT-15** | FIX: wallet before == after                                       | Wallet snapshot compared across a FIX cycle                                                                             | **GREEN**   | `partner-scanner-fix.test.ts`                                                                                      |
| **AT-16** | Webhook cannot double-credit; retry cannot double-charge          | Stripe purchase/grant/refund into the credit authority, replay-safe                                                     | **GREEN**   | `partner-credit-purchase.test.ts`                                                                                  |
| **AT-17** | Onboarding truthful states / readiness                            | Derived readiness; credential lifecycle (0077)                                                                          | **GREEN**   | `partner-management-ux-runtime.test.ts`; `partner-dashboard-operations.test.ts`                                    |
| **AT-18** | Session invalidation on reset; MFA reset; stale session           | Session revocation, MFA reset, step-up ladders — both Partner and Super Admin                                           | **GREEN**   | `partner-step-up-auth.test.ts`; `partner-admin-step-up.test.ts`; `partner-admin-control-shell-integration.test.ts` |
| **AT-19** | Printed grade == approved grade; reprint same cert, zero credits  | Full output road; reprint reuses cert + MV with a byte-identical wallet snapshot                                        | **GREEN**   | `partner-card-job-output.test.ts` AT-P1..P4, AT-P8, AT-P9/P10                                                      |
| **AT-20** | NFC retry same certificate; tag ↔ cert 1:1                        | Bind gate on approval; **0088** unique index on `lower(nfc_uid)`; retry costs nothing                                   | **GREEN**   | `partner-card-job-output.test.ts` AT-P11, AT-P11b                                                                  |
| **AT-21** | Webhook grant under concurrent NEW                                | Capacity 0; a verified grant lands while 4 workers hammer NEW across the boundary; repeated over independent iterations | **GREEN**   | `tests/partner-at21-grant-boundary.test.ts` (5 cases)                                                              |
| **AT-22** | FIX forensic integrity / abuse measurability                      | Original + replacement evidence, actor, station, reason, timestamps all preserved                                       | **GREEN**   | `partner-scanner-fix.test.ts`                                                                                      |
| **AT-23** | Multi-Machine state independence (2 Fly Machines, forced pinning) | Requires staging scaled to two Machines — **owner-gated**. I19 subset proven locally                                    | **NOT RUN** | see §Gaps                                                                                                          |

---

## Additional matrices proven this programme

| Set                 | Cases | Suite                                           |
| ------------------- | ----- | ----------------------------------------------- |
| AT-B1…AT-B23        | 27    | `tests/partner-card-job-grading-bridge.test.ts` |
| AT-P1…AT-P15        | 12    | `tests/partner-card-job-output.test.ts`         |
| R1…R9 (drift)       | 7     | `tests/partner-card-job-reconciliation.test.ts` |
| L1…L9 (concurrency) | 9     | `tests/partner-pilot-concurrency.test.ts`       |

---

## Fresh-state proof

Executed on a **fresh disposable PostgreSQL 16 + pgvector** database (`mv_freshstate`, loopback only):

1. `CREATE DATABASE` + `CREATE EXTENSION vector`
2. `npm run db:push` — base application schema (guard permits local/disposable hosts only)
3. `npx tsx scripts/db/migrate.ts --apply --allow-destructive` → **52 migrations applied in order,
   0001 … 0088**, 0 inconsistent, 0 checksum-mismatch
4. `node dist/index.cjs` against that database → **boots clean, `serving on port 5199`**, `/api/health`
   **HTTP 200**, root **HTTP 200**
5. Critical Partner gate: **35/35 suites green**
6. `npm run build` clean

**Two findings worth recording:**

- The numbered migrations are **additive over a Drizzle-pushed base schema**, not a from-scratch
  bootstrap. A truly empty database fails at `0010` (`relation "users" does not exist`) until
  `db:push` has run. This is by design, but it means "apply the migrations" is not sufficient to
  stand up a new environment — the base schema step is mandatory and must be in any provisioning
  runbook.
- A fresh apply requires `--allow-destructive` because **three pre-existing** migrations (0043, 0074, 0084) drop an index or a constraint in order to replace it. 0088 is clean
  (`lint-destructive-sql` passes). The runner refusing by default is correct behaviour.

Additionally, the gate itself is a fresh-state proof repeated **35 times per run**: every
self-provisioning suite starts its own PostgreSQL 17 container, applies the partner migrations in
order and runs against them.

---

## Test integrity audit

- **0 skipped** across all 35 critical suites, enforced by the runner: any skip, partial skip or
  environment abort in a critical suite is a build failure, not a local convenience.
- Suites are `isolate: true` and launched as their own vitest invocation. This is load-bearing:
  several assign `MINTVAULT_/PARTNER_*_DATABASE_URL` in their own `beforeAll`, and sharing a worker
  silently drops assertions (documented in the matrix header).
- **Bare `npx vitest run` is not trusted** and must not be used to judge this gate. It reports 7
  unrelated suites failing; those fail **identically at the pre-existing baseline** (`ce123e45`:
  22 failed / 157 passed in `certificate-update-route.test.ts`, verified by worktree comparison) and
  are untouched by this programme.

---

## Gaps, stated plainly

**AT-21 — CLOSED (was PARTIAL).** Now proven by `tests/partner-at21-grant-boundary.test.ts`: with
capacity at zero, four NEW workers retry across the boundary from two approved stations while four
concurrent deliveries of one verified Stripe event grant ten credits. Repeated over four independent
iterations, each on a fresh shop. Every iteration yields exactly one applied grant, exactly ten
distinct Card Jobs / MVs / certificates / reservations, a refused eleventh, exact
ledger-versus-reservation reconciliation, and zero capacity left. Overlap comes from the retry loop,
never from a sleep.

**A real defect was found on the first run and fixed, not assertion-weakened.** The money was always
correct — the ledger's `(source, idempotency_key)` uniqueness refused the second row under four-way
concurrent delivery, and total credited was exactly ten. But `fulfilPartnerCreditPurchase` discarded
`appendFoundationCredit`'s `alreadyApplied` flag and returned `granted: true` unconditionally, so all
four deliveries claimed to have performed the grant. The webhook handler **logs that value**, so an
ordinary Stripe redelivery storm wrote repeated `granted=true credits=10` lines for one £-paying
purchase — poisoning the single signal an operator would use to spot a genuine double-grant, and
training them to ignore the line that would show a real one. A replay now returns
`granted: false, reason: "already_granted"`, which is the function's own documented contract for a
"nothing to do" case and keeps a Stripe retry a 200. The canonical P5 webhook suite was hardened with
the same assertion, since that is where a future regression would surface first.

**AT-23 — NOT RUN.** Requires staging scaled to two Fly Machines with forced per-step request
pinning. Scaling staging is **owner-gated** and was not performed.

What _is_ proven locally is the I19 subset that AT-23 exists to protect: no authoritative state is
process-local. Sessions, wallet/availability, Card Job state, idempotency keys and edit leases all
live in PostgreSQL, and every concurrency proof in `L1`–`L9` runs across separate pool connections
rather than shared process memory. A second Machine is a second pool client, which is the case those
tests already drive. The untested part is genuinely the Fly routing layer, not the state model.

**Owner-gated and therefore not executed anywhere in this programme:** production database access or
migration, production deploy, live Stripe charges, real £ pack pricing, live email, secrets/flags,
Scanner signing/notarisation, and staging two-Machine scaling.

---

## Known MEDIUM / LOW

| Sev    | Item                                                                                                                             | Mitigation                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MEDIUM | QA approval spans two pools; a crash between them leaves an approved grade whose Card Job is still `QA_REVIEW`                   | **Closed operationally.** Fail-closed (output refused), detected and repaired within 15 minutes, idempotently, audited as a repair. Proven end-to-end in `partner-card-job-reconciliation.test.ts`. |
| FIXED  | Webhook grant reported `granted: true` on every replay, poisoning the operational double-grant signal (money was always correct) | Fixed in this pass: `alreadyApplied` is propagated as `granted: false, reason: "already_granted"`. Proven by AT-21 and the hardened P5 suite.                                                       |
| LOW    | `/api/admin/printing/workflow/reprint` does not consult partner print eligibility                                                | Flagging `reprint_required` is harmless; **producing** the reprint does consult it (`createBatchAtomic`).                                                                                           |
| LOW    | `POST /api/admin/printing/mark-printed` stamps `label_prints.printed_at` with no partner check                                   | Legacy sheet cache only; it does not change `print_state`, so it cannot produce output.                                                                                                             |
| LOW    | The Drizzle `certificates` definition does not model `source`, `scan_status`, `raw_uploaded`, which production has               | Named explicitly in `tests/helpers/certificates-stub.ts`; no runtime impact.                                                                                                                        |
| LOW    | The occupied-card workstation hides the grading panel rather than rendering a read-only view                                     | Safe direction; the banner explains why. A true read-only projection is larger than this pass.                                                                                                      |

---

## Rollback

- Rollback files: `migrations/rollback-*.sql`.
- **0088** rollback is `DROP INDEX IF EXISTS uq_certificates_nfc_uid;` — always safe, since the index
  constrains rather than stores.
- Policy: once a table holds live MV allocations, rollback is **forward-fix only**. Never a
  destructive rollback on real data.
- `tests/partner-rollback.test.ts` runs in the critical gate and owns its whole cluster (it drops
  cluster-global roles).
