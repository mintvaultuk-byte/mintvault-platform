# MEGS v1.0 Proposed Amendments

**Purpose:** These are proposed v1.1 documentation changes. They do not amend the six MEGS v1.0 baseline documents until founder approval.  
**Review date:** 2026-07-22

## Amendment MEGS-AMD-001

| Field | Proposed amendment |
|---|---|
| Target file | `01_Engineering_Constitution.md` |
| Target section | 8.1 Evidence Categories and new 8.3 Lifecycle States |
| Existing wording or gap | The evidence-category list is useful, but the matrix mixes evidence classification and lifecycle status in one field. |
| Proposed wording | `Every material claim must record exactly one evidence classification: Locked Founder Requirement, Proven from repository, Proven from production, Proven from database, Proven by tests, Proven by human review, Reported but Unverified, Assumption, Future Roadmap, Open Question, Stale Evidence, Contradiction, or Superseded Decision. Each requirement and phase must separately record exactly one lifecycle state: not started, proposed, in progress, implemented, test evidence missing, tests failing, review pending, review failed, review passed, deployment pending, deployed, production verification pending, production verified, blocked, stale, unknown, or superseded. Evidence classification never implies lifecycle completion.` |
| Reason | Prevents false readiness and satisfies the required state separation. |
| Requirement IDs affected | MEGS-GOV-003, MEGS-EVID-001, MEGS-EVID-002, MEGS-EVID-004, MEGS-PCD-008 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-002

| Field | Proposed amendment |
|---|---|
| Target file | `01_Engineering_Constitution.md` |
| Target section | 10 Document Hierarchy |
| Existing wording or gap | Locked Decision Log entries are ranked below domain documents without defining their authority. |
| Proposed wording | `A Founder Decision Log entry has authority only when its status is Locked Decision and it includes direct founder approval evidence. A Locked Decision overrides a conflicting domain-governance statement. A Historical Decision, repository fact, reported statement, or agent conclusion does not create founder authority. Every conflict must be entered in the Contradiction Register before implementation proceeds in the affected area.` |
| Reason | Resolves the Decision Log authority ambiguity. |
| Requirement IDs affected | MEGS-GOV-004, MEGS-DEC-LOCK-007 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-003

| Field | Proposed amendment |
|---|---|
| Target file | `02_MintVault_Platform_Governance.md` |
| Target section | 3 Business Rules; new 6.3 Partner Grading Origin |
| Existing wording or gap | Certificate origin is only described as traceable; the founder requirements are absent. |
| Proposed wording | `Every grading and certificate record must preserve an immutable origin snapshot at the time of grading. The snapshot must identify the physical grading actor, origin type, approved display name, and approved grading location. A partner-graded certificate must display “Graded by [Shop Name]” together with the snapshot grading location. A headquarters-graded certificate must display “Graded by MintVault Headquarters.” Later edits to a partner name, account, or address must not rewrite historical certificates. Correction and rectification routing must use the original snapshot and applicable governance rules; origin must never be reconstructed solely from a mutable partner account.` |
| Reason | This is a Shop Launch trust and historical-integrity requirement. |
| Requirement IDs affected | MEGS-ORIGIN-001, MEGS-ORIGIN-002, MEGS-ORIGIN-003, MEGS-CERT-001, MEGS-CERT-002, MEGS-NFC-001 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-004

| Field | Proposed amendment |
|---|---|
| Target file | `02_MintVault_Platform_Governance.md` |
| Target section | 8 Wallet & Credits |
| Existing wording or gap | Generic ledger rules omit the explicit entitlement invariant and working commercial model. |
| Proposed wording | `One partner credit represents one card grading entitlement. A single card must not consume more than one entitlement. Ledger entries are immutable and append-only; balance is derived from ledger entries and is never directly overwritten. Reserve, consume, and release operations must be idempotent. Administrative adjustments require a reason, actor, timestamp, correlation or idempotency evidence, and audit record. The current working commercial model is customer price GBP20, MintVault entitlement cost GBP15, and shop margin GBP5 unless replaced by a later Locked Decision. Before Stripe packages are implemented, the founder must define VAT, refunds, promotions, chargebacks, effective dates, and any per-location variation.` |
| Reason | Makes financial invariants and commercial assumptions explicit. |
| Requirement IDs affected | MEGS-WALLET-001, MEGS-WALLET-002, MEGS-WALLET-003, MEGS-WALLET-004, MEGS-WALLET-005 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-005

