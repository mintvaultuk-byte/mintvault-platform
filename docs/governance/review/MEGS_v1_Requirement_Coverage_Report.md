# MEGS v1.0 Requirement Coverage Report

**Review date:** 2026-07-22  
**Scope:** 51 baseline permanent-ID requirements plus 35 newly explicit, currently unmapped founder-requirement groups.  
**Test note:** Test files and CI configuration were inspected statically. No test command was run. `Test evidence: static only` never means passing evidence.

## Evidence Key

- **R**: repository source inspected during this review.
- **P**: live `/api/version` endpoint read during this review.
- **T0**: relevant tests/configuration inspected only; not run.
- **D0**: no deployment evidence for the specific requirement.
- **Unknown**: no inspected evidence sufficient to establish the claim.

## Baseline Requirement Coverage

| Requirement ID | Requirement summary | Source document | Classification | Repository evidence | Test evidence | Deployment evidence | Current status | Gap | Recommended action |
|---|---|---|---|---|---|---|---|---|---|
| MEGS-GOV-001 | Founder gates | Matrix §2 | Locked Founder Requirement | R: governance baseline | T0 | D0 | proposed | Reporting enforcement not implemented | Retain; add evidence-record format |
| MEGS-GOV-002 | Live backlog | Matrix §2 | Locked Founder Requirement | R: no dashboard | T0 | D0 | not started | No persisted backlog model | Retain; make PCD-only future work |
| MEGS-GOV-003 | Claim classification | Matrix §2 | Locked Founder Requirement | R: narrative only | T0 | D0 | proposed | Taxonomy inconsistent across docs | Normalize taxonomy |
| MEGS-GOV-004 | Document hierarchy | Matrix §2 | Proposed governance | R: hierarchy in Constitution | T0 | D0 | proposed | Locked-log precedence unclear | Amend hierarchy |
| MEGS-EVID-001 | Append-only evidence | Matrix §3 | Locked Founder Requirement | R: wallet/audit patterns exist | T0 | D0 | proposed | PCD evidence model absent | Add storage acceptance criteria |
| MEGS-EVID-002 | Evidence-derived readiness | Matrix §3 | Locked Founder Requirement | R: no readiness engine | T0 | D0 | not started | No denominator/freshness model | Amend PCD requirements |
| MEGS-EVID-003 | Deploy distinct from verification | Matrix §3 | Locked Founder Requirement | R: `safe-deploy.sh` checks version | T0 | P: live version read | implemented; test evidence missing | Does not prove business flow | Retain separation |
| MEGS-EVID-004 | Unknown remains unknown | Matrix §3 | Locked Founder Requirement | R: draft documentation | T0 | D0 | proposed | No UI/data state model | Add status taxonomy |
| MEGS-REPO-001 | Clean approved base | Matrix §4 | Locked Founder Requirement | R: current base dirty/behind | T0 | D0 | blocked | No clean approved base currently selected | Recheck before implementation |
| MEGS-REPO-002 | Worktree discovery | Matrix §4 | Proposed governance | R: 57 worktrees, 13 prunable | T0 | D0 | implemented; review pending | No persistent classification record | Retain as future scanner requirement |
| MEGS-DB-001 | Numbered migrations | Matrix §4 | Repository-Proven Fact / Proposed governance | R: `scripts/db/migrate.ts`, migrations | T0: migration tests exist | D0 | implemented; test evidence missing | DB head not reverified | Refresh before migration decision |
| MEGS-DB-002 | Approval before apply | Matrix §4 | Locked Founder Requirement | R: baseline/guard docs | T0 | D0 | proposed | Script cannot prove approval exists | Keep human gate |
| MEGS-SEC-001 | Explicit Super Admin auth | Matrix §5 | Proposed governance | R: partner routes use `requireAdmin` | T0: auth tests exist | D0 | review failed | Route implementation conflicts with stated standard | Founder decision and route plan |
| MEGS-SEC-002 | Role separation | Matrix §5 | Proposed governance | R: partner MFA/RBAC/session code | T0: partner tests exist | D0 | implemented; review pending | No full cross-role evidence run | Retain and run targeted tests later |
| MEGS-SEC-003 | Safe public endpoints | Matrix §5 | Proposed governance | R: public/admin route separation | T0 | D0 | review pending | No endpoint inventory/negative test map | Add security test mapping |
| MEGS-SEC-004 | Validate uploads/provider calls | Matrix §5 | Proposed governance | R: VQ guards and upload code exist | T0: VQ guard tests exist | D0 | implemented; review pending | Scanner and all upload paths not mapped | Expand acceptance tests |
| MEGS-TEST-001 | Skips are not passes | Matrix §6 | Locked Founder Requirement | R: CI runs tests; policy narrative | T0 | D0 | proposed | No evidence ledger implementation | Retain |
| MEGS-TEST-002 | CI quality evidence | Matrix §6 | Repository-Proven Fact / Proposed governance | R: CI lint/check/test/build/audit/gitleaks/CodeQL | T0: workflow only | D0 | implemented; test evidence missing | CI run result not inspected | Capture CI run evidence later |
| MEGS-TEST-003 | High-risk regression tests | Matrix §6 | Proposed governance | R: targeted partner/VQ tests exist | T0 | D0 | review pending | No requirement-to-test enforcement | Add PCD data rule |
| MEGS-DEPLOY-001 | Approval before deploy | Matrix §7 | Locked Founder Requirement | R: manual deploy script | T0 | D0 | proposed | Approval is procedural, not technical | Retain human gate |
| MEGS-DEPLOY-002 | Verify running commit | Matrix §7 | Repository-Proven Fact / Proposed governance | R: endpoint and script | T0 | P: prod `e6fd64da`, staging `0fedce6e` | implemented; production verified for commit only | Health/user flow not proven | Record bounded interpretation |
| MEGS-DEPLOY-003 | Rollback path | Matrix §7 | Proposed governance | R: script captures image | T0 | D0 | implemented; review pending | No reviewed deployment record | Retain deployment checklist |
| MEGS-MVGS-001 | MVGS approval/tests | Matrix §8 | Locked Founder Requirement | R: grader/label paths exist | T0: grading tests exist | D0 | proposed | No current rules-to-test index | Add regression mapping |
| MEGS-CERT-001 | Public trust/privacy | Matrix §8 | Proposed governance | R: public verify routes | T0 | D0 | review pending | No formal privacy acceptance map | Add test requirements |
| MEGS-CERT-002 | Audited corrections | Matrix §8 | Repository-Proven Fact / Proposed governance | R: correction module uses `requireSuperAdmin` | T0: relevant test file present but untracked | D0 | implemented; review pending | Baseline test evidence is not committed | Reconcile current branch separately |
| MEGS-NFC-001 | Safe NFC lifecycle | Matrix §8 | Proposed governance | R: admin NFC routes and public lookup | T0 | D0 | review pending | Origin/NFC partner rule absent | Add origin cross-reference |
| MEGS-WALLET-001 | Append-only wallet ledger | Matrix §9 | Repository-Proven Fact / Locked Founder Requirement | R: migration 0016 triggers/view | T0: wallet tests exist | D0 | implemented; review pending | Current DB state only reported | Refresh DB evidence later |
| MEGS-WALLET-002 | Idempotent lifecycle | Matrix §9 | Future roadmap | R: 0017/G6B in `origin/main`; G6D unmerged | T0: reservation tests exist | D0 | in progress | G6D link and one-entitlement rule absent | Amend and decide G6D |
| MEGS-PARTNER-001 | Tenant isolation | Matrix §9 | Repository-Proven Fact / Proposed governance | R: RLS/runtime factory | T0: isolation tests exist | D0 | implemented; review pending | Factory appears unmounted | Resolve portal integration state |
| MEGS-PARTNER-002 | Fail-closed flags | Matrix §9 | Repository-Proven Fact / Proposed governance | R: partner flags/emergency code | T0: tests exist | D0 | implemented; review pending | Shop/PDC flags omitted | Add exact flag requirements |
| MEGS-PARTNER-003 | Audited partner actions | Matrix §9 | Repository-Proven Fact / Proposed governance | R: reason/audit code | T0: tests exist | D0 | implemented; review pending | Some mutation reasons are inconsistent | Specify all high-risk mutations |
| MEGS-SHOP-001 | Shop readiness | Matrix §9 | Future roadmap | R: partial components only | T0 | D0 | proposed | Exact sequence and pilot criteria absent | Add `MEGS-SHOP-002` |
| MEGS-GROAD-001 | G5-G20 governance | Matrix §9 | Future roadmap | R: branches/migrations through G6D | T0 | D0 | proposed | Detailed G7-G20 unknown | Preserve backlog and mark unknown |
| MEGS-PCD-001 | Evidence-based dashboard | Matrix §10 | Locked Founder Requirement | R: no dashboard source found | T0 | D0 | not started | Flag/read-only/state details absent | Add PCD amendments |
| MEGS-PCD-002 | Evidence classes | Matrix §10 | Locked Founder Requirement | R: no dashboard source found | T0 | D0 | not started | Timestamp/provenance freshness absent | Amend |
| MEGS-PCD-003 | Evidence drill-down | Matrix §10 | Future roadmap | R: no dashboard source found | T0 | D0 | not started | No immutable evidence locator definition | Amend |
| MEGS-PCD-004 | Evidence-based next task | Matrix §10 | Locked Founder Requirement | R: no recommendation engine | T0 | D0 | not started | No scoring/governance formula | Amend |
| MEGS-PCD-005 | Continuation prompts | Matrix §10 | Locked Founder Requirement | R: no generator | T0 | D0 | not started | Frozen snapshot rule absent | Amend |
| VQ-CORE-001 | Versioned rules source | Matrix §11 | Proposed governance | R: master spec is draft; rules locks reported there | T0 | D0 | review pending | Latest Rules v0.1 values absent | Add exact rule requirement |
| VQ-WORLD-001 | World Bible changes | Matrix §11 | Proposed governance | R: master doc exists | T0 | D0 | proposed | Character Bible/family registry detail absent | Amend VQ governance |
| VQ-CREATURE-001 | Identity continuity | Matrix §11 | Proposed governance | R: identity/evolution tests exist | T0 | D0 | implemented; review pending | 12-family lock/examples absent | Amend |
| VQ-CARD-001 | Template change QA | Matrix §11 | Proposed governance | R: renderer/template/master spec | T0: card tests exist | D0 | implemented; review pending | Exact geometry conflicts/requirements absent | Amend and reconcile |
| VQ-STUDIO-001 | Spend/provider/identity gates | Matrix §11 | Repository-Proven Fact / Proposed governance | R: guards/provider code | T0: guard tests exist | D0 | implemented; review pending | Job ID, integrity, sources missing | Amend |
| VQ-ASSET-001 | Revisioned assets | Matrix §11 | Proposed governance | R: artwork revision sources/tests | T0 | D0 | implemented; review pending | Approved-master non-overwrite rule absent | Amend |
| VQ-DB-001 | VQ schema isolation | Matrix §11 | Repository-Proven Fact / Proposed governance | R: `vq_*`, separate migrations | T0: migration/test files exist | D0 | implemented; review pending | Phase 0 DB flag state stale | Refresh DB evidence later |
| VQ-REL-001 | VQ release evidence | Matrix §11 | Future roadmap | R: release-related test/docs | T0 | D0 | proposed | UE5 and canon conflicts absent | Amend |
| MEGS-AI-001 | Read governing docs | Matrix §12 | Locked Founder Requirement | R: process text only | T0 | D0 | proposed | No model/effort contract | Amend |
| MEGS-AI-002 | Classify AI claims | Matrix §12 | Locked Founder Requirement | R: process text only | T0 | D0 | proposed | Taxonomy needs normalization | Amend |
| MEGS-AI-003 | Parallel work boundaries | Matrix §12 | Locked Founder Requirement | R: 57 worktrees | T0 | D0 | proposed | 3-5/G6D/stop rules absent | Amend |
| MEGS-AI-004 | Handover gates | Matrix §12 | Locked Founder Requirement | R: templates exist | T0 | D0 | proposed | Uninterrupted coding prompt absent | Amend |
| MEGS-AI-005 | Terra role | Matrix §12 | Open Question | R: no Terra repo role | T0 | D0 | blocked | Founder decision required | Retain as open decision |

