-- 0034 — Partner Network RBAC reference-data seed (canonical initial catalogue).
--
-- WHY THIS EXISTS (first-OWNER-invitation blocker, staging 2026-07-31):
-- 0001_partner_foundation CREATEs partner_roles / partner_permissions / partner_role_permissions but
-- never POPULATES them. invitePartnerUser() resolves 'PARTNER_OWNER' through a lookup that requires
-- exactly one matching row, so every deployed environment answered PARTNER_ROLE_NOT_CONFIGURED on the
-- very first "Create owner login". Confirmed read-only on staging: all three tables held 0 rows.
--
-- APPROVED ARCHITECTURE (owner decision, 2026-07-31) — the HYBRID:
--   * the INITIAL catalogue is seeded HERE, by a numbered migration, under the canonical runner;
--   * application startup performs READ-ONLY validation only (validatePartnerRbac);
--   * runtime application identities never mutate this security catalogue.
-- Rationale proven on disposable PostgreSQL 17.10 before this file was written: a startup seed leaves
-- a PARTIAL catalogue behind on mid-run failure (roles present, mappings incomplete — permission
-- checks then silently under-grant), whereas a migration is atomic and fail-closed. Production also
-- has NO PARTNER_ADMIN_DATABASE_URL, so a startup seed would have written this security catalogue
-- through the main application's table-owning, BYPASSRLS `neondb_owner` identity.
--
-- TRANSACTION: intentionally NO BEGIN/COMMIT. scripts/db/migrate.ts wraps each file in one
-- transaction together with its journal row (migrate.ts:489-498). A nested COMMIT would commit the
-- runner's transaction early and split this seed from its journal entry. All sibling migrations
-- follow the same rule.
--
-- SAFE FOR AN EMPTY CATALOGUE and for a PARTIALLY POPULATED one: every insert is additive with
-- ON CONFLICT DO NOTHING on a real arbiter (partner_roles.code UNIQUE, partner_permissions.code
-- UNIQUE, partner_role_permissions PRIMARY KEY (role_id, permission_id)).
--
-- NOT SILENTLY PERMISSIVE: a pre-existing row whose DEFINITION disagrees with the canonical one
-- (a role code carrying a different label, or a permission whose label is not its code) is a
-- genuine conflict of meaning. This migration RAISES rather than leaving two different notions of
-- the same role in the estate. Extra catalogue rows that are simply unknown to this migration are
-- reported as a NOTICE and left untouched — removing a grant is a deliberate act that belongs in its
-- own numbered migration, never a side effect of seeding.
--
-- COMPLETENESS IS ASSERTED at the end: if the catalogue is not exactly complete when this file
-- finishes, the migration fails and the transaction rolls back.
--
-- CANONICAL SOURCE: server/partner/permissions.ts (PARTNER_PERMISSIONS, ROLE_PERMISSIONS,
-- ROLE_LABELS) and shared/partner-schema.ts (PARTNER_ROLE_CODES). tests/partner-rbac-parity.test.ts
-- fails CI in BOTH directions if this file and those maps ever disagree.

-- ---------------------------------------------------------------------------
-- Canonical definition, stated once. ON COMMIT DROP so nothing outlives the
-- runner's transaction.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _rbac_roles (code text PRIMARY KEY, label text NOT NULL) ON COMMIT DROP;
INSERT INTO _rbac_roles (code, label) VALUES
  ('PARTNER_OWNER', 'Partner Owner'),
  ('PARTNER_MANAGER', 'Partner Manager'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'MVGS Assessment Technician'),
  ('PARTNER_RECEPTION', 'Reception'),
  ('PARTNER_FINANCE_VIEWER', 'Finance Viewer'),
  ('PARTNER_TRAINEE', 'Trainee');

