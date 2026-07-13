# Memory — external providers

- **Higgsfield** (VQ artwork): `HIGGSFIELD_API_KEY` is a SHORT-LIVED `oat_` OAuth access
  token minted by hand via `higgsfield auth token` CLI. No server refresh possible →
  recurring expiry is architectural. Runbook: `docs/runbooks/vq-higgsfield-rotation.md`.
  Charges at `create`, NOT at `GET /jobs/{id}` poll → recovery-by-jobId is no-charge (needs
  1 sandbox confirm). Official Cloud API long-lived Key EXISTS but = a rewrite (F/D).
- **Stripe**: LIVE keys in Fly secrets. Local `.env` uses LIVE Stripe (DB is staging) →
  any local payment/coupon code hits PROD Stripe. Grading checkout = PaymentIntent (not
  Checkout Session) → promos reduce the charge, coupons latent. (src: [[project_local_env_live_stripe]])
- **Resend**: transactional email. Key in Fly secrets.
- **R2 (Cloudflare)**: shared bucket for grading + VQ (isolation = `vq/` prefix only).
  ⚠️ Local toolchain's R2 staging-vs-prod identity UNCONFIRMED — resolve before any R2 op.
- **B2 (Backblaze)**: cold archive, 90-day COMPLIANCE Object Lock, grading cert prefixes
  only (NOT vq/ yet).
- **Neon**: see `databases.md`. **Anthropic API**: VQ text AI (key = Fly secret).
