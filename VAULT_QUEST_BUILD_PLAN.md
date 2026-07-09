# VAULT QUEST — In-Platform Build Plan (Final)

**Prepared for:** Cornelius (founder)
**Date:** 2026-07-07
**What this is:** the practical build plan for adding a Vault Quest section inside the existing MintVault platform, matching the codebase's real conventions (cited by file throughout), sized to the audit's roadmap and kill gates. This is the corrected final version: it incorporates a 24-finding review pass (audit-consistency, codebase-fit, and scope red-team), and every change from that review is baked in below rather than appended.

---

## The isolation contract — an honest extraction manifest, not a slogan

The draft's headline claimed VQ "imports nothing" from the existing platform and that lift-out means "moving three directories." That was not true as written, and this plan replaces the slogan with the real contract.

**The rule, precisely scoped:** VQ code imports **nothing from grading, Stripe/payments, or label business logic** — `server/labels.ts`, the MVGS grading system, `server/stripeClient.ts`, and the payment flow are never imported and never touched. Where VQ needs a *technique* those files use (canvas text-wrapping, DPI scaling, pdfkit buffer assembly), the small helper is **copied** into a VQ file, not imported — deliberate duplication so the module stays liftable.

**The sanctioned touch-points (the extraction manifest).** VQ deliberately shares the following infrastructure, and each one is a thing that must be unwound or re-homed if VQ is ever lifted into a separate app:

| # | Touch-point | Where | Lift-out cost |
|---|---|---|---|
| 1 | `requireAdmin` middleware | `server/middleware/auth.ts` | re-home auth (new admin auth or none) |
| 2 | `storage.writeAuditLog(...)` | `server/storage.ts` | re-home audit trail (own table) |
| 3 | `uploadToR2()` / `getR2Buffer()` | `server/r2.ts` | own bucket + thin R2 adapter |
| 4 | Multer memory-storage configs | `server/lib/multer-configs.ts` | copy (~10 lines) |
| 5 | Rate limiter pattern | `server/lib/rate-limiters.ts` | copy |
| 6 | SEO meta entries | `server/seo-config.ts` | delete entries |
| 7 | Sitemap block | `server/routes.ts` sitemap handler (~line 5000) | delete block |
| 8 | Route registrations | `client/src/App.tsx` lazy routes | delete entries |
| 9 | Admin nav entry | `client/src/components/admin/admin-shell.tsx` `NAV` array | delete one entry |
| 10 | Drizzle config | separate `drizzle-vq.config.ts` (never `drizzle.config.ts` — Section 2) | move file |
| 11 | Shared Postgres database | `vq_*` tables in the same Neon DB | `pg_dump` the `vq_*` tables into a new DB |
| 12 | Shared admin session cookie | `mv.sid` (a known clobber source — see memory: session cookie clobber) | new session handling |

**What lift-out actually costs:** move three directories (`server/vault-quest/`, `server/routes/vault-quest*`, `client/src/pages/vault-quest/` + the admin page) and one schema file, then unwind these 12 registration points and re-home auth, audit, R2, and the database. That is a real day or two of work, not a file move — but it is bounded, listed, and never grows silently, because **any new touch-point must be added to this manifest first**.

---

## Two disclosed deviations from the audit (agreed up front)

**1. In-platform, not a separate app.** The audit's website review (§14) recommended Vault Quest live as a **separate app, separate domain, separate database** — "runtime sharing: nothing," shared build-time JSON only — and said the case for that got *stronger* in v2. This plan deviates, deliberately: the workloads that drove that recommendation (child-adjacent player accounts, match history, moderation, community, ads) are **struck from this plan entirely** per the audit's own cut list. What remains is static public content plus founder-only admin tooling — negligible traffic, no separate regulatory surface, no user data of its own. The agreed compromise is: `vq_` table prefix + directory isolation + the extraction manifest above, with a **defined lift-out trigger** — if VQ ever needs public accounts of any kind, it gets lifted into its own app *before* those accounts are built, using the manifest as the checklist.

**2. Cards in Postgres behind an admin UI, not git files.** The audit recommended card content live as git files so every text change is reviewed as a diff — and it said so twice: §15's substrate ruling ("no admin UI — content edits are file edits + PR" is a feature "for a founder whose interface is already AI agents"), and §25's website gate checklist, which lists **"premature admin"** among the five liabilities to strike. This plan builds the admin UI anyway, for one overriding reason: the founder's explicit workflow decision — git-file editing is not how Cornelius works; a form with a live card preview is. The admin surface is therefore **kept to the minimum needed to author cards, config, and releases** (see Section 3 — several draft screens are cut), and what we lose in git-diff review we buy back two ways: every card save writes a full snapshot to `vq_card_revisions` automatically, and nothing reaches the public site except through an explicit **Publish** step that compiles a frozen, versioned `cards.json`. You still get "which version produced the printed sheet" — it's a release row, not a commit hash.

---

## The effects-vocabulary decision (how the two biggest review findings reconcile)

Two review findings pulled in opposite directions and this plan resolves them explicitly:

- The **scope red-team** correctly showed that the closed machine-readable effects system (enums, zod vocabulary, dropdown Effects Builder, oracle-text generation) was the most expensive part of Phase 1, its only real consumer is the gated Phase-4 engine, and it hard-codes contested mechanics *before a single blind playtest* — maximum rework at the point of maximum rules churn. **It is cut from the early phases.** Cards store founder-typed plain `oracle_text` plus a `keywords[]` multi-select. That is all the card render, proxy sheet, and public card page need.
- The **audit-consistency review** correctly showed that the audit's only press-day-irreversible requirement is that rendered rules text be *generated from, or validated against, structured effects* — otherwise display text and machine truth silently diverge, a failure the audit rated CRITICAL and "effectively unfixable after printing."

**The reconciliation — sequencing changes, the gate does not.** The structured effects vocabulary, the cards/printings split, and generated-vs-display oracle reconciliation become **step 1 of Phase 4** — *and* a hard, named gate that stands independently of whether Phase 4's engine is ever built:

> **THE ORACLE ROUND-TRIP GATE (press-day prerequisite):** No card art is print-locked and no Kickstarter/crowdfunding campaign launches until **every card's text round-trips through the structured effects vocabulary.** Mechanically: each card's effects are entered as structured data; the generator produces `generated_oracle_text`; any card whose display text differs is flagged `oracle_overridden = true`; and the Publish step surfaces every overridden card with a **side-by-side diff** (generated vs display) requiring **explicit per-card approval** before it enters the print-candidate release. Free-typed text is fine for playtesting; it is never fine for print.

To keep that future cheap, `vq_cards` carries a **dormant** `effects jsonb` nullable column from day one (free to add now, nothing built on it), and `oracle_overridden`/`generated_oracle_text` columns arrive with Phase 4 step 1. The full vocabulary design from the draft is preserved as a Phase-4 design reference in Section 8 — designed, not built.

---

## 1. Exact Page Structure

All routes register in `client/src/App.tsx` via Wouter, lazy-loaded with `React.lazy()` exactly like the existing 84+ pages (App.tsx lines 20–109). VQ pages form their own Vite chunk automatically because each lazy import is its own chunk (per `vite.config.ts` — no config change needed). Every public page composes `HeaderV2` / `FooterV2` (`client/src/components/v2/header-v2.tsx`, `footer-v2.tsx`), `SectionEyebrow`, `AmbientLayer` the way `client/src/pages/pricing.tsx` does, and uses `SeoHead` (`client/src/components/seo-head.tsx`) for meta + JSON-LD.

