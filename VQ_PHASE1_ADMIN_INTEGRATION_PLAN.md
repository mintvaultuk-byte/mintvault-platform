# Vault Quest — Phase 1 Admin Integration Plan

**Prepared for:** Cornelius · **Date:** 2026-07-07 · **Status:** plan only, no code written.

**What this is:** the plan to move the working standalone Vault Quest builder (`scripts/vault-quest-builder/`, template v1.2.1, 90 cards + proxy sheets, all proven) into the MintVault admin dashboard — cards edited in a form instead of a CSV, art uploaded through the browser, exports and proxy sheets one click away, and public read-only pages — **without touching grading**.

**The one principle:** Vault Quest shares the building (auth, R2, session, one route-registration line) but nothing of the grading business's logic or data. Every shared seam is listed in Section 9 so lift-out to a separate app later stays a bounded job.

**What already exists and gets reused (not rebuilt):** the creature template, the support template, the QA gates (banned tokens, GNV/2026, stage rules, card-size checks), the family-registry evolution join, the CSV importer, PNG/SVG/PDF export, and the A4 proxy-sheet generator. Phase 1 wraps this proven logic in a database + admin UI; it does not re-solve rendering.

---

## Build order inside Phase 1

- **1a — Engine move (no UI):** schema + storage + port the render/QA/export logic to `server/vault-quest/`. Prove a card built from the DB is byte-identical to the CLI build. *No visible change yet.*
- **1b — Card studio:** admin card editor with live preview + artwork upload.
- **1c — Output:** export buttons (SVG/PNG/PDF, full-set zip) + proxy-sheet button.
- **1d — Public:** publish action → compiled `cards.json` → static `/vault-quest` read pages.

Each sub-phase ends with a staging deploy and your review. 1a–1c are admin-only and invisible to customers; only 1d adds public surface.

---

## 1. Database tables needed

All tables are `vq_`-prefixed, defined in a **new** `shared/vq-schema.ts`, pushed with a **separate** `drizzle-vq.config.ts` carrying `tablesFilter: ["vq_*"]`. This is the single most important safety decision — see Section 8.

