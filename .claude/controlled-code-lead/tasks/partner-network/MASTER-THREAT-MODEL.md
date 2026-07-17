# Master Threat Model — Partner Network

Scope: the new partner system and its seams with existing MintVault. Assets, adversaries,
threats, and the control that mitigates each. Every threat maps to a Phase-20 attack test.

## Assets
- Existing MintVault customer data, direct submissions, certificates, payments.
- Other partners' cards/customers/credits.
- The credit ledger and Stripe money flow.
- Certificate identity + NFC identity.
- Grading integrity (the final grade).
- Physical cards in custody (substitution risk).
- Partner evidence images (PII + card value signals).

## Adversaries
- A malicious or compromised partner user (owner/manager/technician/reception/finance/trainee).
- A malicious partner device or a cloned device.
- An external attacker with a leaked partner session/cookie/signed-URL.
- A dishonest field officer.
- A partner attempting financial gain (free credits, over-redemption, chargeback abuse).
- A card-swapper between scan and seal.

## Threats → controls (T# maps to Phase-20 tests)

| T# | Threat | Primary control | Phase |
|---|---|---|---|
| T1 | Partner A reads/writes Partner B data by changing an ID/URL/payload | RLS on restricted role + fail-closed tenant middleware; server-derived tenant/location; ADR-002/004/012 | 1 |
| T2 | Partner reaches existing MintVault data via a shared route | Dedicated app, separate auth, no admin proxy, partner role has no grant on existing tables | 1 |
| T3 | Location escape (valid partner user, wrong location) | `location_id` in RLS predicate + explicit assignment check | 1 |
| T4 | Partner creates/edits/increases credits | Append-only ledger; credits only via verified Stripe→server; no partner write path; ADR-008 | 5 |
| T5 | Duplicate Stripe webhook double-issues credits | Event-id dedup table + atomic single-winner issuance (Phase 0.5 patterns) | 5 |
| T6 | Two concurrent reservations consume one credit | Atomic reserve with row lock + partial unique index | 5 |
| T7 | Refund/chargeback leaves usable credit | Ledger reversal/freeze on refund + chargeback; reconciliation alert | 5,17 |
| T8 | Capture on an unapproved/cloned Mac | Device key (Keychain/SE) + signed request + nonce/replay + version check; ADR-009 | 4 |
| T9 | Replayed signed capture/seal request | Server nonce + replay window; single-use | 4 |
| T10 | Workflow skip (publish before approvals) | Server state machine; publish gate requires both approvals + label/NFC/seal/photos; ADR-006 | 11 |
| T11 | Certificate duplication / partner-chosen number | Central atomic allocation only after gates; ADR-005 | 11 |
| T12 | NFC reuse/duplication | Unique nfc_uid constraint + read-back verification; ADR-005/009 | 11 |
| T13 | Label reprint abuse | Reprint requires reason + audit + authorisation; void prior | 11 |
| T14 | Card substitution between scan and seal | Tamper-evident numbered packaging + fingerprint compare + field verification; ADR-014 | 10 |
| T15 | Grade manipulation by shop or field officer | Shop never grades; field outcomes are a closed set; grade changes versioned; ADR-007/013 | 8,10 |
| T16 | Signed-URL leak/reuse across tenant | Short TTL + single-use where feasible + ownership check before signing + key traversal guard; ADR-003 | 20 |
| T17 | Secrets in browser/app | Server-side secrets only; short-lived tokens; no permanent R2 creds client-side | 4,7 |
| T18 | Suspended user/device still acts | Server re-checks status on every sensitive action; kill switch; session revoke | 4,15 |
| T19 | Expired insurance/accreditation bypass | Server gate blocks the relevant capability on expiry; ADR onboarding | 2,3 |
| T20 | File-upload attack (malicious/oversized) | Type + size + magic-byte validation at runtime (note esbuild treeshake caveat — verify at runtime), server-generated names, private storage | 7,20 |
| T21 | Rate-limit bypass (multi-machine) | Durable/shared rate-limit store for security-sensitive partner limiters | 1,20 |
| T22 | Emergency-stop ineffective | Server-enforced freeze on partner/location/user/device/credits; proven in test | 15,20 |
| T23 | Field officer privilege escalation | Minimal field role; sees only assigned visits; MFA + registered device | 10,20 |
| T24 | Cross-tenant migration/schema drift | Phase 0.5 preflight fail-closed + numbered migrations + RLS on new tables | 0.5,1 |

## Trust boundaries
- Browser/partner app ↔ partner API: everything from the client is untrusted (tenant/location/
  user/device IDs re-derived server-side).
- Partner runtime ↔ DB: enforced by the restricted role + RLS (defence in depth beneath the app).
- Partner app ↔ shared narrow services: functions with explicit, minimal inputs — no route proxy.
- Field mobile ↔ partner API: MFA + registered device + signed requests.

## Residual risks (accepted / to revisit)
- Same Neon project for pilot (mitigated by RLS + restricted role; revisit at Phase 22).
- Shared Fly platform CPU (partner app is separate app but same org/region; monitor).
- Regex-heuristic destructive-SQL linter (documented; not a parser).
- Physical controls (welder, custody) depend on operational discipline + evidence, not code alone.