### Public pages

| Route | Page name | Purpose | Phase | Reuses |
|---|---|---|---|---|
| `/vault-quest` | VQ Landing | 60-second pitch, hero art, links to Learn/Rules (Cards link appears in Phase 2). The front door. | **1a** | pricing.tsx composition pattern: AmbientLayer, SectionEyebrow, GradientButton, HeaderV2/FooterV2 |
| `/vault-quest/learn` | Learn to Play | Progressive: pitch → illustrated turn walkthrough → link to full rules (Section 6) | **1a** | journal-detail.tsx typography (Fraunces headings, Geist body); SeoHead |
| `/vault-quest/rules` | Rules | Versioned numbered rules doc, anchor links, changelog, "Rules v0.x — in playtesting" badge (Section 7) | **1a** | journal-detail.tsx `sanitizeBody()` heading-ID pattern for anchors |
| `/vault-quest/cards` | Card Database | Search + facet filters over the compiled cards.json; the SEO asset (Section 4) | 2 | Card/Button from `client/src/components/ui/`; TanStack Query for the one JSON fetch |
| `/vault-quest/cards/:slug` | Card Page | One page per card: oracle text authority, stats, image | 2 | SeoHead with per-card meta + JSON-LD (SSR meta scoped per Section 4) |
| `/vault-quest/glossary` | Glossary | Keywords + statuses, from `vq_keywords`/`vq_statuses` via the compiled JSON | 2 | plain content page pattern |
| `/vault-quest/sets/:code` | Set Page | Set list, collector-number order, release notes | 3 | Card Database components |
| `/vault-quest/characters/:slug` | Character Page | Character lore + its evolution line + every printing | 3 | Card Page components |
| `/vault-quest/deck-builder` | Deck Builder | Account-less builder: localStorage + shareable deck codes (Section 5) | 3 | cards.json client-side search from Card Database |
| `/vault-quest/decks/:code` | Deck Viewer | Renders a deck from a self-contained deck code in the URL — no DB read, no short-link table (Section 5) | 3 | Deck Builder components |
| `/vault-quest/play` | Practice vs AI | Browser game client — **hard-gated on Kill Gate 1** (Section 8) | 4 | engine in `shared/vault-quest/` |

Note the phase split: **Phase 1a is the public shell** — Landing, Learn, Rules — which needs no VQ database, no admin studio, and no publish pipeline. It ships the moment the founder has a rules draft (Section 9 explains the restructure). Rules-PDF download is **cut** — the anchor-linked HTML page is the deliverable; browsers print to PDF.

### Admin pages

One new admin surface, following the standalone-page pattern of `client/src/pages/admin-instagram.tsx` (App.tsx routes it directly; auth-gated the same way `admin.tsx` lines 14–43 checks `/api/admin/session`):

| Route | Page | Purpose | Phase |
|---|---|---|---|
| `/admin/vault-quest` | VQ Studio | Tabbed workspace, minimum viable: Cards, Sets, Characters, Keywords & Statuses, Game Config, Proxy Sheets. Releases tab arrives with Phase 2 (Section 3) | **1b** |

Registered as a **link item** in the `NAV` array of `client/src/components/admin/admin-shell.tsx` (lines 68–101) — link items navigate client-side without touching the `AdminTab` union, keeping the diff to admin-shell to one array entry.

### Explicitly not built (any phase in this plan)

No account pages, no player profiles, no community/forum, no ads pages, no tournament software, no matchmaking. Per the audit's strike list (audit Section 14) these are cut, not deferred.

---

## 2. Database Schema

### Where it lives — separate drizzle config, never the main one

New file **`shared/vq-schema.ts`**, driven by a **new, separate `drizzle-vq.config.ts`**:

```typescript
// drizzle-vq.config.ts
export default defineConfig({
  schema: "./shared/vq-schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.MINTVAULT_DATABASE_URL! },
  tablesFilter: ["vq_*"],
});
```

🚨 **Why this matters — do NOT add vq-schema to `drizzle.config.ts`.** The draft proposed a schema-path array in the main config. That would make `db:push` diff the **entire live database** against the combined schema — and the live DB is known to have drifted from `shared/schema.ts` (confirmed in the 2026-06-19 audit: `cert_counter` exists in the DB but not in schema.ts; staging and prod have also diverged). A combined push would propose **DROPs of grading-business objects** alongside the vq CREATEs, and the only safety net would be someone correctly rejecting a destructive diff. One wrong "yes" on prod is a revenue-platform incident. With `tablesFilter: ["vq_*"]`, drizzle **physically cannot** propose changes to grading tables, on staging or prod.

Migrations run as `npx drizzle-kit push --config drizzle-vq.config.ts`:
1. **Staging first** (local `.env` points at the staging Neon branch).
2. **Prod explicitly, founder watching:** the filtered push runs against the prod URL as its own roadmap step, **before** the code deploy that needs the tables — per the standing db-migration discipline. `safe-deploy.sh` ships code, not schema; the prod push is never left implicit.

`shared/schema.ts` — the grading business's single source of truth — is completely untouched, and `drizzle.config.ts` is completely untouched. Conventions in `vq-schema.ts` are copied verbatim from `shared/schema.ts`: `pgTable` with snake_case column names / camelCase field names, `jsonb(...).$type<...>()` for structured fields, `createInsertSchema(...).omit({...})` from drizzle-zod, `$inferSelect` types (recon: schema.ts lines 319–650 pattern).

### Tables (Drizzle-style sketches)

