# Distributed Grading Network — Part 23+ Issue Register

## Scope and baseline

- Branch: `psp/partner-rbac-hybrid`
- Baseline HEAD: `83b335f8` (working tree intentionally contains the active LiDE pass)
- Scope: distributed station identity, tenant/location authorisation, station health/calibration, capture provenance, TIFF/R2 scale, durable processing and fleet-read foundations.
- Excluded: production deployment/data mutation, grading mathematics, payment/credit behaviour and any claim that physical LiDE acceptance has occurred.

| ID | Severity | Reproduction / reachability | Repair in this pass | Proof | Status |
| --- | --- | --- | --- | --- | --- |
| DGN-01 | BLOCKER | A leaked `SCANNER_API_TOKEN` authenticated every station and caller-supplied IDs chose the target. | Per-Mac Ed25519 identity in Keychain-backed storage; signed request, monotonic nonce, server-assigned station code, active user/MFA/capability/location check. Static token is accepted only when **both** non-production and `MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN=1`. | Signature tamper/body/timestamp/version unit tests; TypeScript check. End-to-end Partner HTTP/RLS proof remains in the held-out suite. | FIXED — integration proof pending |
| DGN-02 | BLOCKER | No canonical station/location approval, revocation, calibration or fleet state existed. | Additive `0045_partner_stations.sql`, enrolment/approval/status service, calibration history/current pointer, append-only meaningful events and paginated Super Admin fleet route. | Applied `0045`, `0046`, `0047` twice to a fresh disposable PostgreSQL database; tables/indexes/RLS assertions passed. | PROVEN (migration shape) |
| DGN-03 | HIGH | A capture session could be claimed/evidenced with arbitrary workstation/device strings. | Browser/staff arms resolve an active calibrated canonical station only; service proves the certificate through that station's actual connector tenant/location bridge; production claim/keepalive/evidence/finalise require the signed Mac principal. Immutable provenance derives tenant/location/station/actor server-side. | Boundary tests cover free-form-station refusal, tenant/location bridge and production signed-agent gate; scanner staging PostgreSQL proof rejects another device and candidate crossover. | FIXED — held-out Partner HTTP/RLS proof pending |
| DGN-04 | HIGH | Multer memory storage could allocate 128 MiB per concurrent TIFF; 1,000 uploads would exhaust app memory. | Current production client receives a server-minted opaque staging key + short-lived TIFF PUT URL, then server bounded-finalises/hash-validates/promotes to immutable evidence. The legacy multipart route is bounded and development/rolling-upgrade compatibility only. Staging cleanup is leased/bounded and never touches masters. | Client HTTP proof verifies unchanged TIFF goes only to opaque PUT and finalise contains no TIFF; real PostgreSQL proof covers grant coalescing, changed candidate rejection, finalisation single-flight/retry/cross-device refusal and cleanup lease. On 2026-08-11, the only local R2 config was confirmed as the shared production bucket; its bucket-scoped credential returned 403 to read-only account discovery, and no development bucket/policy was discoverable. | EXTERNAL BLOCKER — a dedicated non-production R2 bucket/policy is required for finalise/load proof |
| DGN-05 | HIGH | Per-target polling was the only health signal; 5,000 stations would generate unsuitable traffic/audit churn. | 75–105 second jittered heartbeat updates current station state; events only on hardware/profile/connection/capture-state/failure changes. A scanner hardware **or locked profile** change invalidates the calibration pointer. Target polling remains separate and target-active only. | Scanner unit regression suite, boundary drift guard and TypeScript check; need held-out HTTP/DB event-count proof. | FIXED — held-out proof pending |
| DGN-06 | HIGH | Every claim globally expired every station’s sessions, and its index did not fit station claim. | Station-local expiry is capped at 50; global expiry is a bounded 100-row, indexed, `SKIP LOCKED` worker. | PostgreSQL staging integration proves bounded expiry; migration includes `idx_scanner_capture_expiry`. | PROVEN |
| DGN-07 | HIGH | Derivative work lived in an in-process FIFO and disappeared on restart. | `0046_scanner_processing_jobs` is durable, coalesced and lease-claimed by one bounded worker per process; reconciler only re-enqueues and never reads/Sharp-processes masters itself. | Disposable PostgreSQL behavior proof previously exercised enqueue/coalesce/reclaim; TypeScript regression after reconciler change. | PROVEN (local DB) |
| DGN-08 | HIGH | Several older core admin/customer list and dashboard paths remain unbounded at million-record scale. | New station fleet read is paginated/capped. Existing legacy lists are preserved rather than silently changing broad UI behaviour without a compatible pagination migration. | Scale audit mapped exact paths. No affected scanner-station path calls them. | OPEN — separate legacy UI/data-contract repair required before broad million-record readiness claim |
| DGN-09 | HIGH | Stale/failed staged objects could grow indefinitely or be double-cleaned by multiple replicas. | `0047` records only server-created staging keys; bounded expiry/cleanup uses a 15-minute cleanup lease and deletes only accepted/expired/failed non-authoritative objects. | Real PostgreSQL test proves cleanup claim exclusivity; TypeScript check. R2 deletion requires non-production object-store proof. | FIXED IN CODE — non-production R2 proof pending |
| DGN-10 | BLOCKER | Candidate `v1066` reached the signed-station route but `GET /api/partner/stations/enrolment-locations` returned `503`. The migration/schema release was then rolled back to v1065 application code; additive tables remain. Read-only reconciliation now proves that `partner_runtime` is `NOLOGIN`, its only member is the `BYPASSRLS` owner (unsafe for runtime use), `PARTNER_MFA_ENC_KEY` has no existing compatible secret, production has no Partner location/user/RBAC catalogue, and `0034_partner_rbac_seed.sql` is unapplied. | Provision one least-privileged Neon LOGIN member of `partner_runtime` against existing `neondb`, create a new 32-byte MFA key, then only under new owner approval apply canonical additive `0034` and bootstrap one HQ location, scan-authorised MFA operator, and portal/login flags. No separate Partner database; do not reuse the owner URL or an unrelated secret. | `partner-runtime-configuration-audit.md`; source gates in `server/partner/mount.ts`, `server/lib/scanner-auth.ts`; production `BEGIN READ ONLY` role/schema/data checks; focused boundary/topology tests. | EXTERNAL BLOCKER — owner must approve a restricted DB login credential, new MFA secret, unapplied RBAC migration and one-HQ bootstrap before a fresh release verification |

