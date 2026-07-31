-- 0035 — Immutable partner ORIGIN SNAPSHOT on certificates.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- A certificate is a permanent public record. Until now the grading issuer was a hard-coded
-- literal, so a certificate could not say WHO graded the card. server/partner/dashboard-service.ts
-- reports this honestly today:
--
--   GRADING_ORIGIN_UNAVAILABLE = 'Per-certificate grading origin is not implemented. The
--   certificate issuer is a fixed literal ("Graded by MintVault UK"); there is no stored
--   "Graded by <Shop>" value or approved-address snapshot to display.'
--
-- The partner pilot puts grading work in third-party shops. Those certificates must say
-- "Graded by <Partner Trading Name>", and that statement must remain TRUE FOREVER — including
-- after the partner renames itself, moves premises, is suspended, or is revoked and deleted.
--
-- WHY A SNAPSHOT AND NOT A FOREIGN-KEY LOOKUP
-- ---------------------------------------------------------------------------
-- A mutable FK join (certificates -> partner_organisations -> partner_profiles) would REWRITE
-- HISTORY: renaming a shop in 2027 would silently change what every 2026 certificate claims,
-- and revoking a partner would either erase the origin or leave a dangling reference. A grading
-- certificate is a bailment/authenticity record; the values printed on it must be the values
-- that were true at the moment of grading. So the VALUES are copied in at creation time and are
-- authoritative for rendering. The partner/location UUIDs are stored ALONGSIDE, for joins and
-- analytics only — never as the rendering source.
--
-- DELIBERATELY NO FOREIGN KEY CONSTRAINT on origin_partner_id / origin_location_id. A real FK
-- would couple certificate survival to partner-lifecycle operations: ON DELETE CASCADE/SET NULL
-- would destroy the origin record, and ON DELETE RESTRICT would make certificates block partner
-- offboarding forever. Both are wrong. The snapshot columns carry the meaning; the ids are a
-- best-effort join hint that is allowed to become orphaned. This is stated here so a future
-- reviewer does not "fix" the missing FK.
--
-- NO BACKFILL — BY DESIGN
-- ---------------------------------------------------------------------------
-- Every existing certificate was graded by MintVault before any partner existed. Marking them
-- as partner-originated would be a fabrication, and stamping them 'HQ' would assert a fact this
-- migration cannot actually verify per-row. All columns are therefore NULLABLE with no DEFAULT
-- and NO UPDATE is issued. NULL origin_type means LEGACY: created before origin capture existed.
-- The application renders legacy exactly as HQ ("Graded by MintVault Headquarters"), which is
-- correct today, while the NULL preserves the distinction between "recorded as HQ" and
-- "predates the feature" for audit purposes. Adding nullable columns with no default is also a
-- metadata-only operation in PostgreSQL 11+ — no table rewrite, no lock held over a data scan.
--
-- ADDITIVE ONLY: no column is dropped, renamed, retyped or repurposed. No row is modified.
--
-- TRANSACTION: intentionally NO BEGIN/COMMIT. scripts/db/migrate.ts wraps each file in one
-- transaction together with its journal row. A nested COMMIT would commit the runner's
-- transaction early and split this migration from its journal entry. Sibling migrations
-- (0022, 0031-0034) follow the same rule.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS / guarded, so a re-run is a no-op.
--
-- FAIL-CLOSED: the block at the end asserts that every column, constraint, index and the
-- immutability trigger are actually present, and that no pre-existing row was disturbed. If
-- anything is missing the migration RAISES and the runner rolls the whole file back rather than
-- leaving a half-built origin facility that silently records nothing. (Same bar as 0034.)
--
-- ROLLBACK: migrations/rollback-0035-partner-certificate-origin.sql.

-- ---------------------------------------------------------------------------
-- 0) Pre-flight. This migration is meaningless without the table it extends, and
--    a silent no-op here would be worse than a loud failure.
-- ---------------------------------------------------------------------------
-- The "fresh install" flag is recorded BEFORE any DDL runs, so the no-backfill assertion at the
-- end can tell a first application (where no row may carry an origin) from a legitimate re-run on
-- an estate where the application has since stamped real certificates. ON COMMIT DROP: nothing
-- outlives the runner's transaction.
CREATE TEMP TABLE _origin_0035_state (fresh_install boolean NOT NULL) ON COMMIT DROP;

DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE EXCEPTION '0035 requires the certificates table, which does not exist in this database.';
  END IF;

  INSERT INTO _origin_0035_state (fresh_install)
  SELECT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'certificates' AND column_name = 'origin_type');
END$$;

-- ---------------------------------------------------------------------------
-- 1) Origin snapshot columns. All NULLABLE, no DEFAULT, no backfill.
--
--    origin_type                  'HQ' | 'PARTNER'. NULL = legacy (pre-feature), rendered as HQ.
--                                 Explicit 'HQ' on new certificates records a POSITIVE assertion
--                                 that the grading happened in-house, which NULL cannot make.
--    origin_partner_id            Join key only. Nullable, no FK (see header).
--    origin_partner_public_ref    Non-sequential public identifier as it stood at capture time.
--                                 Survives deletion of the org row; what support and the partner
--                                 quote to each other.
--    origin_partner_legal_name    partner_organisations.legal_name at capture. The legally
--                                 meaningful entity for disputes/bailment, and the render
--                                 fallback because trading_name is nullable in 0015.
--    origin_partner_trading_name  partner_profiles.trading_name at capture. THE value rendered
--                                 as "Graded by <X>" — the customer-facing shop name.
--    origin_location_id           Join key only for the intake/grading site. Nullable, no FK.
--    origin_location_public_ref   Public identifier of that site at capture.
--    origin_location_name         Site name at capture (e.g. "Canterbury Store").
--    origin_location_address      The APPROVED intake/grading address at capture. This is the
--                                 "where was my card handled" answer; it must not follow the
--                                 partner when they move premises.
--    origin_captured_at           When the snapshot was taken. Without it the snapshot cannot be
--                                 defended against a later rename — it dates the assertion.
--                                 Distinct from issued_at: capture is the origin's as-of moment.
--    origin_snapshot_version      Shape version of this snapshot (1). Lets a future richer
--                                 snapshot be told apart from this one WITHOUT inferring it from
--                                 which columns happen to be NULL.
--
-- CONSIDERED AND REJECTED: a separate origin_tenant_id — partner_organisations.tenant_id is
-- GENERATED ALWAYS AS (id), so it would duplicate origin_partner_id exactly. A snapshot of
-- accreditation_level was also considered; it is out of scope for rendering and is deliberately
-- left for a future numbered migration rather than guessed at now.
-- ---------------------------------------------------------------------------
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_type text;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_partner_id uuid;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_partner_public_ref text;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_partner_legal_name text;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_partner_trading_name text;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_location_id uuid;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_location_public_ref text;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_location_name text;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_location_address text;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_captured_at timestamptz;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS origin_snapshot_version integer;

COMMENT ON COLUMN certificates.origin_type IS
  'Grading origin: HQ | PARTNER. NULL = legacy row predating origin capture; rendered as HQ.';
COMMENT ON COLUMN certificates.origin_partner_trading_name IS
  'IMMUTABLE snapshot of the partner trading name at grading time. Authoritative for rendering; never re-resolved from partner_profiles.';
COMMENT ON COLUMN certificates.origin_partner_id IS
  'Join hint only. Deliberately has NO foreign key so partner offboarding can never destroy or block a certificate. Never render from this.';

