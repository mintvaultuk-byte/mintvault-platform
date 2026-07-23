# MintVault Engineering Governance System (MEGS) v1.1

## 06. Requirements Traceability Matrix

**Status:** v1.1 implementation baseline with open founder decisions explicitly marked  
**Created:** 2026-07-22  
**Updated:** 2026-07-22  
**Rule:** Requirement IDs are permanent. Do not reuse IDs. Mark superseded requirements as `Superseded` and create a new ID.

---

## 1. Status Values

MEGS v1.1 separates evidence classification from lifecycle state. The legacy `Status` column below remains for v1.0 traceability, but Project Control and all future requirement records must use the normalized fields.

### 1.1 Evidence Classification Values

| Classification | Meaning |
|---|---|
| Locked Founder Requirement | Founder-stated requirement preserved as active unless superseded. |
| Proven from repository | Repository source, configuration, scripts, or committed tests prove the stated mechanism or fact. |
| Proven from production | Live production evidence proves the bounded fact. |
| Proven from database | Read-only database evidence proves the bounded fact. |
| Proven by tests | Named tests were run and passed for the stated claim. |
| Proven by human review | Named review evidence supports the claim. |
| Reported but Unverified | Reported by prior review, runbook, comment, memory, or agent summary but not independently rechecked in the current evidence set. |
| Assumption | Explicit provisional assumption. |
| Future Roadmap | Desired future capability not yet implementation-ready. |
| Open Question | Founder or engineering decision still required. |
| Stale Evidence | Evidence exists but is time-bound or superseded by later information. |
| Contradiction | Evidence or documents conflict. |
| Superseded Decision | Historical decision retained for traceability but no longer current. |

### 1.2 Lifecycle State Values

| Lifecycle State | Meaning |
|---|---|
| not started | No implementation evidence. |
| proposed | Documented but not implemented. |
| in progress | Implementation exists but is incomplete or unresolved. |
| implemented | Repository mechanism exists; this alone is not verification. |
| test evidence missing | Implementation exists but no current passing test evidence was recorded. |
| tests failing | Relevant tests are known failing. |
| review pending | Implementation or documentation awaits review. |
| review failed | Review found blocking issues. |
| review passed | Review passed for the stated scope. |
| deployment pending | Ready for deployment gate but not deployed. |
| deployed | Artifact is deployed; production behaviour may still be unverified. |
| production verification pending | Deployed but live behaviour evidence is missing. |
| production verified | Live production evidence proves the bounded requirement. |
| blocked | A gate, contradiction, or decision blocks progress. |
| stale | Existing evidence is too old or superseded to support readiness. |
| unknown | Current state is not known. |
| superseded | Requirement has been replaced by a newer requirement ID. |

### 1.3 Legacy Status Values

| Status | Meaning |
|---|---|
| Draft | Proposed in MEGS v1.0; awaiting founder approval. |
| Locked | Founder-approved and active. |
| Verified | Proven by repository, database, production, tests, or human review. |
| Unknown | Required area exists but details are not available. |
| Superseded | Replaced by another requirement. |
| Roadmap | Future requirement not yet implementation-ready. |

---

## 2. Engineering Governance Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-GOV-001 | Stop at governance gates for migration application, commit, push, merge, deployment, or unresolved architecture. | Preserve founder control and production safety. | Reports show gate reached and no gated action taken without approval. | Draft | All engineering workflows | Governance report review |
| MEGS-GOV-002 | Maintain a live backlog across all remaining phases while executing the current phase. | Prevent lost requirements. | Backlog contains phase, requirement IDs, status, blockers, and evidence links. | Draft | Project Control Dashboard | Unit tests for backlog model when implemented |
| MEGS-GOV-003 | Separate verified facts, founder requirements, assumptions, roadmap, stale, contradictory, and unknown states. | Prevent false certainty. | Every material claim has a classification. | Draft | MEGS docs, Project Control Dashboard | Evidence classification tests |
| MEGS-GOV-004 | Preserve document hierarchy and conflict handling. | Avoid conflicting sources of truth. | Contradictions are logged and block affected implementation. | Draft | Governance docs | Documentation review |

---

