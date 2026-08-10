-- Rollback 0067. Apply only through the reviewed migration rollback runner.
DROP TRIGGER IF EXISTS certificate_image_crops_append_only ON certificate_image_crops;
DROP TRIGGER IF EXISTS certificate_image_workings_append_only ON certificate_image_workings;
DROP TRIGGER IF EXISTS certificate_image_masters_append_only ON certificate_image_masters;
DROP TABLE IF EXISTS certificate_image_crops;
DROP TABLE IF EXISTS certificate_image_workings;
DROP TABLE IF EXISTS certificate_image_masters;
DROP FUNCTION IF EXISTS reject_certificate_evidence_mutation();