## Certificate identity / MV allocator — 2026-08-11 pass

Full detail, including the §8 lifecycle decision, in
`certificate-identity-lifecycle.md`. All defects were REPRODUCED against real
PostgreSQL 17 before being fixed (red baseline captured by running
`tests/certificate-allocator-concurrency.test.ts` against the unfixed tree).

| ID | Severity | Reproduction / reachability | Repair | Proof | Status |
| --- | --- | --- | --- | --- | --- |
| CERT-01 | BLOCKER | The counter increment autocommitted in a transaction separate from the certificate INSERT, so any failed insert permanently burned an MV integer. Injected INSERT failure advanced the counter 836→837 with zero certificates committed. | Allocation + INSERT share one `db.transaction` at all three call sites. | Rollback test: counter unadvanced, next issuance still receives S+1. | PROVEN |
| CERT-02 | BLOCKER | A lost idempotency race burned one integer per losing caller; the source comment called it "a harmless counter gap". 25 concurrent same-key ingests committed MV839, burning 837 and 838. | Losing transaction rolls back via an `IdempotencyRaceLost` sentinel, returning its integer. | 25 concurrent same-key → one committed card at S+1, counter = S+1. | PROVEN |
| CERT-03 | HIGH | `GET /api/admin/next-cert-id` derived the next number from `MAX(regexp_replace(certificate_number…))` — a second formula over a different source of truth than the allocator, and the only number an operator sees before scanning. | Reads `cert_counter.last_issued + 1`; response marked `advisory: true`. | Single-formula; divergence cases (soft-delete, MV900001+ harness band) no longer reachable. | FIXED |
| CERT-04 | HIGH | `scripts/scanner-watcher/watcher.mjs` computed `MV<last + 1>` locally on the scanner — the exact pattern §4 forbids — seeded from a state file across restarts. | Derivation removed; returns null so the guide renders "—". | Permanent repo-wide guard test over `scripts/` + `client/src`. | PROVEN |
| CERT-05 | HIGH | Image upload fell back to `ORDER BY created_at ASC LIMIT 1` when the target was unresolvable, silently binding a customer's photo to an arbitrary certificate with a 200. Reachable in normal operation: the queue pointer is in-process state and production runs multiple Fly machines. | Fallback removed; returns 400. | Server no longer guesses which card an image belongs to. | FIXED |
| CERT-06 | MEDIUM | `uploadImagesToCertUnlocked` fell back to `MV<primary key>`, minting a fake identity and writing images under another certificate's R2 prefix. | Throws instead. | — | FIXED |
| CERT-07 | MEDIUM | `getNextCertId(executor = db)` defaulted to autocommit, letting a future caller silently reintroduce CERT-01 while type-checking cleanly. | Executor is now required; the compiler enforces the invariant. | `npm run check` passes with all three callers passing `tx`. | FIXED |
| CERT-08 | MEDIUM | The counter row is a global mutex held across a small pool with no lock timeout; one stalled holder would block issuance estate-wide and park pooled connections for 30s. | `SET LOCAL lock_timeout = '5s'` inside the allocator transaction. | A stuck waiter fails fast and rolls back, returning its integer. | FIXED |
| CERT-09 | MEDIUM | Boot-time `UPDATE certificates SET certificate_number = …` re-runs on every boot of every machine and swallows its error, so a 23505 collision leaves the server healthy with the migration silently unapplied. | Not changed — it mutates the identity column (Golden Rule 2) and needs a read-only production row count first, which requires production DB access this session lacks. | — | OWNER_DECISION |
| CERT-10 | MEDIUM | `POST /api/admin/certificates/new` has no idempotency key, so a double-click mints two real certificates for one physical card. | Not changed — a complete fix needs the client to send a key. The scanner path in this release is already protected by the content-derived key + `uq_certificates_ingest_idem`. | — | FOLLOW_UP |