| Field | Proposed amendment |
|---|---|
| Target file | `02_MintVault_Platform_Governance.md` |
| Target section | 9 Partner Network |
| Existing wording or gap | Tenant isolation is stated generally; partner revocation, device, three-strike, reuse, and invitation requirements are missing. |
| Proposed wording | `Partner users may view and operate only their own shop’s cards, submissions, credits, and operational data. Access must be revocable and tenant-isolated. Minimum partner access must include secure invitations, authenticated sessions, MFA, and granular RBAC. An approved-device restriction, including an authorised MacBook or device identity where selected, is a founder-governed policy and must define enrolment, evidence, revocation, recovery, and audit before implementation. The three-strike concept remains programme policy until its events, consequences, appeal process, and reset rules are technically specified. Existing MintVault grading, admin, certificate, and label systems must be reused unless a documented architecture review proves reuse unsafe or materially insufficient.` |
| Reason | Converts founder direction into testable Partner Network governance. |
| Requirement IDs affected | MEGS-PARTNER-004, MEGS-PARTNER-005, MEGS-PARTNER-006, MEGS-PARTNER-007, MEGS-PARTNER-008 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-006

| Field | Proposed amendment |
|---|---|
| Target file | `02_MintVault_Platform_Governance.md` |
| Target section | 10 Shop Launch Programme and 11 G5-G20 Roadmap |
| Existing wording or gap | The baseline says the sequence is unknown. The latest founder direction supplies it. |
| Proposed wording | `The preserved Shop Launch sequence is: (1) finish and deploy G5 Partner Management; (2) build G6A wallet schema and immutable append-only credit ledger; (3) build G6B reserve, consume, and release one credit per card; (4) build G6C admin credit management and adjustments; (5) build G6D connection to existing submission and grading workflow; (6) build minimum secure partner authentication, invitations, and RBAC; (7) build the basic Partner Portal; (8) add Stripe credit packages and idempotent credit fulfilment; (9) pilot with one or two shops; (10) fix pilot issues and open access to more shops. The wider G5-G20 programme remains a preserved long-term backlog and is not cancelled. A phase may be described only by evidence-based lifecycle state; its existence in a branch, worktree, or migration is not completion evidence.` |
| Reason | Removes a stale placeholder without inventing G7-G20 detail. |
| Requirement IDs affected | MEGS-SHOP-001, MEGS-SHOP-002, MEGS-GROAD-001, MEGS-GROAD-002, MEGS-WALLET-005 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-007

| Field | Proposed amendment |
|---|---|
| Target file | `02_MintVault_Platform_Governance.md` |
| Target section | 12 Project Control Dashboard |
| Existing wording or gap | Evidence-based intent exists, but mandatory access, state, freshness, and snapshot rules are absent. |
| Proposed wording | `Project Control belongs inside the existing Super Admin area and must initially be read-only. It must be protected by the fail-closed feature flag super_admin_project_control_enabled: absent, false, unreadable, or errored flag state denies access. It must distinguish implementation, testing, review, deployment, and production verification. It must retain separate states for unknown, not started, blocked, failed, and complete, and use the MEGS lifecycle vocabulary. Every percentage, recommendation, and completion state must link to timestamped evidence and its provenance. Stale evidence must reduce displayed confidence or readiness rather than silently remaining current. The dashboard must not perform deployment, repository-write, database-write, or operational mutation actions. Continuation prompts must be generated from frozen evidence snapshots and must not silently change while work is in progress.` |
| Reason | Captures the full founder control boundary. |
| Requirement IDs affected | MEGS-PCD-001 through MEGS-PCD-010, MEGS-EVID-001 through MEGS-EVID-004 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-008

