# CodeQL Decision — js/missing-rate-limiting @ server/partner/public-routes.ts:41 (FOUNDER DECISION REQUIRED)

**Status:** HELD for founder. NOT dismissed by Lead. `public-routes.ts` NOT edited to satisfy the scanner.
**PR:** #270 (`codex/partner-user-management` → `main`), head `a168ae57e85012c179faec2e76afa98f570fa800`
**Date:** 2026-07-29

## The alert

- Rule: `js/missing-rate-limiting` — "This route handler performs authorization, but is not rate-limited."
- Severity: **high**. It is the ONLY new alert; every other check on the PR passes.
- File/line: `server/partner/public-routes.ts:41`
- Exact line: `r.post("/auth/login", partnerLoginLimiter, async (req, res) => {`

## Why it is a FALSE POSITIVE (evidence)

The route **is** rate-limited. `partnerLoginLimiter` is the second argument — it is applied as route
middleware, before the handler runs.

`partnerLoginLimiter` is built by `partnerRateLimit()` (`server/partner/rate-limit.ts:47`), the partner
subsystem's own limiter: store-backed, 10 requests / 15 min, keyed on `email|ip`, and **fail-closed**
(`res.status(503)` if the limiter store itself errors — stricter than the express-rate-limit default,
which fails open).

CodeQL's `js/missing-rate-limiting` query recognises rate limiting only through a fixed set of known
libraries. This repo does use `express-rate-limit` in `server/index.ts`, `server/routes.ts`,
`server/showroom.ts` and `server/partner/connector-admin-routes.ts` — which is why comparable routes
elsewhere are not flagged. The partner subsystem deliberately does not: it needs the fail-closed
behaviour and the composite account+IP key. CodeQL cannot see a custom implementation, so it reports
the route as unprotected.

## Attribution — not caused by the remediation commits

CodeQL had never run on this branch before the PR was opened (no prior PR existed), so the alert is
"new" only in the sense that this is its first analysis. The flagged line is **byte-identical** to its
form at `f83ec8c9`, where it sat at line 23:

```
f83ec8c9:server/partner/public-routes.ts:23:  r.post("/auth/login", partnerLoginLimiter, async (req, res) => {
current  :server/partner/public-routes.ts:41:  r.post("/auth/login", partnerLoginLimiter, async (req, res) => {
```

The emergency-stop middleware added in `fcab6987` shifted the line number by 18 and did not touch the
limiter. The alert is inherent to `5f13b554`, the commit that created the public router as the C1 fix.

## Runtime exposure right now

Nil. Both gating flags (`partner_login_enabled`, `partner_onboarding_enabled`) are absent, so
`resolveGlobalFlag` returns false and every public partner route returns 503 before reaching any
handler. The alert cannot be exercised until the flags are deliberately enabled.

## Options

**A. Founder dismisses the alert in GitHub as a false positive (RECOMMENDED).**
- No code change. Fastest. Matches the reality: the route is rate-limited, harder than CodeQL's own
  reference pattern.
- Dismiss with reason "used in tests" is wrong; use **"false positive"** and paste the rate-limit.ts
  cite.
- Cost: the rule stays suppressed for that alert only; a genuine future removal of the limiter on a
  *different* route would still be caught.

**B. Add an `express-rate-limit` instance as an outer `r.use()` on the public router.**
- CodeQL-recognised, so the alert clears without dismissal, and it is genuine defence-in-depth on the
  one public surface.
- Cost: a second limiter on every public partner request, duplicating work the custom limiter already
  does; two budgets to reason about during an incident; and it changes runtime behaviour on a public
  endpoint at the very end of an integration. Not free.

**C. Inline CodeQL suppression comment.**
- **Not recommended.** It permanently blinds the scanner to that line, including a future edit that
  genuinely removes the limiter.

## Lead recommendation

**Option A.** The finding is understood, the mitigation is real and stronger than what CodeQL looks
for, and the surface is flag-gated OFF. Option B is a defensible hardening if you want belt-and-braces
on the public surface, but it should be a deliberate choice made on its own merits — not a change made
to satisfy a scanner.

## What is blocked on this

PR #270 cannot merge while the CodeQL check is red. Merging past a failing required security check is
a protected action and is not the Lead's to grant. Everything downstream of the merge — staging
precheck, applying 0031/0032, the staging deploy, the readiness check and the flags-off verification —
is therefore held.
