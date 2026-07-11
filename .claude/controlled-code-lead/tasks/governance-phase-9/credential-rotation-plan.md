# Protected credential-rotation plan (AWAITING OWNER APPROVAL — do NOT execute)

Live credential material was detected embedded in local `.claude/settings.local.json`
allow-rules (now removed from those rules in 9B.2 — but the credentials themselves are
still valid and must be rotated, since they were readable in a local file). No secret
value appears in this plan. **Rotation is a protected action; each service below needs
separate owner approval and is NOT performed in Phase 9.**

## Credentials to rotate (category + why)
| # | Credential | Where used | Blast radius if leaked |
|---|---|---|---|
| 1 | Stripe LIVE secret key | `server/stripeClient.ts` (Fly secret `STRIPE_SECRET_KEY`) | Money movement, customer PII |
| 2 | Stripe webhook secret | webhook signature verify | Forged webhook events |
| 3 | Resend API key | transactional email | Email spoofing from the domain |
| 4 | Production DB password | Neon `ep-wispy-morning` connection string | Full customer data read/write |
| 5 | Admin password + Admin PIN | 2-step admin auth | Admin-panel takeover |
| 6 | Transfer confirmation token | ownership-transfer flow | Unauthorised transfers |
| 7 | Any other detected secret (Higgsfield `oat_`, SIGNED_URL_SECRET, SESSION_SECRET) | R2 signing / sessions / provider | Session forgery, presigned-URL abuse |

## Service-by-service order (least-coupled first; avoids an outage)
1. **Resend** — rotate key in the Resend dashboard → `fly secrets set RESEND_API_KEY=…` → rolling restart → send one test email. Email is async; low outage risk. Revoke old key after the test.
2. **Transfer token** — regenerate → update secret → restart → verify a transfer initiates. Self-contained.
3. **Admin password + PIN** — set new values → `fly secrets set` → restart → log in with the new PIN from a fresh session. Rotate together (both gate admin).
4. **Higgsfield / SIGNED_URL / SESSION secrets** — SESSION_SECRET rotation invalidates all sessions (users re-login) — schedule off-peak. SIGNED_URL_SECRET rotation breaks in-flight presigned URLs (~10-min TTL) — brief. Higgsfield `oat_` per its own runbook.
5. **Stripe webhook secret** — rotate in Stripe → update `STRIPE_WEBHOOK_SECRET` → restart → send a Stripe test event and confirm 200. Do BEFORE the API key so signature verification stays consistent.
6. **Stripe LIVE secret key** — create a new restricted key → `fly secrets set STRIPE_SECRET_KEY=…` → restart → run one test-mode PaymentIntent (or a £0.00 auth) → confirm → **then revoke the old key** in Stripe. Highest-risk; do last, with a payment-quiet window.
7. **Production DB password** — rotate in Neon → update `MINTVAULT_DATABASE_URL` secret → **rolling** restart (both machines) → confirm `/ready` returns ready and a read query works → then invalidate the old password. Coordinate so no machine holds a stale connection string mid-rotation.

## Outage avoidance
- Every rotation is `fly secrets set` → **rolling** restart (not all-at-once). Confirm each machine is healthy (`fly status`, `/ready`) before revoking the old value.
- Never revoke the old credential until the new one is proven live (verify the artifact, not the restart).
- DB + SESSION rotations touch every request → schedule during a submission-quiet window.

## Validation after each rotation
- Resend: test email delivered. Transfer: initiate + confirm. Admin: fresh login. Stripe: test event 200 + a test PaymentIntent. DB: `/ready` + a SELECT. Sessions: a fresh login works, old session logged out.

## Rollback
- If a new credential fails to validate and the old is not yet revoked: `fly secrets set <VAR>=<old>` to restore, restart, then investigate. Once the old is revoked, rollback = mint another new one (never un-revoke).

## Dependent systems / restart requirements
- All are Fly secrets → each rotation requires a Fly app restart to take effect (env read at boot / per-call). Two machines → rolling. No DNS change. No code change (values are env-only).

## Standing rule
Do not execute any step without a per-service owner approval record in
`.claude/controlled-code-lead/approvals/`.
