# Admin identity/session recovery packet

**Wave:** `REPAIR-ADMIN-CONTRACTS`
**Pre-wave checkpoint:** `2913bcb1092ea8f43ee1294b711a8df653a06a3d`
**Pre-wave dirty-diff SHA-256:** `e612faf38358956b1a0b485d365f545293359cbd440c9c631a28a7d7cc613633`
**Owner authority:** the repository owner said “Proceed” after being presented the exact contract below.

## Authorised contract

- Logout is a single POST-only command to `/api/admin/logout`.
- Unauthenticated and expired responses are discriminated, never silently converted to nullable protected data.
- Protected browser cache ownership is partitioned by the complete server-confirmed Admin
  principal boundary: normalized email plus Super Admin role. Same-email role changes are
  principal transitions.
- Protected queries are cancelled and mounted observers reset before the former
  principal's cached queries and mutation state are purged on successful logout or
  principal transition. Explicitly public query keys remain shared.
- An untagged protected 401 triggers typed session revalidation; only the session
  authority may declare the principal unauthenticated. A wrong secret is returned with
  machine-readable code `admin_credential_rejected` and remains local to the credential
  form, so it cannot destroy a still-valid session.
- Identity responses are private and non-cacheable at the HTTP boundary.
- `/admin/login` and `/admin/cert/:id` remain public Admin-path exceptions. The public
  certificate page must not mount Admin-only tabs, actions, or protected queries.

The print/reprint route, grading, payments, schema, migrations, providers, secrets, deployment, release, and external systems are not part of this wave.

## Compatibility and failed-cut behavior

- The server's existing `GET /api/admin/session` status/reason matrix and POST login/PIN flow remain compatible. No cookie name, session schema, lifetime, role, credential, or database contract changes.
- `/api/admin/clear-session` remains a temporary login-recovery compatibility command; production UI logout uses only `/api/admin/logout`.
- Until identity is confirmed, protected Admin route children do not mount.
- A network or server failure during identity verification fails closed and offers a local retry; it does not manufacture a logged-out state.
- Logout failure preserves the current principal and cache because the server may still hold the session. The UI reports the failure and permits retry.
- A confirmed expiry or wrong-portal result cancels in-flight protected work, purges browser query/mutation caches, and redirects to `/admin/login` with the full Admin return path and typed reason.
- Concurrent or stale identity verification cannot publish over a newer logout or
  principal transition, and a same-principal verification cannot cancel an in-flight
  logout purge.

## Forward recovery and rollback

Forward recovery is retry-only and local: restore connectivity, retry identity verification, or retry POST logout. It performs no database, provider, object, payment, or deployment action.

Before an immutable candidate exists, rollback means reverse only the `REPAIR-ADMIN-CONTRACTS` hunks in its declared write scope and re-run the focused Admin session proof plus architecture/type/build gates. Do not reset or overwrite the pre-existing dirty tree. The checkpoint and dirty-diff digest above identify the state that must remain intact.

Invalidators: identity/session response changes, credential rejection codes, cookie/session
schema or role changes, public/protected route or query classification changes, cache
key/hash changes, logout destination or method changes, recovery-procedure changes,
candidate-base changes, or owner withdrawal.
