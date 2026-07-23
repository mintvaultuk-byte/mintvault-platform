# MintVault Engineering Governance System (MEGS) v1.1

## 03. Vault Quest Governance

**Status:** v1.1 implementation baseline with open founder decisions explicitly marked  
**Created:** 2026-07-22  
**Updated:** 2026-07-22  
**Relationship to existing docs:** This document governs engineering process for Vault Quest. The existing `VAULT_QUEST_MASTER_SPEC_v1.0.md` contains detailed product/game/art specification material and must be reconciled before Vault Quest implementation work claims canonical status.

---

## 1. Evidence Classification

### 1.1 Verified Repository Facts

The repository contains Vault Quest docs, schema files, migrations, admin routes, storage, rendering, generation, export, provider, and test files. Vault Quest uses `vq_*` tables and a separate migration/config discipline.

### 1.2 Founder Requirements

Vault Quest must remain isolated from MintVault grading, certificates, payments, labels, submissions, users, and auth unless an explicit integration is approved.

### 1.3 Unknowns

Founder approval status of all Vault Quest product rules is not fully known in this MEGS pass. Existing Vault Quest documents include draft/open/lock labels and must be reviewed before print or commercial release.

### 1.4 Reconciliation Gate

Before any Vault Quest print, database seed, public release, provider spend expansion, or commercial claim, reconcile every conflicting product/print rule between the founder-approved MEGS direction and `VAULT_QUEST_MASTER_SPEC_v1.0.md`. Record each resolved conflict in the Founder Decision Log and Contradiction Register. Until that occurs, the VQ master specification is `Reported product input`, not independent production-readiness evidence.

---

## 2. World Bible

The World Bible governs:

- Brand identity.
- Tone.
- Creature-first visual language.
- Avoided themes.
- Element system.
- Family naming.
- Setting terminology.
- Release names.

World Bible changes require founder approval when they affect public brand, printed assets, prompt inputs, or card identity.

---

## 3. Creature Families

Creature families must preserve:

- Stable family IDs.
- Evolution-line continuity.
- Locked names once approved.
- Element identity.
- Stage identity.
- No unapproved species redesign.

Family naming inconsistencies must be recorded as open decisions until founder-approved.

---

## 4. Evolution Rules

Evolution rules must define:

- Stage count.
- Stage display names.
- Previous-stage dependency.
- Visual continuity requirements.
- Gameplay consequences.
- Card template display requirements.

Unknown stage vocabulary or unresolved naming must block final print-readiness.

---

## 5. Card Rules

Card rules must govern:

- Card types.
- Template geometry.
- Art zones.
- Text overflow.
- Rarity.
- Collector numbering.
- Edition/year.
- QR/NFC placement.
- Copyright/footer.
- Print and proxy output.

Template coordinate changes require founder approval and render verification.

### 5.1 Current Founder-Preserved Playtest Direction

For the current founder-preserved Playtest Set 001 direction, Vault Quest uses full-scene portrait cards with 69 x 94 mm bleed, 63 x 88 mm trim, an approximately 60 x 85 mm central safe content area, approximately 3 mm border, and square corners.

Required layout includes top-left stage, top-centre name, top-right Health, lower-left vulnerability/Guard/Shift, lower-right attacks, flavour text, `GENESIS VAULT` banner, and metadata strip.

Playtest Set 001 remains planned as 90 cards: 54 creatures, 18 tactics, 12 relics, and 6 vaults. Twelve three-stage creature families remain preserved. Locked examples include Flammi to Flammro to Flamora; Aquabub to Aquanix to Aquadon; Leafee to Leafflora to Floraven; Zappi to Zapstorm to Zaptor; Mosskit to Mossmire to Mossgloom; and Frosty to Frostra to Frostorn.

This direction requires founder reconciliation against any conflicting existing VQ specification before print, seed, or release work.

---

## 6. Battle Engine

Battle engine governance requires:

- Rules source.
- Win condition.
- Resource economy.
- Turn order.
- Attack resolution.
- Effects model.
- Deck rules.
- Playtest status.
- Versioned rules text.

No battle engine output may be claimed final unless the rules version and acceptance evidence are recorded.

### 6.1 Rules v0.1 Direction