## Unmapped Latest Founder Requirements

These 35 groups were reviewed against all six baseline documents and have no baseline permanent ID. Proposed IDs are not adopted until founder approval of the v1.1 amendments.

| Proposed ID | Requirement summary | Source document | Classification | Repository evidence | Test evidence | Deployment evidence | Current status | Gap | Recommended action |
|---|---|---|---|---|---|---|---|---|---|
| MEGS-ORIGIN-001 | Immutable physical grader/origin snapshot | Latest founder direction | Locked Founder Requirement | R: no matching origin fields found | T0: none mapped | D0 | not started | Missing schema/governance | Add requirement and decision |
| MEGS-ORIGIN-002 | Exact partner/HQ certificate display and location | Latest founder direction | Locked Founder Requirement | R: hard-coded MintVault wording found | T0: none mapped | D0 | not started | Missing render acceptance | Add requirement |
| MEGS-ORIGIN-003 | Origin-based correction routing | Latest founder direction | Locked Founder Requirement | R: correction route exists, no origin rule found | T0: none mapped | D0 | not started | Missing route policy | Add requirement |
| MEGS-WALLET-003 | One credit equals one card, no double consume | Latest founder direction | Locked Founder Requirement | R: partial reservations/G6D | T0: lifecycle tests exist | D0 | in progress | Exact invariant not in matrix | Amend wallet requirement |
| MEGS-WALLET-004 | GBP20/GBP15/GBP5 working model | Latest founder direction | Locked Founder Requirement | R: no partner commercial source found | T0: none | D0 | proposed | Tax/fee/refund scope unknown | Add decision-bound requirement |
| MEGS-WALLET-005 | Stripe packages and idempotent fulfilment | Latest founder direction | Locked Founder Requirement | R: Stripe source field only | T0: no fulfilment test mapped | D0 | not started | No package/fulfilment design | Add Shop Launch requirement |
| MEGS-PARTNER-004 | Own-data access and revocation | Latest founder direction | Locked Founder Requirement | R: RLS/session revoke code | T0: static tests exist | D0 | implemented; review pending | Categories/acceptance not explicit | Amend partner requirement |
| MEGS-PARTNER-005 | Approved-device/Mac policy | Latest founder direction | Locked Founder Requirement | R: device field/flag only | T0: none mapped | D0 | proposed | Identity/enrolment unknown | Add decision-bound requirement |
| MEGS-PARTNER-006 | Three-strike programme policy | Latest founder direction | Locked Founder Requirement | R: no matching policy found | T0: none | D0 | not started | Technical specification absent | Add policy requirement |
| MEGS-PARTNER-007 | Reuse existing core systems | Latest founder direction | Locked Founder Requirement | R: core systems exist | T0 | D0 | proposed | No reuse decision criterion | Add architecture rule |
| MEGS-PARTNER-008 | Secure invitations and RBAC | Latest founder direction | Locked Founder Requirement | R: RBAC/MFA exist; no invite flow found | T0: static auth tests exist | D0 | in progress | Invitation acceptance absent | Add requirement |
| MEGS-SHOP-002 | Exact G5-to-pilot sequence | Latest founder direction | Locked Founder Requirement | R: G5/G6 work exists | T0 | D0 | proposed | Sequence absent from baseline | Add canonical sequence |
| MEGS-GROAD-002 | G5-G20 preserved backlog | Latest founder direction | Locked Founder Requirement | R: branches only through G6D observed | T0 | D0 | proposed | Later phase details unknown | Add roadmap rule |
| MEGS-PCD-006 | `super_admin_project_control_enabled` fail-closed flag | Latest founder direction | Locked Founder Requirement | R: no symbol found | T0: none | D0 | not started | Flag absent from docs/code | Add requirement |
| MEGS-PCD-007 | Read-only/no uncontrolled writes | Latest founder direction | Locked Founder Requirement | R: no dashboard source | T0: none | D0 | not started | Boundary undefined | Add requirement |
| MEGS-PCD-008 | Exact lifecycle-state distinction | Latest founder direction | Locked Founder Requirement | R: matrix status mix | T0: none | D0 | proposed | State model incomplete | Add enum/acceptance |
| MEGS-PCD-009 | Timestamp/provenance/stale confidence | Latest founder direction | Locked Founder Requirement | R: no PCD source | T0: none | D0 | not started | Freshness model absent | Add requirement |
| MEGS-PCD-010 | Frozen evidence-based continuation snapshots | Latest founder direction | Locked Founder Requirement | R: no generator | T0: none | D0 | not started | Snapshot semantics absent | Add requirement |
| VQ-CARD-002 | Exact card geometry/layout | Latest founder direction | Locked Founder Requirement | R: master geometry conflicts | T0: static card tests | D0 | blocked | Canonical dimensions conflict | Founder reconciliation |
| VQ-CORE-002 | 90-card Playtest Set 001 composition | Latest founder direction | Locked Founder Requirement | R: master says 150 canonical | T0 | D0 | blocked | Dataset conflict | Founder reconciliation |
| VQ-CREATURE-002 | 12 families and supplied locked examples | Latest founder direction | Locked Founder Requirement | R: master says 18 lines | T0 | D0 | blocked | Family-model conflict | Founder reconciliation |
| VQ-CORE-003 | Rules v0.1 values and Vault Seal | Latest founder direction | Locked Founder Requirement | R: master contains many values | T0: rules tests not mapped | D0 | proposed | Matrix omits exact values | Add requirement |
| VQ-STUDIO-002 | Master protection and candidate governance | Latest founder direction | Locked Founder Requirement | R: revisions/identity code exists | T0: static tests exist | D0 | implemented; review pending | No explicit immutable-master rule | Amend |
| VQ-STUDIO-003 | Job ID/idempotency/integrity/fail-closed gates | Latest founder direction | Locked Founder Requirement | R: provider and guard code exists | T0: static tests exist | D0 | implemented; review pending | Matrix omits all required evidence | Amend |
| VQ-STUDIO-004 | Subscription and Cloud API paths/credit evidence separate | Latest founder direction | Locked Founder Requirement | R: Higgsfield only; cloud unavailable | T0: static provider tests | D0 | not started | Required architecture absent | Add requirement/decision |
| VQ-REL-002 | UE5 proof of concept is roadmap | Latest founder direction | Future Roadmap | R: no UE5 source inspected | T0 | D0 | roadmap | Matrix omits it | Add roadmap requirement |
| MEGS-AI-006 | Each task declares model and effort | Latest founder direction | Locked Founder Requirement | R: manual lacks rule | T0 | D0 | not started | Required report field absent | Amend |
| MEGS-AI-007 | Model allocation policy | Latest founder direction | Locked Founder Requirement | R: only generic GPT/Claude/Terra text | T0 | D0 | proposed | Medium/High/Claude allocation absent | Amend |
| MEGS-AI-008 | Sol excluded from engineering access | Latest founder direction | Locked Founder Requirement | R: no Sol rule found | T0 | D0 | not started | Access boundary absent | Add requirement |
| MEGS-AI-009 | Controlled 3-5 isolated sessions after G6D | Latest founder direction | Locked Founder Requirement | R: worktree evidence only | T0 | D0 | proposed | Trigger/boundaries absent | Amend |
| MEGS-AI-010 | One uninterrupted coding-agent prompt | Latest founder direction | Locked Founder Requirement | R: prompt rules generic | T0 | D0 | proposed | Copy/paste requirement absent | Amend |
| MEGS-SCAN-001 | Scanner purpose/card/image/output standard | Latest founder direction | Locked Founder Requirement | R: watcher and 1200-DPI marketing claims | T0 | D0 | proposed | Hardware requirements absent | Add scanner section |
| MEGS-SCAN-002 | Optical resolution and hardware controls | Latest founder direction | Locked Founder Requirement | R: no 20/24MP/UVC/control evidence found | T0 | D0 | not started | Acceptance protocol absent | Add requirement |
| MEGS-SCAN-003 | USB-to-Mac watched-folder workflow | Latest founder direction | Locked Founder Requirement | R: watcher/app supports a related path | T0: static code only | D0 | implemented; review pending | Linkage/identity acceptance absent | Add requirement |
| MEGS-SCAN-004 | Test-unit validation/no presumed approval | Latest founder direction | Locked Founder Requirement | R: no hardware record found | T0 | D0 | not started | Approval criterion absent | Add release gate |

## Coverage Totals

| Measure | Count |
|---|---:|
| Existing permanent-ID requirements reviewed | 51 |
| Latest founder-requirement groups reviewed without baseline IDs | 35 |
| Total requirement groups reviewed | 86 |
| Missing requirement groups | 35 |
| Baseline requirements with an inspected repository mechanism | 19 |
| Baseline requirements with only static test evidence | 18 |
| Requirements proven deployed/production-verified beyond a version endpoint | 0 |

The last two totals intentionally do not imply functional completion. The review did not run tests or user-flow verification.