## 3. Evidence Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-EVID-001 | Evidence and status history must be append-only where feasible. | Auditability. | Status changes create new records rather than overwriting history. | Draft | Project Control evidence model | Append-only model tests |
| MEGS-EVID-002 | Every readiness percentage must be derived from requirement evidence, not intuition. | Prevent misleading progress. | Readiness output links each numerator/denominator item to requirement IDs and evidence. | Draft | Readiness engine | Readiness calculation tests |
| MEGS-EVID-003 | Deployment evidence must distinguish deployed commit from verified production behaviour. | Deployment is not verification. | Dashboard shows artifact commit separately from post-deploy checks. | Draft | Deployment scanner | Scanner tests |
| MEGS-EVID-004 | Unknown data must remain unknown until verified. | Prevent invention. | Missing inputs render as `Unknown`, not complete or failed. | Draft | Evidence model | Unknown-state tests |

---

## 4. Repository and Migration Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-REPO-001 | New implementation must start from a clean, approved base. | Avoid stale or dirty worktree risk. | Base commit, branch, and worktree cleanliness are recorded before edits. | Draft | Git workflow | Repository scanner tests |
| MEGS-REPO-002 | Active worktrees must be discoverable and classified. | Avoid parallel-work collisions. | Scanner lists path, branch, HEAD, and prunable state. | Draft | Repository scanner | Git fixture tests |
| MEGS-DB-001 | Real database schema changes must use numbered migrations, not unguarded push. | Prevent destructive schema sync. | Migration plan and journal evidence exist before apply. | Verified repository fact / Draft governance | `scripts/db/*`, migrations | Existing migration safety tests plus new Project Control tests |
| MEGS-DB-002 | Migration application is a founder approval gate. | Prevent unauthorized DB change. | No apply command runs without approval evidence. | Draft | Migration workflow | Governance report review |

---

## 5. Security Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-SEC-001 | Super Admin surfaces must use explicit Super Admin authorization when they expose project control, correction, partner, financial, or deployment evidence. | Protect high-risk controls. | Routes reject non-Super Admin sessions and have tests. | Draft | Admin/Super Admin routes | Authz tests |
| MEGS-SEC-002 | Admin, staff, grader, partner, and customer roles must remain distinct. | Prevent privilege escalation. | Cross-role access tests pass. | Draft / partially verified by existing tests | Auth, Partner Portal, Admin | Role isolation tests |
| MEGS-SEC-003 | Public endpoints must not leak internal environment, DB, or credential details. | Reduce attack surface. | Error responses are generic and tests cover sensitive endpoints. | Draft | Public routes | Security route tests |
| MEGS-SEC-004 | Upload and AI-provider paths must validate inputs before storage, spend, or provider calls. | Prevent abuse and cost leakage. | Validation occurs before side effects. | Draft | Uploads, VQ AI Studio, grading AI | Validation and failure tests |

---

## 6. Testing Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-TEST-001 | Skipped tests must be reported as skipped, never passed. | Accurate readiness. | Test evidence model stores pass/fail/skip separately. | Draft | Test evidence scanner | Evidence model tests |
| MEGS-TEST-002 | CI evidence must include lint, typecheck, test, build, and security scan status where available. | Complete quality picture. | CI scanner captures workflow result or marks unknown. | Draft | CI scanner | CI parser tests |
| MEGS-TEST-003 | High-risk features require targeted regression tests. | Prevent business regressions. | Requirement status cannot become verified without matching test evidence or approved exception. | Draft | Readiness engine | Readiness gating tests |

---

## 7. Deployment Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-DEPLOY-001 | Deployment requires founder approval. | Protect production. | Deployment record includes approval evidence. | Draft | Deployment process | Governance review |
| MEGS-DEPLOY-002 | Running production commit must be verified through live artifact evidence. | Avoid stale deployment assumptions. | `/api/version` or equivalent returns expected commit. | Verified mechanism / Draft requirement | Deployment scanner | Scanner tests |
| MEGS-DEPLOY-003 | Rollback path must be recorded before deployment. | Recovery readiness. | Deployment plan includes previous image/commit or rollback command. | Draft | Deployment handover | Review checklist |

---

## 8. MVGS and Certificate Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-MVGS-001 | MVGS grading logic changes require founder approval and regression tests. | MVGS is core product value. | Approval and tests are linked before merge/deploy. | Draft | Grading, shared schema, labels | MVGS regression tests |
| MEGS-CERT-001 | Certificate public verification must preserve trust and privacy. | Public trust surface. | Public output excludes private data unless explicitly allowed and tested. | Draft | Verify routes, certificate pages | Privacy/route tests |
| MEGS-CERT-002 | Certificate corrections must be audited with before/after evidence. | Protect live record integrity. | Correction records include actor, fields, before/after summary, and version guard. | Draft / partially implemented evidence observed | Correction mode | Correction tests |
| MEGS-NFC-001 | NFC assignment and verification must be unique, auditable, and safe for public lookup. | Physical-digital trust link. | NFC operations are authenticated and audited. | Draft | NFC routes, certificates | NFC route tests |

