/**
 * Bring a disposable `certificates` fixture up to the real shape for every column
 * migration 0048 protects.
 *
 * WHY THIS EXISTS. 0048's presence guard is deliberately UNCONDITIONAL: it RAISEs
 * if any protected field is missing from `certificates`, because a field naming a
 * column that does not exist was previously never "distinct" and so was silently
 * unprotected — a reviewer could approve a grade that changed under them. There is
 * no environment flag and no exemption list, since a guard that can be switched off
 * is not a guarantee.
 *
 * The fixtures that load 0048 verbatim are production-shaped only for the columns
 * their own assertions touch (18, 21 and 20 columns respectively), so without this
 * they would abort on ~45 absent fields. Bringing the fixture up to shape is the
 * correct direction of travel; weakening the guard is not.
 *
 * `IF NOT EXISTS` throughout, so this is safe whatever each fixture already
 * declared, and callers can apply it unconditionally before loading the migration.
 * Nullability and defaults are deliberately NOT mirrored — 0048 requires PRESENCE
 * and a comparable type, nothing more.
 */
export const CERTIFICATES_PROTECTED_COLUMNS_SQL = `
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS card_name                  text,
  ADD COLUMN IF NOT EXISTS set_name                   text,
  ADD COLUMN IF NOT EXISTS card_number_display        text,
  ADD COLUMN IF NOT EXISTS year_text                  text,
  ADD COLUMN IF NOT EXISTS language                   text,
  ADD COLUMN IF NOT EXISTS variant                    text,
  ADD COLUMN IF NOT EXISTS variant_other              text,
  ADD COLUMN IF NOT EXISTS rarity                     text,
  ADD COLUMN IF NOT EXISTS rarity_other               text,
  ADD COLUMN IF NOT EXISTS rarity_code                text,
  ADD COLUMN IF NOT EXISTS rarity_label               text,
  ADD COLUMN IF NOT EXISTS printed_symbol             text,
  ADD COLUMN IF NOT EXISTS printed_symbol_count       integer,
  ADD COLUMN IF NOT EXISTS printed_symbol_colour      text,
  ADD COLUMN IF NOT EXISTS finish_variant             text,
  ADD COLUMN IF NOT EXISTS promo_type                 text,
  ADD COLUMN IF NOT EXISTS subset_name                text,
  ADD COLUMN IF NOT EXISTS region                     text,
  ADD COLUMN IF NOT EXISTS era                        text,
  ADD COLUMN IF NOT EXISTS structured_variant_version integer,
  ADD COLUMN IF NOT EXISTS label_type                 text,
  ADD COLUMN IF NOT EXISTS grade                      numeric(4,1),
  ADD COLUMN IF NOT EXISTS grade_type                 text,
  ADD COLUMN IF NOT EXISTS centering_score            numeric(4,1),
  ADD COLUMN IF NOT EXISTS corners_score              numeric(4,1),
  ADD COLUMN IF NOT EXISTS edges_score                numeric(4,1),
  ADD COLUMN IF NOT EXISTS surface_score              numeric(4,1),
  ADD COLUMN IF NOT EXISTS centering_front_lr         text,
  ADD COLUMN IF NOT EXISTS centering_front_tb         text,
  ADD COLUMN IF NOT EXISTS centering_back_lr          text,
  ADD COLUMN IF NOT EXISTS centering_back_tb          text,
  ADD COLUMN IF NOT EXISTS corner_values              jsonb,
  ADD COLUMN IF NOT EXISTS edge_values                jsonb,
  ADD COLUMN IF NOT EXISTS surface_values             jsonb,
  ADD COLUMN IF NOT EXISTS defects                    jsonb,
  ADD COLUMN IF NOT EXISTS verified_defects           jsonb,
  ADD COLUMN IF NOT EXISTS auth_status                text,
  ADD COLUMN IF NOT EXISTS dark_border_front          boolean,
  ADD COLUMN IF NOT EXISTS dark_border_back           boolean,
  ADD COLUMN IF NOT EXISTS eye_appeal_modifier        integer,
  ADD COLUMN IF NOT EXISTS whitening_lines            jsonb,
  ADD COLUMN IF NOT EXISTS crease_span_pct            numeric,
  ADD COLUMN IF NOT EXISTS crease_lines               jsonb,
  ADD COLUMN IF NOT EXISTS wrinkle_severity           text,
  ADD COLUMN IF NOT EXISTS tear_severity              text,
  ADD COLUMN IF NOT EXISTS centering_outer_front      jsonb,
  ADD COLUMN IF NOT EXISTS centering_outer_back       jsonb,
  ADD COLUMN IF NOT EXISTS centering_inner_front      jsonb,
  ADD COLUMN IF NOT EXISTS centering_inner_back       jsonb,
  ADD COLUMN IF NOT EXISTS centering_method           text;
`;
