-- 0048 — Server-authoritative review-revision token on certificates.
--
-- WHAT THIS INSTALLS
-- ---------------------------------------------------------------------------
--   certificates.grading_revision                INTEGER NOT NULL DEFAULT 1
--   certificates_advance_grading_revision()      trigger function
--   trg_certificates_advance_grading_revision    BEFORE UPDATE ... ENABLE ALWAYS
--
-- The revision is the optimistic-concurrency token behind the pending-review
-- approval boundary. A reviewer approves AT a revision; if any
-- certificate-facing field changed since they looked, the CAS matches zero rows
-- and the approval is refused with STALE_REVIEW rather than publishing a grade
-- nobody inspected.
--
-- It is deliberately independent of updated_at: storage maintenance, the print
-- workflow and image processing must NOT invalidate a human's prepared review.
--
-- TRANSACTION: intentionally NO BEGIN/COMMIT. scripts/db/migrate.ts wraps each
-- file in one transaction together with its journal row. The runner's
-- transaction is REQUIRED, not optional: the temp table below is ON COMMIT DROP,
-- exactly as in 0035.
--
-- IDEMPOTENT + SELF-REPAIRING: safe to run twice, and a re-run CONVERGES a
-- half-built installation instead of silently accepting it (section 3).
--
-- FAIL-CLOSED: sections 2 and 8 RAISE rather than install partial protection.
--
-- ROLLBACK: migrations/rollback-0048-grading-review-revision.sql.
--
--
-- WHY THE COMPARISON LIVES IN THE TRIGGER'S `WHEN` CLAUSE
-- ---------------------------------------------------------------------------
-- The previous revision of this file compared fields with
-- `to_jsonb(OLD) -> field_name IS DISTINCT FROM to_jsonb(NEW) -> field_name`
-- inside a FOREACH loop. That had two defects, one silent and one expensive.
--
--   SILENT. A jsonb name lookup returns NULL for a key that is not there, on
--   BOTH sides, so a protected field naming a column that does not exist is
--   never distinct and is silently unprotected. The same happens to a column
--   that is later RENAMED. Protection that can evaporate without a single
--   error message is the failure mode this migration exists to prevent.
--
--   EXPENSIVE. Both to_jsonb() calls sat INSIDE the loop, so a row update
--   performed up to 51 x 2 = 102 whole-row (~179 column) JSON serialisations,
--   each allocated and discarded after one key lookup. That is the COMMON path,
--   not a corner case: the grading auto-save issues one UPDATE that re-sends
--   every grading column unconditionally, so a debounced save that changes
--   nothing runs the loop to completion.
--
-- Direct column comparison in a trigger-level WHEN clause fixes both without
-- reducing coverage by a single field:
--
--   * Columns are bound by ATTNUM at CREATE TRIGGER time, not looked up by name
--     at runtime. A rename keeps protection on the same physical column, and a
--     drop is recorded in pg_depend, so loss is detectable rather than silent.
--   * A missing column makes CREATE TRIGGER fail INSIDE this transaction. So
--     does a column type with no equality operator. Both roll the file back.
--   * On the no-change path the executor evaluates WHEN in C and never enters
--     plpgsql at all: no exec state, no loop, no jsonb allocation. Zero
--     whole-row serialisations, down from up to 102.
--
-- CONSIDERED AND REJECTED: hoisting the two to_jsonb() calls into DECLARE
-- locals. DECLARE initialisers evaluate on block entry, BEFORE the
-- grade_approved_at early return, which would make the published-certificate
-- path SLOWER than it is today; and even hoisted into the body it still
-- allocates two full-row jsonb values of a wide row on every non-approved
-- update.
--
--
-- WHY `is_black_label` IS NOT IN THE PROTECTED SET
-- ---------------------------------------------------------------------------
-- It was, and it protected NOTHING, because `certificates` has no such column.
-- The repository's only `ADD COLUMN ... is_black_label` targets a DIFFERENT
-- table (server/routes.ts, "Build 6 — extend grading_sessions with AI accuracy
-- columns"). It is absent from shared/schema.ts, from GRADING_OWNED_FIELDS and
-- from UNDECLARED_GRADING_COLUMNS in shared/certificate-field-ownership.ts,
-- whose undeclared-column list was verified against the live staging database
-- on 2026-07-26. Every client-side `isBlackLabel` is DERIVED at render time from
-- the MVGS Pristine gate.
--
-- Do NOT "restore" it here, and do NOT create the column to make it fit:
-- Pristine 10P is gate-derived, and adding a stored black-label column is a
-- change to protected grading logic requiring the owner's explicit approval.
--
--
-- WHY THIS FILE OWNS `auth_status`
-- ---------------------------------------------------------------------------
-- auth_status decides NO / AA, i.e. whether a certificate is numeric at all, so
-- it must be protected. It is a REAL column but is NOT declared in
-- shared/schema.ts: it is created by boot-time DDL in server/routes.ts whose
-- catch block only console.error()s, so its existence is asserted rather than
-- guaranteed. Section 1 adds it with the byte-identical definition, which is a
-- no-op on every database that already has it and removes the only field that
-- could legitimately be absent — letting section 2's guard be UNCONDITIONAL.
--
-- The TRADEOFF, stated so it is a decision and not an accident: this file now
-- creates a column shared/schema.ts does not declare, duplicating the boot DDL.
-- Accepted, because the alternative is a presence guard with a documented
-- exemption, and an exemptable guard is a switch, not a guarantee.
--
--
-- LOCKING
-- ---------------------------------------------------------------------------
-- ALTER TABLE takes ACCESS EXCLUSIVE on `certificates`, and because the runner
-- wraps this file in ONE transaction the first such lock is held until COMMIT.
-- The duration is milliseconds (PostgreSQL 11+ makes ADD COLUMN ... NOT NULL
-- DEFAULT 1 metadata-only; the backfill matches no rows; SET NOT NULL skips its
-- scan when already satisfied). The hazard is the WAIT: one idle-in-transaction
-- session makes our request queue, and then every new reader queues behind us.
-- lock_timeout bounds that convoy to 5 seconds, after which this migration
-- aborts cleanly and rolls back rather than stalling the admin surface.
--
-- SET LOCAL, not SET: the runner reuses one client for the whole run, so a plain
-- SET would leak this timeout into every subsequent migration.
SET LOCAL lock_timeout = '5s';


-- ---------------------------------------------------------------------------
-- 0) Pre-flight.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE EXCEPTION '0048 requires the certificates table, which does not exist in this database.';
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 1) auth_status convergence. Byte-identical to the boot DDL in
--    server/routes.ts; a no-op wherever that already ran. See header.
-- ---------------------------------------------------------------------------
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS auth_status TEXT DEFAULT 'genuine';


