-- 0026_catalogue_abbreviation_unique.sql
--
-- Hostile-review MEDIUM: catalogue persisted-code uniqueness.
--
-- WHY
-- Designations persist `abbreviation || value` onto a certificate (see
-- shared/catalogue-snapshot.ts mapDesignationRow and
-- shared/catalogue-validate.ts effectiveCatalogueCode). 0019 enforces
-- uniqueness on (category, value) only, so two LIVE rows could still resolve to
-- the SAME persisted code — for example row A with abbreviation 'PROMO' and
-- row B with value 'promo' and no abbreviation. A certificate storing 'PROMO'
-- would then resolve ambiguously, and re-saving could silently rewrite which
-- entry it means.
--
-- POLICY (single coherent rule, matched exactly by shared/catalogue-validate.ts)
--   * The rule applies ONLY to the categories that actually persist
--     `abbreviation || value` — `designation` and `attribute` (see SCOPE below).
--   * Uniqueness applies to LIVE rows only (active = TRUE AND archived = FALSE).
--   * Archived/inactive historical rows KEEP their old code and are never
--     rewritten, so certificates that stored that code stay readable.
--   * A new active replacement may therefore reuse a retired code.
--   * Reactivating an archived row whose code is now held by a live row fails —
--     at the service layer with a clear message, and here with this index.
--
-- SCOPE (HIGH-2, final hostile review) — WHY ONLY designation + attribute
--   An earlier revision of this migration applied `abbreviation || value` to
--   EVERY category. That was wrong. Only `designation` and `attribute` are
--   mapped by mapDesignationRow (shared/catalogue-snapshot.ts), whose persisted
--   `code` is `abbreviation || value`. Every other category persists its
--   `value`:
--       rarity   -> value (rarityCode); abbreviation is only a display glyph
--       finish / promo / subset / language / era -> value
--   Applied to `rarity`, the old rule flagged 7 legitimate live collisions
--   across 14 staging rows — English/Japanese pairs that deliberately share a
--   printed abbreviation (hyper_rare/jp_hyper_rare = "HR", rare/rare_holo =
--   "R") — so the migration aborted against real data and the application
--   validator blocked valid edits. Those categories are already protected by
--   the per-category `value` uniqueness rule (0019 + catalogueConflict).
--
-- SHARED NAMESPACE (M-3)
--   `designation` and `attribute` rows BOTH persist into the same
--   certificates.designations array, so a code from either lands in one
--   undifferentiated list. They therefore share ONE persisted-code namespace and
--   are indexed together — which, given the scope above, is the whole index.
--
-- MIGRATION NUMBERING
-- 0019_catalogue_manager.sql is ALREADY APPLIED to production and is byte
-- identical to origin/main — it is NOT edited or renamed here, and its checksum
-- is untouched. Current main's applied/authored set is 0019, 0022, 0023, 0024.
-- 0025 is deliberately LEFT FREE: the separate branch
-- fix/grading-optimistic-concurrency still carries an unapplied
-- 0019_grading_optimistic_concurrency.sql that must be renumbered to the next
-- available number, reported as 0025 at review time. This migration therefore
-- claims 0026 so the two cannot collide whichever lands first. That branch is
-- NOT modified from this worktree.
--
-- SAFETY
-- Additive only: no table is created, altered or dropped, no data is written.
-- Idempotent and safe to re-run. If catalogue_items does not exist (0019 not yet
-- applied) the whole migration is a no-op — the index creation is INSIDE the
-- same guard, so the "skipping" notice is truthful rather than being followed by
-- a statement that fails anyway.

DO $$
DECLARE
  offending TEXT;
BEGIN
  IF to_regclass('public.catalogue_items') IS NULL THEN
    RAISE NOTICE '0026: catalogue_items does not exist (0019 not applied here) — nothing to index, skipping.';
    RETURN;
  END IF;

  -- Fail LOUDLY, naming the offending codes, instead of surfacing a bare
  -- "could not create unique index" from the CREATE INDEX below.
  SELECT string_agg(DISTINCT format('designation+attribute/%s (x%s)', code, n), ', ')
    INTO offending
  FROM (
    SELECT
      lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) AS code,
      count(*) AS n
    FROM catalogue_items
    WHERE active = TRUE
      AND archived = FALSE
      AND category IN ('designation', 'attribute')
      AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> ''
    GROUP BY 1
    HAVING count(*) > 1
  ) dupes;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      '0026 BLOCKED: catalogue_items already contains LIVE designation/attribute rows that persist the same code: %. Reconcile these (change an abbreviation, or archive/deactivate the duplicate) and re-run. Archived and inactive rows are exempt by policy, and value-keyed categories (rarity, finish, promo, subset, language, era) are out of scope.',
      offending;
  END IF;

  -- Dropped first so re-running this migration CONVERGES on the current scope.
  -- An earlier revision created an index of the same name over every category;
  -- a bare CREATE ... IF NOT EXISTS would silently leave that stale, over-broad
  -- index in place. The index is owned exclusively by this migration.
  DROP INDEX IF EXISTS uq_catalogue_items_live_effective_code;

  CREATE UNIQUE INDEX uq_catalogue_items_live_effective_code
    ON catalogue_items (
      lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value)))
    )
    WHERE active = TRUE
      AND archived = FALSE
      AND category IN ('designation', 'attribute')
      AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> '';
END
$$;
