# Canonical extension

`partner_organisations → partner_locations → partner_stations → authenticated partner user → replaceable scanner hardware`

`partner_stations` is the durable Mac/station identity. Scanner hardware is recorded as observation/provenance and calibration context, not as the authorisation identity. Human access continues to use the existing Partner session, MFA and permission resolution. Authoritative scanning requires both a current human Partner principal and a current approved station signature.

The server owns station ID assignment, tenant/location binding, session target ownership, calibration state and all R2 key creation. The Electron app holds only its private signing key in macOS Keychain-backed encrypted storage, opaque station credential metadata, short-lived current target, temporary TIFFs/previews and bounded pending uploads. It never selects tenant, location, certificate, side, R2 key or certificate number.

Heartbeats update a current station row with jittered low-frequency telemetry. Meaningful transitions (enrolment, approval, suspension, credential rotation, scanner replacement, calibration accepted/invalidated and capture failure) append a station event. Heartbeats never append permanent audit rows.

For accepted TIFFs, `scanner_evidence_staging` is an explicitly non-authoritative, short-lived R2 namespace. A claimed session receives one opaque server-created object key and a short-lived TIFF PUT URL; the station supplies its exact file hash/size and provenance in the signed grant request. Finalisation is bounded, single-flight and re-reads that key before decoded TIFF/profile/card-frame validation. Only then can the existing content-addressed immutable ledger be written. A mismatch, stale grant, stale preview, side/candidate crossover or another station fails before a master pointer changes. Accepted/expired/failed staging objects are leased and deleted in small background batches; immutable evidence is never eligible for that cleanup.
