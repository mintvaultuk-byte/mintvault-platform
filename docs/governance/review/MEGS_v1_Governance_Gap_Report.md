# MEGS v1.0 Governance Gap Report

**Review status:** Complete, documentation-only review  
**Review date:** 2026-07-22  
**Baseline:** The six untracked MEGS v1.0 Markdown files in `docs/governance/`  
**Authority:** This report does not make MEGS canonical. It records the changes required before founder approval.

## Executive Verdict

**NEEDS MAJOR RECTIFICATION**

MEGS v1.0 is a useful governance skeleton and correctly preserves several important controls: founder gates, evidence discipline, migration safety, deployment-versus-verification separation, an append-only wallet direction, and Vault Quest operational guardrails. It is not yet sufficiently complete, internally consistent, or repository-grounded to become the governing source of truth.

The primary reason is coverage. Thirty-five material founder-requirement groups supplied for this review have no explicit, permanent requirement ID in the baseline matrix. The most consequential omissions concern immutable partner grading origin, the exact Shop Launch sequence, Project Control fail-closed/read-only operation, Vault Quest print/game locks, AI operating policy, and the scanner programme. There are also seven material contradictions or architecture conflicts requiring explicit resolution.

**Recommendation:** Do not approve MEGS v1.0 as-is. Approve the set only after the amendments in [MEGS_v1_Proposed_Amendments.md](./MEGS_v1_Proposed_Amendments.md) are incorporated as v1.1 and a targeted re-review confirms the amended traceability matrix and decision log. A rebuild is not required.

## Review Snapshot

| Item | Evidence | Classification |
|---|---|---|
| Current branch | `codex/super-admin-correction-mode` | Proven from repository |
| Current HEAD | `0fedce6e95297bc5662d0f1c3ec377bf3c95073e` | Proven from repository |
| `origin/main` | `12139b6ce14c36381294076b5a9ac6f201ac7b82` | Proven from repository |
| Branch relation | HEAD is seven commits behind `origin/main` | Proven from repository |
| Worktree state | 57 registered worktrees, 13 marked prunable | Proven from repository |
| Baseline tracking state | `docs/governance/` is untracked; it was not made canonical or committed | Proven from repository |
| Production version | `https://mintvault.fly.dev/api/version` reported `e6fd64da` at `2026-07-22T05:32:00.389Z` | Proven from production |
| Staging version | `https://mintvault-v2.fly.dev/api/version` reported `0fedce6e` at `2026-07-22T05:32:00.751Z` | Proven from production |
| Database/migration head | The Phase 0 result reported `0016_partner_wallet_ledger.sql` as applied; this review did not reconnect to the database | Reported but not independently verified in this review |
| G6D | `codex/partner-g6d-submission-credit-integration` is unmerged and contains migration `0019_partner_submission_credit_lifecycle.sql` | Proven from repository |

The working-tree changes present at review start remained unchanged throughout this review. No application files were edited.

## Documents Reviewed

1. [01_Engineering_Constitution.md](../01_Engineering_Constitution.md)
2. [02_MintVault_Platform_Governance.md](../02_MintVault_Platform_Governance.md)
3. [03_VaultQuest_Governance.md](../03_VaultQuest_Governance.md)
4. [04_AI_Operations_Manual.md](../04_AI_Operations_Manual.md)
5. [05_Founder_Decision_Log.md](../05_Founder_Decision_Log.md)
6. [06_Requirements_Traceability_Matrix.md](../06_Requirements_Traceability_Matrix.md)
7. `VAULT_QUEST_MASTER_SPEC_v1.0.md` as a repository specification requiring reconciliation, not as automatically controlling authority.
8. Scanner watcher and scanner-app runbooks as repository documentation requiring reconciliation, not as hardware acceptance evidence.

## Repository Areas Inspected

- Server composition, route registration, authentication, `requireAdmin`, and `requireSuperAdmin`.
- Partner portal factory, Super Admin partner routers, RLS/runtime design, MFA/RBAC, wallet/ledger, reservations, and G6D branch diff.
- Certificate, grader, correction, NFC, label, scanner, submission, and public reporting routes.
- Client Partner Portal routes and Vault Quest studio components.
- Numbered migrations, Vault Quest migrations, migration guards, preflight, and migration runbook.
- CI workflow, package scripts, deploy guard, and live `/api/version` evidence.
- Vault Quest provider catalog, feature-state design, identity/spend/provider tests, and master specification.
- Existing scanner application/watcher documentation and code paths.

## Review Methodology

1. Recorded branch, HEAD, `origin/main`, status, worktrees, and tracking state before analysis.
2. Read all six baseline governance documents completely.
3. Inspected committed `origin/main` for authoritative route and architecture claims; uncommitted work was not used as implementation evidence.
4. Used static source and test inspection only. Application tests, database commands, deployments, and migrations were not run.
5. Read the two live version endpoints only. No production or staging state was changed.
6. Classified material claims as Proven, Reported, Inferred, or Unknown. Repository code proves that a mechanism exists, not that it is complete, deployed, or operationally accepted.

