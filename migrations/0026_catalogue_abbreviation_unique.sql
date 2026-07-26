-- 0026_catalogue_abbreviation_unique.sql
--
-- Hostile-review MEDIUM: catalogue abbreviation uniqueness.
--
-- WHY
-- Designations persist `abbreviation || value` onto a certificate (see
-- shared/catalogue-snapshot.ts mapDesignationRow and
-- shared/catalogue-validate.ts effectiveCatalogueCode). 0019 enforces
-- uniqueness on (category, value) only, so two LIVE rows in the same category
-- could still resolve to the SAME persisted code — for example row A with
-- abbreviation 'PROMO' and row B with value 'promo' and no abbreviation. A
-- certificate storing 'PROMO' would then resolve ambiguously, and re-saving
-- could silently rewrite which entry it means.
--
-- WHAT
-- A partial unique index on the EFFECTIVE persisted code, per category, over
-- LIVE rows only (active AND not archived). Deactivated/archived rows are
-- deliberately excluded so history can be retired without blocking a
-- replacement entry that reuses the code.
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
-- The DO block below fails LOUDLY with the offending codes listed, instead of
-- surfacing a bare "could not create unique index" — existing catalogue data
-- must be reconciled by hand before this can apply.

DO $$
DECLARE
  offending TEXT;
BEGIN
  IF to_regclass('public.catalogue_items') IS NULL THEN
    RAISE NOTICE '0026: catalogue_items does not exist yet — skipping (0019 not applied here).';
    RETURN;
  END IF;

  SELECT string_agg(DISTINCT format('%s/%s (x%s)', category, code, n), ', ')
    INTO offending
  FROM (
    SELECT
      category,
      lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) AS code,
      count(*) AS n
    FROM catalogue_items
    WHERE active = TRUE
      AND archived = FALSE
      AND coalesce(nullif(btrim(abbreviation), ''), btrim(value)) IS NOT NULL
      AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> ''
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) dupes;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      '0026 BLOCKED: catalogue_items already contains live rows that persist the same code: %. Reconcile these (change an abbreviation, or archive/deactivate the duplicate) and re-run.',
      offending;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_items_category_effective_code
  ON catalogue_items (
    category,
    lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value)))
  )
  WHERE active = TRUE
    AND archived = FALSE
    AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> '';