---

## 9. Wallet, Credits, and Partner Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-WALLET-001 | Wallet and credit ledger entries must be append-only or correction-audited. | Financial auditability. | No balance-changing operation lacks ledger/evidence. | Draft / partially verified by repo architecture | Partner wallet services | Ledger service tests |
| MEGS-WALLET-002 | Credit reservations, consumption, release, expiry, and adjustment must be idempotent and auditable. | Prevent double-spend and lost credits. | Idempotency and event records exist for each lifecycle action. | Roadmap / G6D unresolved | Partner credit services | Idempotency/concurrency tests |
| MEGS-PARTNER-001 | Partner data access must be tenant-isolated and fail closed. | Partner trust and legal safety. | RLS/runtime tests prove no cross-tenant leakage. | Draft / partially verified by tests | Partner runtime, DB | Tenant isolation tests |
| MEGS-PARTNER-002 | Partner feature flags and emergency controls must fail closed. | Safe launch control. | Missing or errored flag reads deny risky capability. | Draft / repository architecture observed | Partner flags | Flag resolution tests |
| MEGS-PARTNER-003 | Partner Super Admin actions must require reason and audit evidence. | Accountability. | Mutations reject missing reason and write audit/security events. | Draft / partially observed | `/api/super-admin/*` partner routes | Route/service tests |
| MEGS-SHOP-001 | Shop Launch readiness must include onboarding, auth, MFA, feature flags, wallet/credits, submission handoff, certificate-origin, support, emergency stop, and founder approval evidence. | Prevent premature partner launch. | Dashboard shows all launch criteria with evidence or unknown state. | Unknown / Draft placeholder | Partner Network, Project Control | Readiness tests after model exists |
| MEGS-GROAD-001 | Every G5-G20 phase must have scope, requirements, acceptance criteria, tests, migrations, reviews, and gates. | Prevent roadmap drift. | Phase cannot begin until documented and approved. | Unknown / Draft placeholder | Partner roadmap | Documentation review |

---

## 10. Project Control Dashboard Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-PCD-001 | Project Control Dashboard must be evidence-based and never infer completion. | Founder requirement. | Completion states derive from requirement evidence only. | Draft | Dashboard, readiness engine | Readiness tests |
| MEGS-PCD-002 | Dashboard must show repository, production, database, test, CI, review, decision, stale, contradiction, and unknown evidence. | Full governance view. | Each evidence class is visible and filterable. | Draft | Dashboard UI/API | API and UI tests |
| MEGS-PCD-003 | Dashboard must support drill-down pages for requirement, phase, evidence, and risk. | Make status auditable. | Drill-down links show source evidence and related requirements. | Draft | Dashboard UI | UI/source tests |
| MEGS-PCD-004 | Next-task recommendations must be evidence-based. | Avoid arbitrary prioritization. | Recommendation lists unmet gates and evidence gaps. | Draft | Recommendation engine | Recommendation tests |
| MEGS-PCD-005 | Continuation prompts must include current state, evidence, gates, unknowns, and forbidden actions. | Safe AI handover. | Generated prompt includes required fields and requirement IDs. | Draft | Prompt generator | Prompt snapshot tests |

---

## 11. Vault Quest Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| VQ-CORE-001 | Vault Quest rules must have a versioned source and explicit playtest/final status. | Avoid print/game drift. | Rules output shows version and status. | Draft / existing docs require reconciliation | VQ rules | Rules tests/document review |
| VQ-WORLD-001 | World Bible changes affecting public brand or print assets require founder approval. | Protect brand identity. | Decision log records approval before release. | Draft | World Bible, assets | Review checklist |
| VQ-CREATURE-001 | Creature identity must preserve approved family/stage continuity. | Prevent AI identity drift. | Candidate approval requires identity evidence. | Draft | AI Studio, asset pipeline | Identity guard tests where feasible |
| VQ-CARD-001 | Card template geometry must not change without founder approval and render QA. | Print safety. | Coordinate/template hash or equivalent evidence is recorded. | Draft | Render engine | Render/geometry tests |
| VQ-STUDIO-001 | AI Studio must check feature, spend, provider, and identity gates before paid generation. | Prevent uncontrolled cost and bad assets. | Tests prove gates run before provider calls. | Draft | VQ AI Studio | Spend/provider tests |
| VQ-ASSET-001 | VQ assets must be revisioned or auditably promoted. | Preserve art history. | Candidate, approved, replaced, and manual-upload states are traceable. | Draft | R2, asset tables | Asset lifecycle tests |
| VQ-DB-001 | VQ database changes must stay isolated to `vq_*` and approved migration discipline. | Protect MintVault core database. | Migration/config evidence proves isolation. | Verified architecture / Draft requirement | VQ migrations | Migration safety tests |
| VQ-REL-001 | VQ release requires rules, legal, print, asset, DB, provider, testing, and founder evidence. | Prevent premature commercial release. | Release checklist complete with evidence. | Draft | VQ release process | Release review |

