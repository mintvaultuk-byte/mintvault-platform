# Master Task Ledger — Partner Network Programme

Running state for the whole programme. Update at every phase Stage 0 and Stage 7. This is the
source of truth a resuming agent reads first (with the master plan + ADRs).

## Programme identity
- **Programme:** MintVault Approved Grading Partner Network.
- **Governance:** controlled-code-lead v1.1. **Base commit:** `b5fe522c`.
- **Docs home:** `.claude/controlled-code-lead/tasks/partner-network/`.

## Current state (2026-07-17)
- **Phase 0 (read-only audit):** COMPLETE. Report on branch
  `chore/partner-network-phase-0-governance` (remote `ac23f08b`).
- **Phase 0.5 (migration safety):** COMPLETE + independently verified. Branch
  `chore/partner-network-phase-0.5-db-migration-safety`, remote HEAD `3e2dda03`.
  Recommendation: READY WITH SPECIFIC CONDITIONS. NOT merged, NOT deployed. Awaiting owner
  sign-off. Proof level: Local Proof (disposable-DB validated); no real-DB run.
- **Master plan:** DRAFTED (this doc set). Awaiting owner approval.
- **Phase 1+:** NOT STARTED (blocked on master-plan approval + Phase 0.5 sign-off).

## Weighted completion ≈ 12–15%
Architecture (design) ~35% · Code ~4% · Tests ~4% · Infrastructure 0% · Pilot 0% · Rollout 0%.

## Phase status table
| Phase | Programme | Status | Branch | Proof level |
|---|---|---|---|---|
| 0 audit | A | COMPLETE | phase-0-governance @ ac23f08b | Design/evidence |
| 0.5 migration safety | A | COMPLETE (unmerged) | phase-0.5 @ 3e2dda03 | Local Proof |
| 1 foundation | A | NOT STARTED | — | — |
| 2 onboarding | A | NOT STARTED | — | — |
| 3 training | A | NOT STARTED | — | — |
| 4 devices | A | NOT STARTED | — | — |
| 5 credits/Stripe | B | NOT STARTED | — | — |
| 6 intake | B | NOT STARTED | — | — |
| 7 capture/MVGS | B | NOT STARTED | — | — |
| 8 Supreme Grader | C | NOT STARTED | — | — |
| 9 QA/risk | C | NOT STARTED | — | — |
| 10 Field Officer | C | NOT STARTED | — | — |
| 11 label/cert/NFC/seal | C | NOT STARTED | — | — |
| 12 stock | D | NOT STARTED | — | — |
| 13 strikes/incidents | D | NOT STARTED | — | — |
| 14 collection/public cert | D | NOT STARTED | — | — |
| 15 super-admin control | D | NOT STARTED | — | — |
| 16 field routes | D | NOT STARTED | — | — |
| 17 reporting/reconciliation | D | NOT STARTED | — | — |
| 18 support/diagnostics | D | NOT STARTED | — | — |
| 19 backup/disaster | E | NOT STARTED | — | — |
| 20 security validation | E | NOT STARTED | — | — |
| 21 pilot | E | NOT STARTED | — | — |
| 22 expansion review | E | NOT STARTED | — | — |

## Open blockers (see master plan §12)
1. VAT/accounting confirmation (owner's accountant) — blocks production launch.
2. Partner Fly app + R2 buckets + restricted DB role + secrets — blocks deploy.
3. Stripe live products — blocks Phase 5 go-live.
4. Field hardware + welder provisioning — owner-supplied.
5. Phase 0.5 owner sign-off — blocks Phase 1 start.

## Protected actions (never without explicit owner approval)
Merge to main · any deploy · prod/staging DB change · prod migration · prod infra create · Stripe
live product create/change · live secret change · enabling a live partner · external comms · any
destructive action · any change to existing protected MintVault behaviour (grading, Stripe
webhook, auth, cert_counter, R2 signing).

## Next authorised action
Await master-plan approval. On approval: begin Phase 1 local development per the automated
execution rules (isolated branch, disposable DB, tests, local commit, independent verification),
stopping at the first merge/infra/migration/deploy boundary.