-- ---------------------------------------------------------------------------
-- 2) THE PROTECTED SET, declared ONCE.
--
--    This temp table is the single list. Section 8's completeness assertion
--    cross-checks it against the trigger definition that is actually installed,
--    which closes drift in BOTH directions:
--      * a name here that the WHEN clause omits -> section 8 RAISES;
--      * a column in the WHEN clause that is missing -> CREATE TRIGGER fails.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _grading_revision_0048_protected (column_name text NOT NULL) ON COMMIT DROP;

INSERT INTO _grading_revision_0048_protected (column_name) VALUES
  -- Certificate-facing identity and classification.
  ('card_name'), ('set_name'), ('card_number_display'), ('year_text'), ('language'),
  ('variant'), ('variant_other'), ('rarity'), ('rarity_other'), ('rarity_code'),
  ('rarity_label'), ('printed_symbol'), ('printed_symbol_count'),
  ('printed_symbol_colour'), ('finish_variant'), ('promo_type'), ('subset_name'),
  ('region'), ('era'), ('structured_variant_version'), ('label_type'),
  -- Authoritative grade, subgrades, authentication and defects.
  ('grade'), ('grade_type'), ('centering_score'), ('corners_score'), ('edges_score'),
  ('surface_score'), ('centering_front_lr'), ('centering_front_tb'),
  ('centering_back_lr'), ('centering_back_tb'), ('corner_values'), ('edge_values'),
  ('surface_values'), ('defects'), ('verified_defects'), ('auth_status'),
  ('dark_border_front'), ('dark_border_back'), ('eye_appeal_modifier'),
  ('whitening_lines'), ('crease_span_pct'), ('crease_lines'), ('wrinkle_severity'),
  ('tear_severity'), ('centering_outer_front'), ('centering_outer_back'),
  ('centering_inner_front'), ('centering_inner_back'), ('centering_method');

