# Current Catalogue Audit

Read-only audit at `origin/main` `36699531`; production verified live on 2026-08-15.
Nothing in production was modified while producing this report.

## 1. Where classification data actually lives

| Concern | Authority | Notes |
| --- | --- | --- |
| rarity / finish / promo / subset / designation / language / era / attribute | `catalogue_items` (8 categories) | DB-backed, founder-curated, Super-Admin CRUD + audit |
| Sets | `custom_sets`, `tcgdex_sets`, `card_sets` | Three sources UNIONed by `server/services/set-library.ts`. Two are **not** in Drizzle (raw SQL) |
| Cards | `card_master` | **Read-only in practice — no write path exists anywhere in the repo** |
| Printed certificate wording | `certificates` columns | See §3 |

Production `catalogue_items` (2026-08-15): 99 rows — rarity 37, finish 24, promo 12, subset 5,
language 9, era 6, designation 6, attribute 0.

**Production is deliberately curated and has diverged from the static seed arrays.** It holds
language values absent from the code, and lacks 6 languages / ~4 designations the code declares.
The broad `scripts/db/seed-catalogue.ts` is therefore **not** a safe production publishing
mechanism — it would insert ~11 unreviewed rows. Single-item paths only.

## 2. Certificate immutability — verdict

**Catalogue edits CANNOT rewrite historical certificates.** Verified end to end:

- The label renderer imports no catalogue provider and no DB module.
- `updateCatalogueItem` pins `value: before.value`, so a persisted `rarity_code` can never be orphaned.
- Deactivating or archiving a catalogue row cannot blank a historical certificate.

Render sources per surface:

| Surface | Source |
| --- | --- |
| Slab label (v2 certs) | structured columns via `formatVariantLine` |
| Slab label (pre-v2) | legacy maps in `server/labels.ts` |
| Certificate document | legacy `rarity` / `variant` columns verbatim |
| Public `/api/cert/:id` | hardcoded label maps in `server/routes.ts` |

## 3. Defect found and FIXED in this pass — approved wording did not reach the certificate

`formatVariantLine` resolved rarity labels against the **compiled-in seed array**. Any value
published through the Catalogue Manager — i.e. everything a contribution-approval workflow will
ever create — is absent from that array, so it fell through to humanising its CODE.

    approved "Prize Pack Star Holo"  ->  printed "Prize Pack Star"

This falsified three programme objectives: no-deploy catalogue addition, Edit-&-Approve, and
no manual HQ re-entry. Gold Star only prints correctly because it was shipped in the seed array
as well as the database.

**Fix:** the certificate already persists the approved wording in `certificates.rarity_label`
(written at save time from the live catalogue) and it was simply never read at render. The
formatter now prefers it. Precedence: public override > persisted snapshot > seed label >
humanised code.

This also upgrades issued certificates from immutable-by-accident to **immutable by design**:
previously a code deploy editing a seed label would have retroactively changed historical
certificates with no migration and no audit trail.

**Regression risk: nil, measured.** Only 2 production certificates are on the v2 structured path;
both already carry a `rarity_label` snapshot identical to what renders today. Everything else
prints via the legacy path, untouched.

**Remaining gap (not fixed here):** only rarity has a snapshot column. `finish_variant`,
`promo_type` and `subset_name` have none, so catalogue-published finishes/promos will still print
a humanised code. Closing that needs an additive migration — the first task of the next increment.

## 4. Silver Star — confirmed defect, wording is an OWNER DECISION

`publicLabel()` strips a trailing parenthetical, so three distinct codes collide:

| code | catalogue label | prints |
| --- | --- | --- |
| `rare` | Rare | `Rare` |
| `silver_star_rare` | Rare (Silver Star) | `Rare` |
| `bw_rare` | Rare (BWR) | `Rare` |

`silver_star_rare` exists precisely to be distinct from `rare` (one SILVER vs one BLACK star), so
printing `Rare` destroys the distinction the entry was created to capture.

Second-order collisions from the same regex: `jp_double_rare`/`double_rare`,
`jp_ultra_rare`/`ultra_rare`, `jp_hyper_rare`/`hyper_rare`, `jp_ace_spec`/`ace_spec`.

**Blast radius today: zero.** No production certificate on the v2 path uses `silver_star_rare`
(the single prod cert carrying it is pre-v2 and renders via the legacy path).

**NOT FIXED — deliberately.** No repository evidence establishes the intended customer-facing
wording; the introducing commit and the catalogue description assert distinctness but never
specify wording. Guessing it would put invented text on a physical product. Owner must choose,
and the same decision must cover `bw_rare`.

## 5. Gold Star — confirmed correct

`gold_star`, era-scoped `["ex-dp"]`, live in production (`catalogue_items` id 195). EX-era search
returns Gold Star only; Scarlet & Violet search does not offer it; prints `GOLD STAR`, distinct
from Illustration Rare.

## 6. Structural findings

1. **No game scoping.** `catalogue_items` has no game column; rarity/finish/era are Pokémon-shaped
   by type and by seed. Multi-game is unmodelled work, not configuration.
2. **Four divergent supported-game lists** with colliding slugs (`one_piece` vs `onepiece`,
   `magic` vs `mtg`).
3. **`card_master` has no write path** — card contribution needs one built.
4. **`pending_set_lookups` is orphaned** — written on the TCGdex path, never read, no UI.
5. **Cache invalidation is per-machine**, 30s cross-machine staleness by design.
6. **No proposal/submitter concept exists** for `catalogue_items`. The contribution engine is
   genuinely new; there is no partial implementation to salvage.

## 7. Migration numbering

Highest on `origin/main` `0078`; highest at any ref `0091`; staging journal `0090`;
**production journal `0077`**. Next globally-safe number: **`0092`**. `0028`/`0029` are unused but
must not be reclaimed — they sort below the applied high-water.

Nine active number collisions exist across refs (0019, 0020, 0033, 0041, 0044, 0045, 0046, 0047,
0048), and staging's journal conflicts with main at 0044/0046/0047. The runner is fail-closed and
will refuse rather than misapply.
