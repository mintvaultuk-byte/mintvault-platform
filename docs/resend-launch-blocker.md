# RESEND LAUNCH BLOCKER — Found 2026-04-25 06:06 UTC

## Issue
Resend API key (digest `ebabbe3e1586ed1b`, identical on prod + staging) is on
testing tier. Cannot send emails to any address other than the literal
`mintvaultuk@gmail.com`.

Verified via:
- Fly log: `[email] Failed v2 transfer outgoing to mintvaultuk+from@gmail.com:
  Resend API error: You can only send testing emails to your own email
  address (mintvaultuk@gmail.com). To send emails to other recipients,
  please verify a domain at resend.com/domains...`
- Resend API `GET /emails`: every single send in history goes to
  `mintvaultuk@gmail.com` literal. No other addresses, ever.

## Impact
**Production is broken for any email to a real customer.** This includes:
- Magic-link login emails
- Transfer confirmation emails (both outgoing + incoming, both flow versions)
- Submission confirmations
- Cards-received notifications
- Grading-complete notifications
- Shipped notifications
- Stolen card verification emails
- Certificate PDF deliveries

Plus-addressing does NOT bypass — Resend validates the literal string.

## Pre-launch fix required
1. Verify `mintvaultuk.com` (or whatever sender domain) in Resend dashboard:
   https://resend.com/domains
2. Add the DNS records Resend provides (SPF, DKIM, DMARC) at GoDaddy.
   - Note: GoDaddy domain transfer is unrelated and ongoing — DNS edits
     should still work via current registrar.
3. Once domain verified, update `from` address in `server/email.ts` to use
   the verified domain (e.g. `noreply@mintvaultuk.com`).
4. Verify by re-running this Fix 4 test with real plus-addressed gmail
   recipients.

## Why this didn't surface earlier
- All testing in development goes to `mintvaultuk@gmail.com` (works fine).
- Production never sent to a real customer (zero customers prior to v1).
- Try/catch around the Resend call returns success to the app even when
  Resend rejects the send. Silent failure mode.

## Severity
**P0 launch blocker.** v1 cannot launch until Resend domain verification is
complete. Without it, no customer ever receives an email.

## Suggested follow-up engineering
After domain verification, also consider:
- Add structured error reporting on Resend API failures (currently
  console.error only — should fail loudly in admin observability).
- Add a healthcheck endpoint that periodically verifies Resend can send to
  a non-test address, alerting on tier downgrade or quota exhaustion.