-- ---------------------------------------------------------------------------
-- 2) Integrity constraints. These make a HALF-WRITTEN origin impossible, which is
--    the failure mode that would otherwise produce a certificate claiming
--    partner provenance with no partner named on it.
--
--    NOT VALID is NOT used: the columns are brand new and every existing row has
--    them all NULL, so the constraints are trivially satisfiable and are added
--    fully validated. (Verified by the assertion block below.)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- 2a) Closed vocabulary.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_certificates_origin_type') THEN
    ALTER TABLE certificates ADD CONSTRAINT chk_certificates_origin_type
      CHECK (origin_type IS NULL OR origin_type IN ('HQ', 'PARTNER'));
  END IF;

  -- 2b) A PARTNER origin must actually identify a partner AND be renderable AND be dated.
  --
  --     NON-BLANK, not merely NOT NULL. This previously read
  --     `coalesce(trading, legal) IS NOT NULL`, which accepts '' and '   ' — both non-NULL and
  --     both useless. The renderer (server/labels.ts certificateOrigin) does
  --     `(trading ?? "").trim() || (legal ?? "").trim() || UNNAMED_PARTNER_ORIGIN_NAME`, i.e. it
  --     treats whitespace-only as ABSENT and falls through to the unnamed fallback. So the old
  --     constraint's own comment ("exactly the guarantee the renderer needs") was false: the
  --     database and the renderer disagreed about what "named" means, and a certificate could be
  --     frozen forever as blank historical evidence of who graded it.
  --
  --     The test is "is not blank after trimming", applied to each candidate SEPARATELY —
  --     mirroring the renderer's per-field trim-then-fallback, which a coalesce() over the raw
  --     columns does NOT reproduce (coalesce would pick a blank trading name and never consider a
  --     perfectly good legal name).
  --
  --     THE TRIM SET IS SPELLED OUT, and is not `[[:space:]]`. Character classes are LOCALE
  --     dependent (they follow pg_database.datctype), and staging runs C.UTF-8, where NBSP,
  --     U+2007, U+202F and U+3000 are NOT classified as space. Under `[[:space:]]` such a name
  --     would therefore be certified "named" by the database while `certificateOrigin()` — which
  --     uses JS `.trim()`, a fixed Unicode set — trimmed it to empty and rendered
  --     UNNAMED_PARTNER_ORIGIN_NAME. The immutability trigger would then freeze that disagreement
  --     permanently. The explicit list below is exactly ECMAScript's `String.prototype.trim` set
  --     (WhiteSpace + LineTerminator + U+FEFF), so the constraint and the renderer agree on every
  --     input, in every locale.
  --
  --     Deliberately NOT an allowlist of permitted characters: anything carrying a real glyph
  --     passes, so legitimate Unicode and punctuation-bearing business names are unaffected.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_certificates_origin_partner_complete') THEN
    ALTER TABLE certificates ADD CONSTRAINT chk_certificates_origin_partner_complete
      CHECK (
        origin_type IS DISTINCT FROM 'PARTNER'
        OR (
          origin_partner_id IS NOT NULL
          AND (
            btrim(coalesce(origin_partner_trading_name, ''), E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') <> ''
            OR btrim(coalesce(origin_partner_legal_name, ''), E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') <> ''
          )
          AND origin_captured_at IS NOT NULL
          AND origin_snapshot_version IS NOT NULL
        )
      );
  END IF;

  -- 2c) A non-PARTNER origin (HQ, or legacy NULL) must carry NO partner snapshot at all.
  --     Without this, a stale full-row UPDATE could leave partner values stranded on a row
  --     whose origin_type had been flipped to HQ, and the renderer would face two truths.
  --
  --     NULL-SAFE BY CONSTRUCTION. This previously read `origin_type = 'PARTNER'`, which is the
  --     classic three-valued-logic hole: on a LEGACY row origin_type is NULL, so that operand is
  --     NULL rather than FALSE, `NULL OR FALSE` is NULL, and a CHECK PASSES when its expression
  --     evaluates to NULL. The legacy half of this rule therefore enforced nothing, and a fully
  --     fabricated partner snapshot could be inserted on an origin_type IS NULL row — which the
  --     immutability trigger below would then freeze as permanent, uncorrectable provenance.
  --     `IS NOT DISTINCT FROM` cannot yield NULL, so every row now takes one branch or the other.
  --     (Sibling 2b was already immune; it uses IS DISTINCT FROM.)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_certificates_origin_non_partner_clean') THEN
    ALTER TABLE certificates ADD CONSTRAINT chk_certificates_origin_non_partner_clean
      CHECK (
        origin_type IS NOT DISTINCT FROM 'PARTNER'
        OR (
          origin_partner_id IS NULL
          AND origin_partner_public_ref IS NULL
          AND origin_partner_legal_name IS NULL
          AND origin_partner_trading_name IS NULL
          AND origin_location_id IS NULL
          AND origin_location_public_ref IS NULL
          AND origin_location_name IS NULL
          AND origin_location_address IS NULL
        )
      );
  END IF;

  -- 2d) Legacy rows carry no capture metadata either; an origin_captured_at with no
  --     origin_type would be an origin record that says nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_certificates_origin_capture_pairing') THEN
    ALTER TABLE certificates ADD CONSTRAINT chk_certificates_origin_capture_pairing
      CHECK (
        (origin_type IS NULL AND origin_captured_at IS NULL AND origin_snapshot_version IS NULL)
        OR (origin_type IS NOT NULL AND origin_captured_at IS NOT NULL AND origin_snapshot_version IS NOT NULL)
      );
  END IF;

  -- 2e) Version is a positive integer, so "0" or a negative sentinel can never masquerade
  --     as a real snapshot shape.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_certificates_origin_snapshot_version') THEN
    ALTER TABLE certificates ADD CONSTRAINT chk_certificates_origin_snapshot_version
      CHECK (origin_snapshot_version IS NULL OR origin_snapshot_version >= 1);
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 3) IMMUTABILITY, enforced by the database rather than by convention.
--
--    server/storage.ts updateCertificate() spreads a whole record into an UPDATE ... SET, and the
--    certificate edit form posts full state with no optimistic lock. Application-level care is
--    therefore not sufficient: one careless writer would silently rewrite provenance. This trigger
--    makes origin SET-ONCE at the storage layer.
--
--    RULE: once origin_type IS NOT NULL, no origin_* column may change to a different value, ever.
--    Rows whose origin_type is still NULL (legacy) may be stamped ONCE — that is the only
--    permitted transition, and it is what makes a future, evidence-based attribution correction
--    possible without weakening the guarantee for rows that already carry an origin.
--
--    IS DISTINCT FROM (not <>) so a full-row rewrite that re-sends the SAME values is allowed;
--    only an actual change is refused. That keeps every existing writer working untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION certificates_origin_is_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.origin_type IS NULL THEN
    -- Legacy row: the one-time stamp is allowed. Nothing to protect yet.
    RETURN NEW;
  END IF;

  IF NEW.origin_type              IS DISTINCT FROM OLD.origin_type
  OR NEW.origin_partner_id        IS DISTINCT FROM OLD.origin_partner_id
  OR NEW.origin_partner_public_ref    IS DISTINCT FROM OLD.origin_partner_public_ref
  OR NEW.origin_partner_legal_name    IS DISTINCT FROM OLD.origin_partner_legal_name
  OR NEW.origin_partner_trading_name  IS DISTINCT FROM OLD.origin_partner_trading_name
  OR NEW.origin_location_id       IS DISTINCT FROM OLD.origin_location_id
  OR NEW.origin_location_public_ref   IS DISTINCT FROM OLD.origin_location_public_ref
  OR NEW.origin_location_name     IS DISTINCT FROM OLD.origin_location_name
  OR NEW.origin_location_address  IS DISTINCT FROM OLD.origin_location_address
  OR NEW.origin_captured_at       IS DISTINCT FROM OLD.origin_captured_at
  OR NEW.origin_snapshot_version  IS DISTINCT FROM OLD.origin_snapshot_version
  THEN
    RAISE EXCEPTION
      'certificate % has an immutable grading origin snapshot; origin_* columns cannot be changed once set',
      OLD.certificate_number
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_certificates_origin_immutable ON certificates;
CREATE TRIGGER trg_certificates_origin_immutable
  BEFORE UPDATE ON certificates
  FOR EACH ROW
  EXECUTE FUNCTION certificates_origin_is_immutable();

