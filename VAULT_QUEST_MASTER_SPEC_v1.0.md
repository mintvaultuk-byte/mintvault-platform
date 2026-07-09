# VAULT QUEST — MASTER SPECIFICATION v1.0

> **Single source of truth for the Vault Quest project.**
> Every feature, component, table, endpoint, card template, rule, colour, typography rule and
> production asset references this document. Do not allow specification drift.
>
> **Owner:** Cornelius (non-technical founder) · **Product:** Vault Quest — a premium collectible trading card game, an isolated sub-project inside the MintVault platform.
> **Status:** DRAFT for founder approval · **Created:** 2026-07-08 · **Author:** Claude (consolidation pass)
> **Supersedes / consolidates:** `VAULT_QUEST_BUILD_PLAN.md`, `VQ_PHASE1_ADMIN_INTEGRATION_PLAN.md`, `VQ_DB_R2_ACTIVATION.md`, the `VQ_CARD_BUILDER_v0.1` handoff pack, the v1.1 Stage-Lock template, the Genesis Vault 90-card master, and all current repo artifacts. The 14-expert audit of 2026-07-07 (verdict 3/10) is treated as the open-risk register.

---

## 0. How to read this document

Every substantive item carries one of three status tags:

| Tag | Meaning |
|---|---|
| 🔒 **LOCK** | Founder-directed and permanent, **or** already built and in force. Do not change without explicit founder approval. |
| 🟡 **DRAFT** | Provisional / built-but-unratified / playtest-only. Will change. Not safe for print, launch, or money. |
| 🔴 **OPEN** | A decision that needs founder sign-off before it can become a LOCK. Listed in the **Open Decisions Register (§23)**. |

**The one rule that governs all others:** *A 🔒 LOCK on an **asset** (the card template, the colour tokens, a built card) does **not** lock the **game design** beneath it.* The template can be permanent while the win condition it serves is still undefined. This document is deliberately built to hold both at once.

**Anti-invention rule (from the directive):** where a detail is unknown, this spec records it as 🔴 OPEN or a TODO placeholder. Nothing has been invented to fill a gap.

---

## 1. Purpose & the central tension

Vault Quest is being built to **commercial production standards** as a scalable TCG platform (thousands of cards, multiple sets, print, organised play, future digital) — but it is **early**. Two truths must be held simultaneously:

**What is locked (founder directive v1.0 + what is already built):**
- A premium, creature-first brand identity (§2) and a navy/gold colour system (§3).
- A permanent, hash-verified card template geometry (§7) with a 90-card Genesis Vault set already rendered as proxies (§9).
- A fully **isolated** database + rendering + admin stack (§12–14) that never touches grading, payments, or labels.

**What is unresolved (2026-07-07 audit, verdict 3/10 — still open):**
- The **win condition (Vault Seals) is undefined.** No rulebook, no `game_config` values, no win-condition text exists anywhere on disk — "Rules v0.1" survives only as a footer string on the proxy sheets.
- The **resource system (Core) has no refresh rule.**
- **Trademark uncleared** (a live "Quest Vault" app exists), **namespace collisions** baked into the schema (Vault/Core/Guard/Shift), and the **colour-blind palette** fails.