---

## 12. AI Operations Requirements

| ID | Description | Rationale | Acceptance Criteria | Status | Related Components | Tests Required |
|---|---|---|---|---|---|---|
| MEGS-AI-001 | AI agents must read governing docs before action. | Prevent context-free changes. | Phase report states docs read. | Draft | AI workflow | Review |
| MEGS-AI-002 | AI-generated claims must be evidence-classified. | Prevent hallucinated status. | Reports classify claims under MEGS evidence categories. | Draft | AI reports | Review |
| MEGS-AI-003 | Parallel AI development must define ownership, branch/worktree, file overlap, and integration order. | Prevent conflicts. | Parallel work plan exists before edits. | Draft | AI operations | Review |
| MEGS-AI-004 | Handover prompts must preserve gates and forbidden actions. | Safe continuation. | Prompt generator includes gates and disallowed operations. | Draft | Prompt generator | Snapshot tests |
| MEGS-AI-005 | Terra's role must be defined before Terra output can support gated decisions. | Avoid undefined authority. | Decision log has locked Terra role. | Unknown | AI operations | Founder review |

---

## 13. v1.1 Normalized Requirement Additions

These rows add the 35 founder-requirement groups identified by the MEGS v1.0 review. They are canonical requirement IDs for future work. Evidence classification and lifecycle state are intentionally separate.

