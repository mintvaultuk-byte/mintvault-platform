# /login session-bleed UI bug — investigation report

**Date:** 2026-05-02
**Reporter:** Cornelius
**Symptom:** Submitted `/login` for `infoconcretedrivewayslast@gmail.com` while
already authenticated as `neilsophieoliver@gmail.com` in the same browser
tab. After the magic-link click, the dashboard rendered with the new
user's display name but the old user's email + cards visible. Logging
out and signing in fresh via incognito works correctly — both users
have separate, isolated data.
**Investigation:** read-only. No code changes.

---

## DB isolation status — **CLEAN**

Two distinct users, no merge / no cross-leak:

| email | id | created_at | display_name |
|---|---|---|---|
| `neilsophieoliver@gmail.com` | `0aa235aa-cbcb-443e-9ab9-4ef87b9a08ec` | 2026-04-28 12:11:14 | neil |
| `infoconcretedrivewayslast@gmail.com` | `792c4235-d5b3-4cd3-b1d2-e09c9ee15de3` | 2026-05-02 11:02:41 | drivways |

| email | certificates (current_owner) | submissions |
|---|---|---|
| neilsophieoliver | **3** | 0 |
| infoconcretedrivewayslast | 0 | 0 |

The 3 certs are correctly owned by Neil's user_id. None bleed across.
Magic-link tokens (latest 9, both users) bound to correct user_ids.
Token id=33 (the one Cornelius clicked) → `infoconcretedrivewayslast`,
created 11:08:03, consumed 11:09:45. Clean.

> Note: certificates' user-link column is `current_owner_user_id` (not
> `user_id` — brief assumed `user_id`, corrected during the probe).

This is purely a session/UI bug. Not a DB merge bug.

---

## Code path findings

### The codebase has THREE concurrent audience identities sharing one session document

