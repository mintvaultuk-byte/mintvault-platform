# VAULT QUEST — CHANGELOG

Chronological record of Vault Quest changes. Additive, isolated (`vq_` / `client/src/vault-quest/` / `server/vault-quest/`). Nothing here touches MintVault grading, payments, certificates, labels, or customer submission.

---

## 2026-07-08

### Anthropic text AI connected locally (AI Assist names/gameplay/flavour live)
_Local `.env` only. No code change, no deploy. Higgsfield/R2/grading untouched._

- **Key found on Fly prod** (the same `sk-ant-…` secret AI grading/IG captions already use; nowhere on the local machine — all `.env*`, shell, profiles, VS Code checked). Appended to local `.env` via `fly ssh printenv` (value never displayed; backup `.env.bak.anthropic`; all 24 existing vars preserved).
- **Verified live 5/5:** provider list shows anthropic connected (model `claude-haiku-4-5-20251001`); Names generate (e.g. "Embercub", with pronunciation), Gameplay suggest-stats (template-correct 5/0/0), Flavour generate — all real API round-trips. Higgsfield still connected. Draft-only invariants unchanged (suggestions preview-only; Apply is client-side; no card writes).
- `npm run check` 0, `git diff --check` clean, server boots, `/ai/generate` admin-gated (401 unauth).

### Hard R2 prefix guard — VQ writes locked to vq/art-candidates/ + vq/art/
_Pre-browser-test safety check. No deploy._

- **Audit:** VQ code has exactly **3 R2 write sites** (candidate upload, manual art upload, Save-Draft promotion) and **zero deletes**; only `uploadToR2`/`getR2Buffer` are imported — no delete/list/grading-key helpers reachable. Export/proxy jobs write to `os.tmpdir`, never R2.
- **New hard guard `assertVqWriteKey`** (`render-saved.ts`): every VQ write key must start with `vq/art-candidates/` or `vq/art/`, and may not contain `..`, backslash, control chars, or a leading slash. Enforced at **all 3** write sites — writes to `images/`, `certificates/`, `labels/`, `scans/`, `uploads/` are now structurally impossible from VQ code.
- **Root-cause fix:** the manual art upload + art-serving routes used the raw `:cardId` URL param (URL-decoding could smuggle `../` into the key — R2 keys are literal so it never resolved, but the shape existed). Both now validate `validVqCardId` first.
- **Verified 17/17:** allows the two real shapes; blocks all five MintVault prefixes, traversal (`vq/art/../../images/…`), backslash, leading-slash, NUL, and prefix lookalikes (`vq/artwork/`, `vq/art-candidatesX/`). `tsc` 0, server boots.

### Local R2 write access restored — candidate flow verified with real artwork
_Local `.env` only. No code change, no deploy, no Higgsfield changes._

- **Root cause of "Unauthorized":** the local `.env` R2 access key (`cbae…`) is **dead — 401 on EVERY operation** (Head/List/Get/Put/Delete, default + EU endpoints). Reads only *appeared* to work because `getR2Buffer` catches all errors → null (miss). All `.env` backups carried the same dead key.
- **Fix:** prod (Fly) runs a **different, working key** (`937b…`, verified by fingerprint via `fly ssh printenv`). Copied prod's R2 credentials into local `.env` (values never displayed; backup `.env.bak.r2fix`), same endpoint/bucket (`mintvault-cards`). Matches the existing local-env pattern (local `.env` already carries LIVE Stripe keys).
- **Verified 6/6 with the real Higgsfield-generated artwork:** candidate upload → read-back under `vq/art-candidates/GNV-001/…` → ownership check → artwork validation (1800×1350) → promotion to `vq/art/GNV-001/main.png` (3.1MB) → **test objects deleted, bucket left clean**. Boot-log `Pre-grade image cleanup error: Unauthorized` is **gone**. No auto-approval, no card-status change anywhere in the flow.
- ⚠️ Note: local dev now writes to the **production bucket** (as the app always intended); VQ uses isolated `vq/…` prefixes.

### Higgsfield LIVE — real image generation verified end-to-end (adapter)
_Staging/local only. No deploy, no dep, no migration. ~0.45 credits spent on verification (9.55 remain)._