**✅ Resolved 2026-07-08:** the colour direction (was the #1 blocker) — see **OPEN-01** in §3.3. Card faces stay element-coloured; navy is the brand/UI/card-back/website foundation; gold reserved for premium/rarity. Phase 2 design tokens now proceed.

> ⚠️ **This is the headline.** A lot of expensive, correct work has been done on the *card-production* layer. The *game-design* layer beneath it is still a draft. This spec preserves the former and gates the latter.

---

## 2. Brand & positioning

### 2.1 Identity — 🔒 LOCK (directive v1.0)
Vault Quest is **colourful, friendly, modern, premium, adventurous, collectible, clean.** It must **not** resemble Pokémon, Yu-Gi-Oh!, Magic, Lorcana, Digimon, or One Piece.

**Avoid list (🔒 LOCK):** medieval, gothic, heavy armour, stone castles, knights, **swords**, dark fantasy.
**Principle (🔒 LOCK):** *The creatures are the heroes. The world supports the creatures.*

> 🔴 **Known violation to fix:** the admin nav icon for Vault Quest is currently a **`Swords`** icon (`client/src/components/admin/admin-shell.tsx:89`) — a direct breach of the avoid-list. Swap for a non-medieval mark (see **OPEN-11**; trivial, admin-only chrome).

### 2.2 Audience — 🔴 OPEN-08
Audit recommends **adult-collector-and-family as primary**, dropping "children 8+" as the primary audience. The build plan cites child-adjacency as the reason to strike player accounts but never records a primary-audience decision. **Needs a founder call** — it drives toy-safety scope, the UK Children's Code, and consent stance.

### 2.3 Publishing identity & the grading conflict — 🔴 OPEN-09
MintVault is a card-grading company. Publishing a TCG it might also authenticate is a conflict of interest the audit flagged. **Policy to ratify:** publish Vault Quest under a **distinct identity**; MintVault may **authenticate / serialise** ("born-certified" NFC cards) but must **never condition-grade its own product.** Until this "authenticate-never-grade" policy is written, **no "grade/authenticate your Vault Quest cards" page may exist.**

### 2.4 Trademark & legal — 🔴 OPEN-09 / TODO
- **`VAULT QUEST` trademark is uncleared** — a live "Quest Vault" app exists. Clearance must start before brand launch.
- The template hard-locks **`FIRST EDITION • 2026`** onto every card (§7). Locking edition/year pre-empts an unresolved brand/legal identity. Acceptable for *playtest proxies*; a decision point before *print*.
- **TODO:** toy-safety testing and UK Children's Code assessment — none exists; scope depends on §2.2.

---

## 3. Colour system & visual language

### 3.1 Brand colour tokens — 🔒 LOCK (directive v1.0)
| Token | Hex | Use |
|---|---|---|
| Primary — Deep Navy | `#102A5E` | Primary brand colour |
| Secondary Navy | `#081A3D` | Depth, backgrounds |
| Background White | `#F7F9FC` | Page/base background |
| Neutral Silver | `#D7DCE6` | Borders, neutrals |
| Premium Gold | *(reserved)* | **ONLY** Secret Rares, Founder Editions, Promotional cards, premium UI highlights |

**🔒 Gold rule (clarified 2026-07-08):** premium gold is reserved for Secret Rare / Founder / Promo / premium UI highlights — **never** the primary colour of a standard card or standard UI. *Element* yellows (e.g. Storm `#E8A100`/`#FFD43B`) are permitted as **element colour** on card faces — that is a different thing from premium gold and is allowed.

### 3.2 Visual language — 🔒 LOCK (directive v1.0)
Deep navy backgrounds · soft radial lighting · subtle glowing neon energy lines · fine glowing particles · soft gradients · minimal geometric patterns. Consistent across website, cards, packs, deck builder, rulebook, UI, loading screens, marketing. Avoid busy backgrounds that reduce readability.

### 3.3 ✅ OPEN-01 — RESOLVED 2026-07-08: navy foundation, element-coloured card faces
The tension was: the directive locks navy-primary/gold-reserved, but every built card uses a saturated per-element palette on cream faces (no navy anywhere), and several *standard* cards are gold-family.

**Founder ruling (2026-07-08) — Option B, card faces exempt:**
- **Card faces stay element-coloured.** Standard cards are **not** re-skinned to navy — creature cards need strong element identity and child-friendly colour. This is an intentional, documented exemption from the navy-primary rule, scoped to card faces only.
- **Navy is the foundation** for the Vault Quest brand, UI, **card backs**, and website.
- **Gold rule still applies:** gold is reserved for premium / rarity treatments only. Storm/yellow **element** accents are allowed as *element colour* (not premium gold) — see §3.1.

**Consequence:** the 90 built card faces do **not** need rebuilding for colour. The card-face element palette (§5.1) is now the sanctioned card-face system (its colour-blind revision is still tracked separately under OPEN-03 — that's about roster/legibility, not navy-vs-element). The Design System (§3.4) is unblocked.

### 3.4 Design-system token foundation — 🟡 Phase 2 (v0.1, built 2026-07-08)
Token layer implemented at **`client/src/vault-quest/design-tokens.css`** — an isolated CSS custom-property set (every token `--vq-`-prefixed; imports nothing, imported by nothing yet; apply via a `.vq-theme` root). Built on the four ruled bases:

| Layer | Tokens | Status |
|---|---|---|
| **Navy foundation** | `--vq-navy` `#102A5E`, `--vq-navy-deep` `#081A3D` + a 100–950 ladder | 🔒 anchors locked / 🟡 ladder derived |
| **White/silver UI** | `--vq-white` `#F7F9FC`, `--vq-silver` `#D7DCE6`, surfaces, borders, ink/muted text | 🔒 anchors / 🟡 derived |
| **Card-face elements** | 7 elements × border/accent/dark, mirroring `vq-constants.ts` | 🔒 (revision = OPEN-03) |
| **Premium gold** | `--vq-gold` + foil gradient, reserved for SR+/Founder/Promo/premium UI | 🟡 hex proposed (OPEN-11) |
| **Visual language** | radial lighting, neon energy-line glow, particle bloom, navy-tinted elevation, 4px spacing, radii, type scale | 🟡 mechanic locked; **neon hue proposed (OPEN-18)** |
| **Typography** | family = **TODO placeholder** (OPEN-02); type scale proposed | 🔴 family unresolved |

**Component library built 2026-07-08** under `client/src/vault-quest/ui/` (isolated, liftable, `react`+`lucide-react` only): page shell (`VQPage` + branded header + "by MintVault" footer + neon background), panels, buttons (primary/secondary/ghost/premium-gold), inputs/select/textarea, element/rarity/status badges, tabs, search bar, empty/loading/error states. Reviewed for brand (PASS), token/isolation (PASS), and accessibility (fixed to WCAG AA — see `VAULT_QUEST_QA_LOG.md`). Not wired into the running app yet. Preview: `DesignSystemPreview.tsx`. Pending founder: typography (OPEN-02), neon hue (OPEN-18), gold hex (OPEN-11).

---

## 4. Typography — 🔴 OPEN-02
- The original builder renders everything in **Arial / Arial Black**.
- MintVault's house rule is **Manrope-only** — but that is a *MintVault-brand* rule, not necessarily a Vault Quest lock.
- **No VQ typography lock exists.** Founder must lock the VQ type family (card + web) before Phase 2. TODO.

---

## 5. Element system

### 5.1 Built roster (de-facto) — 🟡 DRAFT
The **render engine** (`server/vault-quest/lib/vq-constants.ts`) ships **7 elements** with these exact tokens:

| Element | border | accent | dark | crest glyph |
|---|---|---|---|---|
| Flame | `#C93316` | `#F97316` | `#2A0B05` | 🔥 |
| Water | `#0284C7` | `#38BDF8` | `#082F49` | 💧 |
| Nature | `#2F9E44` | `#69DB7C` | `#0B2E13` | 🌿 |
| Storm | `#E8A100` | `#FFD43B` | `#3A2A00` | ⚡ |
| Stone | `#7A6A55` | `#B8A88F` | `#2A231A` | ⬢ |
| Shadow | `#6741D9` | `#9775FA` | `#160B2E` | ☾ |
| Neutral | `#64748B` | `#CBD5E1` | `#0F172A` | ◆ (support-only) |

### 5.2 Known problems — 🔴 OPEN-03
- **Roster bloat:** the CLI `elements.json` carries **18 keys** with heavy duplication (Blaze==Flame pixel-identical, Spark==Electric, Tide≈Water, Cosmos/Dark/Shadow all purple, Blossom≈Nature, Earth≈Stone). Only the 7 above are real.
- **Naming split:** two systems coexist — Flame/Water/Nature/Storm/Stone/Shadow (the set) vs Blaze/Tide/Blossom/Spark/Earth/Wind (the sample). **Lock one.**
- **Crest mismatch (rendering bug):** `crest-data.ts` keys are lowercase `blaze/flame/nature/shadow/stone/storm/water` — **`blaze` is orphaned** and **there is no `neutral` crest**, so a Neutral creature's crest resolves to `''` and falls back to an emoji that **does not rasterise** in PNG/PDF (librsvg has no colour-emoji). All crests are **PLACEHOLDER**.
- **Colour-blind failure (audit):** 4 of 6 elements collapse under a colour-blind check; audit recommends a **12-crest, one-sitting redesign** with distinct hue + distinct shape per element.

**Decision needed:** final element roster + colour-blind-safe palette + **1:1 element→crest** mapping (add a Neutral crest; resolve Flame vs Blaze; dedupe to the real set). Reconcile with OPEN-01.

---

## 6. Creature & evolution model

### 6.1 Three-stage evolution — 🔒 LOCK (directive + built)
| Stage | Directive intent | Template | Life-stage label (built) | Card rules |
|---|---|---|---|---|
| Stage 1 | cute, rounded, friendly, large eyes, simple silhouette | A | BABY | no previous portrait, no "Evolves From" |
| Stage 2 | growing, longer limbs, more confident, recognisably same | B | TEEN | shows Stage-1 portrait + "Evolves From \<Stage 1\>" |
| Stage 3 | powerful, dynamic, large silhouette, epic, still recognisable | C | FINAL | shows Stage-2 portrait + "Evolves From \<Stage 2\>" |

Evolution must feel natural — **never** medieval warriors. QA enforces the stage-lock (Stage 1 must not carry a previous stage; Stages 2–3 must name theirs).

### 6.2 Display-name lexicon — 🔴 OPEN-04
The schema stores neutral codes (`stage1/2/3`). Two competing display vocabularies exist and are load-bearing (QA warns on mismatch, and they print on-card / on the site):
- **Life-stage words:** `BABY / TEEN / FINAL` (on-card, current).
- **Plan's stage names:** `Origin / Ascendant / Apex` (proposed for `stage_display_names`).

Founder must **lock the words** (and the phase names, incl. the audit's "Quest Phase" rename) — a **blocking deliverable before the first proxy sheets** are considered final.

### 6.3 Families — 🟡 DRAFT
- **18 evolution lines** (`vq_families` / the family registry), 3 families per element × 6 elements = 18.
- Registry status flags: F01–F12 (Flame/Water/Nature/Storm) `LOCKED_NAME_DIRECTION`; F13–F18 (Stone/Shadow) `NEW_SUPPORT_FAMILY`.
- 🔴 **OPEN-12 — family anchor-naming is inconsistent:** the "Family" name is sometimes the Stage-1 name (F01 Flammi), sometimes Stage-3 (F08 Rooterra, F14 Crystalux), sometimes neither (F05 Aquorun). Lock one convention — it drives DB family keys and public display.

---

## 7. Card template — 🔒 LOCK (permanent, hash-verified)

### 7.1 Physical geometry — 🔒 LOCK
| Property | Value |
|---|---|
| Canvas (with bleed) | **69 × 94 mm** |
| Trim (finished) | **63 × 88 mm** (standard TCG size) |
| Bleed | **3 mm** all sides |
| Safe live area | x6 y6, 57 × 82 mm |
| Preview render | **300 DPI** PNG |
| Print master | **600 DPI** PNG → embedded full-bleed in PDF |
| Front QR / NFC | **Prohibited** (`front_qr_nfc_allowed=false`) — scan/verify is back-only |

### 7.2 The 29-zone immutable grid (Z00–Z28) — 🔒 LOCK
The Standard Creature card is a fixed grid of 29 zones (mm). **Coordinates never move — only data and artwork change.** Verified by `coordinate_map_sha256 = 4c84fbe9959167f89fd9b0ffdcb7d9f39283853102f8cc1821e7fd36226521db`, byte-identical across v1.1/v1.2/v1.2.1, and re-hashed at every build.

Key zones: Z04 stage `6,6,10×10` · Z05 prev-portrait `6,17,9×9` · Z06 name `17,6,29×6` · Z07 crest `58,6,5×5` · Z08 Health `47,6,10×5` · Z09 Guard `47,12,8×4` · Z10 Shift `56,12,7×4` · Z11 Evolves-From `17,12,29×4` · Z12 main art `6,17,57×35` · Z13 meta `6,53,57×5` · Z14 Attack 1 `6,59,57×11` (Z15 Core cost / Z16 name / Z17 dmg / Z18 effect) · Z19 Attack 2 `6,71,57×11` (mirror) · Z24 Vulnerability `6,83,14×4` · Z25 Rarity `21,83,5×4` · Z26 Collector `27,83,20×4` · Z27 Edition/Year `48,83,15×4` · Z28 Copyright `6,88,57×3`.

**Text never resizes a zone.** Overflow is handled by font-size laddering (name 4.0→2.8 mm, attack name 2.6→2.0, vulnerability 1.7→1.0, effect 1.35→1.1); if effect text still exceeds **2 lines** at min size it **throws `ZoneOverflowError` → QA reject** (the grid stays fixed).

### 7.3 Template versions — 🔴 OPEN-05 (version reconciliation)
| Ver | Where | Notes |
|---|---|---|
| **v1.1** | CLI path (`template.ts`) | Original. **Has defects** (Vulnerability box overlap; copyright drawn at y=90.2 outside any zone; attack effect a single unwrapped line). Kept for comparison only. |
| **v1.2** | — | Style-only over identical zones: heavy outlines/boxes removed, soft element-tinted chips, measured text-fit, 2-line effect wrap, copyright moved into Z28. |
| **v1.2.1** | **Server path (default, live)** | v1.2 **+ square outer frame corners** (radius 2.2→0). This is what the admin studio and the 90-card proxy set render. |

Two live template versions can drift (CLI v1.1 vs server v1.2.1). **Decision:** ratify **v1.2.1 as the sole canonical template** and retire v1.1 from the build path (comparison-only).

### 7.4 Support-card template — 🟡 DRAFT
Tactic / Relic / Vault cards render through a **separate** template (`template-support.ts`) with its own zone set that **never** references the creature grid — it shares only outer geometry (69×94 / 63×88 / 3 mm) and the footer y-line. Effect panel currently prints a placeholder ("effect text pending playtest").

### 7.5 Card **back** — 🔴 OPEN-10 (coverage gap)
**No card-back design exists anywhere** in code or docs. The audit flagged a self-contradictory back "lock" (single universal back vs a distinct Core side-deck back; bold-V/keyhole vs its own 180° rule). Must be defined or explicitly deferred before print/Kickstarter assets.

---

## 8. Game design & rules — 🟡 PLAYTEST LOCK v0.1 (source: `VQ_RULES_v0.1_PLAYTEST_LOCK`, folded in 2026-07-08)

> Rules v0.1 are now on disk and folded into this spec. **Status: PLAYTEST LOCK — not final print approval.** The values are locked *for playtesting* and will change through Kill-Gate playtests before print. Canonical rules body is copied to `client/src/content/vault-quest-rules.md` (30 sections) for the Phase 6 rules page; canonical numbers live in `vq_game_config` (§11). This resolves OPEN-06 and OPEN-07.

### 8.1 Objective / win condition — ✅ OPEN-06 RESOLVED (playtest lock)
Win by claiming **5 Seals**. Seals are claimed by **Knocking Out** opposing Creatures — a KO of a Baby/Teen claims **1 Seal**, a KO of a **Final/Stage 3** Creature claims **2 Seals**. (`seal_count_to_win=5`, `final_ko_seal_value=2`.) Also: if you cannot place an Active Creature when required, you **lose** (empty-board loss, §27–28).

### 8.2 Core economy / resource — ✅ OPEN-07 RESOLVED (playtest lock)
Each player has a **Core Bank**, cap **10** (`core_cap=10`), starting with **1** unlocked Core (`starting_core=1`). **Core Phase:** unlock **1** more Core (up to cap). **Ready Phase / start of turn:** all unlocked Core **readies** and can be spent again. **Attacking needs no Core** by default; an attack only costs Core if the attack itself prints a cost (so most `attack_cost` values are legitimately 0).

### 8.3 Turn sequence — 🟡 playtest lock
**Ready → Draw → Core → Action → End.**
- **Ready:** ready all exhausted cards + all unlocked Core.
- **Draw:** draw 1 (first player skips their first Draw — `first_player_skips_first_draw=true`).
- **Core:** unlock 1 Core (≤10).
- **Action:** play cards, Ascend, use effects, Shift, attack.
- **End:** resolve end-phase effects; clear "until End Phase" effects.

### 8.4 Creatures, Ascend & Shift — 🟡 playtest lock
- **Start:** 1 Baby/Stage 1 Active Creature + up to 2 Babies in Reserve (`reserve_slots=2`).
- **Ascend:** Baby→Teen costs **2 Core** (`stage_2_ascend_cost`), Teen→Final costs **4 Core** (`stage_3_ascend_cost`). Not on the turn the Creature entered play or already Ascended. On Ascend: draw 1. Damage carries over; statuses clear; attached Relics stay unless stated.
- **Shift:** once per turn, pay the Creature's **Shift** cost to swap Active with a Reserve Creature.

### 8.5 Combat — 🟡 playtest lock
- **Health:** damage counters persist; damage ≥ Health → **Knock Out**.
- **Guard:** reduces incoming damage by its value (printed). "Guard Broken" ignores Guard until End Phase.
- **Vulnerability:** if the attacker's element matches the defender's Vulnerability, **+2 damage** (`vulnerability_bonus_damage=2`).
- **Knock Out:** discard the Creature + cards under it; attacker claims Seal(s); defender draws 1.

### 8.6 Deck / hand / misc — 🟡 playtest lock
Deck **40** (`deck_size`), up to **4** copies per card name (`copy_limit`), up to **2 elements** (Neutral exempt) (`max_elements`). Opening hand **5** (`opening_hand`); mulligan if no Stage 1 (opponent draws 1 per mulligan). Ties: more Seals wins; if tied, the player whose turn it is loses.

### 8.7 Still open (not in v0.1)
- **Statuses** (§8-adjacent) — v0.1 references clearing statuses on Ascend but does not enumerate the launch statuses. 🔴 OPEN (2–3 launch statuses TBD).
- **Keywords** roster + the pending **Guard→Brace/Ward** rename (OPEN-14) — v0.1 keeps "Guard" as the printed term.
- **Effects/attack text** for the cards themselves — comes with the 150-card master (OPEN-19), not the rules doc.
- These are **playtest-locked, not print-final** — subject to Kill-Gate 1 playtesting before any print/Kickstarter.

---

## 9. Canonical card data model — ✅ OPEN-13 resolved (canonical = 150-card master)

### 9.0 Canonical set: `VQ_GENESIS_VAULT_MASTER_SET_LIST_v1.0` — 🟡 received 2026-07-08
- **150 cards** (`001/150`–`150/150`), **12 families** (Option B reconciliation, locked names: Flammi, Aquabub, Leafee, Zappi, Rocko, Galaxi, Windo, Voltex, Crystalux, Shadowix, Rooterra, Aquorun).
- **It is a SET LIST, not a gameplay dataset.** Columns: collector_number, card_id, name, display_name, card_type, element, family_id, family, stage_number, stage_role, rarity, variant_tier, source_base_card, gameplay_status, art_status, generation_priority, notes. **No stats/effects** (health/guard/shift/vulnerability/attacks) — those are authored later (**OPEN-20**).
- **Composition:** 120 Creature + 11 Tactic + 11 Relic + 6 Collector + 2 Place. **60 base + 90 alt-rarity VARIANTS** (variant_tier SRA/CHR/FSR/UR/CR, linked to base via `source_base_card`).
- **Element taxonomy is ~15** (Blaze/Tide/Blossom/Spark/Earth/Cosmos/Wind/Electric/Ice/Dark/Water/Light/Brand/Crystal/Neutral) — the render engine has palettes/crests for only **7** (**OPEN-21**).
- **Import status:** imports cleanly as **150 draft shells** (structure mode; `server/vault-quest/seed.ts`). Cannot render/approve/play until OPEN-20/21/22/23 are resolved. Schema lacks `variant_tier`/`base_card_id` (**OPEN-22**); card types Collector/Place + variant rarity tiers not yet in enums (**OPEN-23**).

### 9.1 DEPRECATED reference set: 90-card `…SET001_90_CARD_MASTER` — ⛔ playtest reference only (not canonical)
- **90 cards**, numbered `001/090`–`090/090`, IDs `GNV-001`–`GNV-090`. Every row `Gameplay Status = PLAYTEST_DRAFT`.
- **By type:** Creature 54 · Tactic 18 · Relic 12 · Vault 6.
- **By element:** Flame/Water/Nature/Storm/Stone/Shadow 13 each + Neutral 12 (support-only).
- **By rarity:** C 32 · U 30 · R 23 · SR 3 · GR 1 · UR 1. Creature rarity is stage-tied (S1=C, S2=U, S3=R); SR/GR/UR only on support (GR = Genesis Token 084, UR = Genesis Gate 090).
- **Stat scale (uniform across all 18 lines):** S1 Health 5 / Guard 0 / Shift 0 · S2 8/1/1 · S3 12/3/2.
- **Vulnerability map:** Flame→Water, Water→Storm, Nature→Flame, Storm→Nature, Stone→Nature, Shadow→Light (Light is text-only, not an element).
- **Art:** all placeholder (85 art-missing warnings). Creatures 001–036 `REFERENCE_APPROVED`, 037–054 `NEEDS_FAMILY_SHEET`, support 055–090 `TEMPLATE_NEEDED`.
- **Effects/attack-cost text: MISSING** for the whole set — the 90-card master CSV has no cost/effect columns; support cards have no gameplay data at all. **All effect text is TODO** and needs founder-approved wording.

### 9.2 Two conflicting datasets — 🔴 OPEN-13 (blocks P3 Database)
The same Flammi line exists twice with contradictory schemas/scales:

| | Master `…90_CARD_MASTER_v1.0.csv` (as-built) | `cards_sample.csv` (richer) |
|---|---|---|
| Element name | **Flame** | Blaze |
| Health S1/S2/S3 | **5 / 8 / 12** | 70 / 120 / 180 |
| Set size | **/090** | /150 |
| Rarity | C/U/R | includes **`RR`** (outside the ladder) |
| Attack cost / effect | **none** | present |

**Founder must lock one canonical schema, stat scale, set size (90 vs 150), and rarity ladder** before any DB push. *(Note: the `vq_cards` DB schema (§12) is effectively the reconciled superset — it uses the master's `Flame`/`/090` naming **and** carries `attack1_cost`/`attack1_effect` columns like the sample.)*

---

## 10. Terminology & namespace register — 🔴 OPEN-14

Audit consensus critical: several terms are overloaded or borrowed, and are now hard-coded as printed labels / enum values / schema columns, so a rename is a schema + template + data migration, not a text edit.

| Term | Collisions | Status |
|---|---|---|
| **Vault** | brand ("Vault Quest"), set ("Genesis Vault"), a `card_type` value | 5–7 meanings — **OPEN** |
| **Core** | attack-cost resource, `core_cap` config, relic "Core Ring" | ×4 — **OPEN** |
| **Guard** | creature stat + "Guardian"; pending rename **Guard→Brace/Ward** | **OPEN** |
| **Shift** | creature stat — a **Lorcana signature term** | **OPEN** |

Decide keep-or-rename for each before the schema/template lexicon is treated as permanent.

---

## 11. Rules-as-data & game config — 🔴 OPEN-15

**Principle (🔒 LOCK):** every playtest-sensitive number lives in `vq_game_config`, never in code; a rules change is a *republish*, not a code change. (Audit's highest-leverage digital decision.)

**Canonical seed values — 🟡 PLAYTEST LOCK (source: `VQ_GAME_CONFIG_v0.1.csv`, folded in 2026-07-08; resolves OPEN-15):**
`deck_size=40 · opening_hand=5 · copy_limit=4 · max_elements=2 · seal_count_to_win=5 · core_cap=10 · starting_core=1 · reserve_slots=2 · stage_2_ascend_cost=2 · stage_3_ascend_cost=4 · final_ko_seal_value=2 · vulnerability_bonus_damage=2 · first_player_skips_first_draw=true`. All marked `LOCKED_FOR_PLAYTEST`. These seed `vq_game_config` at Phase 3 (still gated behind the DB-push approval). `stage_display_names` (Origin/Ascendant/Apex) remain OPEN-04.

**Field-level print validators (🔒 LOCK, `shared/vq-validate.ts`):** card name ≤25 · attack name ≤18 · cost ≤6 · health 3–12 · damage 1–4. *(Note the built stat scale in §9.1 sits inside these caps; the sample's 70–180 health does not.)*

> ⚠️ **DB-migration discipline:** these keys must not be seeded with assumed values while the win condition (OPEN-06) and Core rule (OPEN-07) are undefined.

---

## 12. Database architecture & isolation — 🔒 LOCK (best-executed part of the build)

### 12.1 Isolation contract — 🔒 LOCK (safety-critical, non-negotiable)
- **Separate Drizzle config** `drizzle-vq.config.ts` with **`tablesFilter: ["vq_*"]`**, `out: ./migrations-vq`, `schema: ./shared/vq-schema.ts`. It throws if `MINTVAULT_DATABASE_URL` is unset. **`drizzle-vq.config.ts` and `drizzle.config.ts` must NEVER be merged** — a combined push would propose **DROPs** of grading tables because the live DB has drifted from `shared/schema.ts` (e.g. `cert_counter` exists in the DB but not the schema).
- Push command is always `npx drizzle-kit push --config drizzle-vq.config.ts` — **never** `npm run db:push`.
- **Zero foreign keys** to grading tables (relationships are soft, by text business keys) → CASCADE-safe rollback (rollback = DROP the 7 `vq_` tables + optional `aws s3 rm vq/`).
- **Copy, don't import:** VQ imports nothing from `server/labels.ts`, the MVGS grading system, `server/stripeClient.ts`, or the payment flow. Techniques are duplicated so the module stays liftable.
- **Shared Neon DB, `vq_`-prefixed tables only. Shared R2 bucket, `vq/` prefix only. No new secrets.**
- **12-point extraction manifest** (the only sanctioned shared touch-points): `requireAdmin`, `storage.writeAuditLog`, `uploadToR2()/getR2Buffer()`, multer memory config, rate-limiter pattern, SEO meta, sitemap block, App.tsx lazy routes, admin nav entry, the separate Drizzle config, the shared Postgres DB, the shared `mv.sid` admin session cookie. Any new touch-point must be added to the manifest first.
- **Lift-out trigger:** if VQ ever needs public accounts of any kind, it is lifted into its own app *before* those accounts are built.

### 12.2 The seven `vq_` tables — 🔒 LOCK (as-built in `shared/vq-schema.ts`; migration `migrations-vq/0000_next_mister_fear.sql`, **not yet pushed**)
| Table | Purpose / key columns |
|---|---|
| `vq_sets` | `set_code` (UQ), name, year, edition, `rules_version` (def `v0.1`), `card_count`, status |
| `vq_families` | `family_id` (UQ), `set_code` (def GNV), element, name, `stage1/2/3_name`; the 18 lines |
| `vq_cards` | `card_id` (UQ, GNV-001), `collector_number` (001/090), name, `display_name`, `card_type` (Creature\|Tactic\|Relic\|Vault), element, rarity; creature-only nullable: `family_id`, `stage_number`, `life_stage`, `health`, `guard`, `shift`, `attack1_name/cost/damage/effect`, `attack2_*`, `vulnerability`; `keywords` jsonb `[]`; `effects` jsonb (**dormant**); `art/prev_art/render_r2_key`; locked defaults `set_code=GNV, language=EN, year=2026, edition=FIRST EDITION`; `status` def `draft`. Indexes: (set,status), element, card_type |
| `vq_card_revisions` | `card_id`, `revision_json`, `edited_by`, `edited_at` — the git-diff substitute; **prior state snapshotted on every UPDATE** (first insert writes none) |
| `vq_elements` | name (UQ), border, accent, dark, `crest_key` — seeded from `elements.json` |
| `vq_game_config` | key (UQ), value — rules constants (§11) |
| `vq_releases` | version (UQ), `set_code`, `cards_json_r2_key`, `card_count`, `is_current` (**partial-unique: at most one current per set**), `published_at` — compiled cards.json snapshots (Phase 2) |

### 12.3 🔴 OPEN — status vocabulary & DB constraint
- `status` is a **plain text** column (no CHECK/enum) — the DB accepts any string; the three-state lifecycle is enforced only in code.
- **Vocabulary mismatch:** the plan documents `draft → ready → published`; the as-built code (`storage.ts`, admin) uses **`draft → approved → published`**. **As-built truth = `approved`.** Reconcile the plan's wording (and consider adding a DB CHECK constraint).

### 12.4 Push status — 🟡 DRAFT / gated
`VQ_DB_R2_ACTIVATION.md` is *plan only — nothing has been run.* Staging push (`ep-purple-voice-abfez796`) is the first activation step; production push is **founder-watched and gated behind `safe-deploy.sh` being present** (§21). See **db-migration-discipline**.

---

## 13. Rendering & print production engine — 🟡 DRAFT (built, unratified specifics)

**Pipeline (server, pure & liftable — no DB/R2 inside; callers pass art buffers in):**
`RenderCardInput (camelCase) → apply VQ_LOCKED_CONSTANTS → warm embedded crest + art buffers → Gate 1 data QA → render SVG (creature `cardSVG_v121` or `cardSVG_support`) → Gate 2 rendered-SVG scan → rasterise (300 preview / 600 master) → PDF.` Any reject short-circuits with **no images produced.**

**Outputs:** SVG (vector source of truth) · preview PNG (300 DPI) · master PNG (600 DPI) · print PDF (69×94 mm page, 600-DPI master full-bleed, hairline 0.25 pt crop marks in bleed corners).

**QA gates (🔒 LOCK — anti-Pokémon differentiation):**
- **Banned (reject):** `HP`, `Pokémon`/`Pokemon`, `Weakness`, `Resistance`, `Retreat`, `GV1`, `2025`. Front-only: `QR`, `NFC`, `scan to/me`.
- **Required lexicon:** Health, Guard, Shift, Core, Ascend, Vulnerability.
- **Creature rejects:** missing required field · `set_code≠GNV` · `year≠2026` · id not `GNV-` · unknown element · stage∉1–3 · stage-lock breach · effect >2 lines at min size.

**🔴 OPEN — print master format (OPEN-16):** the PDF embeds a **600-DPI raster** in a plain pdfkit doc — **no vector text, no PDF/X-4 profile, no ICC.** Audit recommends **vector-first PDF/X-4** for the print house. Fine for proxies; a decision before commercial print.

**Proxy sheets (🔒 LOCK spec):** A4, 3×3 = 9 cards/page, cards cropped to true **63×88 mm**, guillotine cut ticks, footer `PLAYTEST PROXY — NOT FINAL PRINT · Genesis Vault (GNV) · Rules v0.1 · exported <date> · page N/N`.

**🔴 Crests must ship as SVG** (OPEN-03) — emoji do not rasterise.

---

## 14. Admin VQ Studio — 🟡 DRAFT (built, partial)

**Route:** `/admin/vault-quest` ("VQ Studio"), lazy-loaded, server-side `requireAdmin` (reuses `mv.sid`; no new portal). Nav entry in `admin-shell.tsx` (**icon = Swords → must change, §2.1**).

**API (all `requireAdmin`, additive — registered once in `routes.ts`):**
| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/vault-quest/config` | elements + gameConfig (falls back to `{}`) |
| GET | `/api/admin/vault-quest/cards` | filters setCode/status/cardType/element — **DB-dependent** |
| GET | `/api/admin/vault-quest/cards/:cardId` | 404 if missing |
| POST | `/api/admin/vault-quest/cards` | save; **422 if approving a QA-reject card** |
| POST | `/api/admin/vault-quest/cards/preview` | **DB-free** live preview PNG |
| POST | `/api/admin/vault-quest/cards/export/:fmt` | svg\|png\|pdf; **DB-free**; 422 on reject |
| POST | `/api/admin/vault-quest/cards/:cardId/art` | magic-byte guard → `vq/art/{cardId}/{main\|prev}.png` |

**Built:** editor form (identity + creature stats, hidden for support) · 400 ms debounced live preview · SVG/PNG/PDF export · art upload · QA surfaced inline · two-layer approve gate.

**Not built / 🔴 gaps:** **Edit-a-card is unimplemented** (row click only refetches) · no tabbed workspace (Families/Sets/Elements/Bulk-import/Proxy-sheet tabs absent) · **no attack-cost input** in the form · save/list/get/upload **never runtime-exercised** (tables not pushed; local DB/R2 unreachable) · export path shape deviates from the plan (POST body vs GET `:id/export.fmt`) — accepted deviation.

---

## 15. Public website, publish pipeline & SEO — 🟡 DRAFT (schema only, no routes built)

**Public routes (🔒 planned list):** `/vault-quest` (landing) · `/learn` · `/rules` · `/cards` + `/cards/:slug` · `/glossary` · `/sets/:code` · `/characters/:slug` · `/deck-builder` · `/decks/:code` · `/play` (Practice vs AI — hard-gated on Kill Gate 1). Every page composes the existing `HeaderV2`/`FooterV2`, `SectionEyebrow`, `AmbientLayer`, `SeoHead`.

**Publish pipeline (🔒 design, built Phase 2 first session):** validate `status='approved'` cards → compile a **frozen versioned `cards.json`** (cards + keywords + statuses + game config + rules body) → `uploadToR2 vq/releases/{v}/cards.json` → insert `vq_releases` row (sha256) → flip `is_current`. **Nothing draft reaches the public site.** Public card DB fetches exactly one file (`cards.json`, <1 MB target), all search/filter client-side.

**Security/SEO locks:** assets served **by card ID, never by R2 key** (`GET /api/vault-quest/assets/:cardId/{art|render}`; the VQ bucket also holds private grading photos) · SSR meta is slug-derived (the injector can't read the DB) · sitemap VQ block wrapped in try/catch so a failure emits the existing static sitemap unchanged · **analytics cookieless only.**

**🔴 OPEN-17 — sub-brand header:** keep MintVault `HeaderV2`/`FooterV2` on VQ pages, or introduce a VQ-branded header variant (first Phase 1a styling decision; ties to OPEN-01/§2.3).

---

## 16. Deck builder & deck codes — 🔒 LOCK (design)
- **Validation 100 % config/JSON-driven** (deck 40, copy-limit 4, max 2 elements, exactly-one Vault card *once that type is defined*, Core cards excluded from count). **Persistence: `localStorage` only — no server write, no exceptions.**
- **Deck code format:** `VQ1.<release-version>.<base64url payload>` — decodable entirely from `cards.json`, renders with zero DB reads. `vq_shared_decks` is **struck** (not deferred).

---

## 17. Effects vocabulary & the Oracle Round-Trip Gate — 🔒 LOCK (press-day prerequisite; machinery Phase 4)
- Cards store **founder-typed plain `oracle_text`** + a `keywords[]` multi-select for now. The `effects` jsonb column **ships dormant day one.**
- **🔒 THE ORACLE ROUND-TRIP GATE:** *no card art is print-locked and no Kickstarter launches until every card's text round-trips through the structured effects vocabulary* — effects entered as data → generator produces `generated_oracle_text` → any card whose display text differs is flagged `oracle_overridden` → Publish surfaces every override with a side-by-side diff requiring per-card approval. Free-typed text is fine for playtest, **never for print.** Binds even if the browser game is descoped.

---

## 18. Game engine & playtesting — 🟡 DRAFT (GATED behind Kill Gate 1)
- **🔒 Kill Gate 1:** engine code does not start until **30+ blind external playtests** where strangers finish unaided and **>50 % want to replay.** *The blocker is cardboard, not code.*
- **Engine (committed design):** `shared/vault-quest/engine/` — deterministic pure TS, command/event split, seeded RNG, `legalMoves(state)` single API, property tests (no negative health, seals only via KO, game terminates, Core never exceeds cap). AI = greedy heuristic over `legalMoves()`, no ML. `/vault-quest/play` is account-less.

---

## 19. Security, assets & R2 isolation — 🔒 LOCK
Shared R2 bucket, **`vq/` prefix only** (`vq/art/{cardId}/…`, `vq/renders/…`, `vq/releases/…`); never touches `images/{certId}/` customer photos. Upload **magic-byte validation** via `sharp` (spoofed Content-Type can't pass; png/jpeg/webp; min 64×64). Public asset route serves **by ID, 404 on unknown/null**. Verification is **runtime against the built bundle**, never by source-reading (the esbuild tree-shake lesson).

---

## 20. Build phases, roadmap & gates

**Directive P1–P10 mapped to the plan's finer 1a/1b/2/3/4:**

| Directive phase | Plan | Status |
|---|---|---|
| **P1 Foundation** | *this master spec* | 🟢 **this document** — awaiting approval |
| **P2 Design System** | tokens/components | ✅ **v0.1 done** (2026-07-08) — tokens + component library built, reviewed, tsc clean, unwired. Open: OPEN-02 (type), OPEN-18 (neon hue), OPEN-11 (gold hex), OPEN-03 (element roster) |
| **P3 Database** | 1a schema (built), staging push | 🟡 built, **not pushed**; blocked on OPEN-13 canonical data + safe-deploy |
| **P4 Admin Studio** | 1b VQ Studio | 🟡 partial (§14) |
| **P5 Rendering Engine** | render + proxy + print | 🟡 built; OPEN-16 print format |
| **P6 Public Website** | 1d landing/learn/rules/cards | 🔲 not built; blocked on rules text (§8) |
| **P7 Deck Builder** | Phase 3 | 🔲 designed (§16) |
| **P8 Release Pipeline** | Phase 2 first session | 🔲 designed (§15) |
| **P9 Playtesting** | proxy/Kill Gate 1 | 🟡 proxies build; playtest protocol TODO |
| **P10 Future Systems** | design-only | 🔲 roadmap only (accounts, AI, marketplace, organised play) — **do not implement** |

**Kill/Kickstarter gates (audit):** Gate 1 (30+ blind playtests) → UK Games Expo → £30–45k Kickstarter gate; spend caps £5k / £10k / £35k. **Explicitly NOT built (cut, not deferred):** player accounts, collections, matches, tournaments, consent records, community/forum, matchmaking. **Named deferrals:** `vq_card_printings` split (2nd printing), `vq_rulings` (Phase 3+), localisation tables, formats/legalities.

---

## 21. Deploy discipline & safety — 🔒 LOCK
- **`scripts/safe-deploy.sh` is the only deploy path — never raw `fly deploy`.** It is **absent on `main`** (lives on `routes-split`, commits `94e9938`/`9fc70a1`) and must be merged/cherry-picked before any VQ deploy. **If it's absent on the working branch, STOP.**
- Staging first; **production schema push and code deploy are founder-watched and serialized** (see `mintvault-concurrent-session-discipline`).
- Rules/learn pages must always render a **`Rules v0.x — open playtesting, rules will change`** badge; never present draft rules as final.
- **Zero new npm dependencies** for phases 1a–2 (canvas, pdfkit, qrcode, sharp, drizzle, zod, multer, R2 SDK already present). Any later dep is an approval item.

---

## 22. Deferrals & explicitly-not-built
See §20. Recorded here so they read as **deliberate deferrals, not omissions:** `card_printings` split · rulings · localisation · formats/legalities · shared-decks (struck) · all account/collection/match/tournament tables and pages · the effects-vocabulary machinery (Phase 4 step 1).

---

## 23. Open Decisions Register — 🔴 (ranked; every item needs founder sign-off)

| # | Decision | Blocks | Severity |
|---|---|---|---|
| ~~**01**~~ | ✅ **RESOLVED 2026-07-08** — Option B: card faces stay element-coloured; navy foundation for brand/UI/card-back/website; gold reserved for premium/rarity | — | ✅ done |
| ~~**06**~~ | ✅ **RESOLVED 2026-07-08** — Rules v0.1 (playtest lock): win by 5 Seals via KO, Final KO = 2 Seals. Folded into §8. | — | ✅ done (playtest lock) |
| ~~**07**~~ | ✅ **RESOLVED 2026-07-08** — Core economy defined: cap 10, start 1, unlock 1/turn, readies each Ready Phase; attacks free unless printed. §8.2. | — | ✅ done (playtest lock) |
| ~~**15**~~ | ✅ **RESOLVED 2026-07-08** — `game_config` canonical values from `VQ_GAME_CONFIG_v0.1.csv` (§11). Seed still gated on DB push. | — | ✅ done |
| ~~**13**~~ | ✅ **RESOLVED 2026-07-08** — canonical = 150-card master `VQ_GENESIS_VAULT_MASTER_SET_LIST_v1.0` (001/150–150/150), Option B family reconciliation, locked creature names; 90-card set deprecated (playtest reference only) | — | ✅ done |
| **19** | ⛔ **150-card master file not on disk** — the canonical source doesn't exist in repo/Downloads/zips; must be uploaded before any seed. Do not invent the missing cards. | P3 seed, publish, proxies, P6 | 🔴 **blocker (needs upload)** |
| **03** | **Element roster** — dedupe 18→final set, colour-blind-safe palette, 1:1 element→crest (add Neutral crest, fix `blaze`) | P2, render correctness, brand | 🔴 high |
| **14** | **Namespace** — keep/rename Vault-type / Core / Guard(→Brace/Ward) / Shift | schema, template lexicon, card data, public terms | 🔴 high |
| **04** | **Stage/phase/keyword display names** (BABY/TEEN/FINAL vs Origin/Ascendant/Apex + phase names) | first proxy sheets, learn/rules, rendering | 🔴 high |
| **02** | **VQ typography lock** (card + web) | P2 Design System | 🔴 medium |
| **05** | **Template-version reconciliation** — ratify v1.2.1 as sole canonical, retire v1.1 from build path | render consistency | 🔴 medium |
| **08** | **Primary audience** (adult-collector-and-family vs children 8+) + set-size intent | toy-safety/Children's Code, accounts stance | 🔴 medium |
| **09** | **Publishing identity + authenticate-never-grade policy + trademark clearance** | any crossover page, edition/year permanence, launch | 🔴 medium |
| **10** | **Card-back design** (or explicit deferral) | print, proofing, Kickstarter assets | 🔴 medium |
| **11** | **Rarity ladder meaning** (C/U/R/SR/GR/UR) + confirm gold confined to SR+/Founder/Promo | colour system, premium treatment, print | 🔴 medium |
| **12** | **Family anchor-naming convention** (founder chose "Option B" — definition arrives with the 150-master registry) | DB family keys, public display | 🔴 low |
| **16** | **Print master** — 600-DPI raster PDF vs vector-first PDF/X-4 + ICC | commercial print | 🔴 low |
| **17** | **Sub-brand header** on VQ pages | Phase 1a styling, brand separation | 🔴 low |
| **18** | **Neon accent hue** for the glow/energy-line visual language (a 5th colour beyond the locked 4; currently proposed `#4EA8FF` in the tokens) | Phase 2 neon-background system | 🔴 low |
| **—** | **Status vocab** — reconcile plan's `ready` vs as-built `approved` (+ optional DB CHECK) | doc accuracy | 🔴 low |
| ~~**—**~~ | ✅ **DONE 2026-07-08** — sword nav icon swapped for `Sparkles` (`admin-shell.tsx`) | — | ✅ done |

---

## 24. Phase 1 approval checklist & change log

### Phase 1 (Foundation) exit checklist
- [ ] This spec read and its **LOCK / DRAFT / OPEN** framing accepted.
- [ ] **OPEN-01 (colour)**, **OPEN-06 (win condition)**, **OPEN-13 (canonical data)** — the three blockers — acknowledged as the gate before P2/P3.
- [ ] Confirmation that the **card template geometry (§7)** and **DB isolation (§12)** are ratified as LOCKs as-is.
- [ ] Founder begins the **paper-design critical path** (§8 rulebook v0.x + win condition), which no code session unblocks.
- [ ] Agreement that **no further Vault Quest development proceeds until this spec is approved** (directive Phase-1 rule).

### Change log
| Date | Change | By |
|---|---|---|
| 2026-07-08 | Master Spec v1.0 created from full inventory of all VQ artifacts + the `VQ_CARD_BUILDER_v0.1` pack + build plan + audit. No code changed. | Claude |
| 2026-07-08 | **OPEN-01 resolved** (founder ruling): card faces stay element-coloured; navy foundation; gold reserved (Option B). §1/§3.1/§3.3 updated. | Founder + Claude |
| 2026-07-08 | **Sword nav icon swapped** `Swords`→`Sparkles` (`admin-shell.tsx`) — brand avoid-list compliance. | Claude |
| 2026-07-08 | **Phase 2 token foundation built** — `client/src/vault-quest/design-tokens.css` (isolated, unwired). §3.4 added. New OPEN-18 (neon hue). | Claude |

---

*End of VAULT_QUEST_MASTER_SPEC_v1.0.md — the single source of truth. Update this document at the end of every phase (directive §Quality Control).*
