# Change manifest — Partner Pilot auth and onboarding

## Scope and compatibility

- `migrations/0077_partner_credential_lifecycle_hardening.sql` is an additive, idempotent Partner-scope migration. It adds credential provenance, retires duplicate live reset links, enforces one live reset link, and recreates the narrow pre-auth definer lookup with the least-privilege owner and fixed search path.
- Existing `/api/partner/session` remains unchanged as a compatible alias; `/api/partner/me` exposes the same MFA-safe payload.
- Existing invite and reset URLs, bcrypt hashing, MFA enrollment, session revocation, and delivery adapters remain in use.

## Security invariants

- No password, hash, raw reset token, TOTP secret, or recovery code is returned by the Admin UI or `/me`.
- New passwords are validated in the service layer at 10+ characters and at most 72 UTF-8 bytes.
- Issuing a reset link marks every older unconsumed link used in the same user-row-serialized transaction.
- Completing a reset sets provenance, increments credential version, clears lockout, and revokes all sessions.
- Admin Partner Management requires Super Admin authentication before any read or mutation.
- `READY_TO_LOG_IN` requires portal+login flags, active organisation/user, freshly-proven credential, required MFA configured, and runtime-equivalent active-location eligibility.

## Intentionally changed legacy behaviour

`0077` leaves every pre-existing `password_set_at` value null. Such accounts must use the normal reset/invite path after migration; this is deliberate fail-closed remediation for unknown legacy credential provenance, not a data backfill.