- **Reverse-engineered the real API from the official `higgsfield` CLI binary** (the npm CLI at `~/.npm-global/bin/higgsfield` wraps a Go binary; `HIGGSFIELD_API_URL` env is ignored by it, so the protocol was extracted from binary strings + live probes):
  base `https://fnf-api-gw.higgsfield.ai/fnf` · auth `Bearer <oat_… access token>` **+ `hf-workspace-id` header** (auto-resolved via `GET /developer/v2alpha/account/workspaces`, cached; override `HIGGSFIELD_WORKSPACE_ID`) · create `POST /developer/v2alpha/images/{job_type}/generations {params:{prompt,aspect_ratio}}` · cost `POST /developer/v2alpha/jobs/{job_type}/cost` · poll `GET /developer/v2alpha/jobs/{id}` → `{status,result_url}`.
- **Adapter rewritten to the verified protocol** (`ai/higgsfield.ts`): correct base, workspace resolution, exact create/poll/download, clear 401 (token expired → `higgsfield auth token`) and 402 (no credits) messages. Default model **`nano_banana`** (1cr/image; `hfai-dop-lite` did not exist). CDN download sends NO auth header (token never leaks to CloudFront).
- **REAL IMAGE GENERATED through the adapter**: z_image test → 1800×1350 PNG in ~19s (jobs `a7635f35`, `96012651`). **Caught + fixed a live guardrail failure:** the artwork prompt's "collectible-card…/Card context" wording made the model draw a FULL CARD LAYOUT (frame/name plate/text). `buildVaultQuestArtworkPrompt` rewritten card-vocabulary-free, constraint-first — re-test produced a clean standalone character on a plain background (verified visually).
- **⚠️ Local blocker for the browser E2E: local R2 credentials are READ-ONLY** (probe: read ok, write → Unauthorized; same pre-existing cause as the boot-log "Pre-grade image cleanup" error). Candidate upload (`vq/art-candidates/…`) therefore fails LOCALLY; prod Fly R2 secrets are write-capable. Fix = put a write-capable R2 token in local `.env`.
- `.env` fixed (`HIGGSFIELD_API_BASE` → the live gateway; backup `.env.bak.higgsfix`), `.env.example` updated with the verified protocol. `tsc` 0, `git diff --check` clean, server boots, `/ai/artwork` admin-gated (401 unauth).

### Higgsfield integration investigation + host fix
_Staging/local only. No deploy, no dep, no migration._

- **Investigated existing MintVault Higgsfield usage.** Found: `scripts/upload-share-backgrounds.ts` (uses the `hf` CLI) + `scripts/upload-share-backgrounds-v2.ts` (REST poll-only) + stored OAuth creds at `~/.config/higgsfield/credentials.json` (`access_token` + `refresh_token`). These are one-off site-background scripts, **not a reusable image service** — so VQ's adapter is the first proper create→poll→download client, not a duplicate of a shared service. The credential is **not a new key**: it's the existing Higgsfield OAuth access token (`hf auth token`).
- **Tested the adapter against the REAL API and found two bugs:**
  1. **Wrong host (FIXED):** `api.higgsfield.ai` returns Cloudflare **521 (origin down/decommissioned)** for every path — including the exact `/v1/generations` endpoint the old v2 script used. The live API is **`platform.higgsfield.ai`** (real JSON: `POST /v1/generations` → 401 `{"detail":"Invalid credentials"}`, `GET` → 405). Changed `DEFAULT_API_BASE` → `platform.higgsfield.ai`.
  2. **Expired token (BLOCKER, not fixable here):** the stored access token (Jun 12) is rejected `401 Invalid credentials`. OAuth access tokens are short-lived; refreshing needs `hf auth login` / a fresh `hf auth token`, which I can't mint. Could not identify the refresh endpoint (host 401s all paths).
- **Still NOT end-to-end verified** — a real image has NOT been generated. Host is confirmed correct; a valid token is required to confirm the create/model/poll round-trip. `.env.example` updated to document all of this. `tsc` 0.

### Higgsfield artwork hardening (post-review fixes)
_Staging/local only. No deploy, no prod, no dep, no migration. Locked renderer untouched._

