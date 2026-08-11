# Coordinated scanner canary — implementation budget

## Production dependency path

`partner_stations` (0045) → `scanner_processing_jobs` (0046) →
`scanner_capture_sessions` / `scanner_evidence_staging` /
`certificate_image_evidence` (0047) → signed station capture and staged TIFF finalisation.

## Resource and failure budget

- Migration work is metadata-only and additive; no certificate or object-store row is modified by applying it.
- Evidence upload remains staged and server-finalised; an unaccepted TIFF cannot switch the immutable pointer.
- No production load test is part of this release. The only authorised evidence operation is MV837 FRONT then BACK after health verification.
- If any migration, health, route, schema, version, tenant/station, certificate-number, or evidence invariant check fails, rollback is application-only to the captured v1065 image. Additive tables remain.