| Table | Purpose | Key columns |
|---|---|---|
| `vq_sets` | one row per set | `set_code` (GNV), `name`, `year`, `edition`, `rules_version`, `card_count` |
| `vq_families` | the 18 evolution lines (feeds the prev-stage join) | `family_id` (GNV-F01), `element`, `name`, `stage1_name`, `stage2_name`, `stage3_name` |
| `vq_cards` | **the core** — one row per card | `collector_number`, `card_id` (GNV-001), `name`, `display_name`, `card_type` (Creature/Tactic/Relic/Vault), `element`, `family_id` (null for support), `stage_number` (null for support), `life_stage`, `health`/`guard`/`shift` (null for support), `attack1_name`/`cost`/`damage`/`effect`, `attack2_*`, `vulnerability`, `keywords[]`, `rarity`, `art_r2_key`, `render_r2_key`, `status` (draft/approved/published), `effects jsonb` (dormant — the audit's future Oracle gate), `notes`, `created_at`, `updated_at` |
| `vq_card_revisions` | auto snapshot on every save (replaces git-diff review for a DB-edited card) | `card_id`, `revision_json`, `edited_at` |
| `vq_elements` | palette + crest per element | `name`, `border`, `accent`, `dark`, `crest_key` (seeded from `elements.json`) |
| `vq_game_config` | rules constants | `key`, `value` (deck_size 40, seal_count 5, rules_version v0.1, …) |
| `vq_releases` | published snapshots (Phase 1d) | `version`, `cards_json_r2_key`, `is_current`, `published_at` |

**Explicitly NOT built in Phase 1** (named deferrals, not forgotten): `vq_printings` (collapsed into `vq_cards` — split when a real second printing exists), `vq_rulings`, `vq_players`, `vq_collections`, `vq_decks`, `vq_matches`, `vq_tournaments`, and the structured-effects vocabulary tables. The `effects jsonb` column ships dormant so adding the Oracle Round-Trip Gate later is free.

**Migration discipline:** push to **staging first** (local `.env` → staging Neon branch), then a separate filtered push to **prod with you watching**, before the code deploy that needs the tables. Never the main drizzle config.

---

## 2. Admin pages needed

**One** new admin surface: **`/admin/vault-quest`** ("VQ Studio"), a tabbed workspace following the existing standalone-admin-page pattern (`client/src/pages/admin-instagram.tsx`), gated exactly like `admin.tsx` checks `/api/admin/session`.

Tabs:
- **Cards** — list with filters (set / type / element / status), status chips (draft·approved·published), New/Edit.
- **Card editor** — form + live preview (Section 3).
- **Families** — the 18 evolution lines (edit stage names; drives prev-stage art).
- **Sets & Game Config** — set metadata + rules constants.
- **Elements** — palette + crest per element.
- **Bulk import** — upload the 90-card master CSV → preview which rows add/change → commit (reuses the CLI importer).
- **Export** — per-card and full-set SVG/PNG/PDF + zip (Section 5).
- **Proxy Sheets** — generate the A4 proxy PDF (Section 6).

Registered as **one** entry in the `NAV` array (`admin-shell.tsx:68`) and **one** lazy route in `App.tsx`.

---

## 3. Card editor workflow

1. Cards tab → **New** or **Edit** a row.
2. Form, grouped: **identity** (name, collector no., type, element, family, stage) · **stats** (health/guard/shift — *creature only, hidden for support*) · **attacks** (name/cost/damage/effect ×2 — *creature only*) · **vulnerability, rarity, keywords, notes**. A card-type toggle switches the form between the **creature** and **support** shapes (support = no stats/attacks, just an effect field).
3. **Live preview:** on change, the form POSTs to `/api/admin/vault-quest/cards/preview` which runs the **ported renderer** and returns a PNG shown beside the form. This is the same render engine the CLI uses, so preview = final.
4. **Save** writes `vq_cards` **and** a `vq_card_revisions` snapshot, and runs the **QA gates server-side** (banned tokens HP/Pokémon/Weakness/Resistance/Retreat, GNV/2026, stage rules, zone overflow, card-size). Reject reasons show inline.
5. **Status flow:** `draft` → (QA clean) `approved` → `published`. A card **cannot be marked approved while failing QA**, and only `published` cards reach exports/public. This is the database version of the CLI's `--approved-through` gate — per-card, not a CLI flag.

---

## 4. Artwork upload workflow

1. Card editor has an **art dropzone** (main artwork). The **previous-stage portrait** is auto-resolved from the family (same logic the CLI uses), no separate upload.
2. Upload → **multer memory storage** (config from `server/lib/multer-configs.ts`) → **magic-byte validation** (the ~20-line `rejectInvalidUploads` guard **copied** into `server/vault-quest/upload-guard.ts`, not imported from the routes monolith — keeps lift-out clean) → `sharp` normalise → `uploadToR2("vq/art/{card_id}/main.png", buf, "image/png")` → store `art_r2_key` on the card.
3. **Serving is by card ID, never by raw key:** `GET /api/vault-quest/assets/:cardId/art` looks up `art_r2_key` from the row and streams via `getR2Buffer`, `Cache-Control: public, max-age=31536000, immutable`. The client never supplies an R2 key — critical because this bucket also holds **private customer grading photos** (Section 8).
4. **Crests** stay as the 7 in-repo SVG files (`art/symbols/crest_*.svg`) for Phase 1 — static, no upload UI needed. Neutral keeps its inline vector diamond.

---

## 5. Export workflow

Reuses the CLI's export logic (ported to `server/vault-quest/export.ts`): **SVG** (vector), **PNG** (300 DPI preview), **PDF** (600 DPI master, true 69×94mm + 3mm bleed + crop marks).

- **Per-card:** buttons in the editor → `GET /api/admin/vault-quest/cards/:id/export.{svg,png,pdf}`.
- **Full set:** Export tab → "Export approved set" → renders every `approved`/`published` card → zip → download.
- QA runs on export; any card that fails is **excluded and listed**, never silently shipped.
- **Admin-only.** These renders are CPU-bound (canvas + pdfkit); keeping them off the public surface protects the shared Fly process (Section 8).

---

## 6. Proxy-sheet workflow

Reuses the proven `proxy-sheets.ts` logic (ported to `server/vault-quest/proxy.ts`): **A4, 9 cards/page (3×3), true 63×88mm** (bleed cropped), guillotine cut ticks, footer `PLAYTEST PROXY — NOT FINAL PRINT · Rules {version from vq_game_config} · exported {date} · page N/N`.

- Proxy Sheets tab → choose scope (all / approved / range) → "Generate" → A4 PDF download.
- QA JSON confirms every card placed at exactly 63×88mm (as the CLI already does).
- **Admin-only** for the same CPU reason. If a public "print your deck" feature is ever wanted, it must be client-side assembly from cached PNGs or pre-rendered static sheets — never an on-demand public server renderer (audit rule).

---

## 7. Public /vault-quest pages (Phase 1d)

Static, read-only, cacheable, **no accounts**. All compose `HeaderV2`/`FooterV2` + `SeoHead` like `pricing.tsx`.

| Route | Page | Source |
|---|---|---|
| `/vault-quest` | Landing (pitch, links) | static |
| `/vault-quest/cards` | Card database (search/filter) | the published `cards.json` |
| `/vault-quest/cards/:slug` | Card page (image, oracle text, stats, SEO meta + JSON-LD) | `cards.json` |
| `/vault-quest/learn` | Learn to play | `vault-quest-rules.md`, version-badged |
| `/vault-quest/rules` | Rules v0.1 | `vault-quest-rules.md`, version-badged |

**Data flow — single source of truth flows outward:** a **Publish** action compiles all `published` cards into `vq/releases/{version}/cards.json` in R2 and flips `vq_releases.is_current`. Public pages read that **compiled JSON** (one fetch, <1 MB, CDN-cacheable), never the live tables. Card images come from the by-ID asset route (long-cached).

**SEO:** add the 5 static routes to `SEO_MAP`; per-card meta is slug-derived. **Sitemap:** append VQ card slugs **inside a try/catch that falls back to the existing static sitemap** on any error (Section 8).

Not in Phase 1: deck builder, collection tracker, accounts, community, news, tournaments — all later/gated per the audit.

---

## 8. Risks to existing MintVault grading (and mitigations)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **A schema push DROPs grading tables.** The live DB has drifted from `shared/schema.ts` (`cert_counter` exists in DB, not in schema). A combined push would diff the whole DB and propose destructive changes. | **Critical** | Separate `drizzle-vq.config.ts` with `tablesFilter: ["vq_*"]` — drizzle **physically cannot** touch grading tables. Never add vq to `drizzle.config.ts`. Prod push filtered + you-watching, before deploy. |
| 2 | **Public asset route leaks customer photos.** The R2 bucket holds private grading images (`images/{certId}/…`, presigned-only). A raw-key asset route would serve them. | **Critical** | Serve VQ art **by card ID** (key comes from the DB row, never the client); enforce `vq/` prefix; **verify the guard survives the prod esbuild bundle on staging** (the tree-shake lesson — validate the running bundle, not the source). |
| 3 | **Sitemap 500 drops grading pages from crawl.** A VQ DB/R2 read inside `/sitemap.xml` that throws would break the whole sitemap. | Major | Wrap the VQ block in try/catch → emit the existing static sitemap unchanged on any failure; source slugs from an in-memory list refreshed at publish. |
| 4 | **Heavy renders starve payment traffic.** Export/proxy PDF renders share the single Fly process with Stripe + cert lookup. | Major | Keep all renders **admin-only** and bounded; no public server-side PDF/render endpoint. |
| 5 | **Deploying with no safety net.** `scripts/safe-deploy.sh` is **absent on this branch** (confirmed — it lives on `routes-split`). | Major | Merge or cherry-pick `safe-deploy.sh` (routes-split commits `94e9938`, `9fc70a1`) **before any VQ deploy**. If absent, STOP — never raw `fly deploy`. Prod deploys serialized + human-gated. |
| 6 | **A "helpful" edit touches protected code.** `labels.ts`, the grading/MVGS system, `stripeClient.ts`, auth logic are off-limits. | Major | VQ **imports none** of them. Render techniques are **copied** into `server/vault-quest/`, never imported. No grading file is edited. |
| 7 | **Session cookie clobber.** VQ admin reuses `mv.sid` + `requireAdmin` (known admin/staff clobber issue). | Minor | VQ admin is admin-gated; it adds no new portal, so no new clobber. Documented, not weakened. |
| 8 | **Bundle bloat slows grading pages.** | Minor | VQ client pages are `React.lazy` — their own Vite chunks; zero weight added to grading routes. |
| 9 | **Merge conflict in routes.ts.** The two `register…Routes(app)` lines sit near other registrations. | Minor | Additive lines only; no existing route changed. |

**Net:** with tables 1–2 handled by design (filtered config + by-ID assets), the residual risk is ordinary deploy hygiene. No grading table, route, cert flow, Stripe path, or export is modified.

---

## 9. Exact files / routes I will touch

**New files (fully isolated):**
- `shared/vq-schema.ts` — all `vq_` tables + Zod insert schemas + types.
- `drizzle-vq.config.ts` — filtered migration config.
- `server/vault-quest/lib/` — **the single source of truth for render/QA/export**, ported from `scripts/vault-quest-builder/lib/` as **pure functions** (canvas/sharp/pdfkit, no Express/DB deps): `template-creature.ts`, `template-support.ts`, `qa.ts`, `export.ts`, `proxy.ts`, `data-import.ts`. *Recommendation: the existing CLI (`scripts/vault-quest-builder/`) then imports from here too, so there is exactly one copy of the render logic.*
- `server/vault-quest/storage.ts` — `vqStorage` (CRUD + revision snapshots), imports only `vq-schema` + db.
- `server/vault-quest/publish.ts`, `server/vault-quest/upload-guard.ts` (copied magic-byte guard).
- `server/routes/vault-quest.ts` (public) + `server/routes/vault-quest-admin.ts` (admin).
- `client/src/pages/admin-vault-quest.tsx` (VQ Studio).
- `client/src/pages/vault-quest/{landing,cards,card,learn,rules}.tsx`.
- `client/src/content/vault-quest-rules.md`.

**Touched — additive only (this is the extraction manifest):**
| File | Change | Lift-out cost |
|---|---|---|
| `server/routes.ts` | 2 register calls near line 1377 + a VQ sitemap block near line 5000 (try/catch) | delete 3 spots |
| `server/seo-config.ts` | `SEO_MAP` entries for 5 VQ routes | delete entries |
| `client/src/App.tsx` | lazy routes for VQ public pages + admin page | delete entries |
| `client/src/components/admin/admin-shell.tsx` | **1** entry in the `NAV` array (line 68) | delete one |
| **`drizzle.config.ts`** | **NOT touched** — vq uses its own config | — |

**Shared infrastructure imported (sanctioned seams):** `requireAdmin` (auth middleware) · `uploadToR2`/`getR2Buffer`/`getR2SignedUrl` (`server/r2.ts`) · `storage.writeAuditLog` (if audit logging desired) · multer config (`server/lib/multer-configs.ts`) · rate limiter · `HeaderV2`/`FooterV2`/`SeoHead`/Shadcn UI (client) · shared Postgres (vq_ tables only) · `mv.sid` session.

**Deploy precondition:** `safe-deploy.sh` merged/cherry-picked to the working branch first; staging → your approval → prod, serialized.

---

## What Phase 1 deliberately leaves for later

- **Oracle Round-Trip Gate** — the structured-effects vocabulary that must round-trip before any print/Kickstarter. `effects jsonb` ships dormant now; built pre-launch.
- **Deck builder, collection tracker, accounts, community, news, tournaments** — audit-gated.
- **Browser game engine** — hard-gated on physical playtesting.
- **Effect text + real art** — the two content gaps (the master had neither); the editor is built to receive both.

---

## One-line summary

Phase 1 gives the proven card builder a Postgres home and an admin UI, plus static public pages, in a `vq_`/`server/vault-quest/`/`vault-quest` island that shares only auth, R2, session and four additive registration points — with the schema push physically fenced off from grading tables and every deploy gated. No grading table, route, certificate flow, Stripe path, or export is modified.
