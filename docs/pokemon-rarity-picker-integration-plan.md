# Pokémon rarity/variant picker — integration plan (needs owner approval)

This commit ships the **safe foundation only** (per your choice): the pure structured
catalogue (`shared/pokemon-rarity-catalogue.ts`), a standalone visual picker
(`client/src/components/rarity-picker/`), and tests. It does **not** touch the protected
grading card tool, the certificate renderer, or the DB schema, and it does **not** change
any existing certificate.

The steps below are the remaining, **approval-gated** work (Golden Rules 2 + the
MVGS-protected zone). Nothing here has been applied.

## 1. Schema migration (Golden Rule 2 — your approval before `db:push`)

Today a card's rarity/variant lives in `rarity` / `rarityOther` / `variant` /
`variantOther` / `language` (one flat `variant` text column mixes rarity + finish +
subset). To store each concept separately, add **new, nullable, additive** columns —
**keep the existing columns untouched** so all history is preserved:

| New column | Holds |
|---|---|
| `rarity_canonical` | catalogue rarity value (e.g. `special_illustration_rare`) |
| `printed_symbol` | glyph (e.g. `★★`) |
| `symbol_colour` | `gold` / `silver` / `black` / … |
| `finish_canonical` | catalogue finish value (e.g. `reverse_holo`) |
| `promo_canonical` | catalogue promo value (kind `promo`) |
| `subset_canonical` | catalogue subset value (kind `subset`) |
| `region` | `western` / `japan` / … |
| `era` | set era |

- The migration is **column adds only** — no drops, no backfill that overwrites existing
  rows. `variant` etc. stay as the historical record.
- I will validate the SQL against the live column list first (db-migration-discipline) and
  **not** apply it to staging/prod without your go-ahead.

## 2. Legacy backfill (opt-in, reversible, never auto-changes a certificate)

`mapLegacyVariant()` proposes a structured mapping for each historical `variant` code and
**flags ambiguous ones** (`FULL_ART`, `ALT_ART`, `RAINBOW`, `GOLD`, `EX`, `PROMO`, `OTHER`,
unknown codes) for admin review. Proposed flow:

1. A read-only **audit report** groups existing distinct `variant` values by proposed
   classification + ambiguous flag (run against staging first).
2. An admin **review queue** applies only the confirmed, non-ambiguous mappings, writing the
   new columns while leaving the old ones intact. Existing certificates are never rewritten
   automatically.

## 3. Wire the picker into the certificate form (protected — your approval)

Replace the flat variant dropdown in `client/src/components/certificate-form.tsx` with
`<RarityVariantPicker>`, saving the eight structured fields. The MVGS grading card tool,
scoring, and Pristine gate are untouched.

## 4. Certificate rendering (protected — your approval)

Show the four classifications separately on the cert (`server/certificate-document.ts` /
`server/labels.ts`) instead of one combined string. This is grade-adjacent rendering and
needs a visual before/after review before any change.

## Confirmed audit findings (this commit)

- Existing canonical values come from `client/src/lib/variantOptions.ts` (`VARIANT_OPTIONS`)
  — a flat list mixing rarities/finishes/subsets/art-types.
- Clear legacy → structured mappings are encoded and tested; ambiguous values are flagged,
  not silently mapped.
