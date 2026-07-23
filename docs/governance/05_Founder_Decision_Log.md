# MintVault Engineering Governance System (MEGS) v1.1

## 05. Founder Decision Log

**Status:** v1.1 implementation baseline with open founder decisions explicitly marked  
**Created:** 2026-07-22  
**Updated:** 2026-07-22  
**Purpose:** Permanent record of long-term architectural and business decisions.

---

## 1. Decision Status Definitions

| Status | Meaning |
|---|---|
| Locked Decision | Current founder-approved rule with direct approval evidence. Do not change without founder approval. |
| Historical Decision | Past decision that explains current state. May still be active or superseded. |
| Superseded Decision | No longer current; retained for traceability. |
| Open Question | Not yet decided. Must not be guessed. |
| Proposed Architecture Principle | Engineering posture supported by repository evidence or review judgment, but not yet founder-locked. |

---

## 2. Locked Decisions

| ID | Decision | Rationale | Evidence | Related Requirements |
|---|---|---|---|---|
| MEGS-DEC-LOCK-001 | Founder approval is required for migrations, commits, pushes, merges, deployments, and unresolved architectural decisions. | Protect production, data, money, and project direction. | Founder instruction in MEGS creation task. | MEGS-GOV-001, MEGS-DEPLOY-001 |
| MEGS-DEC-LOCK-002 | Skipped tests never count as passing. | Prevent false readiness. | Founder instruction and scaffold rule. | MEGS-TEST-001 |
| MEGS-DEC-LOCK-003 | Deployment is not production verification. | A running artifact does not prove business behaviour. | Founder instruction and Phase 0 evidence model. | MEGS-DEPLOY-002 |
| MEGS-DEC-LOCK-004 | Evidence and status changes must be append-only where feasible. | Preserve accountability and auditability. | Founder instruction. | MEGS-EVID-001 |
| MEGS-DEC-LOCK-005 | MintVault Project Control readiness must be evidence-based, not inferred. | Prevent made-up percentages or completion claims. | Founder instruction in MEGS task. | MEGS-PCD-001 |
| MEGS-DEC-LOCK-006 | Wallet, credits, ledger, and fail-closed accounting are protected business systems. | Money and partner trust. | Founder instruction and repository wallet/ledger architecture. | MEGS-WALLET-001 |

---

## 3. Historical Decisions

| ID | Decision | Rationale | Evidence | Current Status |
|---|---|---|---|---|
| MEGS-DEC-HIST-001 | Main schema `db:push` is guarded and real database changes use numbered migrations. | Prevent destructive schema sync against unmanaged live objects. | `docs/runbooks/db-migration-safety.md`, scripts under `scripts/db/`. | Active |
| MEGS-DEC-HIST-002 | Partner Network uses isolated `partner_*` tables and tenant isolation. | Protect partner data and MintVault core data. | Partner migrations and tests observed in repository. | Active |
| MEGS-DEC-HIST-003 | Vault Quest uses `vq_*` tables and separate migration discipline. | Keep game subsystem isolated. | `drizzle-vq.config.ts`, `migrations-vq/`. | Active |
| MEGS-DEC-HIST-004 | `/api/version` reports running artifact commit. | Avoid stale-checkout deploy clobber. | `scripts/safe-deploy.sh`, `/api/version` Phase 0 evidence. | Active |

---

## 4. Superseded Decisions

| ID | Superseded Decision | Superseded By | Evidence | Notes |
|---|---|---|---|---|
| MEGS-DEC-SUP-001 | Treat the scaffold Project Control spec as governing. | The scaffold is only a placeholder; MEGS v1.0 documentation set is being drafted for founder review. | Founder instruction on 2026-07-22. | Scaffold must not govern implementation. |
| MEGS-DEC-SUP-002 | Assume the current checkout is implementation-ready. | Future implementation must start from a clean, approved base. | Phase 0 found current checkout stale and dirty. | Current checkout may still be useful for archaeology. |
| MEGS-DEC-SUP-003 | Treat the Shop Launch sequence as unavailable. | The ten-step sequence in Platform Governance v1.1. | Founder instruction reviewed in MEGS v1.0 gap analysis. | G7-G20 details remain open; the ten-step G5-to-pilot path is preserved. |

