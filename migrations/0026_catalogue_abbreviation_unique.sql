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
--   * Uniqueness applies to LIVE rows only (active = TRUE AND archived = FALSE).
--   * Archived/inactive historical rows KEEP their old code and are never
--     rewritten, so certificates that stored that code stay readable.
--   * A new active replacement may therefore reuse a retired code.
--   * Reactivating an archived row whose code is now held by a live row fails —
--     at the service layer with a clear message, and here with this index.
--
-- SHARED NAMESPACE (M-3)
--   `designation` and `attribute` rows BOTH persist into the same
--   certificates.designations array, so a code from either lands in one
--   undifferentiated list. They therefore share ONE persisted-code namespace and
--   are indexed together. Every other category is its own namespace.
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
  SELECT string_agg(DISTINCT format('%s/%s (x%s)', ns, code, n), ', ')
    INTO offending
  FROM (
    SELECT
      CASE WHEN category IN ('designation', 'attribute') THEN 'designation+attribute' ELSE category END AS ns,
      lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) AS code,
      count(*) AS n
    FROM catalogue_items
    WHERE active = TRUE
      AND archived = FALSE
      AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> ''
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) dupes;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      '0026 BLOCKED: catalogue_items already contains LIVE rows that persist the same code: %. Reconcile these (change an abbreviation, or archive/deactivate the duplicate) and re-run. Archived and inactive rows are exempt by policy.',
      offending;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_items_live_effective_code
    ON catalogue_items (
      (CASE WHEN category IN ('designation', 'attribute') THEN 'designation+attribute' ELSE category END),
      lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value)))
    )
    WHERE active = TRUE
      AND archived = FALSE
      AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> '';
END
$$;