-- FAIL-CLOSED PRESENCE GUARD. Every protected field must be a real column of
-- `certificates`. A missing one would previously have degraded to no protection
-- without a word; here it refuses, and NAMES what is missing.
--
-- Deliberately UNCONDITIONAL: no environment flag, no "required core" tier and
-- no exemption list, because a guard that can be switched off is not a
-- guarantee. A disposable test fixture must therefore declare these columns
-- before loading this file.
DO $$
DECLARE
  missing_cols text;
BEGIN
  SELECT string_agg(p.column_name, ', ' ORDER BY p.column_name)
    INTO missing_cols
    FROM _grading_revision_0048_protected p
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name   = 'certificates'
        AND c.column_name  = p.column_name);

  IF missing_cols IS NOT NULL THEN
    RAISE EXCEPTION
      '0048 refuses to install partial review protection: certificates is missing protected column(s): %. '
      'Each absent column would be silently unprotected, so a reviewer could approve a grade that '
      'changed under them. Reconcile the schema first, then re-run.',
      missing_cols;
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 3) grading_revision — ADD, then CONVERGE.
--
--    ADD COLUMN IF NOT EXISTS is a SILENT no-op when the column already exists:
--    it does not correct the type, the default or the nullability. A pre-release
--    deployment that created a NULLABLE grading_revision would therefore have
--    kept it nullable forever while this file reported success — and the
--    application hard-fails the moment RETURNING yields NULL. So the shape is
--    converged explicitly and then ASSERTED.
-- ---------------------------------------------------------------------------
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS grading_revision INTEGER NOT NULL DEFAULT 1;

-- Dry-run before the backfill, per MintVault migration discipline: the row count
-- is reported BEFORE anything is written.
DO $$
DECLARE
  needing_backfill bigint;
BEGIN
  SELECT count(*) INTO needing_backfill
    FROM certificates
   WHERE grading_revision IS NULL OR grading_revision < 1;
  RAISE NOTICE '0048: % certificate row(s) need a grading_revision backfill.', needing_backfill;
END$$;

UPDATE certificates
   SET grading_revision = 1
 WHERE grading_revision IS NULL OR grading_revision < 1;

ALTER TABLE certificates ALTER COLUMN grading_revision SET DEFAULT 1;
ALTER TABLE certificates ALTER COLUMN grading_revision SET NOT NULL;