| Field | Proposed amendment |
|---|---|
| Target file | `02_MintVault_Platform_Governance.md` |
| Target section | New 16 Scanner Programme |
| Existing wording or gap | Scanner governance is absent. Existing watcher/app documents prove a software ingestion path only. |
| Proposed wording | `The scanner programme exists to capture standard approximately 63 x 88 mm trading cards quickly and professionally. The active target is genuine 1200-DPI-equivalent detail: at least 20 MP camera capability, preferably 24 MP, with full-resolution still capture rather than video-frame extraction or software upscaling, and approximately 2976 x 4157 real card pixels. Hardware must provide an enclosed hood or controlled environment and a repeatable square-card physical jig. Software must be developer-accessible and Mac-compatible through a macOS SDK/API, UVC, command-line capture, or complete technical documentation and sample code. Where hardware permits, MintVault must control focus, exposure, white balance, lighting, capture, output, save path, naming, and device identity. Preferred output is TIFF or uncompressed PNG. Intended workflow is USB scanner to MintVault Mac scanner app to front/back capture to watched folder to uploader linkage with the correct submission. SilverFast is optional. No scanner is approved merely from megapixel marketing; one test unit must pass documented optical, workflow, security, and failure-recovery validation before wider deployment.` |
| Reason | Separates hardware acceptance from the existing watcher implementation. |
| Requirement IDs affected | MEGS-SCAN-001, MEGS-SCAN-002, MEGS-SCAN-003, MEGS-SCAN-004 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-009

| Field | Proposed amendment |
|---|---|
| Target file | `03_VaultQuest_Governance.md` |
| Target section | 5 Card Rules and 6 Battle Engine |
| Existing wording or gap | Exact print geometry, layout, Playtest Set 001 composition, family examples, and Rules v0.1 are absent. |
| Proposed wording | `For the current founder-preserved Playtest Set 001 direction, Vault Quest uses full-scene portrait cards with 69 x 94 mm bleed, 63 x 88 mm trim, an approximately 60 x 85 mm central safe content area, approximately 3 mm border, and square corners. Required layout includes top-left stage, top-centre name, top-right Health, lower-left vulnerability/Guard/Shift, lower-right attacks, flavour text, GENESIS VAULT banner, and metadata strip. Playtest Set 001 remains planned as 90 cards: 54 creatures, 18 tactics, 12 relics, and 6 vaults. Twelve three-stage creature families remain preserved. Locked examples include Flammi to Flammro to Flamora; Aquabub to Aquanix to Aquadon; Leafee to Leafflora to Floraven; Zappi to Zapstorm to Zaptor; Mosskit to Mossmire to Mossgloom; and Frosty to Frostra to Frostorn. Rules v0.1 is 40-card deck, opening hand 5, maximum 4 copies, maximum 2 elements, 5 Seals to win, Core cap 10, Ready then Draw then Core then Action then End, and capture device named Vault Seal. This direction requires founder reconciliation against any conflicting existing VQ specification before print, seed, or release work.` |
| Reason | Makes the latest founder direction explicit without silently resolving repository conflicts. |
| Requirement IDs affected | VQ-CARD-002, VQ-CORE-002, VQ-CREATURE-002, VQ-CORE-003 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-010

| Field | Proposed amendment |
|---|---|
| Target file | `03_VaultQuest_Governance.md` |
| Target section | 7 AI Studio through 10 Asset Pipeline |
| Existing wording or gap | Identity and asset controls are generic; required approved-master and provider evidence rules are incomplete. |
| Proposed wording | `Vault Quest must maintain Character Bible, Family Registry, evolution continuity, action references, and pose diversity as governed identity inputs. Approved masters and approved artwork are protected: later generation must not overwrite them. Candidate generation, approval, replacement, and manual promotion must be traceable. Paid generation must propagate the provider job ID, preserve idempotency, perform integrity validation, and fail closed when provider verification or feature flags are not satisfied. The action/master workflow should remove unnecessary manual steps only where the identity, approval, audit, and spend controls remain intact.` |
| Reason | Adds the operational safeguards the baseline only summarizes. |
| Requirement IDs affected | VQ-CREATURE-001, VQ-STUDIO-001, VQ-STUDIO-002, VQ-STUDIO-003, VQ-ASSET-001 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-011