- **`/ai/artwork` audit hardened** — `recordAiGeneration` wrapped in try/catch so a logging failure can't 500 an already-generated + uploaded image (matches `/ai/generate`).
- **"Use Image" = attach + validate ONLY** — removed the premature `markAiGenerationApplied` from `/ai/artwork/use`; it no longer approves artwork or touches the audit "applied" flag. The flag now flips **on promotion** (`promoteArtworkCandidate`, i.e. Save Draft) via a candidate-scoped update (`markAiGenerationAppliedByCandidate`) — truthful audit + matches "promotion only on Save Draft". No card status change anywhere in the artwork flow.
- **Removed two stale `setTimeout(runPreview)` calls** (in `applyAi` and the artwork-use flow) — the debounced live-preview effect already re-runs QA on the form change.
- **Higgsfield connection documented** in `.env.example`: needs its own `HIGGSFIELD_API_KEY` (REST) — the `claude.ai Higgsfield` MCP is Claude-side OAuth and unusable by the app.
- **Verified:** `npm run check` 0, `git diff --check` clean, server boots clean, routes admin-gated (401 unauth), promote-time applied-flip 3/3 (correctly scoped to the exact candidate). Flow: candidate under `vq/art-candidates/…` → Use attaches → Save Draft promotes to `vq/art/{cardId}/{slot}.png`.

### AI Assist + add-new dropdowns + text-AI layer (AI upgrade, part 2)
_Staging/local only. No deploy, no prod. Locked renderer untouched. Admin auth unchanged._

- **New table `vq_ai_generations`** (founder-approved) — audit log for every AI suggestion (provider/model/prompt/output/applied). Migration `migrations-vq/0002_blushing_overlord.sql`, applied to **staging only**. ⚠️ Applied by running the CREATE directly, NOT `drizzle-kit push` — push diffs the whole vq schema and, on the existing drift, attempted a destructive drop (aborted safely, no data lost: 150 cards / 12 families intact). Use migration SQL, never `push`, for VQ.
- **AI provider abstraction** (`server/vault-quest/ai/provider.ts`) — text = Anthropic via the existing `anthropicFetch` (model `claude-haiku-4-5-20251001`, overridable by `VQ_AI_TEXT_MODEL`); image providers (Higgsfield MCP, OpenAI Images, Nano Banana, Nano Banana Pro) declared but **not wired** — each reports "not connected". No provider absence ever fails the Studio.
- **Text generators** (`ai/generators.ts`) — name, family-names, gameplay, flavour, artwork-prompt; each builds a lexicon-locked prompt, parses strict JSON, and screens every suggestion. **Guardrails** (`ai/guardrails.ts`): input + output blocked for Pokémon/Yu-Gi-Oh/Magic/Lorcana/Digimon/One Piece, banned card terms (HP/Weakness/Resistance/Retreat), and card-layout/logo/text requests; soft warnings for medieval/overused/long names. Verified 8/8 (guardrails + audit + graceful degradation).
- **AI Assist panel** (client) — tabs Names / Gameplay / Flavour / Artwork / Variants; every suggestion has Copy · Apply · Regenerate · Reject; **never auto-applies** — Apply sets form fields then runs QA (Phase 8). Disclaimer shown. Image tabs list the 4 providers as "not connected".
- **Add-new dropdowns:** Element (`POST /elements` → placeholder palette, NEEDS_APPROVAL), Family (`POST /families` → registry row, auto id), Keyword + Status-effect (chip multi-selects seeded from `/taxonomy`, free-form add). `effects` column now wired through save. Verified 6/6 with cleanup (staging back to 150).
- **⚠️ Gate — text AI needs a key locally:** `ANTHROPIC_API_KEY` is NOT in local `.env` (it's a Fly/prod secret, and Fly secrets can't be read back). So text AI shows "not connected" locally until the founder adds the key to `.env` and restarts. All non-AI parts (guardrails, audit, add-new, panel UI, "not connected" states) are fully verified; the live Anthropic round-trip is unverified locally for that reason.
- **Verified:** `tsc` 0, `npm run build` exit 0, all 7 new routes behind `requireAdmin`, `lib/` untouched.

### Generate "Unauthorized" fix + Phase 1 dropdowns (AI upgrade, part 1)
_Staging/local only. No schema change, no dependency, no deploy. Locked renderer untouched._

