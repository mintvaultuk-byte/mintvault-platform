# Proof map — vault-quest-phase-10

Proof levels: Designed / Implemented / Locally-verified / Staging-verified / Activated.
Local = pure + mocked + local-Postgres integration. NEVER call local mocks/2-worker sims
"staging proof"; authored/local-applied migrations are NOT production-active.

| Subsystem | Commit | Proof level | Evidence |
|---|---|---|---|
| 10A-0 prerequisites | (this) | **Locally verified** | migrations 0012/0013 applied to LOCAL DB (127.0.0.1:55432) — attempt_count≥0 + ids≤1000 CHECKs fire; vq-config resolveVqCeilings + r2-identity checkR2Identity + 7-state provider-status + tablesFilter → 35 targeted + 437 full tests green; tsc clean; lint 4452 |
| 10A-1 durable exports | 169366a→(this) | **Locally verified** | export-job-store.ts (DB+R2 adapter, safe/42P01 degrade) + export-jobs facade (durable-first, legacy fallback) + routes stream from shared R2. 8 store integration tests vs LOCAL Postgres prove idempotent create / atomic single-winner claim / cross-'machine' visibility / counts-derived partial-vs-failed / cancel; 10 facade tests lock the 3-state client contract + download plan. tsc clean; full 447 + integration 18 green; lint no new issues. **Deferred to 10B (staging):** real multi-machine routing, real R2 upload/stream, streaming-multipart upload (final artifact is buffered once for upload — bounded), active lease-reclaim scheduler (ids/attempt_count columns ready, no cron wired). |
| 10A-2 spend controls | fb89bb7→(this) | **Locally verified** | Owner D8/D9/D10 resolved (my recommendation). generation-guard.ts: pre-provider spend gate (vq_config ceilings + live hourly/daily windows from vq_generation_requests) + best-effort window recording; wired into all 4 paid routes (single/batch/family/card) BEFORE any Higgsfield create. Family capped by per-BATCH credits not the 3-image count (D8); per-request default 5→8cr so premium 3× master isn't blocked (D9). 9 integration tests vs LOCAL Postgres (scope mapping, per-request/count caps, live windows bind, config override, degrade, record). tsc clean; full 447/17-skipped; integration 17/17; 0 new lint. **Deferred (D10):** idempotency/double-pay protection (needs client Idempotency-Key minting) — substrate (generation-idempotency.ts) ready; TOCTOU check-then-record acceptable for single-admin, closed by the reserve-before lifecycle later. |
| 10A-3 provider status | 8bdaffd→3224188→(this) | **Locally verified** | recordHiggsfieldOutcome/getLastHiggsfieldOutcome (provider-status.ts, in-memory single-process observation point — correct scope: display honesty, not a spend/cross-machine concern) wired into every real network-outcome branch of generateHiggsfieldArtwork (create 401/402/generic, poll timeout/failure/job-failed, download failure, success). imageProviders() now derives the 7-state status from a REAL observed outcome instead of env-presence; `connected` flips false only on a genuine observed failure (fixes "expired token still shows green"); `configured_unverified` keeps `connected:true` so a fresh restart doesn't flash red before any call. 4 provider-status unit tests + 4 imageProviders derivation tests + 4 fetch-mocked generateHiggsfieldArtwork wiring tests (proves the ACTUAL call sites fire, not just the pure composition). tsc clean; full Vitest 517/517 with local DB (481/517 without, 36 gated); ESLint 4452 == baseline; build clean; governance 4/4; 0 secrets. **Found + fixed the local Postgres throwaway instance had been wiped (system restart cleared /tmp) — recreated (14 migrations reapplied, schema-verified identical) before re-running gates.** **Test-infra finding (not a product defect):** running the full suite WITH DB under vitest's default parallel-file execution intermittently false-fails 1-2 integration files (shared-table race across files that each assume exclusive DB access — a pre-existing convention, exposed now by more DB-touching files). Fix/workaround: run with `--no-file-parallelism` (confirmed 517/517 clean, reproducibly). Flagging as a follow-up, not blocking. **Deferred to 10A-4:** `disabledByOwner` wiring (feature-flags table exists, not yet read by deriveHiggsfieldStatus's opts). |
| 10A-4 feature controls | pending | — | |
| 10A-5 observability | pending | — | |
| 10A-6 revisions | pending | — | (gated: only after 10A-1..5 green) |
| 10A-7 reconciliation | pending | — | |
| 10A-8 B2 framework | pending | — | |

## Verification pass (169366a/fb89bb7/4cd8fb4) + corrective commit
Full report: [verification-10A-0-to-2.md](verification-10A-0-to-2.md). 3 read-only reviewers + Lead.
Grading isolation PROVEN safe (drizzle-kit 0.31.10 source trace). 4 verified defects fixed in ONE
corrective commit (Locally verified — tsc, full Vitest **478**, spy 5/5 zero-create, parallel
concurrency, build, lint parity 4452, 0 secrets):
- R2-F1: `isUndefinedTableOrColumn` degrades on 42703 (partial migration = staging) instead of 500; pg-msg leak scrubbed.
- R1-F2: `effectiveCreditsPerImage` prices non-ref-capable models at the nano_banana upgrade floor (kills the z_image undercount) — gate + record, all 4 routes.
- R1-F1: `providerCalls` threaded from generateCharacterCandidate → record ACTUAL paid creates (incl. master bg-retries).
- R3-F1: vq-schema.ts re-exports all 13 operational+production tables + drizzle-vq header de-advertises push → a stray VQ `push` is non-destructive.
Deferred (documented): R1-F3 charged-but-failed record, R1-F7/D10 idempotency, R1-F4 kill-switch(10A-4), R1-F5 config clamp, R2-F3 reclaim/GC(10A-7/8), ownership filter. See report.

## Staging-only evidence (NOT closeable locally — 10B)
Multi-machine export routing; real Higgsfield sandbox gen; real R2/B2 bucket integration;
prod-unpooled-host write behaviour; migration application on staging/prod.