## Missing Founder Requirements

The baseline has **35 missing requirement groups**. They are absent as explicit, traceable requirements even where a related general principle exists.

| Area | Missing groups | Count |
|---|---|---:|
| Partner grading origin | Physical grader and immutable origin snapshot; mandatory partner/HQ certificate wording and location snapshot; origin-based correction routing | 3 |
| Credits and commercial model | One entitlement per card; locked working commercial model of GBP20 / GBP15 / GBP5; Stripe packages and idempotent fulfilment | 3 |
| Partner access and Shop Launch | Own-data/revocation rule; approved-device policy; three-strike policy; reuse-core rule; invitations/RBAC; exact G5-to-pilot sequence; preserved G5-G20 backlog | 7 |
| Project Control Dashboard | Exact fail-closed flag; read-only/no-write boundary; state taxonomy; timestamp/provenance/staleness; frozen continuation snapshots | 5 |
| Vault Quest | Geometry/layout; 90-card composition; 12-family lock/examples; Rules v0.1; approved-master protection/candidate governance; job-ID/idempotency/integrity gates; separated provider-credit paths; UE5 roadmap classification | 8 |
| AI Operations | Per-task model/effort declaration; Medium/High/Terra/Claude allocation; Sol exclusion; controlled 3-5 session policy; uninterrupted coding-prompt rule | 5 |
| Scanner programme | Purpose/card dimensions; optical-resolution requirements; hardware/control integration acceptance; watched-folder workflow and test-unit approval | 4 |

The proposed permanent IDs and exact wording are in [MEGS_v1_Proposed_Amendments.md](./MEGS_v1_Proposed_Amendments.md). The detailed coverage appears in [MEGS_v1_Requirement_Coverage_Report.md](./MEGS_v1_Requirement_Coverage_Report.md).

## Missing Partner Network Requirements

The baseline lacks immutable grading-origin requirements, the exact Shop Launch sequence, the commercial-model record, Stripe fulfilment acceptance, approved-device governance, three-strike technical policy, and invitation acceptance. Existing partner RLS, MFA, RBAC, wallet, and Super Admin-route sources are meaningful implementation evidence, but they do not close these governance gaps.

## Missing Project Control Requirements

The baseline has useful high-level dashboard goals but omits the required fail-closed `super_admin_project_control_enabled` flag, initial read-only boundary, lifecycle vocabulary, freshness/confidence degradation, provenance field set, and frozen continuation snapshots. No Project Control implementation source was found; it must remain `not started`.

## Missing Vault Quest Requirements

The baseline omits the exact card geometry/layout, 90-card composition, 12-family lock, Rules v0.1 values, protected-master rule, provider job-ID propagation, integrity validation, separated provider-credit sources, and UE5 roadmap status. The repository contains sophisticated VQ source and tests, but the current master specification has conflicts that must be resolved before any release claim.

## Missing AI Operations Requirements

The baseline does not preserve per-task model/effort declaration, the GPT-5.5 Medium/High allocation, Terra Extra High and Claude Opus High roles, Sol exclusion, the post-G6D three-to-five-session condition, unexpected-change stop rule, or the one-block coding prompt requirement.

## Missing Scanner Requirements

The baseline has no scanner governance. Existing watcher and Mac scanner-app code prove a related ingestion workflow, while the required hardware quality, device-control, image-format, physical-jig, and test-unit acceptance rules remain undocumented.

## Repository Contradictions

See the complete register in [MEGS_v1_Contradiction_Register.md](./MEGS_v1_Contradiction_Register.md). The highest-impact repository conflicts are:

1. **Proven:** `origin/main` mounts partner routes below `/api/super-admin/*`, but `server/partner/admin-routes.ts`, `connector-admin-routes.ts`, and `partner-management-routes.ts` use `requireAdmin`, not `requireSuperAdmin`. This conflicts with `MEGS-SEC-001`'s stated Super Admin standard.
2. **Proven:** `server/partner/app.ts` contains a Partner Portal API factory, but this review found no invocation of `createPartnerApp()` from committed `server/index.ts` or `server/routes.ts`. The client routes exist. The portal therefore cannot be represented as a verified live server capability without further evidence.
3. **Proven:** no committed origin snapshot fields or partner/HQ certificate display path were found for the required grading-origin model. Existing output includes a hard-coded MintVault wording in certificate/report paths.
4. **Proven:** the repository Vault Quest master document contains a 150-card/18-line direction while the latest founder requirement preserves a 90-card/12-family direction. The master is itself marked draft, so neither conflict may be silently resolved.
5. **Proven:** the master document's safe live area is `57 x 82 mm`; the latest founder requirement calls for an approximately `60 x 85 mm` central safe area. This is a print-critical conflict.
6. **Proven:** the current provider registry supports the Higgsfield OAuth/legacy path and rejects `cloud_api` as an unavailable provider selection. The requested separated Cloud API path is not represented as an implemented path.
7. **Inferred:** the decision log calls strict Vault Quest isolation a locked founder decision while citing repository architecture. The current founder direction requires ecosystem membership without weakening core security; the stricter rule needs explicit founder confirmation or reclassification.

