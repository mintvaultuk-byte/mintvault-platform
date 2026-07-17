# Master Pilot Plan — Partner Network (Phase 21)

The pilot proves the whole chain end-to-end at the smallest safe scale before any expansion.
It does not begin until Programmes A–D are locally complete + independently verified, Phase 19
(backup/disaster) and Phase 20 (security validation) pass, and the owner has approved going live.

## Pilot configuration (hard limits)
- 1 approved partner · 1 shop location.
- 1 approved MacBook · 1 approved scanner · 1 printer · 1 NFC writer · 1 registered ultrasonic
  welder.
- Limited assessment technicians · limited field authentication officers.
- Max **20 active credits** initially · max **20 cards/day**.
- £15 wholesale credit · £20 retail service (locked).
- **100% Supreme Grader review · 100% Field Authentication Officer approval.**
- No auto-approval · no Stripe Connect · no automatic top-up · no high-value cards above the
  configured pilot limit.
- Daily reconciliation · weekly quality review · weekly security review.

## Go-live prerequisites (owner-gated, protected actions)
1. Phase 0.5 signed off; partner phases merged in the owner's chosen order.
2. Dedicated partner Fly app + hostname provisioned.
3. Dedicated private partner R2 buckets (prod + staging) provisioned.
4. Restricted partner DB role created; RLS policies applied via numbered migration (verified on
   staging first).
5. Stripe **test-mode** credit products validated; live products created only at go-live with
   owner approval.
6. VAT/accounting treatment confirmed by the owner's accountant.
7. Partner agreements/insurance/documents APPROVED for the pilot partner.
8. Devices enrolled + approved; welder registered + serviced.
9. Backup + restore test actually performed (not just claimed).

## Daily pilot operations
- Every card: shop capture → Supreme Grader (100%) → Field Officer (100%) → seal → publish →
  collection. One £15 credit reserved at submission, consumed at completion.
- Daily reconciliation must be clean: credits vs completed cards vs labels/NFC/slabs/seals; any
  mismatch is an alert investigated same day.

## Weekly reviews
- **Quality:** technician accuracy vs Supreme Grader, rescan rate, defect discrepancies, shop
  health score.
- **Security:** audit-log review, any device/session anomalies, emergency-control drill.

## Pilot exit criteria → Phase 22 expansion (all must hold)
No tenant/location data leakage · no credit duplication · no payment mismatch · no certificate
duplication · no NFC duplication · correct chain of custody · acceptable scan quality · acceptable
technician accuracy · reliable HQ review · reliable field authentication · reliable ultrasonic
sealing · reliable customer collection · reliable backups · reliable emergency controls.

## Kill criteria (pause the pilot immediately)
Any tenant escape, credit-integrity failure, certificate/NFC duplication, card-substitution
evidence, or unrecoverable data-loss event → freeze via super-admin emergency controls, preserve
evidence, run incident procedure, do not resume until root cause fixed and re-verified.

## Addendum — new subsystems in the pilot
- Every pilot card must pass all Digital Chain of Custody checkpoints (ADR-015); a missing/out-of-
  order checkpoint blocks completion.
- "MintVault Verified" appears on the public cert only at the full dual-verification gate (ADR-016).
- Pilot partner starts at PROVISIONAL_PARTNER (ADR-017); 100% Supreme Grader + Field approval apply
  regardless of level.
- The single registered welder must be ACTIVE + in service/calibration (ADR-018) for any seal.
