-- 0073 — FORWARD-ONLY LINEAGE CONVERGENCE
--
-- Owner decision (2026-08-11): converge MintVault's three divergent migration
-- lineages by moving FORWARD only. No applied migration is renamed, renumbered,
-- deleted or replayed; every applied journal row is immutable history.
--
--
-- WHY THIS FILE EXISTS
-- ===========================================================================
-- Three lineages forked at 0045-0048 and each applied a DIFFERENT migration into
-- the same numeric slots:
--
--   number | PRODUCTION (scanner)        | STAGING (final-product-integration)      | this branch
--   -------|----------------------------|------------------------------------------|---------------------------
--   0045   | partner_stations           | -                                        | -
--   0046   | scanner_processing_jobs    | partner_mfa_pending_lifecycle            | partner_mfa_pending_lifecycle
--   0047   | scanner_evidence_staging   | partner_owner_invariant_tenants_rls      | partner_label_preview_permission
--   0048   | -                          | partner_location_snapshot_search_path    | grading_review_revision
--
-- Replaying this branch's historical 0047/0048 into either environment would put
-- two different migrations in one numeric slot — permanently ambiguous, and
-- silently, because the journal is keyed on filename and numbers are only sort
-- order. (The runner now refuses that outright; see the migration identity guard
-- in scripts/db/migrate.ts.) So those two files were withdrawn while still
-- UNAPPLIED anywhere, and their semantics live here instead.
--
-- 0046_partner_mfa_pending_lifecycle.sql is NOT withdrawn: it is APPLIED on
-- staging, with a matching checksum, so it is immutable history. It must simply
-- never be applied to production, where 0046 already means something else — the
-- identity guard enforces that, and production already has the lifecycle anyway.
--
-- 0073 is the next GLOBALLY safe number: the highest allocated across production,
-- staging, origin/main, this branch, codex/mintvault-final-product-integration and
-- every other reachable ref is 0072 (partner_quality_enforcement, local, not yet
-- applied anywhere). 0072 was NOT free despite an earlier recommendation.
--
--
-- MEASURED STARTING STATE (read-only inspection, 2026-08-11)
-- ===========================================================================
--                                   PRODUCTION        STAGING
--   certificates columns            169               (superset)
--   all 50 protected columns        ALL PRESENT       ALL PRESENT
--   certificates.grading_revision   ABSENT            PRESENT (added by 0071)
--   revision trigger                ABSENT            ABSENT
--   partner MFA lifecycle columns   PRESENT           PRESENT
--   partner_auth_lookup projects
--     has_active_mfa                YES               YES
--   partner.cards.preview           ABSENT            ABSENT
--   partner role codes seeded       YES               YES
--   certificate rows                836               264
--
-- So the real convergence delta is small and identical in shape for both hosts:
-- install the revision TRIGGER, add the column only where absent, and grant the
-- preview permission. Everything else is already satisfied and must no-op.
--
--
-- DESIGN RULES
-- ===========================================================================
--  * INTROSPECTION-DRIVEN. Every section inspects the catalog and repairs only
--    what is missing, so the same file is correct against production's scanner
--    lineage, staging's 0071 lineage and a fresh main-shaped database.
--  * IDEMPOTENT. Safe to re-run; a second run changes nothing.
--  * FAIL CLOSED where the outcome is security-relevant, and NAME what is wrong.
--  * NEVER replays historical semantics blindly — it converges to the target.
--
-- TRANSACTION: no BEGIN/COMMIT. scripts/db/migrate.ts wraps each file in one
-- transaction with its journal row. The temp table below is ON COMMIT DROP and
-- depends on that.
--
-- ROLLBACK: migrations/rollback-0073-lineage-convergence.sql
SET LOCAL lock_timeout = '5s';


-- ---------------------------------------------------------------------------
-- 0) Pre-flight.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE EXCEPTION '0073 requires the certificates table, which does not exist in this database.';
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 1) auth_status convergence.
--
--    auth_status decides NO / AA, so it must be protected by the trigger below.
--    It is a REAL column on both hosts but is NOT declared in shared/schema.ts:
--    it is created by boot-time DDL in server/routes.ts whose catch block only
--    console.error()s, so its existence is asserted rather than guaranteed. This
--    is byte-identical to that boot DDL and a no-op wherever it already ran,
--    which lets section 2's guard be UNCONDITIONAL.
-- ---------------------------------------------------------------------------
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS auth_status TEXT DEFAULT 'genuine';


