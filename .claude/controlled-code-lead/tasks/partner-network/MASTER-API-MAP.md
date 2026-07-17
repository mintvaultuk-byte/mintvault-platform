# Master API Map — Partner Network

All partner endpoints live in the **dedicated partner app** under `/api/partner/*`, behind
`requirePartnerAuth` + `requirePartnerCapability(...)` + device/status gates. Super-admin partner
management lives in the existing app under `/api/super-admin/grading-partners/*` behind the
existing admin auth (MintVault-internal only). **No partner route ever uses `requireAdmin` or a
numeric-ID admin route** (ADR-004). Tenant/location/device are always derived server-side.

## Partner-facing (dedicated app, cookie `mv.partner.sid`)
```
POST /api/partner/auth/login            (+ MFA step)
POST /api/partner/auth/logout
GET  /api/partner/session
GET  /api/partner/dashboard
# orders / customers
POST /api/partner/customers
GET  /api/partner/customers
POST /api/partner/orders
GET  /api/partner/orders            (tenant+location scoped)
GET  /api/partner/orders/:id        (ownership re-checked, not trusted from URL)
# credits (read-only to partner)
GET  /api/partner/credits/balance
GET  /api/partner/credits/ledger
# cards / capture (device-gated)
POST /api/partner/cards/:id/arrival-photos
POST /api/partner/cards/:id/scan            (approved device+scanner required)
POST /api/partner/cards/:id/identify
POST /api/partner/cards/:id/mvgs-evidence
POST /api/partner/cards/:id/submit          (-> "awaiting MintVault review"; no final grade)
GET  /api/partner/cards                      (queue, scoped)
# custody (handover = a HANDOVER checkpoint via the checkpoint route below) / stock / docs / training / support
GET  /api/partner/stock ; POST /api/partner/stock/report-damage
POST /api/partner/documents ; GET /api/partner/documents
GET  /api/partner/training ; POST /api/partner/training/:id/complete
POST /api/partner/support ; GET /api/partner/support
# asset access
GET  /api/partner/assets/:key/signed-url     (server checks ownership, mints short-lived URL)
```

## Field Authentication Officer (mobile, `requireFieldOfficer` — dedicated MintVault-internal auth, ADR-020; MFA + registered `mobile` device; NOT `mv.partner.sid`, NOT `requireAdmin`)
```
GET  /api/partner/field/visits              (only assigned visits)
POST /api/partner/field/visits/:id/scan-qr
POST /api/partner/field/visits/:id/verify-custody
POST /api/partner/field/visits/:id/authenticate   (outcome ∈ closed set, ADR-013)
POST /api/partner/field/visits/:id/confirm-label-nfc
POST /api/partner/field/visits/:id/seal            (registered welder required)
POST /api/partner/field/visits/:id/nfc-readback
POST /api/partner/field/visits/:id/final-photos
POST /api/partner/field/visits/:id/approve
```

## Super Admin partner management (existing app, admin auth only)
```
GET  /api/super-admin/grading-partners
GET  /api/super-admin/grading-partners/:partnerId
.../locations .../users .../devices .../credits .../documents .../quality
.../strikes .../stock .../incidents .../finance
# Supreme Grader queue (MintVault-internal grading)
GET  /api/super-admin/grading-queue
POST /api/super-admin/grading/:cardId/approve|reject|request-rescan|set-grade
# emergency controls
POST /api/super-admin/grading-partners/:id/freeze|unfreeze  (partner/location/user/device/credits)
POST /api/super-admin/emergency/disaster-mode
# credit admin (owner/super-admin only)
POST /api/super-admin/credits/adjust        (reason + re-auth + audit)
```

## Shared narrow services (functions, not routes)
`mvgsScore(...)`, `isPristine(...)`, `allocateCertificateNumber(...)`, `renderLabel(...)`,
`verifyNfc(...)`, `publishCertificate(...)`. Called by partner/super-admin controllers with
explicit inputs; never reached by proxying `/api/admin/*`.

## Cross-cutting rules
- Every partner route: tenant/location derived from session; ownership re-verified on `:id`.
- Sensitive capture/seal routes: require signed device request + nonce + active device/user +
  current app version + required permission + valid workflow state.
- Separate rate limiters (durable store) per partner route group.
- Webhook: partner Stripe webhook is signature-verified + event-id deduped (Phase 5), mounted
  before body JSON parsing, in the partner app.

## Addendum — new subsystem routes
```
# custody checkpoints (ADR-015) — device-gated, append-only
POST /api/partner/cards/:id/custody/checkpoint      (type in closed set; server enforces order)
GET  /api/partner/cards/:id/custody                  (scoped)
# MintVault Verified (ADR-016) — read-only public projection lives on existing public cert page
GET  /api/cert/:id                                    (existing; shows "MintVault Verified" only at gate)
# accreditation levels (ADR-017) — super-admin controlled
GET  /api/super-admin/grading-partners/:id/accreditation
POST /api/super-admin/grading-partners/:id/accreditation/upgrade   (approval required; explainable)
POST /api/super-admin/grading-partners/:id/accreditation/downgrade (reason + audit)
# welder governance (ADR-018) — MintVault-internal `field_welders` registry (not tenant-scoped)
GET  /api/super-admin/field-welders ; POST /api/super-admin/field-welders/:id/status
GET  /api/partner/field/welders/:id                   (officer, requireFieldOfficer: assigned welder validity)
```
Partner users have READ-only visibility of their own accreditation level and its parameters; they
can never self-upgrade (ADR-017). Checkpoint POSTs require an approved device + valid workflow state.