- **Fixed live bug "Generate failed — Unauthorized."** Root cause: not a Generate-specific bug — every Studio endpoint (dashboard/preview/generate) 401s identically when the admin session isn't active (confirmed by curl). The board was silently empty (getQueryFn swallows 401 → null) so the Studio *looked* logged-in. Fix: `runGenerate` now uses the shared `apiRequest` (same cookie/credentials path as the rest of the Studio); a 401 shows **"Admin login required" + redirect to `/admin/login`** instead of a cryptic toast; the board shows an **"Admin login required"** panel when no data loads. Auth is NOT weakened — `requireAdmin` still enforced. Added `scripts/vault-quest-builder/generate-auth-smoke.sh` (asserts unauthenticated Generate → 401; passing).
- **Phase 1 — proper dropdowns (foundation).** New reusable searchable `Combo` (type-to-filter, ↑/↓/Enter/Esc keyboard nav). Converted **Card Type, Element (with `NEEDS APPROVAL` labels from `/config`), Rarity, Stage, Family (searchable), Base Card (searchable), Variant Tier**. **Evolves-From auto-populates** from family + stage (Stage 1 = none, 2 = Stage 1 name, 3 = Stage 2 name) with a manual-override warning. `/config` now returns the `needsApproval` element set.
- **Gated (not shipped): "Core"/"Token" card types.** The locked render engine's QA rejects unknown card types (verified: Core/Token → reject, Collector → renders), so adding them would create un-renderable cards — reverted. Needs a locked-renderer extension (founder approval).
- **Verified:** `tsc` 0 errors, full `npm run build` exit 0 (client bundles), Core/Token render smoke, auth smoke. Existing editor behaviour preserved (dropdowns fall back to the stored value so no legacy data is lost).

### Generate-from-template + hardening-review fixes
_Staging-only. No schema change, no dependency, no deploy. Locked render engine untouched._

- **New: "Generate from template" (Card Studio).** Gold **Generate** button on the board opens a dialog to create a **single card** or a **full family** (Baby/Teen/Final) as new draft cards from the locked template (`server/vault-quest/generate.ts` + `POST /api/admin/vault-quest/generate` + modal in `admin-vault-quest.tsx`). The seeded 150 are still opened by clicking a row; Generate is for new/expansion cards. Reuses the importer's `STAT_SCALE` (5/0/0 · 8/1/1 · 12/3/2) and C/U/RR ladder. **Atomic + create-only** via a new transactional `storage.createFamilyAndCards` (onConflictDoNothing) — can never overwrite existing cards, no TOCTOU. Verified on staging (create → template/linkage/collision checks → rows removed, set back to 150).
- **Adversarial review of the session's changes (31 agents) → 16 confirmed findings, all resolved:**
  - **HIGH (crash):** `ZipStream` attached no `error` listener to its output stream — a disk-write failure during a pack export would emit an unhandled `'error'` and kill the whole server process. Fixed: latch the stream error in the constructor and surface it through `add()/finalize()` (`zip.ts`).
  - **MED:** export temp-file/fd could leak on a mid-job error → set `job.filePath` early + `destroy()` the write stream on error in both runners (`export-jobs.ts`).
  - **FALSE POSITIVE (verified, not changed):** claim that Final-stage rarity should be `R` — staging shows the set uses `C/U/RR` (12 each per stage), so the generate ladder already matches.
  - **LOW (all fixed):** `getStudioCardsBatch` now set-agnostic (matches `getStudioCard`); collector denominator grows so it can't read `151/150`; generate is transactional (kills the concurrent-generate race + non-atomic family write); element allowlist uses `hasOwnProperty` (no prototype-key bypass); cardType/rarity/setCode validated; zip entry-name sanitizer now segment-splits (no single-pass `..` bypass); client export poll aborts on unmount; server job hard-timeout (15 min) with an unhandled-rejection guard; download read stream destroyed on client disconnect.
- **Re-verified on staging:** ZipStream error now rejects gracefully (no crash), pack/proxy jobs + 2× determinism still green, generate atomic create/collision/cleanup all pass (10/10), `tsc` 0 errors.

### Production hardening — Export/Proxy stability + Card Studio performance (QA pass)
_Staging-only. No schema change, no new dependency, no deploy. Locked render engine (`server/vault-quest/lib/*`) untouched._

