# White Ace Assurance assessment — MintVault repository

> **Scope correction — 2026-09-04:** This document established a release-integrity
> control slice, not a complete architectural assessment. Its statements that the
> damage was “severe but bounded” and consisted of concentrated repair packages are
> withdrawn. The 34-node graph is retained as a nested release-integrity subgraph of
> the repository-wide [architecture recovery program](../repository-architecture-recovery-20260904/architecture-damage-assessment.md).
> No release or architectural-completeness claim may cite this document alone.

**Assessment date:** 2026-09-04  
**Starting branch/SHA:** `fix/resource-hardening-staging-20260827` / `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`  
**Corrected scope:** release-integrity controls sampled across the reachable repository, local build/test/security evidence, CI definitions, protected auth/payment/evidence/storage boundaries, and the boundary to staging/production; not a complete architecture/wiring assessment.  
**External observation:** none. No provider, staging, production, GitHub control-plane, secret, customer-data, deployment, migration, or paid-service mutation was performed.  
**White Ace verdict:** `NOT_ESTABLISHED`  
**Release verdict:** `NOT READY`

## Executive assessment

The release-integrity defects found in this slice are severe and the repository remains repairable. This slice did not establish that the wider architectural damage was bounded. A later architecture-wide route, data, runtime, client, migration, and operational wiring review found systemic authority drift and supersedes the earlier boundedness inference.

The assessment reproduced four new HIGH product defects: a dual-image publication race, an audit key/hash identity mismatch, a phone-upload success path that does not persist its certificate pointer, and a timezone-dependent anonymous-credit over-admission/refund defect. It also found one HIGH local credential-permission defect and confirmed the pre-existing six-family plaintext bearer-token repair is unfinished. These remain valid findings, but they are only one release-integrity subgraph of the wider recovery program.

One confirmed operational problem is proof fragmentation: the default local engineering gate is not self-contained, 75 test files contain conditional skip wiring, the shell runtime is Node 24 while the product runtime is exact Node 20.20.2, hosted exact-SHA CI is unavailable locally, and all live provider/staging/production facts remain unknown. The architecture recovery assessment identifies the broader composition and wiring failures that this slice did not cover.

## Accepted findings

| Finding | Severity | Status | Why it is accepted |
| --- | --- | --- | --- |
| `WAA-IMAGE-001` | HIGH | `FAIL` | Production-shaped route test deterministically reproduces dual-side partial publication followed by HTTP 500. |
| `WAA-IMAGE-002` | HIGH | `FAIL` | The SHA in the replacement audit does not hash the object identified by the same record's R2 key. |
| `WAA-IMAGE-003` | HIGH | `FAIL` | Current source uploads phone evidence, never applies its computed pointer map, bypasses 0122, and returns success. |
| `WAA-CREDIT-001` | HIGH | `FAIL` | Two controlled non-UTC-session PostgreSQL assertions deterministically reproduce over-admission and failed refund. |
| `WAA-LOCAL-SECRET-001` | HIGH | `FAIL` | Eight ignored local environment/backup files with non-empty credential-like variables are `0644` beneath a group-traversable home directory. |
| `REL-TOKEN-001` | HIGH | `FAIL` | Six reachable bearer-token families still store/lookup plaintext values; migration 0123 is absent. |
| `REM-SUPPLY-001` | HIGH | `FAIL` / external repair | The main CI is pinned, but the checksum-managed governance workflow uses mutable Action/service tags and a Node major. |
| `REM-GH-001`, `REL-ENV-001` | HIGH | `UNKNOWN` externally | GitHub enforcement, exact-SHA CI, live credentials, retention/restore, staging/device acceptance and production capacity were not observed. |

## Control disposition

White Ace labels below mean exactly: `PASS` has sufficient current evidence; `FAIL` has contrary evidence; `UNKNOWN` lacks sufficient evidence; `NOT_APPLICABLE` is outside bound scope.