### Test-state separation (controller: separate pre-existing root failures)

Full suite on the working tree: **3,935 passed / 22 failed / 875 skipped (4,832)**.

A clean worktree at `20850ae9` was created and the same suites re-run to
establish a baseline. Result:

- **Consistent, pre-existing, NOT caused by this pass:**
  `structured-variant-persistence` test 22 (protected-file guard). It compares
  against `origin/main`, and `server/certificate-document.ts` + `server/grader.ts`
  already differ at `20850ae9`. **None** of this pass's changed files match the
  guard's engine regex. Reproduced identically on the clean baseline.
- **Resource-contention flakes, not regressions:** `printable-grade-safety`,
  `project-control-hardening`, `partner-recovery-cardinality`,
  `scanner-station-capture-boundary`, and the vq-*/pokemon-handbook/lide400
  suites. The failing set differs between runs and all fail at ~5s boundaries;
  all pass in isolation. `printable-grade-safety` failed on the clean baseline
  too, then passed isolated in the working tree.
- **This pass's own suites:** `certificate-allocator-concurrency` 10/10,
  `scanner-station-capture-boundary` 5/5.

## Pilot gates

1. Apply `0045`–`0047` through the guarded migration runner to a non-production environment.
2. Run signed-station Partner HTTP/RLS/tenant-crossover and event-count integration proofs.
3. Provision a non-production R2 bucket/policy and run direct PUT → finalise → immutable promotion/retry/cleanup tests with representative 1200-DPI TIFFs.
4. Run the controlled 100/500/1,000 station/upload load scenarios and record measured latency, memory, R2 timing and pool use.
5. Complete the separate physical LiDE 400 final Scan → Preview → Accept/Rescan proof and sustained scan run. No software-only evidence may replace it.