- **OPEN-27 resolved — export/proxy are production-safe.** Export pack and proxy sheet moved off the request thread into background jobs (`server/vault-quest/export-jobs.ts`): POST returns a `jobId` immediately (no request timeout on 150+ cards), the client polls progress, then downloads a streamed temp file.
  - New streaming ZIP writer `ZipStream` (`zip.ts`) — async deflate on the libuv threadpool (event loop never blocked) writing one entry at a time to a temp file. Replaces the synchronous in-memory `makeZip` for packs.
  - `buildProxyPdf` (`proxy.ts`) refactored to a lazy page-by-page provider that streams the PDF to disk — peak memory is one 9-card page, not the whole set.
  - Cards rendered one at a time from a single batched load → peak memory bounded to ~one card. Verified full-150 pack 4.2s / proxy 6.4s, peak RSS ~630MB (vs the old buffer-everything path heading toward ~1GB).
  - Jobs capped (`MAX_ACTIVE=3`, `MAX_BATCH=200`); temp files random-named in `os.tmpdir`, unlinked on TTL/error. Download endpoint streams a server-controlled path (no user path input → no traversal); `jobId` is an unguessable UUID used only as a map key. Known caveat: in-process store assumes single-machine (documented in the module + OPEN-27 residual).
- **Deterministic + checksum-verified exports.** New `pdf-normalize.ts` freezes pdfkit's only non-deterministic bytes (indirect-object `(D:…)` dates + trailer `/ID`), length-preserving so the xref stays valid. Verified: two full exports produce **identical `checksums.txt`**; normalized PDFs remain structurally valid (header/`%%EOF`/`startxref→xref`). Applied to all saved-card renders + single-card PDF export.
- **N+1 eliminated in Card Studio.** `getStudioCardsBatch` (`storage.ts`) loads all cards + families in **2 queries** and resolves family/base/previous-stage in memory; batch QA + export + proxy use it instead of 3 queries per card (measured **10–18× fewer round-trips**, 60→2 on a 20-card slice). `fetchArt` now skips R2 entirely for art-less cards (was 2 GetObject/card) and parallelizes the two slots when art exists.
- **Client:** proxy/export buttons now start a job, show live `Proxy… 42/150` progress, disable during a run, and auto-download on completion (`admin-vault-quest.tsx`). No redesign, no new user features.
- **Verified on staging:** N+1 profile, 2× pack determinism, PDF validity, full-150 pack+proxy jobs, 15/15 service-layer regression (dashboard, get/batch, evaluate, render, fetchArt, setIntegrity, metadata, families, familyTree, revisions), `tsc` 0 errors.

### Phase 1 — Foundation
- Created `VAULT_QUEST_MASTER_SPEC_v1.0.md` (single source of truth) from full inventory of all VQ artifacts + `VQ_CARD_BUILDER_v0.1` + build plan + 14-expert audit.

### Founder rulings
- **OPEN-01 resolved:** card faces stay element-coloured (exempt from navy-primary); navy is the brand/UI/card-back/website foundation; gold reserved for premium/rarity.

### Phase 2 — Design System (done, v0.1)
- `client/src/vault-quest/design-tokens.css` — isolated `--vq-` token foundation (navy ladder, white/silver UI, 7 element card-face palettes, premium gold, rarity tokens, elevation, spacing, radii, glow/neon, type scale). Typography family left as TODO (OPEN-02).
- Rarity colour tokens (C/U/R neutral-navy; SR/GR/UR gold — gold reserved to premium tiers).
- Component library under `client/src/vault-quest/ui/`: `vault-quest.css`, `cx.ts`, `primitives.tsx` (button, field, input, select, textarea, badge, element/rarity/status badges, tabs, search bar), `layout.tsx` (`VQPage` shell + branded header + "by MintVault" footer, `VQPanel`, `VQNeonBackground`, `VQThemeRoot`, `VQPlaytestBadge`), `feedback.tsx` (loading/empty/error), `index.ts` barrel, `DesignSystemPreview.tsx` (living reference).
- Adversarial 3-lens review (brand/a11y/isolation) + fixes: accessible focus ring (`--vq-focus`), AA-compliant rarity/placeholder/gold-label text (`--vq-gold-ink`, `--vq-field-border`), `VQButton type="button"`, reduced-motion spinner, playtest badge de-yellowed. Full detail in `VAULT_QUEST_QA_LOG.md`.
- **Isolation held:** VQ UI dir imports only `react` + `lucide-react`; nothing wired into the running app yet (additive, zero-risk).

### Chore
- `client/src/components/admin/admin-shell.tsx` — Vault Quest nav icon `Swords` → `Sparkles` (brand avoid-list compliance).

