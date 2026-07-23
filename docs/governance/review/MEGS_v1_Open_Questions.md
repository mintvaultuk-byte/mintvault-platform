# MEGS v1.0 Open Questions

**Review date:** 2026-07-22  
**Status:** Questions only. No answer in this document changes a founder requirement or authorises implementation.

## Blocking Before Adoption

| ID | Question | Evidence class | Why it blocks adoption | Required decider |
|---|---|---|---|---|
| MEGS-OQ-ADOPT-001 | Does the latest 90-card/12-family direction supersede the 150-card/18-line direction in `VAULT_QUEST_MASTER_SPEC_v1.0.md`, and which document becomes the product-source record? | Contradiction | MEGS cannot be canonical while its subordinate product source conflicts with it. | Founder |
| MEGS-OQ-ADOPT-002 | Is strict Vault Quest isolation from users/auth a founder-locked rule, or a proposed engineering boundary that permits selected MintVault ecosystem integration? | Inferred | The Decision Log currently overstates its evidence. | Founder |
| MEGS-OQ-ADOPT-003 | Do locked Decision Log entries override a domain governance document when the two differ, and what is the required evidence to create a locked entry? | Ambiguous | The document hierarchy is incomplete. | Founder |
| MEGS-OQ-ADOPT-004 | Is the proposed evidence/lifecycle split acceptable: one classification plus one state, rather than mixed labels such as `Verified mechanism / Draft requirement`? | Proposed | Project Control and reporting cannot calculate readiness reliably without this. | Founder |

## Blocking Before Implementation

| ID | Question | Evidence class | Affected work | Required decider |
|---|---|---|---|---|
| MEGS-OQ-IMPL-001 | What exact immutable fields represent physical grader, grading organisation/HQ, display name, approved grading location, and routing policy? | Locked Founder Requirement | Partner certificate origin, correction, NFC, submissions | Founder |
| MEGS-OQ-IMPL-002 | Should G6D be repaired, merged, superseded, or abandoned? Its branch is unmerged and introduces migration `0019_partner_submission_credit_lifecycle.sql`. | Proven from repository | Submission-credit integration | Founder and engineering lead |
| MEGS-OQ-IMPL-003 | Are Partner Portal API routes intentionally unmounted in `origin/main`; if not, what approved phase and route composition will mount them? | Proven from repository | Partner Portal and Shop Launch | Founder and engineering lead |
| MEGS-OQ-IMPL-004 | What is the canonical Admin/Super Admin privilege boundary for partner controls already mounted under `/api/super-admin/*`? | Proven from repository | Authorization, audit, UI labels | Founder |
| MEGS-OQ-IMPL-005 | What rules surround the GBP20 customer price, GBP15 MintVault entitlement, and GBP5 shop margin: VAT, refunds, promotions, chargebacks, per-location changes, and effective dates? | Locked Founder Requirement | Wallet, Stripe, reporting | Founder |
| MEGS-OQ-IMPL-006 | What evidence sources, freshness threshold, and immutable snapshot format govern Project Control readiness and continuation prompts? | Locked Founder Requirement | Project Control Dashboard | Founder |

## Can Be Deferred

| ID | Question | Evidence class | Deferral condition |
|---|---|---|---|
| MEGS-OQ-DEFER-001 | What is the UE5 proof-of-concept scope, success measure, and relationship to the card game? | Future Roadmap | Defer until Vault Quest core/playtest work is approved. |
| MEGS-OQ-DEFER-002 | What are detailed G7-G20 scopes and acceptance gates? | Future Roadmap | Preserve as backlog; do not invent details before those phases are selected. |
| MEGS-OQ-DEFER-003 | Which scanner vendor/model is preferred after objective acceptance tests exist? | Open Question | Defer procurement selection, not creation of the acceptance protocol. |
| MEGS-OQ-DEFER-004 | What is Terra's specific role, input contract, and review authority? | Open Question | Terra cannot support gated decisions until resolved. |

## Repository Questions