-- ---------------------------------------------------------------------------
-- 2) THE PROTECTED SET, declared once, then proven present.
--
--    Section 8 cross-checks this list against the trigger definition actually
--    installed, closing drift in both directions: a name here that the WHEN
--    clause omits RAISEs; a column in the WHEN clause that does not exist makes
--    CREATE TRIGGER fail. They cannot disagree without the migration failing.
--
--    `is_black_label` is deliberately ABSENT. It was in this branch's historical
--    0048 and protected nothing: certificates has no such column on either host
--    (the repository's only `ADD COLUMN ... is_black_label` targets
--    grading_sessions). Black-label/Pristine is derived at render time from the
--    MVGS gate. Do not "restore" it, and do not create the column to make it fit
--    — that would be a protected grading-logic change.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _grading_revision_0073_protected (column_name text NOT NULL) ON COMMIT DROP;

INSERT INTO _grading_revision_0073_protected (column_name) VALUES
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
  ('centering_inner_front'), ('centering_inner_back'), ('centering_method'),
  -- Owner-authorised addition (2026-08-11). grade_explanation satisfies all three
  -- conditions the owner set for versioning a field: the reviewer edits it in the
  -- grading panel before approving; it is PUBLISHED on two UNAUTHENTICATED public
  -- surfaces -- GET /api/cert/:id/report emits it as `explanation`, and
  -- GET /api/cert/:id/report/pdf prints it into the customer's PDF; and it is
  -- persisted by the grading save as part of the approved record. Without this,
  -- reviewer A could read explanation X, reviewer B replace it with Y, and A's
  -- approval still succeed at the unchanged revision -- publishing text A never
  -- saw. Costs some extra STALE_REVIEW churn under concurrent editing; that is the
  -- intended trade.
  ('grade_explanation');

DO $$
DECLARE
  missing_cols text;
BEGIN
  SELECT string_agg(p.column_name, ', ' ORDER BY p.column_name)
    INTO missing_cols
    FROM _grading_revision_0073_protected p
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name   = 'certificates'
        AND c.column_name  = p.column_name);

  IF missing_cols IS NOT NULL THEN
    RAISE EXCEPTION
      '0073 refuses to install partial review protection: certificates is missing protected column(s): %. '
      'Each absent column would be silently unprotected, so a reviewer could approve a grade that '
      'changed under them. Reconcile the schema first, then re-run.',
      missing_cols;
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 3) grading_revision — ADD where absent, then CONVERGE everywhere.
--
--    Staging ALREADY has this column, added by its own
--    0071_certificate_review_revision_binding as `integer NOT NULL DEFAULT 1` —
--    the same shape this file wants, which is why convergence is possible at all.
--    Production does not have it. Both end identical.
--
--    ADD COLUMN IF NOT EXISTS is a SILENT no-op when the column exists: it does
--    not correct type, default or nullability. So the shape is converged
--    explicitly and then ASSERTED from the catalog rather than inferred from
--    statements that returned success.
--
--    Staging additionally carries chk_certificates_review_revision_binding, which
--    requires grading_revision > 0. The trigger below always yields
--    GREATEST(...,1)+1, so it can never violate that constraint.
-- ---------------------------------------------------------------------------
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS grading_revision INTEGER NOT NULL DEFAULT 1;

DO $$
DECLARE
  needing_backfill bigint;
BEGIN
  SELECT count(*) INTO needing_backfill
    FROM certificates
   WHERE grading_revision IS NULL OR grading_revision < 1;
  RAISE NOTICE '0073: % certificate row(s) need a grading_revision backfill.', needing_backfill;
END$$;

UPDATE certificates
   SET grading_revision = 1
 WHERE grading_revision IS NULL OR grading_revision < 1;