### Phase 3 — Data layer (started)
- **OPEN-13 resolved (founder):** canonical dataset = 150-card master `VQ_GENESIS_VAULT_MASTER_SET_LIST_v1.0` (001/150–150/150), Option B family reconciliation, locked creature names. 90-card set marked **deprecated / playtest reference only**.
- `shared/vq-validate.ts` — shared, dependency-free card + deck validator (required fields, locked constants, enum membership, print-layout caps, creature stage-lock + Evolves-From, banned-term scan, config-driven numeric ranges, deck-size/copy-limit/element rules from config). tsc clean.
- **BLOCKED (OPEN-19):** the canonical 150-card master file is not on disk (searched repo + `~/Downloads` + all zips). Seed import cannot run until it is provided. No cards invented.
- No DB push, no deploy (per instruction + safety rules).

### Rules v0.1 folded in (resolves OPEN-06/07/15)
- Opened `VQ_RULES_v0.1_PLAYTEST_LOCK.zip` (present in Downloads). Contains a complete 30-section ruleset + `VQ_GAME_CONFIG_v0.1.csv`.
- **OPEN-06 (win condition) resolved:** win by 5 Seals via Knock-Out; Final KO = 2 Seals.
- **OPEN-07 (Core economy) resolved:** Core Bank cap 10, start 1, unlock +1/turn, readies each Ready Phase; attacks free unless printed.
- **OPEN-15 (game_config) resolved:** canonical `LOCKED_FOR_PLAYTEST` values recorded (Master Spec §11).
- Master Spec §8 rewritten from DRAFT → **PLAYTEST LOCK v0.1** (turn sequence, Ascend 2/4, Shift, Guard, Vulnerability +2, mulligan, ties).
- Rules body copied to `client/src/content/vault-quest-rules.md` (version-marked) — ready for the Phase 6 rules page.
- **Status: playtest lock, NOT print-final** — subject to Kill-Gate playtesting.

### Phase 3/4 — Importer (dataset-agnostic) + admin import endpoint
- `server/vault-quest/seed.ts` — imports ANY Genesis Vault master (CSV/JSON) with **no code changes** (proven: dry-run on the 90-card master → 90/90 valid, 18 families auto-derived, 14 config keys). Reuses the existing loader, derives families + Evolves-From from the card data itself (no separate registry needed), validates every row, seeds set/families/game-config/cards. **Dry-run is DB-free; `--commit` is gated** (needs the pushed `vq_` tables) and refuses to write if any row fails.
- Adversarial 2-lens review (correctness + safety/isolation): safety **PASS** (dry-run DB-free, commit gated + `vq_`-only, no injection). Fixed 2 HIGH correctness traps + 1 hardening: cross-row duplicate guard (dup `card_id` / collector / stage-in-family — verified firing), read `Attack N Cost`/`Effect` columns when present (`lib/data.ts`), NFC-normalize banned-term scan.
- `POST /api/admin/vault-quest/import` — admin endpoint wrapping the importer (CSV/JSON upload → dry-run report; `?commit=true` gated). tsc clean.

### 150-card canonical master received + structure import
- `VQ_GENESIS_VAULT_MASTER_SET_LIST_v1.0.zip` landed in `~/Downloads` (150 rows + Option B family reconciliation, 12 families). OPEN-19 resolved.
- Finding: it is a **set LIST** (collector/id/name/family/stage/rarity/variant/art-status), **not a gameplay dataset** — no stats/effects; ~15-element taxonomy (vs built 7); adds card types Collector/Place; 60 base + 90 alt-rarity variants (SRA/CHR/FSR/UR/CR) linked by `source_base_card`.
- Importer given a **structure mode** (auto-detected when no creature carries stats): imports the list as **draft shells** (stats null, taxonomy stored verbatim, not enforced). Variants no longer false-rejected (family/stage uniqueness scoped to full-gameplay mode; card_id + collector uniqueness stay hard). **Dry-run: 150/150 valid; 90-card still 90/90 valid in full mode.**
- New OPEN items 20–23 (stats source, element taxonomy, variant schema, new types/tiers) — these gate render/approve/play, not the structure import.

