# Rollout — Scanner SOL campaign

**Classification:** B/C/D/E/F/G; rollout is not authorised by the implementation prompt.

## Ordered gates

1. Complete WP1-WP10 locally in the isolated branch with all resolvable BLOCKER/HIGH issues VERIFIED.
2. Reconcile against frozen final Partner P14 and current main; rerun both non-vacuous suites.
3. Produce unsigned/ad-hoc local arm64 package proof and credential-independent validation.
4. Owner supplies/authorises Apple Developer ID/notarisation credentials; produce signed/notarised/stapled RC.
5. Request staging authorisation and run WP11 rehearsal only when granted.
6. WP12 release gate produces one exact candidate SHA and requests production authorisation.
7. WP13 Pilot Shop 0 and legacy cutover only after explicit production approval.
8. WP14 Partner #1 only after Pilot certification.

## Affected parties

- Pilot shop operators and Super Admin during enrolment/replacement/cutover.
- Partner server/DB/R2 only after separately authorised migration and staging/production rollout.

## Rollout stop conditions

- Helper signature/team mismatch, identity/queue recovery failure, dual-active replacement, credit/job duplication, evidence substitution, downgrade acceptance, unresolved actionable BLOCKER/HIGH, or P14 drift.
