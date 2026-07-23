# MintVault Engineering Governance System (MEGS) v1.1

## 02. MintVault Platform Governance

**Status:** v1.1 implementation baseline with open founder decisions explicitly marked  
**Created:** 2026-07-22  
**Updated:** 2026-07-22  
**Cross-references:** [01 Engineering Constitution](./01_Engineering_Constitution.md), [05 Founder Decision Log](./05_Founder_Decision_Log.md), [06 Requirements Traceability Matrix](./06_Requirements_Traceability_Matrix.md)

---

## 1. Evidence Classification

This document separates:

- **Verified repository facts:** observed in the MintVault repository or Phase 0 reconciliation.
- **Verified production/database facts:** observed through read-only production or database evidence.
- **Locked Founder Requirements:** stated by the founder and preserved as requirements unless superseded by a later locked decision.
- **Assumptions:** provisional implementation guidance, not locked.
- **Future roadmap:** desired later capability.
- **Unknowns:** unresolved items that must not be guessed.

---

## 2. Platform Architecture

### 2.1 Verified Repository Facts

- MintVault is a React SPA with an Express server.
- Server routes are mounted through `server/index.ts` and `server/routes.ts` plus route modules.
- Data is PostgreSQL-backed with Drizzle schema definitions.
- Admin, staff, grading, public certificate verification, Partner Network, Vault Quest, marketplace, and marketing surfaces coexist in the repository.
- Fly configuration exists for production and staging-style apps.
- `/api/version` exists and reports build/commit/timestamp from the running server.

### 2.2 Architecture Governance

- Core grading and certificate functionality is the protected business core.
- Partner Network and Vault Quest must remain isolated from grading, certificates, labels, payments, and auth unless integration is explicitly approved.
- New internal Super Admin capabilities must use explicit auth and rate-limit policy.
- Public APIs must avoid leaking internal database, host, environment, or credential state.

---

## 3. Business Rules

### 3.1 Founder Requirements

MintVault business rules must preserve:

- Customer trust in certificate verification.
- Correct grading records.
- Label and slab integrity.
- Wallet and credit accounting.
- Tenant isolation for partners.
- Append-only evidence for status and financial changes.
- Founder authority over high-risk operations.

### 3.2 Unknowns

The ten-step Partner Network Shop Launch sequence is preserved in this v1.1 document. Detailed G7-G20 rules, certificate-origin implementation fields, correction-routing role boundaries, and full wallet/ledger edge cases remain open until founder-approved evidence is recorded.

### 3.3 Current Commercial Model

The current working commercial model is customer price GBP20, MintVault entitlement cost GBP15, and shop margin GBP5 unless replaced by a later Locked Decision. Before Stripe credit packages are implemented, the founder must define VAT, refunds, promotions, chargebacks, effective dates, and any per-location variation.

---

## 4. MVGS

### 4.1 Governance

MVGS is core business logic. Changes to:

- Numeric grade range.
- Non-numeric grade categories.
- Subgrade rules.
- Centering, surface, edge, corner, defect, pristine, or eye-appeal logic.
- Label grade rendering.
- Public grade display.

require founder approval and targeted regression tests.

### 4.2 Acceptance

MVGS changes must include:

- Before/after rule description.
- Test coverage.
- Impact on existing certificates.
- Label-rendering verification when labels are affected.
- Founder approval before merge/deploy.

---

## 5. Submission Workflow

### 5.1 Protected Behaviour

Submission workflow must preserve:

- Customer-submitted item identity.
- Payment state.
- Received, grading, return, completed, and exception states.
- Auditability of admin changes.
- Staff/grader assignment integrity.
- No loss of item/customer linkage.

### 5.2 Unknowns

The final Partner Network shop-origin submission flow and G6D submission-credit lifecycle are unresolved. G6D was observed as an unmerged WIP branch during Phase 0 and must not be treated as canonical without founder approval.

---

## 6. Certificates

### 6.1 Protected Behaviour

Certificates are public trust objects. Governance requires:

- Stable certificate ID normalisation.
- Public verification must never expose private owner or submission data unless explicitly allowed.
- Certificate corrections must be audited.
- Certificate origin must be traceable.
- Voiding, deletion, reissue, ownership, and public display must be controlled.

### 6.2 Correction Governance

Correction mode must:

- Be Super Admin controlled.
- Preserve before/after evidence.
- Avoid silent overwrites.
- Capture operator identity.
- Respect version/concurrency checks.
- Never use skipped tests as passing evidence.

### 6.3 Partner Grading Origin

Every grading and certificate record must preserve an immutable origin snapshot at the time of grading. The snapshot must identify the physical grading actor, origin type, approved display name, and approved grading location.