| Field | Proposed amendment |
|---|---|
| Target file | `03_VaultQuest_Governance.md` |
| Target section | 7 AI Studio, 12 APIs, and 15 Release Process |
| Existing wording or gap | Provider paths, credit sources, and UE5 roadmap classification are absent. |
| Proposed wording | `Higgsfield subscription and Cloud API paths must remain separately labelled and separately auditable. Subscription credits are the preferred default path unless the founder changes that decision. Where two provider-credit sources are implemented, each must expose its own credit source, usage evidence, provider job ID, verification state, and reconciliation boundary; credits and usage evidence must never be falsely combined. The future Unreal Engine 5 proof-of-concept is roadmap only and must not be represented as production-complete.` |
| Reason | Prevents false spend evidence and false release claims. |
| Requirement IDs affected | VQ-STUDIO-004, VQ-REL-002, VQ-REL-001 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-012

| Field | Proposed amendment |
|---|---|
| Target file | `04_AI_Operations_Manual.md` |
| Target section | New 2.3 Model and Effort Declaration; 5 Parallel Development; 7 Prompt Standards |
| Existing wording or gap | The manual mentions GPT-5.5, Claude, and Terra but omits the requested allocation, Sol boundary, controlled-session trigger, and prompt block rule. |
| Proposed wording | `Every engineering task must state a recommended model and effort level. GPT-5.5 Codex Medium is the default for most coding, bug fixes, tests, CI fixes, pull requests, and staging work. GPT-5.5 Codex High is preferred for large features and complex refactors. High-reasoning models such as Terra Extra High may support broad reconciliation, architecture, governance, and difficult cross-system review. Claude Opus High may provide independent architecture, security, and release reviews. Sol is excluded from MintVault repository, filesystem, credentials, deployment, and engineering access. After G6D is resolved, controlled parallel development may use approximately three to five isolated sessions only when every session has its own worktree and branch, responsibility and file boundaries do not overlap, migration numbers and central-file collisions are prevented, unexpected changes stop the session, and integration review occurs before merge. Coding-agent prompts must be supplied as one uninterrupted copy-and-paste block.` |
| Reason | Converts the founder’s AI operating policy into a durable engineering rule. |
| Requirement IDs affected | MEGS-AI-001 through MEGS-AI-010 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-013

| Field | Proposed amendment |
|---|---|
| Target file | `05_Founder_Decision_Log.md` |
| Target section | Locked Decisions, Superseded Decisions, and Open Questions |
| Existing wording or gap | Several entries lack direct founder evidence or are stale against the latest direction. |
| Proposed wording | `Move MEGS-DEC-LOCK-007 to Proposed Architecture Principle until the founder confirms its exact isolation boundary. Add a superseded entry: “The Shop Launch sequence is unavailable” is superseded by the ten-step sequence in Platform Governance. Add open decisions for certificate-origin data/display/routing, Admin versus Super Admin partner authority, G6D disposition, commercial-model scope, device/three-strike policy, VQ 90/12 versus 150/18 reconciliation, VQ safe-area reconciliation, provider-path/credit separation, and scanner test-unit acceptance. Every new Locked Decision must include the approval date, approving founder, exact decision text, affected requirement IDs, and source record.` |
| Reason | Restores provenance and preserves current founder direction. |
| Requirement IDs affected | MEGS-DEC-LOCK-007, MEGS-DEC-OPEN-001 through MEGS-DEC-OPEN-008, all new requirement IDs |
| Founder approval required | Yes |

## Amendment MEGS-AMD-014