| ID | Description | Rationale | Acceptance Criteria | Evidence Classification | Lifecycle State | Related Components | Tests Required |
|---|---|---|---|---|---|---|---|
| MEGS-ORIGIN-001 | Preserve immutable physical grader and origin snapshot at grading time. | Historical certificate trust must not depend on mutable partner records. | Certificate/grading record stores origin type, physical grader, approved display name, and approved location snapshot. | Locked Founder Requirement | not started | Certificates, grading, Partner Network | Schema, mutation, rendering, correction tests |
| MEGS-ORIGIN-002 | Render partner/HQ certificate origin using approved wording and location snapshot. | Public certificate provenance must be accurate. | Partner certificates show `Graded by [Shop Name]` plus snapshot location; HQ certificates show `Graded by MintVault Headquarters`. | Locked Founder Requirement | not started | Certificates, public verification, grading reports | Render and public-route tests |
| MEGS-ORIGIN-003 | Route corrections and rectifications by immutable origin snapshot. | Prevent unauthorized or misrouted certificate changes. | Correction policy reads the original snapshot and rejects unsupported role/routing cases. | Locked Founder Requirement | blocked | Correction mode, Partner Network | Authz and correction-routing tests |
| MEGS-WALLET-003 | One partner credit equals one card grading entitlement and cannot be double consumed. | Prevent double spend and accounting drift. | Reserve/consume/release paths enforce one entitlement per card with idempotency. | Locked Founder Requirement | in progress | Partner wallet, submissions | Ledger lifecycle, idempotency, concurrency tests |
| MEGS-WALLET-004 | Preserve the working GBP20 customer price, GBP15 MintVault entitlement cost, GBP5 shop margin model. | Commercial reporting and Stripe packages need a baseline. | Model is documented with open VAT/refund/promotion/chargeback/effective-date boundaries. | Locked Founder Requirement | proposed | Wallet, Stripe, reporting | Commercial config and accounting review |
| MEGS-WALLET-005 | Stripe packages and credit fulfilment must be idempotent and auditable. | Prevent duplicate credit grants and money mismatches. | Fulfilment records Stripe event IDs, package, actor/source, idempotency, ledger entry, and reconciliation status. | Locked Founder Requirement | not started | Stripe, Partner wallet | Webhook, idempotency, retry tests |
| MEGS-PARTNER-004 | Partner users may access only their own shop data and access must be revocable. | Tenant isolation and operational safety. | Sessions/RLS/RBAC prevent cross-shop reads and revoked access fails closed. | Locked Founder Requirement | implemented | Partner Portal, auth, RLS | Tenant isolation and revocation tests |
| MEGS-PARTNER-005 | Approved-device policy must be founder-defined before enforcement. | Device hints can become weak security if not governed. | Enrolment, attestation/evidence, revocation, recovery, and audit policy exists before code enforcement. | Locked Founder Requirement | blocked | Partner auth, scanner | Policy review and device tests after design |
| MEGS-PARTNER-006 | Three-strike programme must define technical events, consequences, appeal, reset, and override rules. | Avoid arbitrary partner suspension. | Strike model is documented and mapped to auditable events before implementation. | Locked Founder Requirement | blocked | Partner governance | Policy and workflow tests after design |
| MEGS-PARTNER-007 | Reuse existing MintVault core grading, admin, certificate, and label systems unless review proves unsafe. | Avoid duplication and preserve core trust flows. | Architecture review records reuse decision and any exceptions. | Locked Founder Requirement | proposed | Partner Network, grading, certificates | Integration review |
| MEGS-PARTNER-008 | Partner access must include secure invitations, sessions, MFA, and granular RBAC. | Safe partner onboarding. | Invitation lifecycle and role grants are auditable and fail closed. | Locked Founder Requirement | in progress | Partner Portal, auth | Invitation, MFA, RBAC tests |
| MEGS-SHOP-002 | Preserve the exact ten-step G5-to-pilot Shop Launch sequence. | Prevent roadmap drift. | Project Control tracks all ten steps with evidence-based lifecycle state. | Locked Founder Requirement | proposed | Partner Network, Project Control | Readiness and roadmap tests |
| MEGS-GROAD-002 | Preserve the wider G5-G20 programme backlog without inventing unknown details. | Keep long-term roadmap intact. | Unknown later phases remain backlog items until founder-approved scope exists. | Locked Founder Requirement | proposed | Roadmap, Project Control | Governance review |
| MEGS-PCD-006 | Protect Project Control with fail-closed `super_admin_project_control_enabled` flag. | High-risk governance evidence must not be broadly exposed. | Missing, false, unreadable, or errored flag state denies access. | Locked Founder Requirement | not started | Super Admin, feature flags | Authz and flag tests |
| MEGS-PCD-007 | Project Control must be read-only and perform no uncontrolled writes. | Prevent dashboard from becoming an operational mutation surface. | Dashboard/API cannot deploy, write repository state, apply migrations, mutate production data, or change operational state. | Locked Founder Requirement | not started | Project Control API/UI | Route negative tests |
| MEGS-PCD-008 | Project Control must distinguish implementation, testing, review, deployment, and production verification states. | Readiness must reflect lifecycle reality. | Status engine emits normalized lifecycle states and never collapses unknown into complete. | Locked Founder Requirement | not started | Status engine | State calculation tests |
| MEGS-PCD-009 | Project Control evidence must include timestamp, provenance, freshness, and confidence impact. | Stale evidence must lower confidence. | Evidence records include source, timestamp, locator, requirements, stale state, and confidence contribution. | Locked Founder Requirement | not started | Evidence model, readiness engine | Freshness/confidence tests |
| MEGS-PCD-010 | Continuation prompts must be generated from frozen evidence snapshots. | Safe AI handover requires stable facts. | Snapshot generator records source evidence and generated text immutably for the review period. | Locked Founder Requirement | not started | Prompt generator | Snapshot tests |
| VQ-CARD-002 | Preserve current full-scene portrait geometry and layout direction. | Print output and art templates need explicit dimensions. | 69 x 94 mm bleed, 63 x 88 mm trim, approximately 60 x 85 mm safe area, square corners, and required zones are documented; conflict remains blocked. | Locked Founder Requirement | blocked | VQ card renderer | Geometry/render QA after reconciliation |
| VQ-CORE-002 | Preserve Playtest Set 001 as 90 cards with 54 creatures, 18 tactics, 12 relics, and 6 vaults. | Set seeding and card numbering depend on cardinality. | Canonical set record exists or contradiction remains blocked. | Locked Founder Requirement | blocked | VQ database, rules | Seed/count tests after decision |
| VQ-CREATURE-002 | Preserve twelve three-stage families and supplied locked examples. | Creature identity and evolution continuity. | Family registry records the twelve families and classifies legacy names. | Locked Founder Requirement | blocked | VQ world, assets | Registry and identity tests |
| VQ-CORE-003 | Preserve Rules v0.1 values and Vault Seal terminology. | Battle engine and cards need a rules source. | Rules source states deck, hand, copy, element, Seal, Core, turn, and Vault Seal values. | Locked Founder Requirement | proposed | VQ rules | Rules tests |
| VQ-STUDIO-002 | Protect approved masters and approved artwork from overwrite by later generation. | Prevent AI identity drift and asset loss. | Candidate, approval, replacement, and manual-promotion flows preserve prior approved assets. | Locked Founder Requirement | implemented | VQ AI Studio, assets | Asset lifecycle tests |
| VQ-STUDIO-003 | Paid generation must preserve provider job ID, idempotency, integrity validation, and fail-closed gates. | Spend evidence and asset integrity. | Provider calls are blocked until flags/provider verification pass and job IDs are stored. | Locked Founder Requirement | implemented | VQ provider, generation jobs | Provider, idempotency, integrity tests |
| VQ-STUDIO-004 | Separate Higgsfield subscription and Cloud API credit paths where implemented. | Prevent false usage aggregation. | Each provider-credit source has distinct labels, usage evidence, verification, and reconciliation boundary. | Locked Founder Requirement | blocked | VQ provider registry | Provider architecture tests |
| VQ-REL-002 | UE5 proof of concept is roadmap only. | Avoid false completion claims. | UE5 appears only as roadmap unless future evidence proves implementation. | Future Roadmap | proposed | Vault Quest roadmap | Release review |
| MEGS-AI-006 | Each engineering task declares recommended model and effort when provided. | Execution context is governance evidence. | Handover/report includes requested and actual model/effort. | Locked Founder Requirement | proposed | AI operations | Review |
| MEGS-AI-007 | Use GPT-5.5 Medium for ordinary coding, GPT-5.5 High for large/complex work, Terra Extra High for broad review, and Claude Opus High for independent review where available. | Match risk to reasoning effort. | Reports record model allocation and any unavailable model substitution. | Locked Founder Requirement | proposed | AI operations | Review |
| MEGS-AI-008 | Sol is excluded from repository, filesystem, credentials, deployment, and engineering access. | Protect sensitive engineering surfaces. | No Sol role appears in engineering access plan. | Locked Founder Requirement | proposed | AI operations, access control | Review |
| MEGS-AI-009 | Controlled three-to-five isolated sessions may begin only after G6D is resolved. | Avoid collision before migration-bearing work is settled. | Each session has branch/worktree, file boundary, migration plan, and integration owner. | Locked Founder Requirement | blocked | AI operations, worktrees | Integration review |
| MEGS-AI-010 | Coding-agent prompts must be supplied as one uninterrupted copy-and-paste block. | Preserve governance context and reduce prompt drift. | Prompt templates are generated as a single block with gates and requirement IDs. | Locked Founder Requirement | proposed | Prompt generator | Snapshot tests |
| MEGS-SCAN-001 | Scanner programme must define card purpose, dimensions, image standard, and output format. | Hardware must meet grading-image needs. | Approximately 63 x 88 mm cards, 1200-DPI-equivalent detail, TIFF/uncompressed PNG preference, and front/back workflow are documented. | Locked Founder Requirement | proposed | Scanner programme | Acceptance protocol |
| MEGS-SCAN-002 | Scanner hardware must prove optical resolution and controllable capture. | Avoid interpolation or marketing-only claims. | At least 20 MP, preferably 24 MP, full-resolution still capture, controlled hood/jig, and focus/exposure/WB/lighting/output controls where hardware permits. | Locked Founder Requirement | not started | Scanner hardware | Optical and control tests |
| MEGS-SCAN-003 | Scanner workflow is USB scanner to Mac app to watched folder to uploader linkage. | Preserve current ingestion architecture while validating it. | Captured front/back files are linked to the correct submission and device/operator evidence. | Locked Founder Requirement | implemented | Scanner app/watcher/uploader | Workflow linkage tests |
| MEGS-SCAN-004 | No scanner is approved without one documented test-unit validation. | Prevent premature rollout. | Test unit passes optical, workflow, security, and failure-recovery criteria before wider deployment. | Locked Founder Requirement | not started | Scanner programme | Test-unit acceptance review |