| ID | Question | Evidence class |
|---|---|---|
| MEGS-OQ-REPO-001 | Which deployment/runtime, if any, mounts the `createPartnerApp()` factory not mounted in the inspected `origin/main` composition? | Proven from repository |
| MEGS-OQ-REPO-002 | Which database target did the prior Phase 0 local environment represent, and what is the current migration head on each approved environment? | Reported but not independently verified in this review |
| MEGS-OQ-REPO-003 | Is the VQ feature-flag constraint state reported in Phase 0 still behind `migrations-vq/0015_feature_flags_generation_types.sql`? | Stale evidence |
| MEGS-OQ-REPO-004 | Which committed test suite proves certificate-origin rendering and correction routing once those requirements exist? | Unknown |

## Product and Commercial Questions

| ID | Question | Evidence class |
|---|---|---|
| MEGS-OQ-PROD-001 | Is the GBP20 / GBP15 / GBP5 commercial model inclusive or exclusive of VAT, payment costs, discounts, refunds, and partner variation? | Locked Founder Requirement |
| MEGS-OQ-PROD-002 | What exactly constitutes one grading entitlement when a card is cancelled, resubmitted, corrected, or transferred? | Locked Founder Requirement |
| MEGS-OQ-PROD-003 | Which certificate corrections can be performed by each role after partner-origin grading? | Locked Founder Requirement |

## Vault Quest Questions

| ID | Question | Evidence class |
|---|---|---|
| MEGS-OQ-VQ-001 | Which set cardinality/family model is canonical for Playtest Set 001: founder 90/12 or master-spec 150/18? | Contradiction |
| MEGS-OQ-VQ-002 | Is the canonical safe area approximately 60 x 85 mm or 57 x 82 mm, and does that require a new coordinate-map hash? | Contradiction |
| MEGS-OQ-VQ-003 | Which exact twelve families are locked beyond the six supplied examples, and how are any legacy names classified? | Open Question |
| MEGS-OQ-VQ-004 | What is the formal Cloud API path, what signals provider verification, and which provider/credit source may be charged? | Locked Founder Requirement |

## Partner Network Questions

| ID | Question | Evidence class |
|---|---|---|
| MEGS-OQ-PN-001 | How is a shop's approved device enrolled, attested, revoked, and recovered without turning a browser/device hint into a weak security control? | Locked Founder Requirement |
| MEGS-OQ-PN-002 | What events create a strike, what is the strike window, who may review/appeal it, and what is the disposition after strike three? | Locked Founder Requirement |
| MEGS-OQ-PN-003 | Is the incomplete/unmounted portal intentional during the stated Shop Launch sequence, and what is the minimum usable portal for the pilot? | Proven from repository / Locked Founder Requirement |

## Project Control Questions

| ID | Question | Evidence class |
|---|---|---|
| MEGS-OQ-PCD-001 | How is `super_admin_project_control_enabled` sourced, cached, audited, and made fail-closed? | Locked Founder Requirement |
| MEGS-OQ-PCD-002 | Which actions, if any, are ever permitted from a read-only dashboard, and how are links to external operational tools distinguished from repository/deployment writes? | Locked Founder Requirement |
| MEGS-OQ-PCD-003 | What exact freshness thresholds lower confidence, and who may certify or supersede evidence? | Locked Founder Requirement |

## Scanner Questions

| ID | Question | Evidence class |
|---|---|---|
| MEGS-OQ-SCAN-001 | Which measurable optical test proves 1200-DPI-equivalent detail and approximately 2976 x 4157 real card pixels, excluding video extraction/upscaling? | Locked Founder Requirement |
| MEGS-OQ-SCAN-002 | What hardware/interface capability is mandatory for focus, exposure, white balance, lighting, output path/naming, and device identity? | Locked Founder Requirement |
| MEGS-OQ-SCAN-003 | What test-unit acceptance record, operator workflow, and failure/rollback criteria are required before any wider shop deployment? | Locked Founder Requirement |

## Founder Decision Count

There are **10 founder decisions required** before adoption or the affected implementation can proceed: the four adoption decisions and six implementation decisions above. Deferred questions are deliberately excluded from that count.
