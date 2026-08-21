-- Disposable/staging rollback for unapplied 0102. Disable the public directory
-- first. Production use requires a separate retention review because consent,
-- approval and aggregate traffic evidence may exist.
DROP TABLE IF EXISTS partner_location_publications;
DROP TABLE IF EXISTS partner_public_profiles;
-- The composite constraints are retained because later Partner migrations use
-- them and they are harmless independently of this optional public surface.