```typescript
// ---------- game configuration (rules are data, still in flux) ----------
export const vqGameConfig = pgTable("vq_game_config", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),        // "deck_size", "copy_limit", "max_elements",
                                              // "seal_count", "core_cap", "opening_hand",
                                              // "reserve_slots", "apex_seal_value",
                                              // "stage_display_names", "phase_display_names"
  value: jsonb("value").$type<number | string | Record<string, string>>().notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
  updatedBy: text("updated_by"),              // adminEmail, same identity pattern as audit_log
});
// Seeded (Section 10 Task 6 — the FULL list, matching this comment exactly):
//   deck_size=40, copy_limit=4, max_elements=2, seal_count=5, core_cap=10,
//   opening_hand=5, reserve_slots=2, apex_seal_value=2,
//   stage_display_names={stage1:"Origin", stage2:"Ascendant", stage3:"Apex"},
//   phase_display_names={...the audit's renamed phases, incl. the Quest-Phase rename}
// Every number the audit says is playtest-sensitive lives HERE, never in code —
// and the display-name maps are the lever for the naming surgery, so they are
// seeded from day one, not remembered later.

// ---------- sets & releases ----------
export const vqSets = pgTable("vq_sets", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),      // "GNV"
  name: text("name").notNull(),               // "Genesis Vault"
  releaseDate: timestamp("release_date"),
  status: text("status").notNull().default("draft"), // draft | published
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const vqReleases = pgTable("vq_releases", {
  id: serial("id").primaryKey(),
  version: text("version").notNull().unique(),          // "0.1.0"
  cardsJsonKey: text("cards_json_key").notNull(),       // R2 key: vq/releases/0.1.0/cards.json
  checksum: text("checksum").notNull(),                 // sha256 of compiled artefact
  gameConfigSnapshot: jsonb("game_config_snapshot").$type<Record<string, unknown>>().notNull(),
  rulesVersion: text("rules_version"),                  // "v0.3" — badge shown on public pages
  notes: text("notes"),
  publishedBy: text("published_by").notNull(),
  publishedAt: timestamp("published_at").notNull().defaultNow(),
  isCurrent: boolean("is_current").notNull().default(false), // singleton-current, promotion-style
});
// The table ships with the schema (cheap); the publish FLOW that writes it is
// Phase 2's first session (Section 3.6 / Section 9).

// ---------- characters & families (the IP registry, with the Name field the audit
// ---------- found missing) ----------
export const vqFamilies = pgTable("vq_families", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),               // evolution-line name
  element: text("element").notNull(),         // element code, e.g. "flame"
});

export const vqCharacters = pgTable("vq_characters", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),               // THE missing field from the audit's registry
  familyId: integer("family_id").references(() => vqFamilies.id),
  stage: text("stage").notNull(),             // "stage1" | "stage2" | "stage3" — neutral codes;
                                              // display names (Origin/Ascendant/Apex) come from
                                              // vq_game_config so the naming surgery is a config edit
  ascendsFromId: integer("ascends_from_id"),  // explicit evolution edge (self-FK), audit §15
  loreHook: text("lore_hook"),
  // ---- IP-registry fields: DORMANT columns. They exist in the schema now (free),
  // ---- but get NO admin form fields and NO palette-contradiction warnings until
  // ---- the pre-Kickstarter IP pass. Do not build UI on them before then.
  palette: jsonb("palette").$type<{ dominantHex: string; accentHex?: string }>(),
  artProvenance: text("art_provenance"),      // "human" | "ai" | "hybrid" — audit IP field
  nameClearanceStatus: text("name_clearance_status").default("unchecked"),
  artworkVersion: text("artwork_version"),
  artworkChecksum: text("artwork_checksum"),  // sha256 of master export, append-mindset
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------- cards (printings COLLAPSED in — see the named deferral below) ----------
export const vqCards = pgTable("vq_cards", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),                 // url + deck-code stable identity
  name: text("name").notNull(),                          // hard char cap enforced by validator (≤25)
  cardType: text("card_type").notNull(),                 // "guardian" | "tactic" | "relic" | "vault" | "core" | "token"
  element: text("element"),                              // element code; null for neutral/core
  stage: text("stage"),                                  // guardians only: stage1|stage2|stage3
  characterId: integer("character_id").references(() => vqCharacters.id),
  ascendsFromCardId: integer("ascends_from_card_id"),    // guardian evolution edge (self-FK)
  cost: integer("cost"),                                 // Core cost, validator caps at 6 (audit §10.3)
  health: integer("health"),                             // 3–12 (audit §9.3)
  attacks: jsonb("attacks").$type<Array<{
    name: string;                                        // ≤18 chars, validator-enforced
    cost: number;                                        // extra Core, 0 = free (attacks are free by default)
    damage: number;                                      // 1–4
    text?: string;                                       // plain attack text, founder-typed
  }>>().default([]),
  keywords: jsonb("keywords").$type<string[]>().default([]),   // codes from vq_keywords, multi-select
  oracleText: text("oracle_text"),                       // founder-typed PLAIN rules text — the
                                                         // display authority for playtesting phases
  effects: jsonb("effects"),                             // DORMANT, nullable. Reserved for the
                                                         // Phase-4 structured vocabulary (see the
                                                         // Oracle Round-Trip Gate). Nothing reads
                                                         // or writes it before Phase 4 step 1.
  flavorText: text("flavor_text"),
  // ---- printing fields, collapsed from the draft's vq_card_printings table ----
  setCode: text("set_code"),                             // FK-lite to vq_sets.code
  rarity: text("rarity"),                                // rarity-ladder codes, config-listed
  artR2Key: text("art_r2_key"),                          // vq/art/{slug}/{artworkVersion}.png
  renderR2Key: text("render_r2_key"),                    // vq/renders/{set}/{slug}.png (compiled card image)
  status: text("status").notNull().default("draft"),     // draft | ready | published
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
// Index: unique on slug; index on (card_type, element), index on status.

// ---------- revision history (the admin-UI answer to git diffs) ----------
export const vqCardRevisions = pgTable("vq_card_revisions", {
  id: serial("id").primaryKey(),
  cardId: integer("card_id").notNull().references(() => vqCards.id),
  revision: integer("revision").notNull(),               // 1, 2, 3… per card
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(), // full card row
  changedBy: text("changed_by").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
// Index on (card_id, revision). Written automatically on EVERY card save.
// NOTE: the writes are kept (cheap, valuable); the browse/restore admin UI is CUT —
// at single-author scale, restoring by hand from a JSON snapshot is fine.

// ---------- keywords & statuses (the glossary's data, audit §9.5/§15) ----------
export const vqKeywords = pgTable("vq_keywords", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),      // "guard" (pending Guard→Brace/Ward rename — a data edit)
  name: text("name").notNull(),
  reminderText: text("reminder_text").notNull(),
  evergreen: boolean("evergreen").notNull().default(true),  // audit §18: cap evergreen at ~6
  introducedSetId: integer("introduced_set_id").references(() => vqSets.id),
});

export const vqStatuses = pgTable("vq_statuses", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  effectText: text("effect_text").notNull(),
  duration: text("duration").notNull(),       // "until_end_phase" | "until_cured" | ...
  cure: text("cure"),                          // plain-English cure rule
  iconR2Key: text("icon_r2_key"),
});
// The audit's "status subsystem void" (§9.5) gets a home: defining the 2–3 launch
// statuses is a row-insert, not a schema change.
```

Each table gets the standard `createInsertSchema(...).omit({ id, createdAt, updatedAt })` insert schema and `$inferSelect` type export, matching `insertCertificateSchema` in shared/schema.ts.

### Named deferrals (deliberate, per audit §15 — so they aren't rediscovered as gaps)

These are **decisions, not omissions.** Each is listed so a future session adds it on purpose instead of stumbling into the gap:

1. **`vq_card_printings` split** — printings are collapsed into `vq_cards` columns above. **Deferral trigger:** the moment a second printing of any card exists (reprint, foil, second set), split into a `vq_card_printings` table — a mechanical migration (move the four columns + add collector_number/finish/language/artist). **At that point also add `printed_oracle_text`** (or a `release_version` reference) to the printings table, per audit §15's errata requirement, so as-printed text is directly addressable per printing rather than recovered by archaeology through release artefacts.
2. **`vq_rulings`** (table + admin tab + card-page rulings section) — deferred to **Phase 3 at the earliest**. Rulings answer disputes from external players and judges; pre-Gate-1 there are zero players and no final rules.
3. **Localisation text tables** — audit §15 called these "near-zero cost now," but with zero cards and English-only playtesting they are pure ceremony; added alongside the printings split when a non-English printing is actually planned.
4. **`formats` + `card_legalities`** — the audit notes rotation announcements are made *through* this table; it matters when there are two sets and organised play. Deferred until then.
5. **`vq_shared_decks`** — **struck**, not deferred (see Section 5). Deck codes are self-contained; an unauthenticated public write surface is not paid for by a shorter URL. If ever revisited: rate-limited, deck-code size-capped and validated against the release before storing, no user-supplied free text.
6. **Effects vocabulary machinery** — Phase 4 step 1, per the Oracle Round-Trip Gate above. Only the dormant `effects` column ships now.