-- Assert the FINAL shape from the catalog. This is the step that makes the file
-- self-repairing rather than merely re-runnable.
DO $$
DECLARE
  col record;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'certificates'
     AND column_name = 'grading_revision';

  IF col IS NULL THEN
    RAISE EXCEPTION '0048 convergence failed: certificates.grading_revision does not exist after the ADD COLUMN.';
  END IF;
  IF col.data_type <> 'integer' THEN
    RAISE EXCEPTION '0048 convergence failed: certificates.grading_revision is %, expected integer.', col.data_type;
  END IF;
  IF col.is_nullable <> 'NO' THEN
    RAISE EXCEPTION '0048 convergence failed: certificates.grading_revision is still NULLABLE. A NULL revision makes every grading save fail at the RETURNING check.';
  END IF;
  IF col.column_default IS NULL
     OR regexp_replace(col.column_default, '::.*$', '') <> '1' THEN
    RAISE EXCEPTION
      '0048 convergence failed: certificates.grading_revision DEFAULT is %, expected 1. New certificates would be issued without a valid review token.',
      coalesce(col.column_default, 'absent');
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 4) The trigger function.
--
--    The comparison now lives entirely in the trigger's WHEN clause, so by the
--    time this body runs the executor has ALREADY proved that the certificate is
--    unapproved and that at least one protected field changed. The body's only
--    job is to advance the token.
--
--    GREATEST(COALESCE(...)) is belt and braces: grading_revision is NOT NULL
--    after section 3, but a defensive floor of 1 costs nothing and means a
--    corrupted 0 or negative can never propagate into a CAS predicate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION certificates_advance_grading_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.grading_revision := GREATEST(COALESCE(OLD.grading_revision, 1), 1) + 1;
  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 5) The trigger.
--
--    DROP + CREATE rather than CREATE OR REPLACE TRIGGER to match sibling 0035
--    and stay portable. The momentary gap is invisible to every other session
--    because both statements are inside the runner's transaction, which holds
--    ACCESS EXCLUSIVE on the table.
--
--    FIRING ORDER: BEFORE ROW triggers fire in trigger-NAME order, so this runs
--    before 0035's trg_certificates_origin_immutable. The WHEN clause therefore
--    sees NEW as the statement supplied it — the same values the previous
--    FOREACH implementation saw. No behaviour change.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_certificates_advance_grading_revision ON certificates;

CREATE TRIGGER trg_certificates_advance_grading_revision
BEFORE UPDATE ON certificates
FOR EACH ROW
WHEN (
  -- A published certificate cannot be approved through pending review. Do not
  -- version unrelated post-approval administration/correction writes here.
  OLD.grade_approved_at IS NULL
  AND (
    -- Certificate-facing identity and classification.
       OLD.card_name                  IS DISTINCT FROM NEW.card_name
    OR OLD.set_name                   IS DISTINCT FROM NEW.set_name
    OR OLD.card_number_display        IS DISTINCT FROM NEW.card_number_display
    OR OLD.year_text                  IS DISTINCT FROM NEW.year_text
    OR OLD.language                   IS DISTINCT FROM NEW.language
    OR OLD.variant                    IS DISTINCT FROM NEW.variant
    OR OLD.variant_other              IS DISTINCT FROM NEW.variant_other
    OR OLD.rarity                     IS DISTINCT FROM NEW.rarity
    OR OLD.rarity_other               IS DISTINCT FROM NEW.rarity_other
    OR OLD.rarity_code                IS DISTINCT FROM NEW.rarity_code
    OR OLD.rarity_label               IS DISTINCT FROM NEW.rarity_label
    OR OLD.printed_symbol             IS DISTINCT FROM NEW.printed_symbol
    OR OLD.printed_symbol_count       IS DISTINCT FROM NEW.printed_symbol_count
    OR OLD.printed_symbol_colour      IS DISTINCT FROM NEW.printed_symbol_colour
    OR OLD.finish_variant             IS DISTINCT FROM NEW.finish_variant
    OR OLD.promo_type                 IS DISTINCT FROM NEW.promo_type
    OR OLD.subset_name                IS DISTINCT FROM NEW.subset_name
    OR OLD.region                     IS DISTINCT FROM NEW.region
    OR OLD.era                        IS DISTINCT FROM NEW.era
    OR OLD.structured_variant_version IS DISTINCT FROM NEW.structured_variant_version
    OR OLD.label_type                 IS DISTINCT FROM NEW.label_type
    -- Authoritative grade, subgrades, authentication and defects.
    OR OLD.grade                      IS DISTINCT FROM NEW.grade
    OR OLD.grade_type                 IS DISTINCT FROM NEW.grade_type
    OR OLD.centering_score            IS DISTINCT FROM NEW.centering_score
    OR OLD.corners_score              IS DISTINCT FROM NEW.corners_score
    OR OLD.edges_score                IS DISTINCT FROM NEW.edges_score
    OR OLD.surface_score              IS DISTINCT FROM NEW.surface_score
    OR OLD.centering_front_lr         IS DISTINCT FROM NEW.centering_front_lr
    OR OLD.centering_front_tb         IS DISTINCT FROM NEW.centering_front_tb
    OR OLD.centering_back_lr          IS DISTINCT FROM NEW.centering_back_lr
    OR OLD.centering_back_tb          IS DISTINCT FROM NEW.centering_back_tb
    OR OLD.corner_values              IS DISTINCT FROM NEW.corner_values
    OR OLD.edge_values                IS DISTINCT FROM NEW.edge_values
    OR OLD.surface_values             IS DISTINCT FROM NEW.surface_values
    OR OLD.defects                    IS DISTINCT FROM NEW.defects
    OR OLD.verified_defects           IS DISTINCT FROM NEW.verified_defects
    OR OLD.auth_status                IS DISTINCT FROM NEW.auth_status
    OR OLD.dark_border_front          IS DISTINCT FROM NEW.dark_border_front
    OR OLD.dark_border_back           IS DISTINCT FROM NEW.dark_border_back
    OR OLD.eye_appeal_modifier        IS DISTINCT FROM NEW.eye_appeal_modifier
    OR OLD.whitening_lines            IS DISTINCT FROM NEW.whitening_lines
    OR OLD.crease_span_pct            IS DISTINCT FROM NEW.crease_span_pct
    OR OLD.crease_lines               IS DISTINCT FROM NEW.crease_lines
    OR OLD.wrinkle_severity           IS DISTINCT FROM NEW.wrinkle_severity
    OR OLD.tear_severity              IS DISTINCT FROM NEW.tear_severity
    OR OLD.centering_outer_front      IS DISTINCT FROM NEW.centering_outer_front
    OR OLD.centering_outer_back       IS DISTINCT FROM NEW.centering_outer_back
    OR OLD.centering_inner_front      IS DISTINCT FROM NEW.centering_inner_front
    OR OLD.centering_inner_back       IS DISTINCT FROM NEW.centering_inner_back
    OR OLD.centering_method           IS DISTINCT FROM NEW.centering_method
  )
)
EXECUTE FUNCTION certificates_advance_grading_revision();


