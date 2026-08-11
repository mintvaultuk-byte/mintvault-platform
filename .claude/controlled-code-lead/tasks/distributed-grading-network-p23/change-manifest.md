# Coordinated scanner canary — change manifest

## Authorised release boundary

The owner authorised a coordinated production release only for the signed-station
MintVault Scanner canary, its matching server support, and additive migrations
`0045_partner_stations.sql`, `0046_scanner_processing_jobs.sql`, and
`0047_scanner_evidence_staging.sql`. No certificate mutation is permitted until
post-deploy route, schema, machine-health, and existing-workflow checks pass.

## Release-local repair

| Area | Change | Why it is required | Explicitly excluded |
| --- | --- | --- | --- |
| `0047_scanner_evidence_staging.sql` | Add the immutable evidence ledger, legacy scanner durability prerequisites, and the active capture-session uniqueness gate. | Read-only production inventory proved these tables do not exist. The candidate server reads them during accepted evidence finalisation. | No data backfill, deletion, certificate renumbering, or unrelated DDL. |
| `server/routes.ts` | Stop invoking scanner-related schema creation at application startup. | Ensures all schema mutation for this release is supplied by the owner-approved numbered migrations before the app is deployed. | Existing non-scanner startup compatibility routines are untouched. |
| `shared/schema.ts`, `0045_partner_stations.sql` | Correct comments to point at migration `0047`. | Prevents future operators relying on the removed boot-time schema path. | No runtime behavioural change. |
| Release records | Update the task ledger and production preflight with the live-schema finding and decision. | Makes the migration/deploy gate auditable. | No credentials, certificate contents, or customer data. |

## Invariants and proof

- Only a completed staging finalisation can add an immutable current evidence row.
- A capture session may have one active (`armed`/`claimed`/`capturing`) target per certificate side.
- `certificate_image_evidence` keeps historical revisions and has at most one `is_current` row per certificate/side.
- The migration is additive and idempotent on a fresh production-shaped schema.
- The app is deployed only after `0045` → `0046` → `0047` succeed and their exact objects are inventoried.