Rules v0.1 is 40-card deck, opening hand 5, maximum 4 copies, maximum 2 elements, 5 Seals to win, Core cap 10, Ready then Draw then Core then Action then End, and capture device named Vault Seal.

---

## 7. AI Studio

AI Studio includes:

- Provider connection status.
- Generation request lifecycle.
- Prompt composition.
- Spend guard.
- Feature flags.
- Candidate review.
- Manual upload.
- Asset promotion.
- Audit trail.

AI Studio must fail closed for spend, provider uncertainty, unsafe prompt state, missing identity references, and unapproved generation types.

Paid generation must propagate the provider job ID, preserve idempotency, perform integrity validation, and fail closed when provider verification or feature flags are not satisfied.

Higgsfield subscription and Cloud API paths must remain separately labelled and separately auditable. Subscription credits are the preferred default path unless the founder changes that decision. Where two provider-credit sources are implemented, each must expose its own credit source, usage evidence, provider job ID, verification state, and reconciliation boundary; credits and usage evidence must never be falsely combined.

---

## 8. Identity Locking

Identity locking must preserve:

- Approved master reference.
- Face, eye, markings, proportions, silhouette, colour, species, and style.
- Evolution continuity.
- Prompt restrictions.
- Candidate rejection evidence.
- Human approval state.

Generated art must not be treated as approved identity without review evidence.

Vault Quest must maintain Character Bible, Family Registry, evolution continuity, action references, and pose diversity as governed identity inputs.

---

## 9. Prompt System

Prompt governance requires:

- Versioned prompt templates.
- Purpose-specific prompts.
- Negative constraints.
- Reference image policy.
- No hidden product-rule drift.
- Evidence of prompt change impact.

Prompt changes that can alter identity, cost, legal posture, or print assets require review.

---

## 10. Asset Pipeline

Asset pipeline must govern:

- R2 key naming.
- Immutable/revisioned asset storage.
- Manual uploads.
- Generated candidates.
- Backups.
- Export jobs.
- Print-ready outputs.
- Preview outputs.
- File formats.

Asset deletion or replacement requires founder approval unless it is a documented rollback of a failed, unapproved candidate.

Approved masters and approved artwork are protected: later generation must not overwrite them. Candidate generation, approval, replacement, and manual promotion must be traceable. The action/master workflow should remove unnecessary manual steps only where identity, approval, audit, and spend controls remain intact.

---

## 11. Database

### 11.1 Verified Repository Facts

Vault Quest uses `migrations-vq/`, `shared/vq-schema.ts`, and `drizzle-vq.config.ts`.

### 11.2 Governance Rules

- Vault Quest tables must remain `vq_*`.
- Vault Quest migration discipline must not be merged into the main grading schema path.
- Production/staging changes require founder approval.
- DB state must be verified before claiming readiness.

### 11.3 Known Staleness from Phase 0

Phase 0 observed that the queried database's `vq_feature_flags` constraint was behind code expectations for newer `gen_*` and `auto_paid_retry` flags. This must be refreshed and resolved before Vault Quest ops readiness is claimed.

---

## 12. APIs

Vault Quest APIs must:

- Be admin-gated unless explicitly public.
- Respect write/generation/export feature gates.
- Avoid paid provider calls before gates pass.
- Bound list sizes and export workloads.
- Return safe errors.
- Preserve idempotency for generation and export jobs.

---

## 13. Admin

Vault Quest admin surfaces must:

- Be isolated from MintVault core admin workflows.
- Clearly display operational status.
- Surface provider, spend, export, and feature-flag states.
- Preserve draft versus approved states.
- Not imply print readiness without evidence.

---

## 14. Testing

Vault Quest testing must cover:

- Schema/migration safety.
- Feature flags.
- Spend guard.
- Provider failure.
- Prompt/identity guardrails where testable.
- Render output.
- Export lifecycle.
- Admin controls.
- Regression around known audit findings.

---

## 15. Release Process

No Vault Quest release may proceed without:

- Founder-approved rules version.
- Founder-approved visual identity and template.
- Trademark/legal review status recorded.
- Print/export QA.
- Database migration evidence.
- Provider/spend guard status.
- Security review.
- Deployment plan and rollback path.

The future Unreal Engine 5 proof-of-concept is roadmap only and must not be represented as production-complete.