-- ENABLE ALWAYS, not the default ENABLE (pg_trigger.tgenabled = 'A', not 'O').
--
-- A default-created trigger fires only when session_replication_role is 'origin' or 'local'. Any
-- session able to SET it to 'replica' therefore turns provenance immutability off wholesale and
-- can rewrite a stamped snapshot silently — which is the one thing this facility exists to make
-- impossible. 'A' keeps it firing in replica mode too.
--
-- HONEST LIMIT, stated so it is not over-sold: this closes the replication-role path, NOT a
-- deliberate `ALTER TABLE ... DISABLE TRIGGER` by the table owner. The threat model here is an
-- accidental full-row rewrite (server/storage.ts updateCertificate spreads a whole record) and a
-- privileged-but-careless bulk/restore session — both of which this does stop. It is not, and
-- cannot be, a defence against an intentional owner-level actor.
ALTER TABLE certificates ENABLE ALWAYS TRIGGER trg_certificates_origin_immutable;

-- ---------------------------------------------------------------------------
-- 4) Index for the real query path only: "all certificates originated by this partner"
--    (per-partner certificate counts on the partner dashboard). Partial, because the
--    overwhelming majority of rows are and will remain HQ/legacy NULL.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_certificates_origin_partner
  ON certificates (origin_partner_id)
  WHERE origin_partner_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) Completeness assertion. Fail closed rather than leave a half-built facility.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  expected_cols text[] := ARRAY[
    'origin_type','origin_partner_id','origin_partner_public_ref','origin_partner_legal_name',
    'origin_partner_trading_name','origin_location_id','origin_location_public_ref',
    'origin_location_name','origin_location_address','origin_captured_at','origin_snapshot_version'
  ];
  expected_cons text[] := ARRAY[
    'chk_certificates_origin_type','chk_certificates_origin_partner_complete',
    'chk_certificates_origin_non_partner_clean','chk_certificates_origin_capture_pairing',
    'chk_certificates_origin_snapshot_version'
  ];
  missing_cols text;
  missing_cons text;
  not_valid_cons text;
  nullable_violation text;
  stamped bigint;