ALTER TABLE certificates ALTER COLUMN grading_revision SET DEFAULT 1;
ALTER TABLE certificates ALTER COLUMN grading_revision SET NOT NULL;

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
    RAISE EXCEPTION '0073 convergence failed: certificates.grading_revision does not exist after the ADD COLUMN.';
  END IF;
  IF col.data_type <> 'integer' THEN
    RAISE EXCEPTION '0073 convergence failed: certificates.grading_revision is %, expected integer.', col.data_type;
  END IF;
  IF col.is_nullable <> 'NO' THEN
    RAISE EXCEPTION '0073 convergence failed: certificates.grading_revision is still NULLABLE. A NULL revision makes every grading save fail at the RETURNING check.';
  END IF;
  IF col.column_default IS NULL
     OR regexp_replace(col.column_default, '::.*$', '') <> '1' THEN
    RAISE EXCEPTION
      '0073 convergence failed: certificates.grading_revision DEFAULT is %, expected 1.',
      coalesce(col.column_default, 'absent');
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 4) The trigger function.
--
--    The comparison lives entirely in the trigger's WHEN clause, so by the time
--    this body runs the executor has already proved the certificate is unapproved
--    and that at least one protected field changed. The body only advances the
--    token. GREATEST(COALESCE(...),1) is a defensive floor so a corrupted 0 or
--    negative can never propagate into a CAS predicate.
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
--    Direct column comparison in a WHEN clause, NOT a to_jsonb() name lookup.
--    A name lookup returns NULL for a key that is not there, on BOTH sides, so a
--    protected field naming a non-existent column is never "distinct" and is
--    silently unprotected — and the same happens after a RENAME. Column
--    references are bound by attnum at CREATE TRIGGER time, so a missing column
--    fails the DDL inside this transaction and a rename keeps protection on the
--    same physical column.
--
--    It is also far cheaper. The previous form re-evaluated to_jsonb(OLD) and
--    to_jsonb(NEW) INSIDE a 51-iteration loop: up to 102 whole-row (169+ column)
--    JSON serialisations per updated row, and the worst case was the COMMON case
--    because the grading auto-save re-sends every column unconditionally. Here
--    the executor evaluates WHEN in C and never enters plpgsql on a no-op update.
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
    OR OLD.grade_explanation          IS DISTINCT FROM NEW.grade_explanation
  )
)
EXECUTE FUNCTION certificates_advance_grading_revision();


-- ---------------------------------------------------------------------------
-- 6) ENABLE ALWAYS (pg_trigger.tgenabled = 'A', not 'O'), matching 0035's
--    trg_certificates_origin_immutable on this same table.
--
--    A default-created trigger fires only when session_replication_role is
--    'origin' or 'local'. Any session able to SET it to 'replica' would otherwise
--    turn review-staleness protection off wholesale: a grading write would land
--    without advancing the token, and a reviewer's prepared revision would still
--    match — publishing a grade nobody inspected.
--
--    HONEST LIMIT: this closes the replication-role path, NOT a deliberate
--    `ALTER TABLE ... DISABLE TRIGGER` by the table owner.
-- ---------------------------------------------------------------------------
ALTER TABLE certificates ENABLE ALWAYS TRIGGER trg_certificates_advance_grading_revision;

COMMENT ON COLUMN certificates.grading_revision IS
  'Server-authoritative optimistic-concurrency token for the pending-review approval boundary. Advanced by trg_certificates_advance_grading_revision when an unapproved certificate has a protected field changed. Deliberately independent of updated_at.';


