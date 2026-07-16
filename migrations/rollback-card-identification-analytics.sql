-- ROLLBACK: AI Card Identification analytics + idempotency.
-- Drops only the two new tables (cascades their own indexes/constraints).
DROP TABLE IF EXISTS card_identification_requests;
DROP TABLE IF EXISTS card_identification_corrections;
