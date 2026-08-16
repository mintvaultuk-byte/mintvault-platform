-- P11 — NFC BINDING INTEGRITY.
--
-- NUMBER SAFETY: 0088 follows 0087 (the grading edit lease), the global high-water mark across every
-- ref in the repository. The runner rejects duplicate numbers.
--
-- ============================================================================================
-- WHAT THIS CLOSES
-- ============================================================================================
-- The NFC facility has NO migration at all. Its twelve columns were hand-applied to production in
-- March 2026 (docs/github-push-instructions.md) and exist in shared/schema.ts with no index callback
-- whatsoever — so `certificates.nfc_uid` carries no UNIQUE index, no CHECK and no foreign key.
--
-- "One tag, one certificate" was therefore enforced ONLY by an application-level read-then-write in
-- server/routes.ts:
--
--     const existing = await storage.getCertificateByNfcUid(uid);
--     if (existing && existing.id !== id) return 409;
--     ...
--     await storage.saveNfcData(id, { uid, ... });
--
-- Two concurrent binds of the SAME physical tag to two different certificates both pass that SELECT
-- and both commit. The result is one tamper-evident chip that resolves to two different graded
-- cards — precisely the trust property the chip exists to provide, silently broken, with no row
-- anywhere recording that it happened.
--
-- WHY `lower(nfc_uid)` AND NOT `nfc_uid`. The read guard is already case-insensitive
-- (server/storage.ts getCertificateByNfcUid: `WHERE LOWER(nfc_uid) = $1`) while saveNfcData writes
-- the raw request value. So 'AA:BB' and 'aa:bb' are the SAME tag to the application and two distinct
-- strings to a naive index — an index on the bare column would leave the exact hazard open that the
-- application already considers closed. Indexing the same expression the guard queries is what makes
-- the database agree with the code rather than merely sit alongside it.
--
-- PARTIAL, because an unbound certificate legitimately has no tag and NULLs must not collide.
--
-- ============================================================================================
-- SCOPE: APPLICATION (requires `certificates`)
-- ============================================================================================
-- Guarded by to_regclass so a partner-only disposable database — which has no `certificates` table
-- to index — applies this as a no-op rather than failing. Same conditional idiom as 0080 PART 1b.
--
-- ============================================================================================
-- MIXED-VERSION SAFETY (invariant I17)
-- ============================================================================================
-- Purely additive: one partial unique index. No column added, dropped or altered; no data rewritten.
-- An OLD application version is unaffected except that a duplicate bind it would previously have
-- accepted now raises a unique violation — which is the intended behaviour, and which the new code
-- translates into the same 409 the read guard already returned.
--
-- ROLLBACK / DOWN-PATH: `DROP INDEX IF EXISTS uq_certificates_nfc_uid;` — always safe, since the
-- index constrains rather than stores.

DO $$
DECLARE
  duplicate_report text;
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE NOTICE '0088: no certificates table in this database; NFC integrity index skipped.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'certificates' AND column_name = 'nfc_uid'
  ) THEN
    RAISE NOTICE '0088: certificates.nfc_uid absent in this database; NFC integrity index skipped.';
    RETURN;
  END IF;

  -- FAIL LOUDLY RATHER THAN SILENTLY WIDENING AROUND EXISTING DAMAGE.
  --
  -- If two certificates already share a tag, that is a live trust defect and a human must decide
  -- which binding is correct — it must never be resolved by whichever row an index build happened to
  -- reject. Same discipline 0074 applies before widening a status domain.
  SELECT string_agg(detail, '; ')
    INTO duplicate_report
    FROM (
      SELECT lower(nfc_uid) || ' -> ' || string_agg(certificate_number, ',' ORDER BY certificate_number) AS detail
        FROM certificates
       WHERE nfc_uid IS NOT NULL
         AND btrim(nfc_uid) <> ''
         AND deleted_at IS NULL
       GROUP BY lower(nfc_uid)
      HAVING count(*) > 1
    ) AS duplicates;

  IF duplicate_report IS NOT NULL THEN
    RAISE EXCEPTION
      '0088: one NFC tag is bound to more than one live certificate (%). Resolve each binding before applying this migration.',
      duplicate_report
      USING ERRCODE = 'unique_violation';
  END IF;

  -- `deleted_at IS NULL` in the predicate: a soft-deleted certificate keeps its historical binding
  -- for evidence, and must not block the tag being legitimately rebound to a live card.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_nfc_uid
    ON certificates (lower(nfc_uid))
    WHERE nfc_uid IS NOT NULL AND btrim(nfc_uid) <> '' AND deleted_at IS NULL;
END$$;
