# MV837 production-canary preflight — failed closed

## Authorisation boundary

The owner initially authorised exactly one production certificate (`MV837`) and
its two evidence sides. On 2026-08-11 the owner additionally authorised the
coordinated signed-station scanner release, matching Scanner v1.2.1 support,
and additive migrations `0045`–`0047` only. Bulk testing, unrelated migration,
certificate renumbering, destructive cleanup, and any certificate other than
MV837 remain excluded. No production write has yet been made in this preflight.

## Read-only compatibility proof — 2026-08-11

| Check                                           | Observed result                                                        | Consequence                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Fly release                                     | `mintvault` v1065, committed 2026-07-28                                | Older deployment than the distributed-scanner work.                    |
| `/api/version`                                  | build `MV-P5-20260225-nohalf`, commit `6f182624`                       | Does not identify the current scanner candidate.                       |
| `GET /api/admin/scan-health`                    | `401 Unauthorized`                                                     | A legacy scan-health surface exists; this is not signed-station proof. |
| `GET /api/partner/stations/enrolment-locations` | `404 Not found`                                                        | Required signed-station enrolment route is absent.                     |
| `GET /api/super-admin/fleet/stations`           | `404 Not found`                                                        | Required station approval/fleet route is absent.                       |
| Git ancestry                                    | `f819be9c`, `3092d02b`, and `83b335f8` are not ancestors of `6f182624` | Current station/evidence code is not deployed.                         |

Therefore production cannot safely enrol/approve this Mac as a signed station,
bind the target to that identity, issue an opaque staged TIFF grant, or
finalise the TIFF under the new immutable-revision protocol. The Scanner must
not be pointed at this API for the canary.

## Required coordinated release

An immutable, reviewed release commit must first be created from the current
scanner worktree. There is deliberately no candidate SHA yet: the required
server/station code and migrations are currently uncommitted, and deploying a
dirty worktree is prohibited.

The release candidate must contain these server components as one compatible
unit:

- signed station identity, station service/routes, Partner mount, and fleet
  control;
- production signed-station enforcement on scanner claim, keepalive, staged
  upload and finalisation;
- target-bound scanner capture, staging grant/finalisation, immutable evidence
  revision selection, and durable derivative queue;
- scanner API/R2 integration and the matching Scanner v1.2.1 client.

It must apply these additive production migrations in this order:

1. `0045_partner_stations.sql` — station, calibration, event, RLS, and
   station-link foundation;
2. `0046_scanner_processing_jobs.sql` — durable derivative queue;
3. `0047_scanner_evidence_staging.sql` — scanner durability prerequisites,
   immutable evidence revision ledger, capture-session/staging tables, indexes,
   and scope guards.

Before applying any migration, production must be backed up and its actual
schema inspected for the migration prerequisites. Before deployment, the
focused station/auth/staging/TIFF/immutable-evidence Scanner suites must run
against the immutable candidate. After deployment, the served version and all
three station/staging route families must be checked before any MV837 read or
write.

## Local candidate gates — 2026-08-11

- `npm test --prefix scripts/scanner-app`: **32 passed, 0 failed, 0 skipped**.
- Focused Vitest (`partner-station-identity`, `scanner-evidence-admission`,
  `scanner-evidence-staging-service.integration`,
  `scanner-station-capture-boundary`, `lide400-profile`, `lide400-card-frame`,
  `r2-local-evidence`): **19 passed; 2 skipped**. The two skipped tests are
  intentionally the real-PostgreSQL staging-service suite: no disposable
  `SCANNER_STAGING_TEST_DATABASE_URL` was configured in this preflight.
- `npm run check`: passed.
- `npm run build`: passed. Existing PostCSS `from` warning and server bundle
  size warning were emitted; neither changed the successful build result.
- `git diff --check`: passed.

These are local proof only. They do not establish that the required production
routes, migrations, R2 scope, or station identity are live.

## Rollback / containment

- The migrations are additive. If the canary feature must be withdrawn before
  an accepted scan, roll back only the application image to v1065 and leave
  the new unused tables intact; do not drop production tables.
- Do not start an MV837 capture session until the post-deploy route/schema
  verification passes. This keeps the pre-canary rollback state mutation-free.
- Once a side has been accepted, its TIFF and evidence revision are immutable.
  Containment is to stop further capture sessions and later append a controlled
  replacement revision—not to delete the accepted master from R2.

## Live production schema reconciliation — 2026-08-11

Read-only execution on Fly machine `683720eb5127d8` connected to the expected
pooled Neon host and found only `certificates` and `cert_counter` among the
release prerequisites. `certificate_image_evidence`, station, capture-session,
processing-job, and staging tables are absent. The candidate had previously
created the evidence/session schema at startup; this would violate the owner's
named-migration boundary. The un-applied, owner-approved `0047` was therefore
made self-sufficient for those additive prerequisites, and this release removes
scanner boot-time DDL. Disposable migration validation is required before any
production migration.

## Deferred until a compatible release is live

- fresh server-side MV837 pre-canary snapshot;
- one legitimate signed station enrolment/approval/calibration for this Mac;
- authenticated actor verification;
- physical Preview → Scan → Accept/Rescan for FRONT then BACK;
- all production R2/finalisation timing and immutable-evidence evidence.

## Controlled production release outcome — 2026-08-11

- Immutable candidate: `788d680a289a495f90361133f8173d7f203bd50a`
  (`feat(scanner): add signed station staged evidence release`).
- Production applied only the approved additive migrations `0045`, `0046`, and
  `0047`. Their journal rows, expected tables, and critical indexes were
  verified after application; all new scanner tables were empty before the
  candidate application rollout.
- Candidate application release `v1066` ran the exact image built from that
  commit. Health passed and the fleet/staged/legacy scanner endpoints resolved
  to their authentication boundary, but
  `/api/partner/stations/enrolment-locations` returned `503` rather than its
  expected unauthenticated `401` boundary.
- The failure is fail-closed: the production environment has no configured
  Partner runtime database/MFA configuration required by the signed-station
  route guard. It must not be bypassed with the primary application database
  credential or an invented encryption key.
- Per the approved stop condition, no station was enrolled and no capture,
  staging, R2, evidence, or certificate mutation was attempted. The
  application was immediately rolled back to `v1067`, using the captured
  `v1065` application image/commit `6f182624`; both machines then reported
  healthy and the public version endpoint again reported that commit.
- The additive migration tables remain intact and empty. They were not dropped.
- A read-only pre-canary lookup also found `cert_counter.last_issued = 836`:
  `MV836` is unchanged, while `MV837` and `MV838` do not exist. Allocating or
  renumbering a certificate would exceed the canary authorisation.

The authorised canary is therefore blocked until an owner-approved, restricted
Partner runtime configuration is installed and the intended existing MV837
target is reconciled. A new candidate verification is required before any
physical capture.