## Internal Document Contradictions and Quality Defects

| Finding | Evidence | Classification | Rectification |
|---|---|---|---|
| Shop Launch sequence is called unknown | Platform Governance and Decision Log say the complete sequence is unknown, but the current founder instruction provides it | Stale evidence | Add the exact ten-step sequence and retain G5-G20 as roadmap |
| Decision source is misclassified | `MEGS-DEC-LOCK-007` is marked locked but cites repository architecture, not a recorded founder approval | Inferred | Reclassify pending founder confirmation or record the founder decision explicitly |
| Status vocabulary mixes concepts | Matrix cells such as `Verified mechanism / Draft requirement` combine evidence classification with lifecycle state | Proven from documents | Split evidence classification from requirement lifecycle state |
| Authority order is underspecified | The Decision Log contains locked decisions but is ranked below domain documents | Ambiguous | State whether a locked decision log entry overrides a domain policy and how it is approved |

## Duplicated Requirements

These are not harmful copies, but they lack a nominated primary definition and can drift:

- Evidence classification appears in Constitution section 8, Platform Governance section 1, and the traceability matrix.
- Founder gates appear in Constitution section 6 and AI Operations sections 1 and 8.
- Project Control evidence/readiness rules appear in Platform Governance section 12 and matrix `MEGS-PCD-001` through `MEGS-PCD-005`.
- Vault Quest isolation appears in Platform Governance, Vault Quest Governance, and `MEGS-DEC-LOCK-007`.

The amendment set assigns a primary requirement ID and makes narrative copies cross-references.

## Ambiguous Requirements

- What privilege boundary distinguishes an Admin from a Super Admin for current Partner Network controls.
- Whether partner portal runtime is intentionally unmounted, feature-gated elsewhere, or an incomplete integration.
- The exact unit of an approved device and how an authorised MacBook is enrolled, revoked, audited, and recovered.
- Three-strike threshold, event scope, appeal, reset, suspension outcome, and human override.
- Whether the GBP20 / GBP15 / GBP5 model includes VAT, fees, refunds, promotions, chargebacks, or per-location variation.
- Which evidence sources may update Project Control and how a source is timestamped and declared stale.
- The canonical Vault Quest source where 90/12, 150/18, template geometry, and playtest locks are reconciled.
- Scanner hardware acceptance method for genuine optical detail versus vendor claims or software interpolation.

## Superseded Decisions

| Decision | Assessment |
|---|---|
| Treat the supplied project-control scaffold as governing | Superseded by founder instruction; correctly recorded as superseded. |
| Treat the current dirty checkout as implementation-ready | Superseded; current HEAD is behind `origin/main` and dirty. |
| Treat the Shop Launch sequence as unavailable | Superseded by the latest founder instruction; baseline documentation must be amended. |
| Treat VQ master-spec product direction as automatically canonical | Superseded for this governance review by the latest founder requirements where they conflict; final reconciliation still needs a founder-recorded decision. |

## Unsupported Assumptions Requiring Correction

1. **Inferred:** strict Vault Quest isolation from users/auth is a locked founder decision. The reviewed source supports technical separation, not the claimed approval state.
2. **Inferred:** every `/api/super-admin/*` route is actually Super Admin authorised. Repository evidence disproves this for the partner route modules.
3. **Reported:** the prior production clobber incidents described in `safe-deploy.sh` comments. The guard mechanism is proven; the historical incidents were not independently verified.
4. **Inferred:** certificate-origin governance can be deferred as a general unknown. It is now an explicit Shop Launch prerequisite and must be elevated to a blocking requirement.
5. **Inferred:** scanner watcher/app documentation proves hardware suitability. It proves a software ingestion path, not optical quality, device control, or accepted hardware.
6. **Inferred:** existing Vault Quest provider-credit labels establish two separately auditable credit sources. The inspected registry exposes a Higgsfield subscription label and no implemented Cloud API path.

## Stale Evidence

- The Phase 0 database-head result is time-bound and was not re-queried in this review. It is reported, not current database proof.
- The baseline's statement that the Shop Launch sequence is unknown is stale against the latest founder instruction.
- `/api/version` proves only the running artefact at the recorded timestamps. It does not prove rollout health, migrations, user-flow acceptance, or readiness.
- The Vault Quest master specification is dated 2026-07-08, marked draft, and contains open risks. It is not sufficient evidence of release readiness.
- Scanner runbooks describe historic implementation decisions and known limitations. They are not hardware validation records.

