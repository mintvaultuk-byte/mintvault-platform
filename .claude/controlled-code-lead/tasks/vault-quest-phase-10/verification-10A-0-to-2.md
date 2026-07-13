# Phase 10A verification — commits 169366a / fb89bb7 / 4cd8fb4

Read-only Stage-2 review (3 non-overlapping reviewers) + Lead verification. 2026-07-11.
All tests vs isolated local Postgres (127.0.0.1:55432); no push/deploy/staging/prod/provider.

## Lead-run gates (all green)
- tsc clean; ESLint 4452 problems (1633 err / 2819 warn) == documented baseline (0 net new).
- Full Vitest **471 passed** WITH local DB (464 base + 5 provider-create spy + 2 parallel concurrency).
- Build clean (dist/index.cjs 2.95MB + dist/public/index.html fresh). Secret scan 0 hits across 6439350..4cd8fb4.
- Provider-create SPY (new): all 4 paid routes blocked (429, reason=per_request_ceiling) → **0 provider creates**. Airtight (reason-asserted, not vacuous).
- Parallel concurrency (new): 8 concurrent createOrGet → exactly 1 winner; 8 concurrent claims → 1 processing + 7 conflict.
- Migrations 0012/0013 re-apply idempotently; attempt_count≥0 and ids≤1000 CHECKs fire.
- Paid-route coverage (traced FE→create): single(gate625<635/649), batch(692<698), family(851<860), card(1190<1209). Only paid-create fns are generateHiggsfieldArtwork(384 inside helper, 1209) + generateCharacterCandidate(→384). No indirect path (workflow-engine = estimation only; generate.ts = text).

## VERIFIED DEFECTS → corrective commit required

| ID | Sev | Verified | Summary | Fix |
|---|---|---|---|---|
| **R2-F1** | HIGH | ✅ code-read | Partial migration (0008 table present, 0012 cols absent = STAGING today) throws 42703; `isUndefinedTable` only catches 42P01 → guard rethrows → export routes 500 + leak pg message instead of legacy fallback | Add 42703 to the degrade predicate (export-job-store + generation-guard); scrub pg msg from startBatch 500 |
| **R1-F2** | HIGH | ✅ code-read (higgsfield.ts:298-299) | z_image→nano_banana auto-upgrade when references attached: gate/record price the REQUESTED model (z_image 0.15) not the effective (nano_banana 1) → up to 6.67× undercount on the identity-lock path | effectiveCreditsPerImage(model): non-ref-capable → nano_banana floor; use in gate + record on all 4 routes |
| **R1-F1** | HIGH | ✅ code-read (routes:378) | Master bg-retry `maxAttempts=2`: each candidate can bill 2 paid creates → single route up to 6 creates vs gate estimate 3; window records candidate outcomes not actual creates | Thread providerCalls from generateCharacterCandidate; record actual creates. (Per-request cap can't block premium master without breaking D9 → daily WINDOW is the mitigation) |

## KNOWN / DEFERRED (documented, not fixed now)
- **R1-F3** (MED): charged-but-failed create (poll/download throw after create, chargePresumed) escapes the record → window under-counts. Proper fix = reserve-before-create (D10).
- **R1-F7 / D10** (MED, owner-deferred): these are CEILINGS not idempotency — duplicate/retried/2-tab/2-machine requests double-charge. Substrate ready; not wired. Largest residual real-money exposure.
- **R1-F4** (LOW): `disabled` kill-switch is dead code (never set). Emergency freeze today = set a vq_config ceiling to 0 (works, fail-closed). Real kill-switch = 10A-4.
- **R1-F5** (LOW): config values have a floor (num() fails closed) but no upper clamp — owner-gated typo could loosen caps. Add clamp.
- **R1-F6** (LOW): check-then-record TOCTOU window is the full generation latency (wide). Closed by D10 reserve-before-create.
- **R2-F2** (LOW/info): no per-job ownership filter on poll/download (single-admin, unguessable uuid jobId → negligible; matters only multi-admin).
- **R2-F3** (LOW, expected): lease/attempt/reclaim + expiry/GC latent — no reclaimer, no R2 export GC. A machine dying mid-render leaves the job `processing` forever; R2 exports never swept. = 10A-7/10A-8 + needs 2-machine staging.
- **R2-F4** (LOW): concurrency-limit retires a fresh job (queued→cancelled) rather than leaving it for another machine → durable design gives cross-machine VISIBILITY, not distributed EXECUTION. Document.

## Requires real 2-machine staging proof (cannot close locally)
INFRA-01 end-to-end (POST-A / poll+download-B via LB + shared R2); R2-F1 vs the actual target DB state before deploy; abandoned-processing behaviour; genuine simultaneous-POST 23505 loser re-read.

## Default-safety (owner Q7)
8-cr/request and ~12-cr/batch are structurally sound (allow premium 3× master = 6cr; cap runaway), BUT until R1-F1/F2 land the ENFORCED numbers understate real spend, so the effective cap is looser than 8/12 on the z_image-upgrade and master-retry paths. After the corrective commit the ceilings match real pricing.