## MV837 production-canary preflight — 2026-08-11

- Owner authorised one target only (MV837) but explicitly did **not** authorise a general production deployment or migration.
- Read-only Fly/API proof established that production is not compatible with the signed-station/staged-evidence protocol. The canary was therefore stopped before an MV837 read/write, station enrolment, R2 operation, or certificate mutation.
- The exact coordinated-release and rollback boundary is recorded in `production-canary-preflight.md`. A fresh MV837 snapshot must be taken only after that release is demonstrably live; a snapshot taken now would be stale by the time a canary could begin.

## Closure discovery — 2026-08-11

- The running Scanner is v1.2.1 from this repository, but is a manually launched Electron process rather than the `com.mintvault.scanner` LaunchAgent. It has no stored signed-station identity and its only local endpoint is the legacy production host.
- Port 5000 is owned by macOS Control Center, not a MintVault development server. The only local PostgreSQL databases are `postgres` and an unrelated Vault Quest database.
- The configured R2 bucket is documented shared production infrastructure and was not read or written. No R2 profile/CLI or pre-provisioned non-production bucket was available. This is an external-provisioning gap, not a scanner-code regression.

## Production runtime bootstrap — EXECUTED 2026-08-11

Intentional production mutations, in order (all verified by row count, never by exit code):

1. `fly secrets set` → `PARTNER_DATABASE_URL` (restricted `partner_runtime_app` LOGIN) + `PARTNER_MFA_ENC_KEY` (fresh 32-byte, generated inline, never printed). Release **v1067 → v1068**, rolling, both machines healthy. `[config]` confirms `DB_HOST=ep-wispy-morning-…-pooler DB_NAME=neondb`; no topology error.
2. Applied **`0034_partner_rbac_seed.sql`** → verified **6 roles / 20 permissions / 70 mappings**, journal checksum `9600c9d0…3115f`. `MVGS_ASSESSMENT_TECHNICIAN` = 10 perms, holds none of credit/orders-submit/user-admin.
3. Applied **`0031`, `0032`, `0033`, `0044_partner_mfa_pending_lifecycle`** under a second, explicit owner authorisation — required because `team-service.ts` needs `partner_invitations` and `mfa-service.ts` needs `enrolment_session_id`. Verified present. **`0041`/`0042`/`0043` (credit/settlement) deliberately NOT applied** — proved unreachable at boot and on the station/scan path.

Method: each file copied into the running machine with sha256 verified against the local file, then a dry run that had to show exactly the authorised filenames, then `--apply`. The production DB credential never left Fly. Journal: 31 rows. `cert_counter.last_issued` unchanged at **836**.

### DGN-11 — BLOCKER: candidate branch would regress production on deploy

`psp/partner-rbac-hybrid` is 10+ commits behind `origin/main`. Critically,
`f51beb10 fix(cert): stamp HQ grading origin on the two raw certificate INSERT paths`
is on main and not here, and it edits `server/routes.ts` +
`server/scan-ingest-service.ts` — the same two files the allocator work changed.
Deploying this branch would silently revert it. `safe-deploy.sh` GUARD 1 would
correctly refuse.

Also: two different migrations are numbered 0044 —
`0044_partner_mfa_pending_lifecycle.sql` (this branch, APPLIED to production) and
`0044_partner_submission_lifecycle_and_location_snapshot.sql` (origin/main,
unapplied). Filenames differ so the filename-keyed journal tolerates both, but the
sequence is ambiguous across branches and should be reconciled.

Repair: integrate `origin/main` into the candidate, preserving BOTH the
HQ-grading-origin fix and the transactional allocator (they touch the same
functions — expect a real conflict in `createCertForScan`), re-run the allocator
and ordering suites, then deploy. Status: OPEN — blocks deploy, station enrolment
and the physical canary.
