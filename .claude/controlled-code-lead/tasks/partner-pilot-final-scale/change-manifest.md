# Change manifest — Partner Pilot final-scale completion

**Date:** 2026-08-12
**Candidate:** `codex/partner-pilot-pass2` at `f3e90e63`

## Authority and boundary

The owner brief authorises this final workflow build. This manifest permits local source and test changes only. It does not apply DDL, mutate credentials or a Partner account, change a feature flag, perform an R2/Stripe production operation, push, deploy, or run a physical capture/print.

## Findings addressed

- F1 — Scanner-native credit reservation and card start (B/C).
- F2 — evidence-derived Ready-to-Grade queue (B).
- F3 — signed Scanner version recovery (B).
- F4 — bounded streamed finalisation design and testable admission boundary (C/F).
- F5 — reproducible non-production scale harness (C/D).

## Files to change

| File set                                                                                                                  | Change                                                                                                                                                                                                                                            | Why   | Class |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- |
| `server/partner/station-routes.ts`, new `server/partner/scanner-card-service.ts`, existing submission/connector contracts | Add an idempotent, signed-station + MFA-operator start-card endpoint. It uses the existing per-card reservation and connector/allocator path, returns server-derived status only, and never accepts a tenant, credit or MV identity from Scanner. | F1    | B/C   |
| `scripts/scanner-app/{lib/station-client.js,main.js,preload.js,renderer/index.html,renderer/app.js}`                      | Show server credit facts and Start New Card; then use only the returned/polled server target.                                                                                                                                                     | F1    | B     |
| `server/partner/grading-routes.ts`, Partner dashboard/grading presentation and tests                                      | Restrict Ready to Grade to two current terminal station-bound TIFF masters; return only trusted certificate/image facts.                                                                                                                          | F2    | B     |
| `server/partner/station-service.ts`, station route tests                                                                  | Permit a monotonic app-version update only from a body-bound, signed heartbeat before subsequent capture gates.                                                                                                                                   | F3    | B     |
| `server/r2.ts`, scanner finalisation/processing route/service tests                                                       | Replace direct whole-object finalisation retrieval with a bounded retrieval/verification path and explicit cross-replica admission semantics, without weakening TIFF/hash/evidence checks.                                                        | F4    | C/F   |
| `scripts/partner-scale-harness.*`, focused tests/docs                                                                     | Add an opt-in synthetic harness that cannot target production by default and emits measured latency/error/concurrency evidence.                                                                                                                   | F5    | C/D   |
| `tests/partner-*.test.ts`, `tests/scanner-*.test.ts`                                                                      | Add endpoint/state-matrix/adversarial regression proof for each control.                                                                                                                                                                          | F1–F5 | B/C   |

## Explicitly not touched

- `shared/mvgs-scoring.ts`, protected grading maths, grade thresholds and label renderer.
- Stripe/payment code, production R2 objects, database roles/secrets, Fly configuration, migration journal, physical station/printer.
- Existing print eligibility/QA authority, except tests may prove it remains closed.

## Protected actions

- [x] No protected action is executed by this manifest.
- [ ] Owner action later: restricted runtime URL reset, named migration application, deploy, and physical canary — each needs a separate approval record.

## Order

1. Implement and prove F3 signed upgrade recovery.
2. Implement F2 Ready-to-Grade evidence predicate/state matrix.
3. Implement F1 start-card contract and Scanner UI against existing server authority.
4. Implement F4 bounded finalisation and F5 safe harness; stop if a database/R2 test environment is required beyond local source proof.
5. Run full regressions, anti-clobber checks and a changed-file/secret review.

## Regression gates

- [ ] Focused station, credit, capture, queue, QA/print and Scanner tests.
- [ ] `npm run check`, `npm test`, `npm run lint`, `npm run build`, and a clean `npm run dev` boot.
- [ ] `git diff --check`, secret scan and manifest/diff allowlist review.

**Approved to proceed to Stage 5:** owner’s final completion brief for local-source scope — 2026-08-12.
