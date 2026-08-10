# Issue register — partner-full-pilot

| ID | Severity | Source / reproduction | Root cause | Repair | Proof | Status |
| --- | --- | --- | --- | --- | --- | --- |
| PFP-01 | HIGH | Staging Super Admin request `GET /api/admin/submissions/327/certs` returned 500 for a Partner-imported two-card destination. | Legacy picker queried removed `cert.cert_id` and joined only legacy `cards`; Partner imports link certificates through `submission_items`. | A Partner-owned, read-only adapter uses `certificate_number` and supports both canonical link paths; the admin picker calls it. | Protected engine regression 323/323; staging retest pending deploy. | LOCALLY VERIFIED |
| PFP-02 | HIGH | Staging connector detail labelled the pilot's two valid per-card reservations as `reservation_link_inconsistent`. | The read-only projection retained obsolete single-reservation cardinality logic. | Return all reservations plus count/active count; UI displays the list. | Real PostgreSQL two-card lifecycle test; staging retest pending deploy. | LOCALLY VERIFIED |

No speculative findings were added. The unsigned Stripe supply webhook proof remains an external staging configuration dependency, not a code finding.
