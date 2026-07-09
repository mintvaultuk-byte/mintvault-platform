# VAULT QUEST — OPEN ITEMS (approval / decisions required)

Every item here needs a founder decision before it can become permanent. Mirrors the Open Decisions Register in `VAULT_QUEST_MASTER_SPEC_v1.0.md` §23, plus build-time approval gates. **Do not guess past these — build a placeholder and log it.**

**Legend:** 🔴 blocker · 🟠 high · 🟡 medium/low · ✅ resolved · ⛔ hard approval gate (safety)

| # | Item | Blocks | Status |
|---|---|---|---|
| 01 | Colour direction (navy vs element card faces) | P2 | ✅ resolved 2026-07-08 (card faces exempt) |
| 06 | ✅ **RESOLVED 2026-07-08** — Rules v0.1 folded in (win by 5 Seals via KO, Final KO = 2). §8. | — | ✅ playtest lock |
| 07 | ✅ **RESOLVED 2026-07-08** — Core economy defined (cap 10 / start 1 / +1 per turn / readies). §8.2. | — | ✅ playtest lock |
| 15 | ✅ **RESOLVED 2026-07-08** — `game_config` canonical values from `VQ_GAME_CONFIG_v0.1.csv`. §11. Seed still gated on DB push. | — | ✅ resolved |
| 13 | ✅ **RESOLVED 2026-07-08 (founder)** — canonical = 150-card master `VQ_GENESIS_VAULT_MASTER_SET_LIST_v1.0` (001/150–150/150), Option B family reconciliation, locked creature names. 90-card set = **deprecated / playtest reference only**, must not be seeded. | — | ✅ resolved |
| 19 | ✅ **RESOLVED 2026-07-08** — 150-card master received (`~/Downloads`, 150 rows + Option B reconciliation, 12 families). Imports as 150 draft shells (structure mode). | — | ✅ file received |
| 20 | ✅ **RESOLVED 2026-07-08** — base creatures seeded with the 90-card starting stat scale (S1 5/0/0, S2 8/1/1, S3 12/3/2); variants inherit from base; effects/final balance authored in Card Studio. No invented balance. | — | ✅ resolved |
| 21 | ✅ **RESOLVED 2026-07-08** — all 15 elements registered with placeholder palettes; 13 new ones flagged `VQ_ELEMENTS_NEEDS_APPROVAL` + render a vector-diamond placeholder crest (never emoji). Renderer warns NEEDS_APPROVAL, never blocks. Verified: Blaze/Cosmos/Brand/Crystal render to PNG. Real final palettes/crests still need founder sign-off. | — | ✅ resolved (placeholders pending final approval) |
| 22 | ✅ **RESOLVED 2026-07-08** — `variant_tier` + `base_card_id` added to `vq_cards`; migration `migrations-vq/0001_equal_iron_fist.sql` **generated offline (not pushed)**; importer links 84 variants to base. | — | ✅ resolved (migration awaits push) |
| 23 | ✅ **RESOLVED 2026-07-08** — card types `Collector`/`Place` added (route to support render) + rarity tiers `SRA`/`RR`/`FSR`/`CR` added, across `vq-validate.ts`, render `SUPPORT_TYPES`, `qa.ts`, and the Studio dropdowns. Renderer handles all values without crashing (verified). | — | ✅ resolved |
| 12 | Family anchor-naming — founder chose **"Option B"**, but the A/B option scheme isn't defined in our records; it should arrive with the 150-card master's family registry. Confirm the Option-B definition when the file lands. | DB family keys, P6 display | 🟠 open (pending file) |
| 03 | Element roster + colour-blind-safe palette + crest 1:1 (no Neutral crest; `blaze` orphan) | P2 element tokens, render | 🟠 open |
| 14 | Namespace (Vault / Core / Guard / Shift) | schema, lexicon, data | 🟠 open |
| 04 | Stage/phase/keyword display names (BABY/TEEN/FINAL vs Origin/Ascendant/Apex) | proxies, P6, render | 🟠 open |
| 02 | **VQ typography family** (card + web) | P2 components final | 🟡 open (placeholder in tokens) |
| 05 | Template-version reconciliation (ratify v1.2.1 sole) | render consistency | 🟡 open |
| 08 | Primary audience + set size (90 vs 150) | toy-safety, accounts | 🟡 open |
| 09 | Publishing identity + authenticate-never-grade + trademark clearance | crossover page, launch | 🟡 open |
| 10 | Card-back design (or defer) | print, P8 assets | 🟡 open |
| 11 | Rarity ladder meaning + confirm gold hex (`#C9A227` proposed) | colour, print | 🟡 open |
| 16 | Print master (600-DPI raster vs PDF/X-4) | commercial print | 🟡 open |
| 17 | Sub-brand header on VQ pages | P6 styling | 🟡 open |
| 18 | Neon accent hue (`#4EA8FF` proposed — a 5th colour) | P2 neon background | 🟡 open |
| 24 | **Batch-export ZIP needs a dependency** (`archiver` or `jszip`) — per CLAUDE.md rule #5, a new npm package needs founder OK. Single-card export (SVG/PNG/PDF) + DB proxy PDF (pdfkit, no dep) work without it; only the multi-file ZIP pack needs it. | Export Centre batch ZIP | 🟠 approval (dependency) |
| 25 | **Element roster promotion** — which of the 13 `NEEDS_APPROVAL` placeholder elements become "approved" (final palette/crest). Default: placeholder = warn in draft, will block at approve. | approve gate severity | 🟡 open |
| 26 | **Locked numeric stat bounds** (health/guard/shift/damage/cost) from `vq_game_config` — QA currently checks presence, not magnitude. | balance QA enforcement | 🟡 open |
| 27 | ✅ **RESOLVED 2026-07-08** — export/proxy are now background jobs (POST→jobId→poll→stream), streaming ZIP with async deflate, page-by-page proxy, one-card-at-a-time render off a single batched load, N+1 killed (`getStudioCardsBatch`, 2 queries), deterministic PDFs (`pdf-normalize.ts`) → stable checksums. Verified on staging (full-150 pack 4.2s/proxy 6.4s, peak ~630MB, 2× identical checksums, 15/15 regression). **Residual:** in-process job store assumes single-machine; a multi-machine prod rollout would need a shared store (no new dep/schema added now). | prod deploy of export | 🟢 resolved (single-instance caveat) |
| 28 | **Print colour space** — exports are RGB (no CMYK/ICC). Confirm the print house handles RGB→CMYK, or add an sRGB/ICC path. | commercial print | 🟡 open |
| — | Status vocab `ready` vs as-built `approved` | doc accuracy | 🟡 open |

## Hard approval gates (safety — will STOP here)
- ⛔ **DB push** (staging then prod) — never run without explicit founder approval. Migration generated offline only.
- ⛔ **Production deploy** — never without explicit "deploy" from founder; requires `safe-deploy.sh` present on branch (currently absent on `main`).