---

## 5. Proposed Architecture Principles

| ID | Principle | Rationale | Evidence | Related Requirements |
|---|---|---|---|---|
| MEGS-DEC-PROP-001 | Vault Quest should remain isolated from MintVault core systems unless integration is approved. | Protect grading-platform security and reliability while preserving ecosystem membership. | Repository architecture and existing VQ migration separation; founder direction requires VQ not to weaken MintVault. | VQ-DB-001, VQ-REL-001 |

---

## 6. Open Questions

| ID | Question | Why It Matters | Required Decider | Blocks |
|---|---|---|---|---|
| MEGS-DEC-OPEN-001 | What evidence records and pilot criteria mark each preserved Shop Launch step complete? | Required for launch readiness and Project Control seeding. | Founder | Shop Launch readiness percentages |
| MEGS-DEC-OPEN-002 | What are the detailed G7-G20 requirements and acceptance gates? | Prevent roadmap invention. | Founder | G7-G20 planning |
| MEGS-DEC-OPEN-003 | Should G6D be repaired, merged, superseded, or abandoned? | G6D contains unmerged migration-bearing work. | Founder/engineering lead | Submission-credit integration |
| MEGS-DEC-OPEN-004 | What is the final certificate-origin model for partner shops? | Affects public trust, certificate provenance, NFC, and correction routing. | Founder | Partner shop launch |
| MEGS-DEC-OPEN-005 | What is the exact correction-routing policy across Super Admin, staff, graders, and partners? | Prevent unauthorized or unaudited live record edits. | Founder | Correction dashboard/workflows |
| MEGS-DEC-OPEN-006 | What role does Terra play in AI operations? | Required before Terra output can support gated decisions. | Founder | AI operations model |
| MEGS-DEC-OPEN-007 | Which database target does the local `.env` represent: production, staging, or shared operational DB? | Prevent accidental migration or readiness conclusions. | Founder/ops | DB governance |
| MEGS-DEC-OPEN-008 | What is the exact immutable certificate-origin data model, display wording, and correction-routing policy? | Required before partner-origin certificates or correction workflows can be implemented. | Founder | Partner certificate origin, NFC, corrections |
| MEGS-DEC-OPEN-009 | What is the canonical Admin versus Super Admin privilege boundary for partner controls under `/api/super-admin/*`? | Current route-path naming conflicts with middleware evidence. | Founder | Authorization, audit, UI labels |
| MEGS-DEC-OPEN-010 | Should G6D be repaired, merged, superseded, or abandoned? | G6D contains unmerged migration-bearing submission-credit lifecycle work. | Founder/engineering lead | Submission-credit integration |
| MEGS-DEC-OPEN-011 | What commercial-model boundaries apply to GBP20 / GBP15 / GBP5: VAT, refunds, promotions, chargebacks, effective dates, and partner variation? | Required before Stripe packages and fulfilment. | Founder | Wallet, Stripe, reporting |
| MEGS-DEC-OPEN-012 | What are the technical rules for approved device identity and the three-strike programme? | Required before enforcement. | Founder | Partner security, scanner operations |
| MEGS-DEC-OPEN-013 | Which VQ set model is canonical: 90-card/12-family or master-spec 150-card/18-line? | Blocks VQ print, seed, and release claims. | Founder | Vault Quest |
| MEGS-DEC-OPEN-014 | Which VQ safe-area geometry is canonical: approximately 60 x 85 mm or 57 x 82 mm? | Blocks template coordinates and print QA. | Founder | Vault Quest print |
| MEGS-DEC-OPEN-015 | What is the formal Higgsfield subscription versus Cloud API provider and credit architecture? | Prevents false spend evidence. | Founder | VQ AI Studio |
| MEGS-DEC-OPEN-016 | What scanner test-unit acceptance criteria approve hardware for wider deployment? | Prevents relying on marketing claims or unvalidated hardware. | Founder | Scanner programme |
