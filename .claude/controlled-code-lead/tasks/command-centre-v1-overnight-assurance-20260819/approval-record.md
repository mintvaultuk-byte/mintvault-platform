# Owner approval record

## 2026-08-19 — Admin IP authority hardening

Owner approved only replacement of raw leftmost `X-Forwarded-For` parsing with Express `req.ip`, conditional on proof that the application's trust-proxy configuration is correct for Fly, unforgeable, and resolves the legitimate client. Login/password/PIN/MFA/session/cookie/role/Partner/customer/staff behavior was expressly excluded.

Precondition result: **failed**. The app uses `trust proxy=1`; the public `fly.v2.toml` path is Fly Proxy -> Machine; Fly documents the rightmost XFF address as the app-assigned IP. Express hop-count 1 therefore does not establish the originating client required by the owner. In accordance with the approval, protected auth editing stopped. No auth file has been changed.

The owner's same message separately authorises the already-scoped local non-auth repairs, isolated retest and staging redeployment/acceptance; production remains forbidden.