BEGIN
  SELECT string_agg(c, ', ' ORDER BY c) INTO missing_cols
    FROM unnest(expected_cols) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'certificates' AND column_name = c);

  -- Every origin column must be NULLABLE and DEFAULT-less: that is what makes "no backfill"
  -- structurally true rather than merely intended.
  SELECT string_agg(column_name || ' (' || is_nullable || '/' || coalesce(column_default, 'no default') || ')', ', '
                    ORDER BY column_name)
    INTO nullable_violation
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'certificates'
     AND column_name = ANY (expected_cols)
     AND (is_nullable <> 'YES' OR column_default IS NOT NULL);

  SELECT string_agg(c, ', ' ORDER BY c) INTO missing_cons
    FROM unnest(expected_cons) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c);

  SELECT string_agg(conname, ', ' ORDER BY conname) INTO not_valid_cons
    FROM pg_constraint WHERE conname = ANY (expected_cons) AND NOT convalidated;

  IF missing_cols IS NOT NULL THEN
    RAISE EXCEPTION '0035 completeness assertion failed: missing column(s): %', missing_cols;
  END IF;
  IF nullable_violation IS NOT NULL THEN
    RAISE EXCEPTION '0035 completeness assertion failed: origin column(s) are not nullable/default-free: %',
      nullable_violation;
  END IF;
  IF missing_cons IS NOT NULL THEN
    RAISE EXCEPTION '0035 completeness assertion failed: missing constraint(s): %', missing_cons;
  END IF;
  IF not_valid_cons IS NOT NULL THEN
    RAISE EXCEPTION '0035 completeness assertion failed: constraint(s) present but NOT VALID: %', not_valid_cons;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_certificates_origin_immutable'
                   AND tgrelid = 'public.certificates'::regclass) THEN
    RAISE EXCEPTION '0035 completeness assertion failed: immutability trigger was not created.';
  END IF;
  -- …and that it is ENABLE ALWAYS. Asserting mere EXISTENCE is what previously let a trigger that
  -- any replica-role session could bypass pass as "installed" — the check has to look at the mode,
  -- or it certifies a guarantee the database is not actually giving.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_certificates_origin_immutable'
                   AND tgrelid = 'public.certificates'::regclass AND tgenabled = 'A') THEN
    RAISE EXCEPTION
      '0035 completeness assertion failed: immutability trigger is not ENABLE ALWAYS (tgenabled=%), so session_replication_role=replica would bypass it.',
      (SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_certificates_origin_immutable'
         AND tgrelid = 'public.certificates'::regclass);
  END IF;
  IF to_regclass('public.idx_certificates_origin_partner') IS NULL THEN
    RAISE EXCEPTION '0035 completeness assertion failed: idx_certificates_origin_partner was not created.';
  END IF;

  -- No-backfill proof. Only meaningful on a FIRST application: if the columns did not exist when
  -- this file started, nothing but this migration could have written them, so any non-NULL
  -- origin_type would mean a backfill happened. On a RE-RUN the application has legitimately
  -- stamped certificates in the meantime, and asserting zero there would make the file
  -- non-idempotent — so the check is scoped, not skipped.
  IF (SELECT fresh_install FROM _origin_0035_state) THEN
    SELECT count(*) INTO stamped FROM certificates WHERE origin_type IS NOT NULL;
    IF stamped > 0 THEN
      RAISE EXCEPTION
        '0035 completeness assertion failed: % certificate(s) carry an origin_type immediately after a migration that writes no rows. Refusing to record a provenance claim this migration cannot substantiate.',
        stamped;
    END IF;
  END IF;

  RAISE NOTICE '0035: certificate origin snapshot installed (% columns, % constraints, trigger + partial index). No rows modified.',
    array_length(expected_cols, 1), array_length(expected_cons, 1);
END$$;
