-- Rollback 0095. Do not run against production until lead retention/export
-- obligations have been assessed; dropping this table permanently deletes leads.
DROP TABLE IF EXISTS partner_applications;