Per the comment at [routes.ts:5935-5937](../server/routes.ts#L5935-L5937)
("Prevents pre-existing admin/account-holder fields from surviving into
the new customer session document — PR 3a"):

| Audience | Session keys |
|---|---|
| Admin | `req.session.isAdmin`, `req.session.adminEmail` |
| Account-holder (the "auth" flow) | `req.session.userId`, `req.session.userEmail` |
| Cert-owner / customer | `req.session.customerEmail` |

Three login endpoints write to these. They are **not symmetric** about
cross-audience cleanup:

| Endpoint | Regenerate? | Explicit cross-clear? |
|---|---|---|
| POST `/api/admin/pin` ([:1925](../server/routes.ts#L1925)) | ✅ | ✅ clears userId, userEmail, customerEmail |
| GET `/api/customer/verify/:token` ([:5927](../server/routes.ts#L5927)) | ✅ | ✅ clears userId, userEmail, isAdmin, adminEmail |
| GET `/api/auth/magic-link/verify` ([:9007](../server/routes.ts#L9007)) | ✅ | ❌ **no explicit cross-clear** |

The account-holder verify flow is the asymmetric one. After
`req.session.regenerate(...)`, the session is empty, so technically
`isAdmin / adminEmail / customerEmail` ARE cleared too — but the
asymmetry is a code smell. It documents that the author of this
handler didn't think about cross-audience hygiene.

### The dashboard reads identity from THREE different queries that can disagree

[client/src/pages/dashboard.tsx](../client/src/pages/dashboard.tsx):

| Line | Query | Returns | Source of truth |
|---|---|---|---|
| 892 | `/api/customer/me` | `{email}` | `req.session.customerEmail` |
| 902 | `/api/auth/me` | `{id, email, display_name, …}` | DB lookup by `req.session.userId` |
| 921 | `/api/customer/submissions` | `[CustomerSubmission]` | filter by `customerEmail` |
| 926 | `/api/customer/certificates` | `[CustomerCert]` | filter by `customerEmail` |
| 485 | `/api/vault-club/me` | (legacy + Step 4 fields) | `req.session.userId` |

The "welcome name" Cornelius saw comes from `authMe.display_name` (line
902, sourced from `userId`). The "email + cards" come from `me.email` +
`certs` (lines 892 + 926, sourced from `customerEmail`). **These two
session keys can hold different identities at the same time** —
intentionally, because that's how the three-audience design works. But
the dashboard treats them as one user.

### TanStack Query is configured `staleTime: Infinity` with no session-change invalidation

[client/src/lib/queryClient.ts:55](../client/src/lib/queryClient.ts#L55):

```ts
queries: {
  queryFn: getQueryFn({ on401: "returnNull" }),
  refetchInterval: false,
  refetchOnWindowFocus: false,
  staleTime: Infinity,
  retry: false,
},
```

Once a query is fetched and cached, it is treated as fresh **forever**.
`refetchOnMount` defaults to `true` but only refetches stale queries —
with `staleTime: Infinity`, mount returns cached data without a network
call. There is **no global "user has logged in / out" handler that
invalidates the cache**.

### POST /api/auth/magic-link sends a link for a different user without checking the requester's session

[routes.ts:8987-9004](../server/routes.ts#L8987-L9004):

```ts
app.post("/api/auth/magic-link", async (req, res) => {
  const { email } = req.body;
  ...
  const user = await findUserByEmail(email);
  if (user && !user.deleted_at) {
    const token = await createAccountMagicLinkToken(user.id);
    ...
    await sendAccountMagicLinkEmail(user.email, loginUrl);
  }
  return res.json({ ok: true, message: "If an account exists, a login link has been sent." });
});
```

No check of `req.session.userId` against the requested email. If
already-logged-in Neil submits Driveways' email, a magic-link is
created against Driveways' user_id and emailed to Driveways' inbox.
Anyone with email-jar access for the second account becomes Neil's
session-swap accomplice.

### /login renders unconditionally even when authenticated

[client/src/pages/login.tsx:8-25](../client/src/pages/login.tsx#L8-L25):

```ts
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  ...
}
```

No `useQuery(/api/auth/me)` check. No redirect-if-authenticated. A
user with a live session is shown a fresh login form as if they
weren't logged in.

---

## Session-management invariants violated

1. **"At most one audience identity per session at any time."**
   Violated by the asymmetric account-holder verify handler — though
   regenerate happens to enforce the invariant via empty-session
   side-effect, the explicit clear is missing and the codebase reads
   inconsistently.
2. **"Visiting /login while authenticated is a no-op or a redirect, never a fresh form."**
   Violated by [login.tsx](../client/src/pages/login.tsx).
3. **"A magic-link request from an authenticated session for a different email is rejected or requires confirmation."**
   Violated by [POST /api/auth/magic-link](../server/routes.ts#L8987).
4. **"Cached SPA data is invalidated when the underlying session identity changes."**
   Violated by [queryClient.ts](../client/src/lib/queryClient.ts) — no
   session-change-aware invalidation; `staleTime: Infinity` makes any
   stale data sticky until manually invalidated or app reload.
5. **"Pages that read identity should pin all reads to a single audience identity."**
   Violated by [dashboard.tsx](../client/src/pages/dashboard.tsx) —
   reads from `customerEmail` AND `userId` simultaneously, treating
   them as one user.

---

## Reconstruction of Cornelius's mixed-state outcome

The most-likely path (cannot prove without browser-side timing
instrumentation; treat as informed guess):

1. Tab #1 had the SPA running and had already cached some queries
   under user-A's session (probably `/api/customer/me` and
   `/api/customer/certificates` from a prior dashboard visit).
2. User navigated within tab #1 to `/login` (Wouter, no session
   check).
3. User submitted user-B's email. Server sent the magic link
   without checking who was already authenticated.
4. User clicked the email link. Depending on email client, the
   verify URL loaded either in tab #1 (full-page nav, fresh SPA,
   no cache) or in a new tab.
5. The verify endpoint regenerated the session — old cookie (user-A
   sid) replaced by new cookie (user-B sid). **The cookie jar
   replacement applies to ALL tabs on the same domain, not just the
   tab that received the response.**
6. Dashboard was reached in some tab. The QueryClient instance
   serving that paint had **stale cached data from user-A's session**
   (because the SPA didn't re-bootstrap if the verify happened in a
   different tab and the user came back to tab #1) AND fresh queries
   for things that hadn't been previously cached.
7. `authMe` (display_name) was previously uncached for tab #1 OR was
   served from a fresh fetch with the new cookie, returning user-B.
   `me` (customerEmail) was cached from earlier and returned user-A.
   `certs` was cached from earlier and returned user-A's 3 certs.

The exact split between fresh and cached depends on whether the user
visited dashboard before the login attempt (some queries would have
fetched first time then) — but the structural cause is clear: cached
SPA state survives a session swap that the SPA doesn't know
happened.

---

## Three possible fixes — trade-offs

### Fix 1 — Prevent the session-swap from being possible while a session is live (defence in depth, server-side)

**Change:** /login renders a "you are already logged in as X — log out
first?" prompt when `/api/auth/me` returns a user. POST
`/api/auth/magic-link` rejects the request (or auto-logs-out the
caller before issuing) when the requester is authenticated and the
email differs from the session user.

**Pros:**
- Closes the easiest path to session bleed.
- Server-enforced — no client-cache invalidation question to answer.
- Matches user intent: a logged-in user clicking "Login" probably
  means "switch users", which should explicitly log out first.

**Cons:**
- Doesn't fix the underlying SPA cache-invalidation gap. A session
  swap via other means (admin impersonate, expired session refresh
  with wrong cookie, etc.) still leaks.
- Slightly hostile UX — Neil might genuinely want to add
  Driveways' email to his session for some workflow we haven't
  built yet (rare, but ruling it out is a product call).

**Sketch:**
```ts
// /login mount
const { data: authMe } = useQuery({ queryKey: ["/api/auth/me"], … });
useEffect(() => {
  if (authMe?.id) navigate("/dashboard"); // or render switch-user prompt
}, [authMe]);

// POST /api/auth/magic-link
const callerUserId = req.session?.userId;
if (callerUserId) {
  const callerUser = await findUserById(callerUserId);
  if (callerUser?.email && callerUser.email !== email) {
    return res.status(403).json({ error: "already_authenticated_as_other" });
  }
}
```

### Fix 2 — Invalidate the SPA query cache on any auth-state transition (client-side)

**Change:** Centralise auth-state into a single `useAuth()` hook that
owns `/api/auth/me` + `/api/customer/me` + admin status. Whenever the
`(userId, customerEmail, isAdmin)` triple changes between renders,
call `queryClient.clear()`. Also clear on `logout` mutations.

**Pros:**
- Fixes the underlying class of bug, not just the /login path.
- Belt-and-braces against any future session-swap mechanism.
- Forces dashboards to declare which audience they read.

**Cons:**
- Bigger refactor — every page that reads identity has to migrate to
  the centralised hook.
- `queryClient.clear()` is heavy: every query gets refetched on next
  use, including expensive ones (showroom, certificates list, etc.).
  Visible loading states reappear on the auth-state-transition tick.
- Still wouldn't catch the case where the session changed in another
  tab and the user comes back to a stale tab — until they themselves
  navigate or the page mounts fresh.

**Sketch:**
```ts
function useAuthSession() {
  const queryClient = useQueryClient();
  const { data: authMe } = useQuery({ queryKey: ["/api/auth/me"] });
  const { data: customerMe } = useQuery({ queryKey: ["/api/customer/me"] });
  const fingerprint = `${authMe?.id ?? ""}|${customerMe?.email ?? ""}`;
  const prev = useRef(fingerprint);
  useEffect(() => {
    if (prev.current !== fingerprint) {
      queryClient.clear();
      prev.current = fingerprint;
    }
  }, [fingerprint]);
  return { authMe, customerMe };
}
```

### Fix 3 — Make cookies short-lived + version-stamp the session (architectural)

**Change:** Embed a session "epoch" in the cookie value. Every
regenerate bumps the epoch. The client stores the epoch from its last
known auth state (in-memory, not localStorage). Every API response
returns the current epoch in a header. If the response epoch differs
from the client's, the client calls `queryClient.clear()` and reloads
auth state.

**Pros:**
- Catches cross-tab session swaps.
- Server is the source of truth; client follows automatically.
- Future-proof against new audience flows.

**Cons:**
- Largest change — requires header propagation + interceptor in
  `apiRequest()` and the queryFn.
- Doesn't help non-API server-redirect flows (verify endpoint
  redirects to /dashboard with new cookie; client-side epoch is
  outdated until the first API call). Need a one-time check in the
  app shell.
- Crosses into sessionId-rotation territory — solid security
  pattern, but more than the symptom needs.

**Sketch:** server `app.use((req, res, next) => { res.setHeader("X-Session-Epoch", req.session.epoch); next(); })`; client interceptor compares incoming epoch against last-known and calls `queryClient.clear()` on mismatch.

---

## Recommendation

Combine **Fix 1 (server-side session-swap rejection) + Fix 2
(centralised auth-state hook with queryClient.clear on transition)**.

Fix 1 closes today's reproducer in one commit, low-risk. Fix 2 is the
real architectural fix and should land within Phase 1 — the dashboard
is one of three audience-mixed pages and the others (account-settings,
account-vault-club) have the same latent vulnerability. Fix 3 is
overkill for the current threat model; defer.

Also add to the Stage A invariant list:
- All session-mutating endpoints must explicitly clear cross-audience
  fields after `regenerate()` (mirrors the existing customer-verify +
  admin-pin pattern). Update [routes.ts:9028-9032](../server/routes.ts#L9028)
  to clear `isAdmin`, `adminEmail`, `customerEmail` for symmetry.

---

## Files / lines worth keeping in your head

- [client/src/pages/login.tsx](../client/src/pages/login.tsx) — needs session-aware redirect
- [client/src/pages/dashboard.tsx:892,902](../client/src/pages/dashboard.tsx#L892) — three-audience read; the bug surface
- [client/src/lib/queryClient.ts:55](../client/src/lib/queryClient.ts#L55) — `staleTime: Infinity`
- [server/routes.ts:8987](../server/routes.ts#L8987) — POST magic-link, no caller-auth check
- [server/routes.ts:9007](../server/routes.ts#L9007) — verify endpoint, asymmetric cross-clear
- [server/routes.ts:5927](../server/routes.ts#L5927) — customer verify, the canonical "do it right" example
- [server/customer-auth.ts:39](../server/customer-auth.ts#L39) — `requireCustomer` reads only `customerEmail`

No code changed. No DB changed. No tokens cleared. Probe script
written + deleted.