| Control area | Status | Evidence boundary |
| --- | --- | --- |
| Governance authority and immutable starting baseline | `PASS` | Required controllers, project profile, canonical issue/proof ledgers and exact Git baseline were captured before edits. |
| Graph-first inventory with source verification | `PASS` | Code-only graph rebuilt and passed freshness; protected conclusions were checked against source, SQL and tests. |
| Secret scanning of complete Git history | `PASS` (WIP candidate) | Exact-fingerprint review followed by a clean 2,890-commit scan; no broad suppression. |
| Local ignored secret-file permissions | `FAIL` | Eight credential-bearing `.env`/backup files are `0644`; values were neither displayed nor copied. |
| Frozen MVGS grading behavior | `PASS` for non-change | No MVGS/scoring/golden-vector file was edited in this pass. Prior proof remains the authority for behavior. |
| Primary CI action/image/runtime immutability | `PASS` for `.github/workflows/ci.yml` | Actions and service images are SHA/digest pinned; Node is exact 20.20.2. |
| Managed Engineering OS workflow immutability | `FAIL` | Mutable `@v4` actions, mutable service tags and Node `24`; repair belongs upstream. |
| Object-write/certificate evidence integrity | `FAIL` | `WAA-IMAGE-001/002/003`; seven central 0122 suites otherwise pass 33/33. |
| Payment/credit day authority | `FAIL` | `WAA-CREDIT-001`; core canonical paid-order binding remains separately proven. |
| Bearer-token at-rest authority | `FAIL` | `REL-TOKEN-001`; six plaintext families remain. |
| Full local engineering test gate | `FAIL` | Captured run: 9 failed files / 12 failed assertions; five environment-blocked suites pass separately. Final focused fixtures reproduce four deterministic protected failures. |
| Dependency vulnerability status | `UNKNOWN` | Registry-backed audit was not authorised because it would disclose private dependency metadata; no network workaround was used. |
| Canonical Node 20.20.2 execution on this host | `UNKNOWN` | Local shell is Node 24.14.1; repository/Docker authorities pin 20.20.2. |
| GitHub ruleset and exact-candidate CI | `UNKNOWN` | Local GitHub authentication is invalid; no result is inferred. |
| Staging, production, provider retention/restore and physical Scanner acceptance | `UNKNOWN` | Not accessed and not mutated. |
| Deployment/release by this task | `NOT_APPLICABLE` | Explicitly outside authorised scope. |

## Safe repairs completed in the working tree

- Updated stale route/wiring proofs to assert current fail-closed behavior and actual wrapper delegation.
- Made the anonymous-credit fixture use the real current UTC day, exposing the production timezone defect instead of masking it.
- Brought the reduced certificate-route fixture to the production image/evidence schema so current behavior is exercised.
- Added exact gitleaks fingerprints for reviewed historical false positives; fresh full-history scan passes.
- Preserved all product code, protected MVGS code, migrations, dependencies, environments and external systems unchanged.

## Evidence summary

- White Ace skill package: SHA-256 `e8f549d3d7f5d15e1d2098ec119c7ef7dc21649a7942cebf85058b2142060a21`; self-tests 6/6.
- Graphify after WIP proof changes: 14,846 nodes, 33,334 edges, 731 communities; freshness passes.
- TypeScript check: pass before WIP documentation consolidation.
- Lint: pass with zero errors and 2,888 warnings before WIP consolidation.
- Build: pass before WIP consolidation; one PostCSS source-path warning remains.
- Durable object-write focus: 7 files, 33/33 assertions pass serially.
- Environment-dependent database cluster: 5 files, 62/62 assertions pass on disposable loopback PostgreSQL 17.
- Certificate route: 178/180 pass; the two failures are `WAA-IMAGE-001/002` and intentionally remain visible.
- Anonymous estimate credit: 22/24 pass; two controlled timezone failures reproduce `WAA-CREDIT-001` and intentionally remain visible.
- Full engineering test gate: 421 files pass, 54 skip, 9 fail; 6,200 assertions pass, 1,014 skip, 12 fail.
- Full-history gitleaks after exact-fingerprint repair: 2,890 commits / 71.86 MB, zero unallowlisted findings.
- Local secret-file metadata: eight ignored credential-bearing `.env`/backup files at `0644`; one `.env.save` sibling at `0600`.

## Fact, inference, claim, unknown

**Facts:** the exact source/test/workflow observations and command results above.  
**Inference:** the codebase is repairable because the failures cluster in bounded authorities with existing coordinator, migration, test and governance foundations.  
**Claim allowed now:** local assessment has identified and reproduced the highest-consequence current repository defects; safe proof/scanner repairs are present in the working tree.  
**Claims prohibited now:** release-ready, production-safe, staging-accepted, provider-compliant, dependency-vulnerability-free, exact-runtime proven, or complete remediation.  
**Unknowns:** hosted CI/rulesets, canonical runtime execution, dependency advisory state, live credentials/roles, object retention/restore, staging/device behavior, production capacity and customer-data behavior.

## Repair order

1. With owner approval, restrict the eight credential-bearing `.env`/backup files to `0600`; decide whether stale backups should be removed and credentials rotated.
2. With owner approval, fix `WAA-CREDIT-001` under one explicit UTC-day database authority and rerun boundary/concurrency/refund proofs.
3. With owner approval, fix `WAA-IMAGE-001/002/003` and complete the remaining 0122 writer enrollment with atomic/forward-recovery and audit-identity proofs.
4. With separate owner approval, implement the already-scoped additive migration 0123 and rolling SHA-256 bridge for the six bearer families, including atomic stolen-report consumption.
5. Obtain upstream managed-workflow pinning, registry-backed dependency evidence, exact Node 20.20.2 clean-install/build/test proof and exact-SHA hosted CI.
6. Only after repository gates pass, perform owner-authorised staging migration/readiness/retention/restore/device acceptance, then independently decide production release.

## Current blocker

Repository governance requires explicit owner approval before changing environment material, payment/entitlement, certificate/storage/evidence, authentication, or migration behavior. No such protected change has been made in this task.
