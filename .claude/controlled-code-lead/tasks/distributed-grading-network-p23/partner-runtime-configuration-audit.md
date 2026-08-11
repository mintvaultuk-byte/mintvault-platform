# Signed-station production runtime-configuration reconciliation — 2026-08-11

## Scope and safeguards

This is a read-only production reconciliation from checkpoint `20850ae9`. It
does not create a Neon role/database, change a Fly secret or flag, apply a
migration, deploy, enrol a station, read/write R2, or mutate a certificate.
All database observations below were made inside `BEGIN READ ONLY` sessions;
no secret values are recorded.

## Findings

### `PARTNER_DATABASE_URL`

`server/partner/db.ts` uses this URL exclusively for the Partner **runtime**
pool. Every tenant query passes through `withTenant`, which opens a transaction
and sets transaction-local `app.tenant_id` and `app.location_id`; it deliberately
never falls back to the MintVault owner connection. The Partner credit lifecycle
also asserts that this URL, when configured, identifies the **same PostgreSQL
database** as `MINTVAULT_DATABASE_URL`. A separate Partner database would break
the required atomic MintVault/Partner transaction and is architecturally wrong.

Production proof:

- `MINTVAULT_DATABASE_URL` targets production Neon database `neondb`.
- That database already contains the Partner foundation and the applied
  `0045_partner_stations.sql`, `0046_scanner_processing_jobs.sql`, and
  `0047_scanner_evidence_staging.sql` tables.
- `partner_runtime` exists but is a `NOLOGIN`, non-superuser, non-`BYPASSRLS`
  group role. Its only current member is `neondb_owner`, which is `BYPASSRLS`.
  It is not a safe runtime identity and its URL must **not** be copied into
  `PARTNER_DATABASE_URL`.

The safe value class is therefore a **new dedicated production LOGIN principal**
with a fresh database credential, granted only the `partner_runtime` role (and
with inherited membership enabled), `NOSUPERUSER`, `NOBYPASSRLS`, no role/database
creation or replication privilege. Its Neon URL must point to the same `neondb`
database (direct or Neon pooler hostname are both accepted as the same topology).
This is a new **login/credential**, not a new database.

### `PARTNER_MFA_ENC_KEY`

`server/partner/mfa.ts` decodes exactly 32 bytes: either 64 hexadecimal
characters or base64 which decodes to 32 bytes. It encrypts TOTP material with
AES-256-GCM using a random 12-byte IV and stores `v1:<iv>:<tag>:<ciphertext>`.
The same key also HMAC-SHA-256 hashes Partner recovery codes. Missing or malformed
key material throws, so encryption and recovery verification fail closed.

No existing production MFA/TOTP encryption secret was found by source inventory
or Fly secret-name inventory. `SESSION_SECRET`, signed-URL secrets and database
credentials are not compatible substitutes and must not be reused. A fresh
32-byte random value in the approved secret manager is required. Production
currently has zero Partner MFA method rows and zero recovery-code rows, so there
is no ciphertext compatibility/migration burden **before first use**. After
MFA enrolment, rotation without a keyring/re-encryption plan would make existing
TOTP material and recovery hashes unusable.

### Required Partner bootstrap is not a secret-only change

Production has one active Partner organisation but zero Partner locations,
roles, permissions, users and scan-authorised operators. Global
`partner_portal_enabled`, `partner_login_enabled` and `partner_emergency_stop`
rows are absent; absent portal/login flags resolve false (closed), and absent
emergency stop resolves false.

The existing canonical additive migration
`0034_partner_rbac_seed.sql` is not in production's migration journal. It is
the approved atomic seed for the six roles, 20 permissions and mappings,
including `partner.cards.scan`; without it the first owner/operator cannot be
authorised. It was not among the earlier narrowly authorised `0045`--`0047`
migrations and must not be applied in this pass.

After explicit owner approval, the minimal controlled bootstrap is:

1. Provision the restricted `LOGIN` member of `partner_runtime`, then set only
   `PARTNER_DATABASE_URL` to its same-`neondb` URL.
2. Generate and set only `PARTNER_MFA_ENC_KEY` to a new 32-byte random secret.
3. Apply the already-reviewed additive `0034_partner_rbac_seed.sql` through the
   guarded migration runner; do not hand-seed the security catalogue at runtime.
4. Create one active internal/HQ location and one MFA-enrolled internal operator
   with the minimum approved role containing `partner.cards.scan` (normally
   `MVGS_ASSESSMENT_TECHNICIAN`; do not grant owner merely to scan).
5. Set global `partner_portal_enabled=true` and `partner_login_enabled=true`;
   ensure `partner_emergency_stop` remains false/absent. Then deploy the matching
   signed-station release and run the one-station enrolment verification.

`PARTNER_ADMIN_DATABASE_URL`, `PARTNER_CONNECTOR_DATABASE_URL`, scanner R2
credentials and `SCANNER_API_TOKEN` compatibility are not required for this
single internal station. Do not enable the legacy scanner-token bridge in
production.

## Fail-closed proof

The candidate's Partner mount returns 503 if `PARTNER_DATABASE_URL` is absent,
and also returns 503 if that URL is present without `PARTNER_MFA_ENC_KEY`.
Candidate target mutations require both `requireScannerOrAdmin` and
`requireStationCaptureAgent`; in production the latter rejects any request
without a verified signed station identity. Local focused boundary tests cover
that condition. The currently rolled-back `v1067` application has no
signed-station routes at all. Its legacy scanner ingest endpoint is not a
signed-station or target-bound capture path and cannot substitute for the new
station protocol.

## Certificate state

At the read-only check, `cert_counter.last_issued = 836`; `MV836` exists and
`MV837`/`MV838` do not. There are 12 non-draft, non-deleted unlinked submission
items in legitimate workflow states, but none has a certificate allocated.
Therefore a legitimate next issuance is pending somewhere in the workflow, but
MV837 cannot be promised or reserved: it remains awaiting the next legitimate
allocation and another authorised allocation could consume it first.

## Re-entry gate

Do not deploy or attempt station enrolment until the owner has authorised the
restricted Neon LOGIN credential, a new MFA key, the already-existing `0034`
RBAC migration, and the tightly scoped HQ location/operator/flag bootstrap.
Then use a new immutable application candidate and prove the signed station
boundary before taking a fresh MV837 snapshot. No station/evidence/certificate
operation precedes those checks.