A partner-graded certificate must display `Graded by [Shop Name]` together with the snapshot grading location. A headquarters-graded certificate must display `Graded by MintVault Headquarters`. Later edits to a partner name, account, or address must not rewrite historical certificates.

Correction and rectification routing must use the original snapshot and applicable governance rules. Origin must never be reconstructed solely from a mutable partner account.

---

## 7. NFC

### 7.1 Governance

NFC links physical slabs to certificate verification. Changes require:

- Authenticated admin path for NFC registration or update.
- Uniqueness and collision handling.
- Audit logging for assignment, lock, verification, removal, or replacement.
- Public verification safety.

### 7.2 Unknowns

The final certificate-origin and NFC origin rules for Partner Network shops are unknown and must be founder-defined before shop launch.

---

## 8. Wallet & Credits

### 8.1 Verified Repository Facts

The repository contains Partner Network wallet/ledger code and migrations through at least `0016_partner_wallet_ledger.sql` in the current checkout. Phase 0 database evidence showed wallet and ledger tables present in the queried database, while G6B/G6C/G6D later tables were not fully applied there.

### 8.2 Governance Rules

Wallet and credit systems are financial-accounting systems:

- One partner credit represents one card grading entitlement.
- A single card must not consume more than one entitlement.
- Ledger entries should be append-only.
- Balance must be derivable from ledger evidence or a provably reconciled materialized view.
- Reservation, consumption, release, expiry, adjustment, refund, and manual admin actions must be auditable.
- Idempotency keys are required for mutating financial operations.
- No partner, staff, or public route may bypass the trusted server-side accounting boundary.
- Fail closed on uncertainty.
- Administrative adjustments require a reason, actor, timestamp, correlation or idempotency evidence, and audit record.

### 8.3 Gating

Any wallet/credit change requires:

- Database review.
- Financial/accounting review.
- Tests for idempotency, concurrency, tenant isolation, and failure cases.
- Founder approval before migration application, commit, merge, or deployment.

---

## 9. Partner Network

### 9.1 Verified Repository Facts

The repository contains:

- Partner schema and migrations.
- Partner runtime isolation and RLS-related tests.
- Super Admin partner routes under `/api/super-admin/*`.
- Partner Portal routes under `/partner/*`.
- Partner feature flags in `partner_feature_flags`.
- Partner wallet and ledger services.

Repository evidence must distinguish client route presence, server factory/source presence, mounted runtime presence, test execution, deployment, and production verification. As of the v1.0 review, client Partner Portal routes and an isolated server API factory are repository-proven; no mount of `createPartnerApp()` was found in the inspected `origin/main` server composition. The operational status of the Partner Portal is therefore `Unknown` until deployment/runtime evidence is recorded.

The v1.0 review also found that current partner control routers are mounted under `/api/super-admin/*` and use `requireAdmin`. Until a founder-approved privilege model is recorded, do not describe those routes as Super Admin-authorised. After the founder decision, replace this statement with the approved authorization contract, route test matrix, audit requirements, and migration/rollout plan if applicable.

### 9.2 Governance Rules

- Partner runtime must be tenant-isolated.
- Partner users must not gain MintVault Super Admin access.
- Super Admin partner controls must be audited.
- Emergency stop and feature flags must fail closed.
- Partner route changes require isolation tests.
- Global partner operations require founder approval when they affect live partner capability, money, credentials, or submissions.
- Partner users may view and operate only their own shop's cards, submissions, credits, and operational data.
- Partner access must be revocable and tenant-isolated.
- Minimum partner access must include secure invitations, authenticated sessions, MFA, and granular RBAC.
- Existing MintVault grading, admin, certificate, and label systems must be reused unless a documented architecture review proves reuse unsafe or materially insufficient.

### 9.3 Device and Three-Strike Policy

An approved-device restriction, including an authorised MacBook or device identity where selected, is a founder-governed policy and must define enrolment, evidence, revocation, recovery, and audit before implementation.

The three-strike concept remains programme policy until its events, consequences, appeal process, and reset rules are technically specified.

---

## 10. Shop Launch Programme

### 10.1 Founder Requirement

The Shop Launch Programme must preserve the complete Partner Network launch sequence and G5-G20 roadmap.

### 10.2 Preserved Sequence

The preserved Shop Launch sequence is:

1. Finish and deploy G5 Partner Management.
2. Build G6A wallet schema and immutable append-only credit ledger.
3. Build G6B reserve, consume, and release one credit per card.
4. Build G6C admin credit management and adjustments.
5. Build G6D connection to existing submission and grading workflow.
6. Build minimum secure partner authentication, invitations, and RBAC.
7. Build the basic Partner Portal.
8. Add Stripe credit packages and idempotent credit fulfilment.
9. Pilot with one or two shops.
10. Fix pilot issues and open access to more shops.

A phase may be described only by evidence-based lifecycle state. Its existence in a branch, worktree, or migration is not completion evidence.

### 10.3 Launch Rules

No shop may be treated as launch-ready until evidence proves:

- Partner onboarding path.
- Tenant isolation.
- Partner auth and MFA.
- Feature flag state.
- Wallet/credit state.
- Submission handoff.
- Certificate-origin tracking.
- Support and emergency-stop process.
- Founder approval.

---

## 11. G5-G20 Roadmap

### 11.1 Current Evidence

Phase 0 observed repository branches and worktrees for Partner Network G phases through G6D. G6D was not merged into `origin/main` at that time.

### 11.2 Governance

Each G phase must have:

- Scope.
- Requirements.
- Acceptance criteria.
- Tests.
- Migration list.
- Security review.
- Database review if applicable.
- Founder approval at gates.

### 11.3 Preserved Backlog

The wider G5-G20 programme remains a preserved long-term backlog and is not cancelled. G7-G20 detailed requirements are unknown and must be supplied or derived from founder-approved roadmap documentation before implementation.

---

## 12. Project Control Dashboard

### 12.1 Purpose

The Project Control Dashboard will track evidence-based programme readiness across repository, database, production, tests, reviews, decisions, and founder gates.

### 12.2 Governance Requirements

- It must distinguish implementation from verification.
- It must not infer completion from missing data.
- It must preserve append-only evidence.
- It must show stale, contradictory, unknown, blocked, and approved states.
- It must use permanent requirement IDs from the traceability matrix.
- It must be Super Admin only.
- It must initially be read-only.
- It must be protected by the fail-closed feature flag `super_admin_project_control_enabled`: absent, false, unreadable, or errored flag state denies access.
- It must distinguish implementation, testing, review, deployment, and production verification.
- It must retain separate states for unknown, not started, blocked, failed, and complete, and use the MEGS lifecycle vocabulary.
- Every percentage, recommendation, and completion state must link to timestamped evidence and provenance.
- Stale evidence must reduce displayed confidence or readiness rather than silently remaining current.
- It must not perform deployment, repository-write, database-write, or operational mutation actions.
- Continuation prompts must be generated from frozen evidence snapshots and must not silently change while work is in progress.

### 12.3 Implementation Status

Not implemented by this documentation task.

---

## 13. Security

Security governance applies to:

- Admin and Super Admin auth.
- Staff and grader access.
- Partner auth and RLS.
- Public endpoints.
- Uploads and image handling.
- R2 signed URLs.
- Stripe webhooks.
- Session handling.
- Rate limiting.
- CSRF/origin checks.
- AI provider calls and secrets.

Any security-relevant change requires review and evidence.

---

## 14. Testing

Testing evidence must include:

- Command run.
- Commit or file set.
- Pass/fail/skip status.
- Skip reason if skipped.
- Logs or summarized output.
- Related requirement IDs.

Skipped tests never count as passing.

---

## 15. Deployment

Deployment is a governance gate. No deployment may occur without founder approval. After deployment, production verification must prove:

- Running commit.
- Health/readiness where relevant.
- Database migration state where relevant.
- User/admin flow evidence appropriate to the change.
- Rollback path.

---

## 16. Scanner Programme

### 16.1 Purpose

The scanner programme exists to capture standard approximately 63 x 88 mm trading cards quickly and professionally.

### 16.2 Hardware and Image Standard

The active target is genuine 1200-DPI-equivalent detail: at least 20 MP camera capability, preferably 24 MP, with full-resolution still capture rather than video-frame extraction or software upscaling, and approximately 2976 x 4157 real card pixels.

Hardware must provide an enclosed hood or controlled environment and a repeatable square-card physical jig. Software must be developer-accessible and Mac-compatible through a macOS SDK/API, UVC, command-line capture, or complete technical documentation and sample code.

Where hardware permits, MintVault must control focus, exposure, white balance, lighting, capture, output, save path, naming, and device identity. Preferred output is TIFF or uncompressed PNG.

### 16.3 Workflow and Acceptance

The intended workflow is USB scanner to MintVault Mac scanner app to front/back capture to watched folder to uploader linkage with the correct submission. SilverFast is optional.

No scanner is approved merely from megapixel marketing. One test unit must pass documented optical, workflow, security, and failure-recovery validation before wider deployment.