### Explicitly NOT built (schema)

`vq_players`, `vq_collections`, `vq_matches`, `vq_tournaments`, accounts of any kind, consent records. Per audit §15 these are deleted/deferred; the three-entity account shape (users / player_profiles / consent_records) is written down in the audit for whenever the audit's traction gates open — it is intentionally absent here.

---

## 3. Admin Panel Requirements (Phase 1b — "Card studio", kept to the minimum)

One standalone page `client/src/pages/admin-vault-quest.tsx` ("VQ Studio"), auth-gated exactly like `admin.tsx` (session check against `/api/admin/session`), styled with the `--admin-*` CSS variables and raw-React-state forms of `client/src/pages/admin-promotions.tsx` (no form library — recon: admin-promotions.tsx lines 44–90). Server side: **`server/routes/vault-quest-admin.ts`** exporting `registerVaultQuestAdminRoutes(app)`, registered in `server/routes.ts` alongside the other modules (routes.ts:1370–1384), every route behind `requireAdmin` (`server/middleware/auth.ts`), every mutation writing to `audit_log` via the existing `storage.writeAuditLog(entityType, entityId, action, adminUser, details)` — a sanctioned touch-point (manifest #2), because the audit trail should be unified. All other DB access goes through a new **`server/vault-quest/storage.ts`** (`vqStorage`) — a deliberate deviation from the single-`IStorage` convention, so lift-out later doesn't mean unpicking 3,000-line `server/storage.ts`.

Per the premature-admin disclosure in the preamble: this surface is the **minimum needed to author cards, config, and releases.** The draft's Effects Builder, rulings tab, printings tab, revision browser/restore UI, and IP-ceremony form fields are all cut or deferred.

### Screens (tabs within VQ Studio)

**3.1 Cards** — list with search + filters (type, element, stage, status), and the **Card Editor**:
- Fields: name, slug (auto from name), card type, element, stage, character (dropdown), ascends-from (dropdown filtered to prior stage), cost, health, attacks (repeatable rows: name / cost / damage / plain text), **keywords (multi-select from `vq_keywords`)**, **oracle text (plain textarea — founder-typed rules text, the display authority for playtesting)**, flavor text, set code, rarity, status (draft/ready).
- **No Effects Builder.** Structured effects arrive at Phase 4 step 1 under the Oracle Round-Trip Gate. The editor's job in Phase 1b is to get real card text onto proxy sheets fast.
- **Print-layout validators kept** (cheap plain-field checks, audit §7 — data errors, not layout emergencies): card name ≤25 chars, attack name ≤18, cost ≤6, health 3–12, damage 1–4. Copy-limit/deck-size checks read from `vq_game_config`. These live in **`shared/vq-validate.ts`** so the server and the deck builder (Phase 3) share one definition.
- **Live card preview**: right-hand panel showing the server-rendered card PNG (`GET /api/admin/vault-quest/cards/:id/preview`, re-fetched on save). Uses a v0 frame template — this is the design tool that accelerates physical playtesting.
- Every save: automatic `vq_card_revisions` snapshot + audit_log entry. **No revision browse/restore UI** — the snapshots are the safety net; restore-by-hand from a JSON snapshot at this scale.
- **Art upload lives here too** (since printings collapsed into cards): multipart upload using the multer memory-storage configs from `server/lib/multer-configs.ts` (the 50MB image config, same family as `identifyUpload`/`hotFolderUpload`). ⚠️ **`rejectInvalidUploads()` is NOT in multer-configs** — it is defined and exported from `server/routes.ts` at line 399. Importing it would mean importing the 12k-line routes monolith into VQ (there is precedent — `server/routes/pre-grade.ts:11` does exactly that — but it breaks the lift-out rule). **Decision: copy the ~20-line magic-byte helper into `server/vault-quest/upload-guard.ts`** per the copy-not-import rule. Upload then goes via `uploadToR2()` (`server/r2.ts`, manifest #3) to keys under `vq/art/{cardSlug}/{version}.png`.

**3.2 Sets** — CRUD for `vq_sets` (code, name, release date, status).

**3.3 Characters & Families** — the minimum registry needed for card authoring: name, family, stage, ascends-from, lore hook. **The IP-registry fields (palette, art provenance, name clearance, artwork version/checksum) stay dormant** — columns exist, no form fields, no palette-contradiction warnings — until the pre-Kickstarter IP pass, when a dedicated session adds the form and the audit §23 cross-layer palette warning together.

**3.4 Keywords & Statuses** — CRUD for `vq_keywords` / `vq_statuses`. Guardrail displayed: evergreen keywords capped at ~6 (soft warning, audit §18). Defining the launch statuses here closes the audit's "status void" (§9.5).

**3.5 Game Config** — edit `vq_game_config` values (deck size, copy limit, seal count, core cap, reserve slots, apex seal value, stage/phase display names…). Every edit audited. This is where the naming surgery (Origin/**Ascendant**/Apex, Quest-Phase rename) lands as data.

**3.6 Releases (Publish/Snapshot) — built as Phase 2's FIRST session, not Phase 1.** The full release machinery's only consumer is the public site, which is Phase 2; building the outward-flow gate before there is any outward flow is a session of plumbing ahead of need. When it ships:
- "Publish release" button: validates every `status="ready"` card against the caps → compiles **cards.json** (all published cards, keywords, statuses, game config, rules body) → uploads to R2 at `vq/releases/{version}/cards.json` → inserts `vq_releases` row with checksum → flips `is_current` (promotion-style singleton, like `server/services/promotionService.ts` active-flag handling).
- Nothing draft ever reaches the public site: public endpoints serve only the compiled artefact.
- **Release diff-summaries are cut** (nice-to-have for a single-author dataset; `vq_card_revisions` already answers "what changed").
- **In Phase 1b, proxy sheets don't wait for this:** they read straight from the DB and stamp the current `rules_version` (from game config) + date in the sheet footer — that gives "which version printed this sheet" without the pipeline.
- **From Phase 4 step 1 onward,** publish additionally enforces the Oracle Round-Trip Gate: every `oracle_overridden` card shows a side-by-side generated-vs-display diff requiring per-card approval before entering a print-candidate release.

**3.7 Proxy Sheets** — the playtesting accelerator:
- Pick cards (or a whole set) → `GET /api/admin/vault-quest/proxy-sheet.pdf` → pdfkit A4 with a 3×3 grid of 63×88mm card renders (9 per page), cut margins marked, **rules_version + date stamped in the footer**. Built in `server/vault-quest/proxy-sheet.ts` using the pdfkit assembly technique from `server/certificate-document.ts` (buffer-stream pattern, lines 82–94) — **new file, technique copied, nothing imported from protected files**. Reads cards directly from the DB (no release needed).
- **Admin-only, full stop, pre-Gate-1.** The founder printing sheets for playtest groups is sufficient. The public deck-export variant is a Phase-3 decision made now in Section 5: client-side assembly or pre-rendered static artefacts — never an unbounded public server renderer.
- This ships in Phase 1b because the audit mandates print-and-play proxy testing within weeks (audit §11.3, §28 item 9).

### Client wiring

TanStack Query per the promotions pattern — but note the repo's default `queryFn` builds the URL as `queryKey.join("/")` (`client/src/lib/queryClient.ts:37`), so **an object in the key array produces `/api/.../cards/[object Object]` and a 404.** Use **single-string keys with the query string serialized in**:

```typescript
useQuery({ queryKey: [`/api/admin/vault-quest/cards?type=${type}&status=${status}`] })
```

— or fetch the unfiltered list under one key and filter client-side (card counts are small; this is the simpler default). `useMutation` + `queryClient.invalidateQueries` on save (admin-promotions.tsx lines 102–139); `apiRequest()` from `client/src/lib/queryClient.ts` for all calls.

---

## 4. Card Database Requirements (Public — Phase 2)

**Prerequisite:** the publish/releases pipeline (Section 3.6) is Phase 2's first session — the card database serves only compiled release artefacts, never draft rows.

**Data source:** the client fetches exactly **one file** — the current release's compiled `cards.json` — via `GET /api/vault-quest/cards.json` (streams the R2 artefact with `Cache-Control: public, max-age=3600` + an immutable versioned variant `?v=0.1.0` at max-age=31536000). Target size **<1MB** (audit §25 confirms the whole DB compiles under 1MB); all search/filter is client-side, **zero server round-trips per keystroke**.

**Search & facets** (`/vault-quest/cards`):
- Free-text over name + oracle text (simple client-side index; no dependency needed at this scale).
- Facets: element, card type, stage, cost, rarity, set, keyword. URL-encoded filter state so filtered views are shareable/crawlable.

**Card page anatomy** (`/vault-quest/cards/:slug`):
1. Card render image (from `render_r2_key`, long-cached, served by ID — see below).
2. **Oracle text block** — visually marked as the authoritative current text (audit §9.3: "the website card database as the oracle-text authority"). Post-errata "As printed vs Current oracle" display arrives with the printings split (named deferral #1).
3. Stats (cost, health, attacks with the config-driven display names).
4. Keywords with reminder text (hover/inline from `vq_keywords`).
5. Evolution line strip (ascends-from / ascends-to, linked).
6. Rules-version badge ("Rules v0.x — in playtesting") — mandatory while rules are draft.
7. Rulings section — deferred with `vq_rulings` (named deferral #2).

**Public asset serving — by ID, never by key.** 🚨 The VQ art lives in the **same R2 bucket as private customer photos** (`images/{certId}/…`, presigned-only — the risk register's "R2 images become public" item). A public route that fetches R2 objects by client-supplied key is one weak prefix-check away from being a generic unauthenticated R2 reader for customer images — and this codebase has already seen esbuild **silently tree-shake upload-validation guards out of the prod bundle** (memory: esbuild tree-shake validation). So:

- Route shape: **`GET /api/vault-quest/assets/:cardId/art`** and **`GET /api/vault-quest/assets/:cardId/render`** — the handler looks up `art_r2_key` / `render_r2_key` from the `vq_cards` row by numeric ID. **The client never supplies an R2 key.** A nonexistent ID or a null key is a 404. (This also sidesteps the Express routing fact that a `:key` param can't match keys containing slashes.)
- Fetch via `getR2Buffer()` from `server/r2.ts` and set `Cache-Control: public, max-age=31536000, immutable` **explicitly on the response** — the r2.ts immutable default is object metadata on upload, not this route's response header. Precedent for the buffer-serve + Cache-Control pattern: the share-image handler at routes.ts ~1749–1772.
- **Verification is runtime, not source-reading:** after the staging deploy, curl the route with a traversal-shaped ID and a real ID against the **built bundle** (`dist/index.cjs` running on staging) and confirm behaviour — per the tree-shake lesson, guards are verified in the artifact, never assumed from source.

**SEO per card page:**
- Client: `SeoHead` (seo-head.tsx) with per-card title ("{Name} — Vault Quest Card Database | MintVault"), description from oracle text, OG image = card render, JSON-LD (`CreativeWork` schema with name, image, isPartOf set).
- **Server SSR meta — scoped to what the sync path actually supports.** `getSeoMeta()` (`server/seo-config.ts:195`) is synchronous and is called from the static HTML injector (`server/static.ts:15`) with only the pathname — it cannot read the DB. So the server-injected meta for `/vault-quest/cards/:slug` is **slug-derived**: title from the de-slugged name ("Ember Fox — Vault Quest Card | MintVault") plus a generic VQ description — exactly the `/cert/:id` generic-pattern mechanism. Per-card description and OG image come from client-side SeoHead.
- **Optional named task (only if crawler-visible per-card meta proves necessary):** load an in-memory `slug → {description, ogImageUrl}` map from the current release's cards.json at publish time and at boot, and consult it in the injector. This is a distinct, deliberate task — not smuggled into the base SSR work.
- Static VQ pages (`/vault-quest`, `/learn`, `/rules`, `/cards`) added to `SEO_MAP`.
- **Sitemap — must be unable to hurt the grading business.** The current `/sitemap.xml` handler (routes.ts:5000–5042) is fully synchronous and static — it cannot fail. The VQ addition must keep it that way: card slugs come from an **in-memory list refreshed at publish time** (the publish flow already knows the card list) — the sitemap route itself never touches DB or R2 — and the whole VQ block is wrapped in try/catch so that **on any failure the existing static sitemap is emitted unchanged.** A hobby-side bug must never drop the revenue side's pages out of crawl.

**Analytics — cookieless only.** Per audit §14's keep-list (its only two keeps: SEO and cookieless analytics): Cloudflare Web Analytics-class, no ad-tech, no profiling, no cookies. Written here explicitly so no future session adds a cookie-based tracker instead.

**Performance:** VQ pages are their own lazy chunks (App.tsx pattern); card images long-cached from R2; the JSON fetch is TanStack-cached with `staleTime: Infinity` (the queryClient default).

---

## 5. Deck Builder Requirements (Phase 3)

**Validation — 100% driven by config + compiled JSON, zero hard-coded numbers:** deck size (40), copy limit (4-of, audit §23b), max elements (2), exactly-one Vault card (once the type is defined), Core cards excluded from deck count. All read from the `gameConfig` block inside cards.json, so a playtest-driven rules change is a republish, not a code change.

**Persistence: localStorage only — no server write, and no exceptions.** (Audit §14 Phase 2: "account-less deck builder — localStorage + shareable deck codes.") Multiple named decks stored locally. The draft's `vq_shared_decks` short-link table contradicted this line in the same section — it was the first public write surface in an otherwise read-only public module, unsanctioned by the audit. **It is struck** (named deferral #5): deck codes are self-contained, so long URLs are the accepted cost.

**Deck code format — self-contained, no DB row needed:**
```
VQ1.<release-version>.<base64url payload>
payload = repeated (varint cardId, uint4 count) over the release's stable numeric card ids
```
Decodable entirely from cards.json — `/vault-quest/decks/:code` renders any deck with zero DB reads.

**Proxy-PDF export of a deck — never an unbounded public server renderer.** An unauthenticated, CPU-bound PDF endpoint (canvas + pdfkit, ~40 card images per deck) would run in the same single Fly process that serves Stripe checkout and cert lookups — a small burst could starve the event loop and degrade payment traffic. Decision, made now:
- **Pre-Gate-1:** the proxy renderer stays **admin-only** (Section 3.7). The founder prints for playtest groups — sufficient.
- **If a public variant is ever wanted (post-Gate-1):** it is **client-side assembly** — the browser composites the already-long-cached per-card render PNGs into a PDF (zero server cost) — or **pre-rendered static artefacts** (full-set sheets rendered once at publish time, served from R2). If a server-side variant is ever truly unavoidable, it gets a dedicated limiter (~2/min/IP), a global concurrency cap of 1, and a hard cards-per-request cap — but the default answer is: the server does not render PDFs for the public.

**Out of scope:** accounts/sync, deck ratings/comments, price data, meta statistics, import from other games' formats, collection-aware building (collection tracker is a later, purely client-side checklist per audit §14).

---

## 6. Learn-to-Play Pages (Phase 1a)

Progressive disclosure, one page with three depth levels (or three linked pages if content grows):

1. **The 60-second pitch** — what the game is, the 5-seal win condition in one sentence, one hero image. Above the fold on `/vault-quest/learn`.
2. **Illustrated turn walkthrough** — the 5 phases (with the audit's renamed display names — hard-coded in the page copy for Phase 1a, wired to config once the DB exists), one annotated board diagram, one worked combat example (declare → Guard → counters → KO check, per the audit's §9.3 fixed 5-step combat).
3. **Full rules** — link to `/vault-quest/rules`.

**Version badging — mandatory:** every learn/rules page renders a prominent "Rules v0.x — Vault Quest is in open playtesting; rules will change" badge. In Phase 1a the version string lives with the rules content itself (Section 7); once the release pipeline exists it comes from the current release's `rules_version`. The rules are explicitly draft (win condition just written); the site must never present them as final.

**Content dependencies — the true critical path:** these pages are blocked on the draft rulebook existing (audit §28 items 2–3 — the founder's paper work, not code). **No code session unblocks this.** Page skeletons can ship with placeholder-marked sections, but the page is only worth deploying once the rules draft is real.

**Asset needs (Phase 1a):** 1 board-layout diagram, ~6 phase illustrations, 1 combat-example strip, 1 hero image. These can be simple SVG diagrams initially — no art commissioning required (audit: placeholder art only until Kill Gate 1).

---

## 7. Rules Pages (Phase 1a, upgraded in Phase 2)

- **Phase 1a storage — deliberately primitive:** the rules body is a **checked-in markdown file** (`client/src/content/vault-quest-rules.md` or equivalent) — or, if the founder wants to edit without a code session, a single-row table with one admin textarea; the checked-in file is the default because it needs zero schema. Versioned by an explicit `version: v0.x` line at the top, which feeds the badge. This ships the rules page the moment the rules draft exists — no VQ database, no pipeline.
- **Phase 2 upgrade:** the rules body moves into the release pipeline (a `rules` field alongside cards.json in the compiled artefact) so rules and cards version together.
- **Rendering:** the journal-detail.tsx approach: sanitised HTML with **stable IDs injected on numbered rules** (journal-detail.tsx `sanitizeBody()` lines 25–36 does exactly this for H2s today) → **anchor-linkable rule numbers** (`/vault-quest/rules#7.4.2`) — what judges and future rulings link to.
- **Changelog:** a "What changed in v0.x" section — hand-written notes per version (in the markdown file for 1a; from `vq_releases.notes` in Phase 2).
- **PDF download — CUT.** The anchor-linked HTML page is the deliverable; browsers print to PDF. (One less pdfkit endpoint, one less publish-time artefact.)
- **Glossary wired to data (Phase 2):** the glossary section (and `/vault-quest/glossary`) renders straight from `vq_keywords` + `vq_statuses` in the compiled JSON — one definition source for card reminder text, glossary, and (later) engine tooltips.

---

## 8. Browser-Game Prototype Plan (Phase 4 — HARD-GATED)

**The gate (audit §16, §27):** engine code does not start until **Kill Gate 1 passes** — 30+ blind external playtests where strangers finish unaided in the time window and >50% want to replay. The blocker is cardboard, not code.

**Step 1 of Phase 4 — the effects vocabulary + the Oracle Round-Trip Gate.** Before any engine code, Phase 4 opens by formalising what the earlier phases deliberately deferred:

1. **Build `shared/vq-effects.ts`** — the closed vocabulary (the design reference below), now against **stable, playtested rules** instead of contested drafts.
2. **Split `vq_card_printings` out of `vq_cards`** (named deferral #1) with `printed_oracle_text`, per audit §15.
3. **Backfill every card's structured effects** and add `generated_oracle_text` + `oracle_overridden` to `vq_cards`; the Effects Builder UI (dropdown-driven, never free JSON) arrives here.
4. **Wire the Publish gate:** every `oracle_overridden` card surfaces a side-by-side diff (generated vs display text) requiring explicit per-card approval before entering a print-candidate release.

And the standing rule from the preamble, restated because it is press-day-irreversible: **no card art is print-locked and no Kickstarter campaign launches until every card's text round-trips through the structured vocabulary.** This gate binds even if the browser game itself is descoped.

**The vocabulary design (reference — designed now, built at Phase 4 step 1).** Lives in `shared/vq-effects.ts` as Zod enums + a `VqEffect` type, so server validation and the admin UI dropdowns share one definition. Sized to the audit's adopted draft rules — 5-seal KO model, free attacks, Guard/Shift/Ascend, persistent damage counters, 2–3 statuses, no stack. Sketch (subject to post-Gate-1 rules): triggers (`on_play`, `on_ko`, `on_ascend`, `on_attack`, `on_damaged`, `start_of_turn`, `end_phase`, `activated`, `static`); conditions (`target_stage_is`, `target_element_is`, `self_has_status`, `target_has_status`, `seals_behind`, `core_unlocked_at_least`, `reserve_count_at_least`); actions (`deal_damage`, `heal`, `draw`, `discard`, `apply_status`, `remove_status`, `grant_keyword`, `modify_attack`, `modify_health`, `search_deck`, `shift`, `ready`, `exhaust`, `unlock_core`, `ready_core`); targets (self/ally/opposing/all/player variants); durations (`instant`, `this_turn`, `until_your_next_turn`, `permanent`). Deliberately absent: `gain_seal`/`steal_seal` (seals move only via KO in the adopted model), counter/negate (no stack, no priority windows), anything that interrupts the opponent's turn. Adding a verb later = one enum entry + engine support.

**Architecture (per audit §16, committed):**
- **`shared/vault-quest/engine/`** — deterministic pure TypeScript: no DOM, no server imports, no I/O. Consumes card definitions from the compiled cards.json shape (the same artefact the site reads — single source of truth holds).
- **Command/event split:** commands = rejectable player intents (`playCard`, `attack`, `ascend`, `shift`, `endPhase`); events = accepted facts, append-only log. The event log IS the replay format and the bug-report format.
- **Seeded RNG:** same seed → same game. Deterministic replays, reproducible bugs, scriptable tutorials.
- **`legalMoves(state): Command[]`** — the single API powering the AI, tutorial hints, and fuzz testing.
- **Property tests:** fuzzers driving random legal moves for thousands of seeded games asserting invariants (no negative health, seals only via KO, game always terminates, Core never exceeds cap). Plus the audit's simulator metrics: median Apex turn, seal-rate curve, dead-card count, first-player win rate (audit §11.3).
- **"Event queue" = the in-engine trigger stack only.** No Kafka, no queues, no microservices, no search infra — rejected on sight per the audit.

**AI opponent:** greedy heuristic over `legalMoves()` — score each legal move with a simple hand-tuned evaluation, pick the best. No search trees, no ML.

**Tutorial:** scripted decks + fixed seeds — near-free once determinism exists.

**Client:** `/vault-quest/play` — DOM/CSS + images (no canvas/three needed), account-less, progress in localStorage.

**Explicit non-goals:** multiplayer of any kind (friend-link at earliest, traction-gated per audit; open matchmaking never solo-operated), accounts, ranked, mobile wrappers, spectating. The old "temporary simulator" is salvage-inspected for its data representation only; it never becomes the engine by drift (audit §16).

---

## 9. Development Roadmap

Founder priority honoured — and now honestly: **the fastest public value is Phase 1a, one coding session away from a rules draft.** The previous draft shipped zero public value for 4–5 weeks because it coupled the public pages to the whole card pipeline; they don't depend on it. The restructure below decouples them.

**And the plain statement the draft buried: the critical path to anything public is you writing the rulebook. No code phase unblocks that.** The Learn and Rules pages are empty frames until rules v0.x exists; the card database is empty until ~20 cards' text and stats are entered; the proxy sheets print nothing until then either. Code sessions and rulebook-writing can run in parallel, but the rulebook is the long pole.

Phases 1a–2 use **zero new npm dependencies** — everything needed (canvas, pdfkit, qrcode, sharp, drizzle, zod, multer, R2 SDK) is already installed (recon dependency inventory). If a later phase wants one (e.g. a client-side search library, a state library for the game client), it appears as an explicit approval item first — none is currently anticipated.

| Phase | What ships | Est. sessions | Audit alignment | **Founder deliverables (blocking)** | Founder attention cost |
|---|---|---|---|---|---|
| **1a — Public shell** | `/vault-quest` landing + `/learn` + `/rules`, rendering versioned rules text from a checked-in markdown file; "Rules v0.x — in playtesting" badge; SEO_MAP entries + static sitemap URLs; cookieless analytics note | **1 session** | Audit §14 Phase 1's public-value core, decoupled from the pipeline | **Rulebook draft v0.x** — days-to-weeks of design work, the true critical path; learn-page walkthrough copy | Low code review; the real cost is the writing itself |
| **1b — Card studio** (parallel track) | `shared/vq-schema.ts` via separate `drizzle-vq.config.ts` (tablesFilter `vq_*`); `vqStorage`; VQ Studio minimum (cards with plain text + keywords, sets, characters, keywords/statuses, config); live card preview; **proxy sheets reading straight from the DB, rules_version stamped in the footer**; art upload | ~2 weeks of sessions | Audit §28 item 6 **delivered as a DB+admin variant, larger than the audit's file-repo version by design** (see the disclosed deviation); item 9's print-and-play enabler; feeds Kill Gate 1 prep (months 1–3) | **Stage/phase/keyword display names decided before the first proxy sheets print** (open Q3); **~20 cards' text and stats entered** — before that, proxies print nothing | High-value attention: you'll be IN this tool doing game-design work you must do anyway. Plus: reviewing one additive schema migration (staging, then prod with you watching) and one new admin surface |
| **2 — Card database public** | **First session: the publish→cards.json release pipeline** (moved here from Phase 1 — built the week it's needed, not before); then `/cards` + `/cards/:slug` + glossary; SEO (slug-derived SSR meta, JSON-LD, sitemap card-slugs block with try/catch fallback); public cached endpoints + assets-by-ID route | ~2 weeks | Audit §14 Phase 1 static site; ready before the demo cycle / Kickstarter-prep window (audit months 6–8) so the campaign has a real destination | Copy review; first release published (a button-press, but the go/no-go is yours) | Low: copy review. Deploys are batch-and-approve per your standing workflow |
| **3 — Deck builder + extras** | Deck builder, self-contained deck codes, deck viewer, set/character pages, client-side collection checklist; `vq_rulings` earliest here (named deferral) | ~1–2 weeks | Audit §14 Phase 2 | Naming/format decisions as they arise | Minimal — pure client work over the compiled JSON |
| **4 — Engine (GATED)** | **Step 1: effects vocabulary + printings split + Oracle Round-Trip Gate** (press-day prerequisite even if the game client is descoped); then `shared/vault-quest/engine/`, property tests, AI-practice client at `/vault-quest/play`, scripted tutorial | 1–3 months of agent work (audit's own estimate) | **Starts only after Kill Gate 1** (30+ blind playtests pass, rules stable). Audit §16 build order steps 2–3; §15's rules-as-data requirement lands here as the gate | Per-card oracle-diff approvals at the gate; rules Q&A during engine building; playtest coordination | Meaningful — which is why it's gated; it must not compete with the grading business before the game is proven on cardboard |

Kill-gate mapping: Phase 1b unblocks proxy printing for Gate 1 playtesting; Phase 2 is in place for Gate 2 (Kickstarter needs the site); Phase 3 rides the **demo cycle / Kickstarter-prep window (audit months 6–8)**; Phase 4 sits strictly behind Gate 1, and its step-1 gate binds any print run regardless. Nothing in this plan spends on OP, boosters, accounts, or community — matching the audit's hard caps.

---

## 10. First Tasks to Implement (Sessions 1–3)

Each task ≈ one commit. Standard verification on every task: `npm run check` passes, `npm run dev` starts clean.

🚨 **Deploy precondition (applies to every VQ deploy):** deploys go **staging first via `scripts/safe-deploy.sh` — never raw `fly deploy`.** But note: **`safe-deploy.sh` does not exist on main.** It ships in the `routes-split` branch (commits `94e9938`, `9fc70a1`). **Merge routes-split into main (or cherry-pick those two commits) before any VQ deploy. If the script is still absent on the working branch, STOP — do not fall back to raw `fly deploy`.**

⚠️ **Migration precondition (Session 2):** the `vq_*` push uses the **separate** `drizzle-vq.config.ts` with `tablesFilter: ["vq_*"]` — never the main drizzle config (Section 2 explains why). Staging first (local `.env` points at the staging Neon branch); prod gets the same filtered push as its own explicit step, founder watching, **before** the code deploy that needs the tables.

### Session 1 — Phase 1a: the public shell, end-to-end

1. **Create the rules content file** — `client/src/content/vault-quest-rules.md` (or the founder's current draft pasted in, placeholder-marked where unwritten), with a `version: v0.x` header line. *Verify: file renders in the next task.*
2. **Create `client/src/pages/vault-quest/landing.tsx`, `learn.tsx`, `rules.tsx`** — landing per the pricing.tsx composition pattern (AmbientLayer, SectionEyebrow, GradientButton, HeaderV2/FooterV2); learn per Section 6's progressive structure; rules rendering the markdown with the journal-detail.tsx `sanitizeBody()` heading-ID technique for anchor-linkable rule numbers; the "Rules v0.x — in playtesting" badge on learn + rules sourced from the content file's version line. Register all three as lazy routes in `client/src/App.tsx`. *Verify: check + dev server + click through all three pages.*
3. **SEO for the shell** — add `/vault-quest`, `/vault-quest/learn`, `/vault-quest/rules` to `SEO_MAP` in `server/seo-config.ts`; append the three static URLs to the sitemap handler in `server/routes.ts` (static strings only — the per-card block comes in Phase 2 with its try/catch fallback). Note in the page shells: analytics is cookieless-only per audit §14 — no tracker added here, and never a cookie-based one. *Verify: check + curl `/sitemap.xml` + view-source meta on each page.*
4. **Batch review + staging deploy of the shell** — full check, dev-server pass, then `scripts/safe-deploy.sh` to staging for founder review (see the deploy precondition above — merge/cherry-pick safe-deploy.sh first if absent). Prod on explicit approval. *This is public Vault Quest value in one session — gated only on the rules draft existing.*

### Session 2 — Phase 1b: schema + storage + minimal card editor

5. **Create `drizzle-vq.config.ts` + `shared/vq-schema.ts`** — all Section 2 tables (with printings collapsed into `vq_cards`, the dormant `effects`/IP columns, and no `vq_shared_decks`/`vq_rulings`), insert schemas + types per the shared/schema.ts conventions. Run `npx drizzle-kit push --config drizzle-vq.config.ts` against **staging**. ⚠️ Confirm the generated SQL creates only `vq_*` tables — the tablesFilter guarantees it, but read the diff anyway. *Verify: check + push + `\dt vq_*` against staging.* (Prod push happens as its own step before the Phase-1b deploy, founder watching.)
6. **Create `server/vault-quest/storage.ts`** — `vqStorage` object: CRUD for cards (with automatic `vq_card_revisions` snapshot on update), sets, characters, families, keywords, statuses, game config get/set, releases (rows only — the publish flow is Phase 2). Imports only `shared/vq-schema.ts` + the db connection. Seed function for `vq_game_config` — the **full** list: `deck_size=40, copy_limit=4, max_elements=2, seal_count=5, core_cap=10, opening_hand=5, reserve_slots=2, apex_seal_value=2`, plus `stage_display_names={stage1:"Origin",stage2:"Ascendant",stage3:"Apex"}` and `phase_display_names` seeded with the audit's renamed phases. *Verify: check + seed run on staging.*
7. **Create `shared/vq-validate.ts` + `server/routes/vault-quest-admin.ts`** — the plain-field print-layout validators (name ≤25, attack name ≤18, cost ≤6, health 3–12, damage 1–4); `registerVaultQuestAdminRoutes(app)`: REST endpoints for everything in task 6, all behind `requireAdmin`, `parseInput`-style validation per `server/routes/admin/promotions.ts` (lines 39–90), audit_log writes on mutations. Register in `server/routes.ts` (~line 1380). *Verify: check + dev server + curl a list endpoint as admin.*
8. **Create `client/src/pages/admin-vault-quest.tsx`** — VQ Studio shell + Cards tab: list, filters, create/edit form (plain oracle-text textarea + keywords multi-select — **no Effects Builder**), plus route in `App.tsx` + link entry in the `admin-shell.tsx` NAV array. Promotions-pattern forms; **single-string query keys** with serialized query strings (or unfiltered fetch + client-side filtering) per `client/src/lib/queryClient.ts:37` — never `[url, filtersObject]` tuples. *Verify: check + dev server + create a card end-to-end.*

### Session 3 — Phase 1b: preview render + proxy sheets + assets

9. **Create `server/vault-quest/card-render.ts`** — canvas card render (63×88mm proportions, 300-DPI-class scale) using the techniques of `server/labels.ts` (registerFont, scale-factor DPI, text-wrap) as **copied local helpers — zero imports from labels.ts**; v0 frame = simple element-tinted frame + name bar + stats + oracle text. Endpoint `GET /api/admin/vault-quest/cards/:id/preview` returning PNG; preview panel in the card editor. *Verify: visual check of a rendered card in the editor.*
10. **Create `server/vault-quest/proxy-sheet.ts`** + `GET /api/admin/vault-quest/proxy-sheet.pdf?cards=…` (admin-only) — pdfkit A4, 9 cards per page at true 63×88mm with cut marks, using task-9 renders, **reading straight from the DB** (no release pipeline), with `rules_version` (from game config) + date stamped in the footer; "Proxy sheets" tab with card picker. *Verify: print one page, ruler-check card dimensions.* **This unlocks physical playtesting — the whole point of Phase 1b.**
11. **Art upload + asset route** — card-editor upload using the `server/lib/multer-configs.ts` memory-storage config; **copy the ~20-line `rejectInvalidUploads()` magic-byte helper from `server/routes.ts:399` into `server/vault-quest/upload-guard.ts`** (do not import from routes.ts — lift-out rule; the pre-grade.ts:11 import precedent is explicitly not followed); `uploadToR2("vq/art/…")`. Asset serving **by ID**: `GET /api/vault-quest/assets/:cardId/art` + `/:cardId/render` looking up the R2 key from the `vq_cards` row via `getR2Buffer()`, `Cache-Control: public, max-age=31536000, immutable` set explicitly on the response (share-image handler at routes.ts ~1749–1772 as the buffer-serve precedent). *Verify: upload an image, see it in a card render; curl the asset route with a real ID (200) and a garbage ID (404).*
12. **Remaining admin tabs** — Sets, Characters/Families (minimal fields only — IP columns stay dormant, no form fields), Keywords & Statuses (evergreen-cap soft warning), Game Config (each a small promotions-style CRUD screen over task-7 endpoints). *Verify: define 2 statuses + 3 keywords + config values through the UI.*
13. **Batch review + staging deploy** — full `npm run check`, dev-server pass through every VQ Studio screen, **prod schema push (filtered config, founder watching)**, then `scripts/safe-deploy.sh` to staging for founder review — precondition: safe-deploy.sh present on the branch (merge/cherry-pick `94e9938`/`9fc70a1` from routes-split first; if absent, STOP). **After the staging deploy, verify the upload guard and asset-route checks in the running built bundle** (curl a bad-MIME upload and a garbage asset ID against staging) — per the esbuild tree-shake lesson, never assume source-level guards survived the build. Prod deploy only on explicit approval (standing rule).

**Phase 2 starts session 4+** once Phase 1b is approved and the first real cards are entered — and its **first session is the publish/releases pipeline** (`server/vault-quest/publish.ts`: validate ready cards → compile cards.json incl. keywords/statuses/config/rules body → `uploadToR2()` to `vq/releases/{v}/cards.json` → insert `vq_releases`, flip `is_current`; Releases tab with publish button), followed by `GET /api/vault-quest/cards.json` and the public card pages.

---

### Open questions for the founder (genuine decisions the plan can't make alone)

1. **Sub-brand presentation on VQ pages:** the audit (§3.1) recommends a distinct consumer identity with MintVault as quiet parent. In-platform, do VQ public pages keep the standard MintVault HeaderV2/FooterV2, or get a VQ-branded header variant (still in the design system) to start the brand separation early? Affects **Phase 1a** page composition — this is now the *first* session, so it's the first decision needed.
2. **VQ accent colour:** gold is reserved for MintVault brand/rarity furniture per the audit's palette ruling — pick the VQ sub-brand accent (audit suggests navy-family Layer-1 with element colours as Layer-2) before Phase 1a styling starts.
3. **Stage/phase/keyword display names:** the schema stores neutral codes and display names live in config (seeded with the audit's recommendations: Origin/Ascendant/Apex + renamed phases), so the naming surgery is data entry — but the words themselves are your call, and they're a **blocking founder deliverable before the first proxy sheets print** (Session 3 / roadmap table).
4. **The grading crossover:** does the platform mention "grade/authenticate your Vault Quest cards" anywhere at launch? The audit's authenticate-never-grade line (§3.1) should be written before any such page exists — recommend deferring the page until that policy is published.
