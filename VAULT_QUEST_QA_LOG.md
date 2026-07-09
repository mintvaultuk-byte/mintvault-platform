# VAULT QUEST — QA LOG

Per-phase QA results. Every phase must record: TypeScript, build, isolation, and brand/term checks.

**Isolation invariants checked every phase:**
- No import from `server/labels.ts`, MVGS grading, `server/stripeClient.ts`, payment/certificate/submission flows.
- No schema change outside `vq_` tables; no non-VQ migration.
- No secrets committed; no production deploy; no production DB push.
- No banned card terms (HP / Pokémon / Weakness / Resistance / Retreat) in card output; no template drift.
- No medieval / sword iconography in VQ UI.

---

## 2026-07-08 — Phase 2 (Design System)

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ clean project-wide |
| CSS token integrity (every `var(--vq-*)` defined) | ✅ 64 used / 99 defined, 0 missing |
| Isolation (no grading/payment/label/stripe/`@/` business import) | ✅ clean — only `react` + `lucide-react` |
| No non-VQ schema/migration change | ✅ (no schema touched in P2) |
| No medieval/sword icon | ✅ (`Swords`→`Sparkles`) |
| Brand tokens present (navy/silver/gold/element/rarity) | ✅ |
| `any` types | ✅ none |

### Adversarial 3-lens review + fixes
- **Brand: PASS.** Gold genuinely reserved (wordmark is white+neon, not gold); no sword/medieval/armour; neon background subtle + readable. Fix applied: playtest badge was element-yellow → recoloured to a navy chip (keeps gold/element-yellow off standard chrome).
- **Token/isolation/responsive: PASS.** No undefined vars, liftable, `any`-free, responsive (auto-fit grid + mobile media query). Fixes applied: `VQButton` now defaults `type="button"` (form-submit footgun); added `VQThemeRoot` so primitives work outside `VQPage`; stale token-file comment updated.
- **Accessibility: FAIL → fixed.** Real contrast failures corrected at token level:
  - Focus ring was invisible on white (1.36:1) → new `--vq-focus` `#2B8AF0` solid ring (≥3:1 on white *and* navy).
  - Rarity-C text 2.66:1 → `--vq-rarity-common` darkened to `#5E6A82`.
  - Rarity SR/GR/UR text 3.57:1 → new `--vq-gold-ink` `#7A6410` for labels (border stays gold).
  - Placeholder `--vq-ink-faint` 3.3:1 → `#69758F`.
  - Form-control borders 1.4–1.8:1 → new `--vq-field-border` `#8090AC` (3.23:1).
  - Spinner now respects `prefers-reduced-motion`.
- **Known residual (documented, not blocking):** feedback states (`VQEmptyState`/`VQError`/`VQLoading`) use light-surface ink — must render inside a white `VQPanel`, not directly on the navy page body. Tabs are a minimal ARIA pattern (no `tabpanel`/arrow-key roving). Rarity `UR/GR` vocabulary echoes other TCGs — that's game-data naming (OPEN-11), not a design-system issue.

## 2026-07-08 — Phase 3/4 (importer + admin import endpoint)

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ clean project-wide |
| Dry-run vs 90-card master | ✅ 90/90 valid, 0 invalid, 18 families derived, 14 config keys, **0 DB access** |
| Duplicate guard (positive test) | ✅ dup `GNV-001` correctly flagged (dup card_id + dup stage-in-family), commit refused |
| Isolation | ✅ importer imports only vq modules + `@shared/vq-validate`/`vq-schema` + `lib/data`; endpoint adds node core + multer (sanctioned) |
| No DB push / migration / deploy | ✅ dry-run DB-free; commit gated behind the (unpushed) `vq_` tables |

### Adversarial 2-lens review (correctness + safety) + fixes
- **Safety/isolation: PASS.** Verified dry-run never constructs the DB pool (storage only via dynamic import under `--commit`); commit throws before any write if a row fails; all writes hit `vq_` tables via parameterized drizzle; no raw SQL/injection; upserts make re-run idempotent.
- **Correctness: 2 HIGH + 1 low fixed.**
  - H1/M2 — no cross-row uniqueness → **fixed** (`findDuplicates`: dup `card_id` / collector / stage-in-family → reject; verified firing).
  - H2 — `fromMasterRow` silently zeroed `Attack N Cost`/blanked `Effect` → **fixed** (reads those columns when the master has them; 90-card behaviour unchanged).
  - L2 — banned-term scan missed decomposed-accent "Pokémon" → **fixed** (NFC normalize).
- **Accepted as-is (documented):** print-layout caps (name ≤25, cost ≤6) intentionally reject unprintable data (a data fix, not a false-reject); no transaction wrapper around `--commit` (upserts keep re-runs idempotent); revision-row growth on re-seed (revisions are meant to grow).

### 150-card canonical master (structure import)
| Check | Result |
|---|---|
| Dry-run vs 150-card master (structure mode) | ✅ **150/150 valid**, 0 invalid, 12 families, mode auto-detected as "structure" |
| 90-card master regression (full mode) | ✅ still 90/90 valid, mode "full" |
| Variant handling | ✅ 90 alt-rarity variants no longer false-rejected; `card_id` + collector uniqueness still enforced (hard) |
| Duplicate guard regression (full mode) | ✅ still catches real dup (card_id + family/stage) |
| DB writes | ✅ none — dry-run only; commit still gated on the DB push |
- **Not yet renderable/playable:** structure import is draft shells only. The 15-vs-7 element render palette (OPEN-21) and new types/tiers (OPEN-23) must still be resolved before these cards can render/approve/play.

### Founder rulings applied (OPEN-20 stats + OPEN-22 variants)
| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ clean project-wide |
| Migration generated offline (`0001_equal_iron_fist.sql`) | ✅ 2× `ALTER TABLE vq_cards ADD COLUMN` (variant_tier, base_card_id) — `vq_`-only, additive, no DROP, **NOT pushed** |
| Base-creature starting stats (150 dry-run) | ✅ 36 base creatures seeded S1 5/0/0, S2 8/1/1, S3 12/3/2 (sample verified) |
| Variant linkage (150 dry-run) | ✅ 84 variants linked to base via `base_card_id`; inherit stats (blank) |
| 90-card regression | ✅ full mode, 90/90, keeps real stats, 0 variants (unchanged) |
| DB writes | ✅ none — dry-run only; commit + push still gated |

### OPEN-21/23 render taxonomy (draft-safe)
| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ clean project-wide |
| Render smoke test (5 cards) | ✅ Flame (approved), Blaze/Cosmos/Brand/Crystal (new elements), Collector/Place (new types) → all `status=pass`, real PNG (54–60 KB), **0 crashes, 0 rejects** |
| Approved-element regression | ✅ Flame renders with no NEEDS_APPROVAL flag; new elements correctly flagged |
| Crest fallback | ✅ vector-diamond placeholder (no emoji-tofu) for elements without a crest SVG |
| Card-type routing | ✅ Collector/Place route to support template (no creature-field rejects) |
| Isolation / safety | ✅ additive render-engine edits; no grading/payment/label touch; no DB push; no deploy |
- Placeholder palettes/crests are **NEEDS_APPROVAL, not final** — real approved art pending founder sign-off.