-- ---------------------------------------------------------------------------
-- 7) Partner preview permission (the semantics of this branch's withdrawn 0047).
--
--    Additive and conditional: only where the Partner RBAC catalogue exists.
--    Verified absent on BOTH hosts, and all three role codes are seeded on both,
--    so this grants on both and is a no-op on a re-run.
--
--    A database without the partner catalogue (a fresh grading-only install)
--    skips this entirely rather than failing — the permission is meaningless
--    without the tables that consume it. Where the tables DO exist, an incomplete
--    grant is an error, because a half-granted permission silently 403s the
--    partner label preview.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing_grants integer;
BEGIN
  IF to_regclass('public.partner_permissions') IS NULL
     OR to_regclass('public.partner_roles') IS NULL
     OR to_regclass('public.partner_role_permissions') IS NULL THEN
    RAISE NOTICE '0073: Partner RBAC catalogue absent; skipping the partner.cards.preview grant.';
    RETURN;
  END IF;

  INSERT INTO partner_permissions (code, label)
  VALUES ('partner.cards.preview', 'partner.cards.preview')
  ON CONFLICT (code) DO NOTHING;

  INSERT INTO partner_role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM partner_roles r
    JOIN partner_permissions p ON p.code = 'partner.cards.preview'
   WHERE r.code IN ('PARTNER_OWNER', 'PARTNER_MANAGER', 'MVGS_ASSESSMENT_TECHNICIAN')
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO missing_grants
    FROM (VALUES ('PARTNER_OWNER'), ('PARTNER_MANAGER'), ('MVGS_ASSESSMENT_TECHNICIAN')) expected(role_code)
   WHERE EXISTS (SELECT 1 FROM partner_roles r WHERE r.code = expected.role_code)
     AND NOT EXISTS (
       SELECT 1
         FROM partner_role_permissions rp
         JOIN partner_roles r ON r.id = rp.role_id
         JOIN partner_permissions p ON p.id = rp.permission_id
        WHERE r.code = expected.role_code
          AND p.code = 'partner.cards.preview');

  IF missing_grants <> 0 THEN
    RAISE EXCEPTION '0073: partner.cards.preview incomplete — % seeded role(s) still lack the grant.', missing_grants;
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 8) Partner MFA lifecycle verification (the semantics of 0046).
--
--    NOT re-applied. 0046_partner_mfa_pending_lifecycle is applied on staging and
--    is immutable history; on production the 0046 slot belongs to
--    scanner_processing_jobs, so that file must never run there — and does not
--    need to: production was measured to already carry both lifecycle columns AND
--    a partner_auth_lookup that projects has_active_mfa.
--
--    This section therefore VERIFIES rather than installs, because the
--    application now fails CLOSED when the projection is missing (it refuses every
--    partner login with a 503 rather than silently minting mfa_passed sessions).
--    Shipping the code without the projection would take the whole partner portal
--    offline, so the migration proves the precondition up front and names it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  result_sig text;
BEGIN
  IF to_regclass('public.partner_users') IS NULL THEN
    RAISE NOTICE '0073: Partner portal absent; skipping the MFA projection check.';
    RETURN;
  END IF;

  SELECT pg_get_function_result(oid) INTO result_sig
    FROM pg_proc WHERE proname = 'partner_auth_lookup' LIMIT 1;

  IF result_sig IS NULL THEN
    RAISE EXCEPTION '0073: partner_users exists but partner_auth_lookup() is missing — partner login cannot work.';
  END IF;

  IF result_sig NOT LIKE '%has_active_mfa%' THEN
    RAISE EXCEPTION
      '0073: partner_auth_lookup() does not project has_active_mfa. The application fails CLOSED on this '
      '(every partner login returns 503) rather than silently treating MFA as disabled, so deploying against '
      'this database would take the Partner Portal offline. Install the MFA lifecycle projection first.';
  END IF;

  RAISE NOTICE '0073: partner_auth_lookup projects has_active_mfa — the fail-closed MFA guard is satisfied.';
END$$;


-- ---------------------------------------------------------------------------
-- 9) Completeness assertion — verify the INSTALLED trigger, not the statements
--    above. "The migration returned success" is not evidence.
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
    RAISE EXCEPTION '0073 completeness assertion failed: trg_certificates_advance_grading_revision was not created.';
  END IF;

  IF trg.tgenabled <> 'A' THEN
    RAISE EXCEPTION
      '0073 completeness assertion failed: the revision trigger is not ENABLE ALWAYS (tgenabled=%), so '
      'session_replication_role=replica would bypass review-staleness protection.', trg.tgenabled;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'certificates_advance_grading_revision' AND n.nspname = 'public') THEN
    RAISE EXCEPTION '0073 completeness assertion failed: certificates_advance_grading_revision() is missing.';
  END IF;

  def := pg_get_triggerdef(trg.oid);

  IF def !~* 'BEFORE UPDATE' OR def !~* 'FOR EACH ROW' THEN
    RAISE EXCEPTION '0073 completeness assertion failed: not BEFORE UPDATE FOR EACH ROW. Installed: %', def;
  END IF;

  IF def !~* 'grade_approved_at' THEN
    RAISE EXCEPTION
      '0073 completeness assertion failed: the WHEN clause does not reference grade_approved_at, so approved '
      'certificates would be re-versioned. Installed: %', def;
  END IF;

  -- COVERAGE PROOF. Every protected name must appear in the installed definition
  -- inside a real comparison, not merely somewhere in the text. Structural, not
  -- token-presence: a name mentioned in a non-comparison position would otherwise
  -- pass while protecting nothing.
  SELECT string_agg(p.column_name, ', ' ORDER BY p.column_name)
    INTO uncovered
    FROM _grading_revision_0073_protected p
   WHERE position(
           lower('old.' || p.column_name || ' IS DISTINCT FROM new.' || p.column_name)
           IN regexp_replace(lower(def), '\s+', ' ', 'g')
         ) = 0;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      '0073 completeness assertion failed: the installed trigger does not COMPARE protected field(s): %. '
      'Those fields could change under a prepared review without invalidating it.', uncovered;
  END IF;

  RAISE NOTICE '0073: lineage convergence complete (% protected fields, ENABLE ALWAYS trigger, structural coverage proof).',
    (SELECT count(*) FROM _grading_revision_0073_protected);
END$$;