### Founder rulings on the 150 set + build (OPEN-20/21/22)
- **OPEN-20 (stats):** base creatures seeded with the deprecated 90-card starting scale (S1 5/0/0, S2 8/1/1, S3 12/3/2); variants inherit from base; effects/final balance authored in Card Studio (no invented balance). Verified: 150 dry-run → 36 base creatures get stats, 84 variants linked, sample confirms 5/8/12 by stage.
- **OPEN-22 (variants):** added `variant_tier` + `base_card_id` to `vq_cards` (`shared/vq-schema.ts`); migration **`migrations-vq/0001_equal_iron_fist.sql` generated offline** (2 additive `ALTER TABLE vq_cards ADD COLUMN`, `vq_`-only, no DROP) — **NOT pushed**. Importer resolves `source_base_card` (collector) → base card_id and links 84 variants.
- **OPEN-21 (elements):** keep the 15-element taxonomy; render only approved-active, placeholder + `NEEDS_APPROVAL` for the rest. Data-level done (all 15 stored verbatim on import); render-palette expansion queued (not blocking — draft shells don't render yet).
- Engine `VqCard` type gained optional `variant_tier`/`source_base_card`; `lib/data.ts` unchanged behaviour for the 90-card.

### OPEN-21/23 render work — taxonomy expansion (draft-safe, approval-labelled)
- **Elements:** all 15 registered in `VQ_ELEMENTS` (7 approved + 13 placeholder). New `VQ_ELEMENTS_NEEDS_APPROVAL` set (Blaze/Tide/Blossom/Spark/Earth/Cosmos/Wind/Electric/Ice/Dark/Light/Brand/Crystal). Render service emits a `NEEDS_APPROVAL` **warn** (never a reject).
- **Crests:** the emoji fallback in both templates replaced with a **vector-diamond placeholder** (never emoji, which won't rasterise) — every element now renders a clean mark.
- **Card types:** `Collector` + `Place` added and routed through the support template (stat-less), across `render-service.ts`, `qa.ts`, `vq-validate.ts`, and the Studio dropdowns.
- **Rarity:** `SRA`/`RR`/`FSR`/`CR` added to `VQ_RARITIES` + Studio.
- **Renderer robustness:** verified via smoke test — Flame (approved), Blaze/Cosmos/Brand/Crystal (new elements), Collector/Place (new types) all render to PNG, 0 crashes, 0 rejects; approved elements carry no NEEDS_APPROVAL flag.
- Placeholder palettes/crests are **NOT final** — real approved art pending founder sign-off. Still: no DB push, no deploy. tsc clean throughout.

### STAGING push (founder-approved, staging-only)
- Refreshed the stale staging `neondb_owner` password in `.env` (backup: `.env.bak.prevqpush`); prod never touched (endpoint guard active throughout).
- Applied migrations `0000` + `0001` to the **staging** Neon branch (`ep-purple-voice-abfez796`) via `drizzle-kit migrate --config drizzle-vq.config.ts` → 7 `vq_` tables + `variant_tier`/`base_card_id`.
- Seeded the 150 set list (`seed.ts --commit`): **150 cards, 12 families, 14 config keys, 1 set** (GNV/150). 36 base creatures w/ starting stats, 84 variants linked. 0 invalid.
- Verified on staging: row counts confirmed; render smoke test — Collector/Place/Tactic/Relic render to PNG; Creature shells correctly reject (no attack data in the set list → authored later in Studio).
- **No production push, no deploy.** Stopped for founder approval.

### Card Studio — 5-agent review + Foundation phase
- Ran a 5-agent read-only review (arch / workflow / renderer / data / QA-print) + reconciliation → one foundation-first plan. Verdict: Card Studio is ~80% a frontend build on the existing production-grade backend; the locked render engine (`lib/*`) is untouched, consumed only via `renderCard()`.
- **Foundation built (zero schema):**
  - F1 — `GET /cards/:cardId/art/:slot` serves stored artwork by card id (never the raw R2 key).
  - F2 — clicking a card in the list now **loads it into the editor** (was a no-op refetch). Hydrates all fields.
  - F3 — `vqStorage.getStudioCard` derives Stage 2/3 `previousStage` + `familyName` from `vq_families` (no stored column); returns the base card for variants. Enhanced `GET /cards/:cardId`.
  - F5 — attack **Core-cost** inputs added to the editor (`attack1Cost`/`attack2Cost`); `toInsert` now preserves `variantTier`/`baseCardId`.
  - Q1 — PNG export now returns the **600-DPI master** (was 300-DPI preview).
  - Variant base-reference banner (read-only inherited-gameplay display).
- **Data fix (staging):** `familiesFromCards`/`buildFamilyStageMap` now let **only base cards** define family stage-names (variants share family+stage with suffixed names, which had contaminated the derived `previousStage`, e.g. "Flammi SRA"). Re-seeded 12 families on staging → GNV-002 previousStage=Flammi, GNV-003=Flammro (correct).
- Verified: tsc 0 errors; `getStudioCard` derivation confirmed against live staging data. No prod, no deploy, no migration.

### Card Studio — Workflow + Dashboard + QA engine (Phases 6, 7, 9 + Phase 8 backend)
- `shared/vq-workflow.ts` — 10-state workflow (draft → needs_* → ready_for_review → approved → export_ready → printed_proxy, + rejected/archived), `allowedTargets`, `canTransition` gates (no ready-with-blocking-QA; no approve without data+artwork+render; no export without render; variant needs base approved unless override), `readinessScore`, badge tones. Zero schema — history via existing `vq_card_revisions`.
- `server/vault-quest/qa-engine.ts` — `evaluateCard` (resolves variant inheritance on read, runs the LOCKED engine via `renderCard`, computes gates + readiness + suggestions). Never touches the template.
- Storage: `setCardStatusAudited` (audited + compare-and-set optimistic lock), `dashboardSummary` (fast render-free aggregates), `familyTree`, `listVariantsOf`.
- Routes: `GET /dashboard`, `GET /families` + `/:id`, `GET /cards/:id/revisions`, `GET /cards/:id/evaluate`, `POST /cards/:id/status` (gated transition), `GET /cards/:id/render/:fmt` (render a saved card).
- Studio UI rewritten into a **control centre**: dashboard board (12 stat tiles + filters + 150-card table, click-to-edit) + editor with the full workflow bar (status badge, readiness, Run QA, Mark Ready/Approve/Reject/Return/Export-Ready/Printed-Proxy/Archive with gate-reason toasts + variant override).
- **Adversarial review (Phase 13) + fixes:** caught + fixed a HIGH gate-bypass (save route was a 2nd ungated door to `status` → now single-door, forward transitions only via `/status`), a security issue (client-supplied R2 key deref → keys now derived server-side from card id), added optimistic compare-and-set, dirty-form guard on transitions, identity in dashboard `hasData`, more workflow buttons. Isolation/auth/template-drift all reviewed **PASS**.
- Verified on staging: dashboard reads 150 (66 base/84 variants/120 need-data/150 need-art); QA gates correctly; audited transition + compare-and-set + revert confirmed. tsc 0 errors. No migration, no deploy, no prod.

### Card Studio — Export Centre + Proxy + polish (Phases 10, 11, 12) + Phase-13 review
- `server/vault-quest/zip.ts` — zero-dep in-memory ZIP writer (Node zlib + CRC32; deflate/stored per entry). No new npm dependency. Verified valid via `unzip -t`.
- `server/vault-quest/proxy.ts` — DB-driven proxy sheet (A4, 3×3, true 63×88mm from the 600-DPI master, bleed-cropped, cut ticks, playtest footer), bounded sharp concurrency.
- `server/vault-quest/qa-set.ts` — set-integrity QA (collector-number uniqueness / 1..N completeness / base refs resolve) + per-card metadata JSON.
- Routes: `GET /qa/set`, `GET /cards/:id/metadata`, `POST /qa/batch`, `POST /proxy` (PDF), `POST /export/pack` (.zip of svg/png-600dpi/pdf + per-card metadata + manifest + sha256 checksums).
- Studio UI: dashboard bulk **Proxy** + **Export pack** actions (over the filtered board), **family filter**, unsaved-changes (`beforeunload`) guard.
- **Phase-13 adversarial review (4 lenses: print-safety, export, performance, security) + fixes:** filenames now include cardId (no pack collisions); zip entry names + download filenames sanitized (no zip-slip / header injection); selection hard-capped at 200 (blocks a crafted-`ids` DoS); manifest now flags `has_artwork` / `placeholder_element` / `warns` per card (a print house can't mistake a placeholder for final). Print geometry + zip structure + auth + art-key-derivation + no-SQL-injection all reviewed **PASS/CLEAN**.
- Verified on staging: set QA (150 complete, 0 issues), zip validity, proxy PDF (%PDF-). tsc 0 errors. No migration, no deploy, no prod.

### Docs
- Created `VAULT_QUEST_BUILD_PROGRESS.md`, `VAULT_QUEST_CHANGELOG.md`, `VAULT_QUEST_OPEN_ITEMS.md`, `VAULT_QUEST_QA_LOG.md`.
