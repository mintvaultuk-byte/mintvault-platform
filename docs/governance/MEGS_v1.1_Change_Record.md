# MintVault Engineering Governance System (MEGS) v1.1 Change Record

**Status:** Frozen implementation baseline for authorised Project Control work  
**Created:** 2026-07-22  
**Source:** MEGS v1.0 baseline plus `docs/governance/review/` gap, coverage, contradiction, open-question, and proposed-amendment reports.

---

## 1. Scope

MEGS v1.1 incorporates all documentation amendments that can be safely resolved from repository evidence, governance review evidence, and founder requirements available on 2026-07-22.

Unresolved founder decisions are preserved as open questions or blocked lifecycle states. MEGS v1.1 does not invent answers for:

- Certificate-origin schema fields and correction-routing role policy.
- Admin versus Super Admin authority for existing partner controls.
- G6D disposition.
- Commercial-model VAT, refund, promotion, chargeback, effective-date, and per-location boundaries.
- Approved-device and three-strike technical policy.
- Vault Quest 90/12 versus 150/18 and safe-area conflicts.
- Higgsfield subscription versus Cloud API implementation boundary.
- Scanner test-unit acceptance criteria.

---

## 2. Incorporated Amendments

| Amendment | Status | Notes |
|---|---|---|
| MEGS-AMD-001 | Incorporated | Evidence classification and lifecycle state are now separate. |
| MEGS-AMD-002 | Incorporated | Locked Decision Log authority requires direct founder evidence. |
| MEGS-AMD-003 | Incorporated | Immutable certificate-origin governance added; detailed schema remains blocked. |
| MEGS-AMD-004 | Incorporated | Wallet entitlement and working commercial model added with open commercial boundaries. |
| MEGS-AMD-005 | Incorporated | Partner access, device, three-strike, reuse, and invitation governance added. |
| MEGS-AMD-006 | Incorporated | Ten-step Shop Launch sequence and preserved G5-G20 backlog added. |
| MEGS-AMD-007 | Incorporated | Project Control fail-closed, read-only, stale-aware, snapshot-based requirements added. |
| MEGS-AMD-008 | Incorporated | Scanner programme governance added. |
| MEGS-AMD-009 | Incorporated | Vault Quest Playtest Set 001 direction and Rules v0.1 added; conflicts remain blocked. |
| MEGS-AMD-010 | Incorporated | VQ approved-master, candidate, provider-job, and integrity requirements added. |
| MEGS-AMD-011 | Incorporated | VQ provider-credit separation and UE5 roadmap classification added. |
| MEGS-AMD-012 | Incorporated | AI model/effort, Sol exclusion, parallel-session, and prompt-block rules added. |
| MEGS-AMD-013 | Incorporated | Decision Log provenance corrected and open decisions expanded. |
| MEGS-AMD-014 | Incorporated | 35 permanent requirement IDs added to the traceability matrix. |
| MEGS-AMD-015 | Incorporated | Partner route authorization evidence is described precisely without overclaiming Super Admin enforcement. |
| MEGS-AMD-016 | Incorporated | Partner Portal runtime status separated from client and factory source presence. |
| MEGS-AMD-017 | Incorporated | VQ reconciliation gate added before print, seed, spend expansion, release, or commercial claims. |

---

## 3. Implementation Baseline

Project Control implementation may proceed against MEGS v1.1 for requirements that are not blocked by unresolved founder decisions. The Project Control Dashboard itself is authorised as read-only governance infrastructure and must represent blocked or unknown requirements as blocked or unknown, not as complete.

---

## 4. Controlled Pre-Opus Review Addendum (2026-07-22)

| Review record | Status | Notes |
|---|---|---|
| MEGS-RVW-001 | Clarified | The implemented continuation prompt is deterministic and content-addressed, but no application writer persists an immutable prompt snapshot. It must not be described as durable retention until an explicitly approved, bounded, server-authorized writer and retention policy exist. |
| MEGS-RVW-002 | Clarified | The three Project Control governance tables are append-only at the database layer. This does not itself authorize GET-triggered persistence or any mutation interface. |
| MEGS-RVW-003 | Release gate | Project Control migration `0020` must not be applied from a lineage that omits an approved resolution of G6D migration `0019`. |

The detailed evidence, fixes, and pending independent-review questions are in `docs/governance/review/project-control-pre-opus/`. These clarifications do not create founder decisions or claim a deployment or independent Opus review.
