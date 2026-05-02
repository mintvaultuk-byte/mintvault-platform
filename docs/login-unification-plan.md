# Login flow unification — plan

**Goal:** one magic-link click produces a session that satisfies both
audiences (`req.session.userId` AND `req.session.customerEmail`),
regardless of which entry point (`/login` page vs `/dashboard`
cert-owner form) the user used.

**Constraint:** preserve the session-bleed-fix discipline from commit
`5c93b51` (regenerate + explicit cross-clear at every login handler).

---

## Findings

### 1. Cert-owner flow — does NOT touch the users table

[server/customer-auth.ts](../server/customer-auth.ts) — token store is
`customer_magic_link_tokens`, indexed by **email only** (no user_id
column). 15-minute TTL.

[server/routes.ts:5927](../server/routes.ts#L5927) verify endpoint:
- `verifyMagicToken(token)` returns `{email}` from the token table
- Sets `req.session.customerEmail = email`
- Never queries or creates a `users` row

Net: a user can be authenticated as a cert-owner forever without
the system having a `users` row for them. They can see their cards
on `/dashboard`, but anything that requires `userId` (Vault Club,
account-settings, etc.) breaks for them.

### 2. Account-holder flow — REQUIRES an existing users row

[server/routes.ts:8987](../server/routes.ts#L8987) send endpoint:
- `findUserByEmail(email)` — returns null if no row
- If null: silent no-op (returns generic success for enumeration
  protection, doesn't send anything)
- If found: creates token bound to `user.id` in `account_magic_link_tokens`

[server/routes.ts:9050](../server/routes.ts#L9050) verify endpoint:
- Looks up user by `rec.user_id`
- Sets `req.session.userId = user.id` + `userEmail`
- Does NOT set `customerEmail` (gap)

Net: an existing cert-owner with submission/certificate rows but no
users row cannot use `/login` at all — the magic-link send silently
no-ops because `findUserByEmail` returns null.

### 3. Middleware checks — three independent guards on three keys

| Middleware | Reads | Used by |
|---|---|---|
| `requireCustomer` ([customer-auth.ts:39](../server/customer-auth.ts#L39)) | `req.session.customerEmail` | `/api/customer/me`, `/api/customer/submissions`, `/api/customer/certificates` |
| `requireAuth` ([middleware/auth.ts](../server/middleware/auth.ts)) | `req.session.userId` | `/api/auth/me`, `/api/vault-club/checkout`, `/api/vault-club/portal`, `/api/auth/change-*`, etc. |
| `requireAdmin` ([auth.ts](../server/auth.ts)) | `req.session.isAdmin` | `/api/admin/*` |

These checks are independent — a single Express request flowing
through `requireCustomer` won't auto-promote into something
`requireAuth` accepts. The session-key-per-audience pattern is by
design (per the comment at [routes.ts:5938-5940](../server/routes.ts#L5938-L5940)).

### 4. Users schema + FK constraints

[shared/schema.ts:25-44](../shared/schema.ts#L25):
- PK `id` varchar UUID, default `gen_random_uuid()`
- `email` varchar UNIQUE (LOWER-comparison in `findUserByEmail` —
  case-insensitive lookup against UNIQUE constraint that is
  case-sensitive at storage)
- `deletedAt` nullable (soft-delete pattern)
- `email_verified` boolean — ADD via runtime migration

FK references TO users.id (would cascade if a user row were deleted):
- `vault_club_subscriptions.user_id` (Phase 1 Step 1)
- `subscription_reminders.user_id` (Step 5a)
- `vault_club_consents.user_id` (Step 5d)

NO FK references from `submissions.user_id` or
`certificates.current_owner_user_id` — both columns are plain
`varchar` without `.references()`. Backfill is safe: inserting new
user rows for existing cert-owners doesn't risk cascade or orphan.

### 5. Session-key shape after unification

| Key | Set by | Was set by | Will be set by |
|---|---|---|---|
| `userId` | account-magic-link verify | only account flow | **both flows** |
| `userEmail` | account-magic-link verify | only account flow | **both flows** |
| `customerEmail` | customer-magic-link verify | only customer flow | **both flows** |
| `isAdmin` | admin-pin verify | admin only | admin only |
| `adminEmail` | admin-pin verify | admin only | admin only |

Post-unification: customer-flow verify finds-or-creates the users
row and sets BOTH `userId` and `customerEmail`. Account-flow verify
ALSO sets `customerEmail = user.email` to mirror. Either entry
point produces an equivalent session.

---

## Per-flow changes

### A — `GET /api/customer/verify/:token` ([routes.ts:5927](../server/routes.ts#L5927))

```ts
const email = await verifyMagicToken(token);
if (!email) return res.redirect("/dashboard?error=invalid_link");

// NEW — find or create the users row for this email.
let user = await storage.getUserByEmail(email);
if (!user) {
  user = await storage.createUser({ email });
  // Audit creation as part of the verify flow.
}

await regenerate();
req.session.userId = user.id;        // NEW
req.session.userEmail = user.email;  // NEW
req.session.customerEmail = email;   // existing
req.session.isAdmin = false;         // existing cross-clear
req.session.adminEmail = undefined;
res.redirect("/dashboard?login=success");
```

### B — `GET /api/auth/magic-link/verify` ([routes.ts:9050](../server/routes.ts#L9050))

```ts
// existing logic finds user by token's user_id, then:
await regenerate();
req.session.userId = user.id;
req.session.userEmail = user.email;
req.session.customerEmail = user.email;  // NEW — mirror symmetry
req.session.isAdmin = false;
req.session.adminEmail = undefined;
```

### C — invariant comment blocks

Update all three login-handler comment blocks to reflect:

> Post-verify, BOTH `userId` AND `customerEmail` are set (cert-owner
> verify finds-or-creates; account-holder verify sets both directly).
> `isAdmin`/`adminEmail` are explicitly cleared. Admin verify is the
> only flow that sets `isAdmin`/`adminEmail`, and it explicitly
> clears `userId`/`userEmail`/`customerEmail`.

### D — entry-point pruning: NOT in this commit

Both `/api/auth/magic-link` and `/api/customer/magic-link` send
endpoints stay. Both email templates stay. The two `/login` and
`/dashboard` form entry points stay. Pruning the redundancy is
follow-up.

### E — send-endpoint NOT touched

The session-promote-to-userId moment is `verify`, not `send`.
Touching `send` to create user rows would let unauthenticated
attackers spam-create rows by submitting random emails.

---

## Backfill plan

### Population

Distinct lowercased emails from `submissions.customer_email` ∪
`certificates` (no direct email column — link via owner_user_id?
Actually certificates link to users via `current_owner_user_id`, so
they're already users-linked. Submissions are the population.)

After re-checking [shared/schema.ts:113](../shared/schema.ts#L113):
`submissions.customer_email` is the email captured at checkout. The
submission may also have `user_id` set if `markSubmissionAsPaid`
linked it (see [server/webhookHandlers.ts:80](../server/webhookHandlers.ts#L80)
— the legacy grading payment flow already does
`storage.createUser` then `storage.updateSubmission` linking).

So the backfill population is: emails in `submissions.customer_email`
where there is NO matching `users.email` row. In other words: people
who signed up via the cert-owner magic-link flow but never had a
users row created.

```sql
SELECT DISTINCT LOWER(s.customer_email) AS email,
       MIN(s.created_at) AS earliest_seen
FROM submissions s
WHERE s.customer_email IS NOT NULL
  AND s.customer_email <> ''
  AND NOT EXISTS (
    SELECT 1 FROM users u
    WHERE LOWER(u.email) = LOWER(s.customer_email)
      AND u.deleted_at IS NULL
  )
GROUP BY LOWER(s.customer_email)
ORDER BY earliest_seen;
```

For each: `INSERT INTO users (email, email_verified, created_at)
VALUES (LOWER(email), TRUE, earliest_seen)`. Email-verified=true
because they proved email control during the cert-owner verify
flow (they're already cert-owners — they wouldn't be in this
population otherwise).

### Idempotency

Re-running the script: the `NOT EXISTS` clause filters out
already-created rows. Zero double-inserts. Safe to re-run after a
new cert-owner sign-up if needed.

### Audit

Each create writes one `audit_log` row:
- `entity_type = 'users'`
- `entity_id = <new user.id>`
- `action = 'cert_owner_backfill_create'`
- `admin_user = 'system'`
- `details = {source: 'login_unification_migration', email,
   earliest_submission_at}`

### Batching

If population > 1000 rows, batch with LIMIT/OFFSET and a 500ms
pause between batches (Neon-friendly).

### Dry-run + commit

Default: dry-run, prints the population count + first 5 rows.
Re-run with `--commit` to actually insert. Env-guard pattern from
5b/5d: aborts unless `MINTVAULT_DATABASE_URL` is dev/local OR
`ALLOW_PROD_SMOKE=1` (renamed mentally to "ALLOW_PROD_BACKFILL=1"
for clarity, but using same env name to keep one knob).

---

## Verification

`scripts/test-login-unification.ts` — 9 assertions:
1. New email creates user via cert-owner verify path
2. `/api/auth/me` returns the new user
3. `/api/customer/me` returns the new user
4. Logout
5. Same email re-enters via account-holder verify path
6. Both `/api/auth/me` AND `/api/customer/me` succeed
7. DB shows exactly ONE users row for that email (no duplicate
   create on the second path)
8. customerEmail set after account-holder verify (symmetry)
9. Cleanup: delete test user + audit rows

Browser smoke (manual): cert-owner sign-in via `/dashboard` form
→ click magic link → land on dashboard → navigate to `/vault-club`
→ tick consent → buy button enabled (proves userId is set).

---

## Follow-ups (not this commit)

- Prune the redundant cert-owner sign-in form on `/dashboard` —
  it's now equivalent to `/login`.
- Prune the redundant email template ("Dashboard Login Link", 24h)
  — unify on the single 15-minute account template.
- Migrate `account-settings.tsx` and `account-vault-club.tsx` to
  `useAuthSession` (carry-forward from 5c93b51).