## Missing Acceptance Criteria

The baseline lacks acceptance criteria for:

- Immutable certificate-origin schema, historical display, and correction routing.
- The exact G5, G6A, G6B, G6C, G6D, portal, Stripe, pilot, and expansion sequence.
- Commercial price/margin reconciliation and Stripe fulfilment idempotency.
- Project Control's flag default, read-only boundary, evidence freshness calculation, and snapshot freeze semantics.
- Vault Quest's exact card geometry, set composition, family names, rules v0.1, and provider-credit separation.
- Hardware test-unit criteria and optical resolution proof for scanners.
- AI model choice, effort declaration, Sol exclusion, and parallel-session collision rules.

## Missing Security, Testing, and Release Requirements

### Security

- Origin records need immutable evidence and must not be rebuilt from mutable partner data.
- Partner Super Admin privilege model needs an explicit canonical decision and route test matrix.
- Device enforcement and three-strike policy lack threat model, recovery, audit, and privacy rules.
- Project Control lacks a defined fail-closed flag evaluation and read-only command boundary.
- Scanner-device identity and token lifecycle rules are not governed.

### Testing

- No acceptance-test requirement maps the certificate-origin rules to schema, certificate render, correction, and mutation tests.
- No requirement maps Shop Launch steps to test evidence, including Stripe fulfilment and pilot criteria.
- No print-geometry acceptance requirement covers the newly specified Vault Quest dimensions/layout.
- No scanner test protocol proves source optical pixels, image format, device controls, or watched-folder linkage.
- The repository contains many relevant test files and CI runs `npm test`, but this review did not run them; current test results are unknown.

### Release

- Partner Shop Launch has no canonical release checklist tied to the preserved ten-step sequence.
- Vault Quest lacks an explicit resolution gate for the 90/12 versus 150/18 specification conflict before print/commercial release.
- Scanner deployment lacks a per-device test-unit and operational sign-off gate.
- Project Control lacks a release gate that ensures evidence sources remain read-only and stale-aware.

## Recommended Rectifications

1. Apply the proposed v1.1 documentation amendments without changing application code.
2. Add the 35 permanent requirement IDs to the traceability matrix, with evidence classification separated from lifecycle status.
3. Reclassify the decision log so every Locked Decision has direct founder evidence, not only repository rationale.
4. Record a founder decision for Super Admin versus Admin authority over existing partner controls; do not rely on route-path naming.
5. Reconcile the Vault Quest master specification with the latest 90-card/12-family/geometry direction before any print, seed, or generation work.
6. Establish a written scanner hardware acceptance protocol before equipment is treated as approved.
7. Re-run this review after v1.1 amendments, using a clean and approved implementation base only when implementation is authorised.

## Required Founder Decisions

Ten founder decisions are required before the relevant implementation can proceed. They are listed with scope and urgency in [MEGS_v1_Open_Questions.md](./MEGS_v1_Open_Questions.md):

1. MEGS adoption authority and the hierarchy of locked decision-log entries.
2. Super Admin versus Admin authority for partner controls.
3. Immutable certificate-origin data model and public wording.
4. G6D disposition.
5. Partner commercial model boundaries and Stripe fulfilment policy.
6. Device identity and three-strike programme policy.
7. Canonical Vault Quest 90/12 versus 150/18 direction.
8. Final Vault Quest safe-area/geometry reconciliation.
9. Higgsfield subscription versus Cloud API provider/credit architecture.
10. Scanner hardware acceptance criteria and test-unit decision.

## Proposed v1.1 Change List

| Change | Outcome |
|---|---|
| Add exact Shop Launch sequence and preserve G5-G20 roadmap | Programme direction becomes traceable rather than placeholder text. |
| Add certificate-origin requirements and decision entries | Historical certificates can carry immutable provenance. |
| Add credit commercial, Stripe, device, and three-strike requirements | Partner launch has operational and commercial controls. |
| Add Project Control controls | Dashboard is feature-flagged, read-only, stale-aware, and snapshot-based. |
| Add Vault Quest print, rules, family, asset, provider, and UE5 requirements | Existing product documents can be reconciled safely. |
| Add AI model and access policy | Model selection, Sol exclusion, parallelism, and prompt discipline become enforceable. |
| Add scanner programme governance | Hardware quality is separated from watcher software existence. |
| Normalize evidence/status fields | Reports cannot conflate a source of evidence with a completion state. |

## Review Boundary Confirmation

No application implementation, database schema change, migration, worktree creation, branch switch, commit, push, merge, deployment, environment update, or production/staging alteration occurred during this review.