CREATE TEMP TABLE _rbac_perms (code text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _rbac_perms (code) VALUES
  ('partner.dashboard.view'),
  ('partner.organisation.view'),
  ('partner.location.view'),
  ('partner.users.view'),
  ('partner.users.manage'),
  ('partner.sessions.revoke'),
  ('partner.documents.view'),
  ('partner.training.view'),
  ('partner.credits.view'),
  ('partner.orders.view'),
  ('partner.orders.create'),
  ('partner.orders.edit'),
  ('partner.orders.submit'),
  ('partner.orders.cancel'),
  ('partner.cards.view'),
  ('partner.cards.receive'),
  ('partner.cards.scan'),
  ('partner.cards.assess'),
  ('partner.support.view'),
  ('partner.support.create');

CREATE TEMP TABLE _rbac_map (role_code text, permission_code text, PRIMARY KEY (role_code, permission_code))
  ON COMMIT DROP;
INSERT INTO _rbac_map (role_code, permission_code)
-- PARTNER_OWNER and PARTNER_MANAGER both hold the FULL Phase 1 permission set
-- (ROLE_PERMISSIONS.PARTNER_OWNER is a spread of PARTNER_PERMISSIONS).
SELECT r.code, p.code FROM _rbac_roles r, _rbac_perms p
 WHERE r.code IN ('PARTNER_OWNER', 'PARTNER_MANAGER')
UNION ALL
SELECT * FROM (VALUES
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.dashboard.view'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.location.view'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.documents.view'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.training.view'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.cards.view'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.cards.receive'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.cards.scan'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.cards.assess'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.support.view'),
  ('MVGS_ASSESSMENT_TECHNICIAN', 'partner.support.create'),
  ('PARTNER_RECEPTION', 'partner.dashboard.view'),
  ('PARTNER_RECEPTION', 'partner.location.view'),
  ('PARTNER_RECEPTION', 'partner.orders.view'),
  ('PARTNER_RECEPTION', 'partner.orders.create'),
  ('PARTNER_RECEPTION', 'partner.orders.edit'),
  ('PARTNER_RECEPTION', 'partner.orders.submit'),
  ('PARTNER_RECEPTION', 'partner.cards.view'),
  ('PARTNER_RECEPTION', 'partner.cards.receive'),
  ('PARTNER_RECEPTION', 'partner.support.view'),
  ('PARTNER_RECEPTION', 'partner.support.create'),
  ('PARTNER_FINANCE_VIEWER', 'partner.dashboard.view'),
  ('PARTNER_FINANCE_VIEWER', 'partner.organisation.view'),
  ('PARTNER_FINANCE_VIEWER', 'partner.credits.view'),
  ('PARTNER_FINANCE_VIEWER', 'partner.orders.view'),
  ('PARTNER_TRAINEE', 'partner.dashboard.view'),
  ('PARTNER_TRAINEE', 'partner.location.view'),
  ('PARTNER_TRAINEE', 'partner.training.view'),
  ('PARTNER_TRAINEE', 'partner.cards.view'),
  ('PARTNER_TRAINEE', 'partner.documents.view'),
  ('PARTNER_TRAINEE', 'partner.support.view')
) AS v(role_code, permission_code);

-- ---------------------------------------------------------------------------
-- Guard 1 — refuse to proceed over a CONFLICTING existing definition.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s (existing label %L, canonical %L)', r.code, r.label, c.label), '; ' ORDER BY r.code)
    INTO bad
    FROM partner_roles r
    JOIN _rbac_roles c ON c.code = r.code
   WHERE r.label IS DISTINCT FROM c.label;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      '0034 refuses to run: % existing partner_roles row(s) define a canonical role differently: %. '
      'Seeding over this would leave two different notions of the same role in the estate. '
      'Reconcile the label (or the canonical map in server/partner/permissions.ts) and re-run.',
      (SELECT count(*) FROM partner_roles r2 JOIN _rbac_roles c2 ON c2.code = r2.code
        WHERE r2.label IS DISTINCT FROM c2.label),
      bad;
  END IF;

  -- seedPartnerRbac() writes permissions as (code, label) = (code, code); the canonical rendering of
  -- a permission label IS its code, so any other label is a conflicting definition.
  SELECT string_agg(format('%s (existing label %L)', p.code, p.label), '; ' ORDER BY p.code)
    INTO bad
    FROM partner_permissions p
    JOIN _rbac_perms c ON c.code = p.code
   WHERE p.label IS DISTINCT FROM p.code;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      '0034 refuses to run: existing partner_permissions row(s) define a canonical permission '
      'differently (label must equal code): %. Reconcile and re-run.', bad;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Guard 2 — REPORT unknown catalogue rows. Never delete them: revoking a grant
-- is a deliberate act and belongs in its own numbered migration.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  extra_roles text;
  extra_perms text;
BEGIN
  SELECT string_agg(r.code, ', ' ORDER BY r.code) INTO extra_roles
    FROM partner_roles r WHERE NOT EXISTS (SELECT 1 FROM _rbac_roles c WHERE c.code = r.code);
  IF extra_roles IS NOT NULL THEN
    RAISE NOTICE '0034: partner_roles holds role(s) unknown to the canonical map, left untouched: %', extra_roles;
  END IF;

  SELECT string_agg(p.code, ', ' ORDER BY p.code) INTO extra_perms
    FROM partner_permissions p WHERE NOT EXISTS (SELECT 1 FROM _rbac_perms c WHERE c.code = p.code);
  IF extra_perms IS NOT NULL THEN
    RAISE NOTICE '0034: partner_permissions holds permission(s) unknown to the canonical map, left untouched: %',
      extra_perms;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Seed. Additive, idempotent, deterministic ordering.
-- ---------------------------------------------------------------------------
INSERT INTO partner_roles (code, label)
SELECT code, label FROM _rbac_roles ORDER BY code
ON CONFLICT (code) DO NOTHING;

INSERT INTO partner_permissions (code, label)
SELECT code, code FROM _rbac_perms ORDER BY code
ON CONFLICT (code) DO NOTHING;

-- Joined by natural key so this can never depend on generated uuids.
INSERT INTO partner_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM _rbac_map m
  JOIN partner_roles r ON r.code = m.role_code
  JOIN partner_permissions p ON p.code = m.permission_code
 ORDER BY m.role_code, m.permission_code
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Completeness assertion. If the catalogue is not exactly complete now, fail and
-- roll back rather than leave a half-usable security catalogue behind.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing_roles int;
  missing_perms int;
  missing_maps int;
BEGIN
  SELECT count(*) INTO missing_roles
    FROM _rbac_roles c WHERE NOT EXISTS (SELECT 1 FROM partner_roles r WHERE r.code = c.code AND r.label = c.label);
  SELECT count(*) INTO missing_perms
    FROM _rbac_perms c WHERE NOT EXISTS (SELECT 1 FROM partner_permissions p WHERE p.code = c.code AND p.label = c.code);
  SELECT count(*) INTO missing_maps
    FROM _rbac_map m
   WHERE NOT EXISTS (
     SELECT 1 FROM partner_role_permissions rp
       JOIN partner_roles r ON r.id = rp.role_id
       JOIN partner_permissions p ON p.id = rp.permission_id
      WHERE r.code = m.role_code AND p.code = m.permission_code);

  IF missing_roles > 0 OR missing_perms > 0 OR missing_maps > 0 THEN
    RAISE EXCEPTION
      '0034 completeness assertion failed: % role(s), % permission(s), % mapping(s) still missing after seeding.',
      missing_roles, missing_perms, missing_maps;
  END IF;

  RAISE NOTICE '0034: Partner RBAC catalogue complete (% roles, % permissions, % mappings).',
    (SELECT count(*) FROM _rbac_roles), (SELECT count(*) FROM _rbac_perms), (SELECT count(*) FROM _rbac_map);
END$$;