-- ---------------------------------------------------------------------------
-- 6) ENABLE ALWAYS, not the default ENABLE (pg_trigger.tgenabled = 'A', not
--    'O'). Identical reasoning, and identical statement shape, to 0035's
--    trg_certificates_origin_immutable on this same table.
--
--    A default-created trigger fires only when session_replication_role is
--    'origin' or 'local'. Any session able to SET it to 'replica' therefore
--    turns review-staleness protection off wholesale: a grading write would land
--    without advancing the token, and a reviewer's prepared revision would still
--    match — publishing a grade nobody inspected.
--
--    HONEST LIMIT: this closes the replication-role path, NOT a deliberate
--    `ALTER TABLE ... DISABLE TRIGGER` by the table owner. The threat model is an
--    accidental full-row rewrite and a privileged-but-careless bulk/restore
--    session — both of which this stops. It is not, and cannot be, a defence
--    against an intentional owner-level actor.
-- ---------------------------------------------------------------------------
ALTER TABLE certificates ENABLE ALWAYS TRIGGER trg_certificates_advance_grading_revision;

COMMENT ON COLUMN certificates.grading_revision IS
  'Server-authoritative optimistic-concurrency token for the pending-review approval boundary. Advanced by trg_certificates_advance_grading_revision when an unapproved certificate has a protected field changed. Deliberately independent of updated_at.';