| Field | Proposed amendment |
|---|---|
| Target file | `06_Requirements_Traceability_Matrix.md` |
| Target section | Status Values and new requirement rows |
| Existing wording or gap | The matrix contains 51 rows but no rows for the 35 material founder-requirement groups in this review, and its status field mixes evidence/classification. |
| Proposed wording | `Add the following permanent IDs with Description, Rationale, Acceptance Criteria, Status, Related Components, and Tests Required: MEGS-ORIGIN-001 through MEGS-ORIGIN-003; MEGS-WALLET-003 through MEGS-WALLET-005; MEGS-PARTNER-004 through MEGS-PARTNER-008; MEGS-SHOP-002; MEGS-GROAD-002; MEGS-PCD-006 through MEGS-PCD-010; VQ-CARD-002; VQ-CORE-002 through VQ-CORE-003; VQ-CREATURE-002; VQ-STUDIO-002 through VQ-STUDIO-004; VQ-REL-002; MEGS-AI-006 through MEGS-AI-010; and MEGS-SCAN-001 through MEGS-SCAN-004. Add separate Evidence Classification and Lifecycle State columns using the Constitution vocabulary.` |
| Reason | Gives every current founder requirement durable traceability. |
| Requirement IDs affected | All 35 proposed IDs; MEGS-GOV-003; MEGS-EVID-001 through MEGS-EVID-004 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-015

| Field | Proposed amendment |
|---|---|
| Target file | `02_MintVault_Platform_Governance.md` and `06_Requirements_Traceability_Matrix.md` |
| Target section | Partner Network / Security and MEGS-SEC-001 |
| Existing wording or gap | The source documents call controls Super Admin while `origin/main` partner route modules are `requireAdmin`-gated. |
| Proposed wording | `Until a founder-approved privilege model is recorded, describe the current repository fact precisely: current partner control routers are mounted under /api/super-admin/* and use requireAdmin. Do not describe them as Super Admin-authorised. After the founder decision, replace this statement with the approved authorization contract, route test matrix, audit requirements, and migration/rollout plan if applicable.` |
| Reason | Prevents governance documents from overstating the existing authorization boundary. |
| Requirement IDs affected | MEGS-SEC-001, MEGS-PARTNER-003 |
| Founder approval required | Yes |

## Amendment MEGS-AMD-016

| Field | Proposed amendment |
|---|---|
| Target file | `02_MintVault_Platform_Governance.md` |
| Target section | 9 Partner Network and 10 Shop Launch Programme |
| Existing wording or gap | The baseline treats portal routes as repository facts without distinguishing frontend routes, API factory code, and mounted operational runtime. |
| Proposed wording | `Repository evidence must distinguish client route presence, server factory/source presence, mounted runtime presence, test execution, deployment, and production verification. As of the review, client Partner Portal routes and an isolated server API factory are repository-proven; no mount of createPartnerApp() was found in the inspected origin/main server composition. The operational status of the Partner Portal is therefore Unknown until deployment/runtime evidence is recorded.` |
| Reason | Stops source presence from being misreported as operational completion. |
| Requirement IDs affected | MEGS-PARTNER-001, MEGS-SHOP-001, MEGS-SHOP-002 |
| Founder approval required | No |

## Amendment MEGS-AMD-017

| Field | Proposed amendment |
|---|---|
| Target file | `03_VaultQuest_Governance.md` |
| Target section | 1 Evidence Classification and 15 Release Process |
| Existing wording or gap | The master VQ specification is referenced but there is no explicit reconciliation gate before print, seed, or commercial release. |
| Proposed wording | `Before any Vault Quest print, database seed, public release, provider spend expansion, or commercial claim, reconcile every conflicting product/print rule between the founder-approved MEGS direction and VAULT_QUEST_MASTER_SPEC_v1.0.md. Record each resolved conflict in the Founder Decision Log and Contradiction Register. Until that occurs, the VQ master specification is Reported product input, not independent production-readiness evidence.` |
| Reason | Makes current VQ contradictions an explicit release blocker. |
| Requirement IDs affected | VQ-CORE-001, VQ-CARD-001, VQ-CARD-002, VQ-REL-001, VQ-REL-002 |
| Founder approval required | Yes |

## Adoption Order

1. Founder resolves the decisions identified as blocking before adoption.
2. Apply approved amendments to the six source documents and create a v1.1 change record.
3. Cross-check all 86 reviewed requirement groups against the updated matrix.
4. Re-run the governance review; do not begin implementation as part of that review.
