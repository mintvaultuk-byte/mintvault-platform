# VAULT QUEST — BUILD PROGRESS

Tracks phase-by-phase implementation status. Source of truth for *what is built*.
See `VAULT_QUEST_MASTER_SPEC_v1.0.md` for *what should be built*.

**Legend:** ✅ done · 🟡 in progress / partial · ⛔ blocked (see OPEN item) · 🔲 not started

| Phase | Area | Status | Notes |
|---|---|---|---|
| P1 | Foundation (Master Spec) | ✅ | `VAULT_QUEST_MASTER_SPEC_v1.0.md`, approved 2026-07-08 |
| **P2** | **Design System** | **✅ done** (v0.1) | Tokens + component library built, reviewed (brand/a11y/isolation), tsc clean. Pending founder: typography (OPEN-02), neon hue (OPEN-18), gold hex (OPEN-11) |
| P3 | Database / data layer | ✅ **live on STAGING** | 7 `vq_` tables (+`variant_tier`/`base_card_id`) pushed to staging; **150 cards + 12 families + 14 config seeded** (36 base w/ stats, 84 variants). Row counts verified. Prod still not pushed |
| P4 | Card Studio | 🟢 control centre | Dashboard board (counts + filters + 150-card table) + editor (load/save, live preview, art upload, cost + variant fields) + **full status workflow** (10 states, gated + audited transitions) + **QA engine** (evaluate/gates/readiness) + family/variant backend. Reviewed + hardened. Remaining: export-batch (needs zip dep), DB proxy sheets, family-view UI, polish |
| P5 | Rendering Engine | 🟢 largely built | SVG/PNG/PDF + proxy sheets + full-set batch + QA report exist; **renderer now handles the full 150 taxonomy** (15 elements w/ placeholder palettes + NEEDS_APPROVAL, Collector/Place types, SRA/RR/FSR/CR rarities) without crashing (verified). Real palettes/crests pending founder approval |
| P6 | Public Website | 🟡 | **Rules content now on disk** (`client/src/content/vault-quest-rules.md`, v0.1) — rules page unblocked; card pages still need the 150-card oracle text (OPEN-19); pages not built yet |
| P7 | Deck Builder | 🔲 | Designed; needs a card data source (cards.json / seed) |
| P8 | Release Pipeline | 🔲 | Designed; needs DB |
| P9 | Playtesting Tools | 🔲 | Designed |
| P10 | Future Systems | 🔲 | Design-only, not implemented (per directive) |

## Estimated completion
- Card-production stack (template, render, 90-card proxy set): ~80%
- Platform stack (design system, public site, deck builder, release, playtest): ~15%
- **Overall platform: ~30%**

## Current session (2026-07-08)
- OPEN-01 ruled (card faces element-coloured; navy foundation; gold reserved).
- Sword nav icon → Sparkles.
- Phase 2 token foundation built (`client/src/vault-quest/design-tokens.css`).
- Phase 2 component library: **in progress this session.**
