# White Ace issue crosswalk — repository assurance 2026-09-04

> **Scope correction:** This crosswalk covers the White Ace release-integrity slice.
> Repository-wide architecture findings are in
> [`../repository-architecture-recovery-20260904/issue-register.md`](../repository-architecture-recovery-20260904/issue-register.md)
> and the canonical engineering register. The earlier four-finding framing is not an
> architectural completeness claim.

The single canonical repository-wide issue authority is [`engineering/ISSUE_REGISTER.md`](../../../../engineering/ISSUE_REGISTER.md). This file records only White Ace control mappings and evidence references; it must not override or duplicate canonical issue status.

| White Ace control | Current audit status | Canonical issue mapping | Evidence / next proof |
|---|---|---|---|
| `WAA-SEC-022` | `FAIL` | `REM-SUPPLY-001` | Main CI is SHA/digest pinned, but checksum-managed `.github/workflows/engineering-governance.yml` uses mutable Action/service tags. Upstream Engineering OS repair is required; local edits are prohibited. |
| `WAA-SEC-022B` | `FAIL` | `REM-SUPPLY-001` | The managed workflow selects `node-version: 24`, not an exact patch. Product runtime authorities (`package.json`, `.nvmrc`, Dockerfile) are exact `20.20.2`; managed-workflow resolution remains external. |
| `WAA-DATA-016/017` | `UNKNOWN` | `REM-AUTH-001`, `REL-RUNTIME-001`, `REL-ENV-001` | Repository role/tenant proofs exist, but actual credential provisioning and live isolation remain external evidence. |
| `WAA-DATA-019/020` | `FAIL` | `REL-IMAGE-001`, `WAA-IMAGE-001/002/003`, `REL-ENV-001` | Migration 0122 and seven core writer suites pass 33/33, but dual-side publication, audit identity, and the live phone writer are currently defective. Live retention/restore remains unknown. |
| `WAA-SEC-026` | `FAIL` | `WAA-CREDIT-001`, `REM-PAY-001`, `REL-ENV-001` | Core paid-order binding remains proven, but anonymous estimate reserve/refund is not UTC-stable. Provider delivery remains external. |
| bearer-token lifecycle | `FAIL` | `REL-TOKEN-001` | Six reachable plaintext bearer families remain in current source; migration 0123 has not been authored. Protected repair is owner-gated. |
| secret history | `PASS` (WIP) | `WAA-SCAN-001` | Exact-fingerprint allowlisting reduces a fresh 2,890-commit full-history scan from 147 reviewed false positives to zero unallowlisted findings. |
| local secret-file permissions | `FAIL` | `WAA-LOCAL-SECRET-001` | Eight ignored `.env`/backup files containing non-empty sensitive-looking variables are group/world-readable (`0644`) beneath a group-traversable home. Permission repair and any rotation/deletion require owner action. |
| executable local gate | `FAIL` | `WAA-GATE-001` | Captured full gate: 421 passed files, 54 skipped, 9 failed; 6,200 passed assertions, 1,014 skipped, 12 failed. Five missing-variable suites separately pass 62/62 on disposable PostgreSQL; final focused fixtures reproduce four deterministic protected failures. |
| `WAA-PROOF-030/031/032/034` | `UNKNOWN` | `REM-GH-001`, `REM-SUPPLY-001`, `REL-ENV-001` | Exact-SHA hosted CI, staging, production, rollback, restore and provider evidence were not observed and are not inferred. |
| `WAA-HUM-035B` | `PASS` (repository authority only) | governance cross-cutting | `AGENTS.md`, both completion controllers, `CLAUDE.md`, `.engineering/project.yaml`, the issue register and proof ledger agree on authority and release boundaries. External enforcement remains separately unknown. |

The four HIGH findings in this release-integrity slice were accepted only after Lead source verification and deterministic reproduction. They are not the complete repository HIGH inventory. No product-code remediation is authorised until the owner explicitly approves the applicable protected payment/certificate/storage package; `REL-TOKEN-001` separately requires approval for auth and migration work.