COMMENT ON TRIGGER trg_certificates_advance_grading_revision ON certificates IS
  'Advances certificates.grading_revision when an UNAPPROVED certificate has any certificate-facing field changed, so a stale reviewer cannot approve a grade they never inspected. The AUTHORITATIVE protected set is this trigger''s own WHEN clause — read it with pg_get_triggerdef() rather than trusting any copy of the list. ENABLE ALWAYS: session_replication_role=replica must not bypass it.';


-- ---------------------------------------------------------------------------
-- 7) Deliberately no index on grading_revision. The only query shapes that
--    reference it are `RETURNING grading_revision` on a primary-key UPDATE and
--    the CAS predicate `WHERE id = $1 AND ... AND grading_revision = $2`, which
--    is already satisfied by the primary key. An index here would be write
--    amplification on the hottest table for no read benefit.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 8) Completeness assertion. Fail closed rather than leave a half-built
--    facility, and verify the INSTALLED trigger, not the statements above.
--    "The migration returned success" is not evidence.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  trg record;
  def text;
  uncovered text;
BEGIN
  SELECT t.oid, t.tgenabled INTO trg
    FROM pg_trigger t
   WHERE t.tgname = 'trg_certificates_advance_grading_revision'
     AND t.tgrelid = 'public.certificates'::regclass
     AND NOT t.tgisinternal;

  IF trg IS NULL THEN
    RAISE EXCEPTION '0048 completeness assertion failed: trg_certificates_advance_grading_revision was not created.';
  END IF;

  -- ENABLE ALWAYS. Asserting mere EXISTENCE is what lets a trigger any
  -- replica-role session could bypass pass as "installed"; the check has to look
  -- at the MODE, or it certifies a guarantee the database is not giving.
  IF trg.tgenabled <> 'A' THEN
    RAISE EXCEPTION
      '0048 completeness assertion failed: the revision trigger is not ENABLE ALWAYS (tgenabled=%), so session_replication_role=replica would bypass review-staleness protection.',
      trg.tgenabled;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'certificates_advance_grading_revision' AND n.nspname = 'public') THEN
    RAISE EXCEPTION '0048 completeness assertion failed: certificates_advance_grading_revision() is missing.';
  END IF;

  def := pg_get_triggerdef(trg.oid);

  IF def !~* 'BEFORE UPDATE' OR def !~* 'FOR EACH ROW' THEN
    RAISE EXCEPTION
      '0048 completeness assertion failed: the revision trigger is not BEFORE UPDATE FOR EACH ROW. Installed definition: %', def;
  END IF;

  -- The approval gate must be part of the firing condition, or every
  -- post-approval correction would churn the token.
  IF def !~* 'grade_approved_at' THEN
    RAISE EXCEPTION
      '0048 completeness assertion failed: the trigger WHEN clause does not reference grade_approved_at, so approved certificates would be re-versioned. Installed definition: %', def;
  END IF;

  -- THE COVERAGE PROOF. Every protected name must appear in the installed
  -- definition as a WHOLE IDENTIFIER TOKEN.
  --
  -- Tokenised, not substring-matched, on purpose. `variant` is a substring of
  -- both `variant_other` and `structured_variant_version`, `rarity` of
  -- `rarity_other`, `grade` of `grade_type`. A naive LIKE test would report
  -- those as covered when only their longer neighbours were present — exactly
  -- the class of silent partial protection this migration exists to eliminate.
  SELECT string_agg(p.column_name, ', ' ORDER BY p.column_name)
    INTO uncovered
    FROM _grading_revision_0048_protected p
   WHERE NOT EXISTS (
     SELECT 1
       FROM regexp_split_to_table(lower(def), '[^a-z0-9_]+') AS tok(t)
      WHERE tok.t = p.column_name);

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      '0048 completeness assertion failed: the installed trigger does not compare protected field(s): %. Those fields could change under a prepared review without invalidating it.',
      uncovered;
  END IF;

  RAISE NOTICE '0048: review-revision token installed (% protected fields, ENABLE ALWAYS trigger, no whole-row JSON serialisation).',
    (SELECT count(*) FROM _grading_revision_0048_protected);
END$$;
