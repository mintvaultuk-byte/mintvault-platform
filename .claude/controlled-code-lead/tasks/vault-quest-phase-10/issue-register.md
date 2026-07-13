# Issue register — vault-quest-phase-10

Findings from the 6 read-only reviewers, Lead-verified. Proof levels: Designed / Implemented /
Locally-verified / Staging-verified / Activated. A landed substrate is NOT closed until Activated.

| ID            | Summary                                                                                                                                                                                      | Reviewer | Sev  | Lead-verified                                            | Class                      | Status                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- | -------------------------------------------------------- | -------------------------- | ----------------------------------------- |
| P10-R1-F1     | Download depends on process-local temp file → ~50% multi-machine failure (INFRA-01)                                                                                                          | R1       | High | YES (grep FLY_MACHINE_ID empty; download reads local fs) | C                          | accepted — wire DB+R2 (10A.1)             |
| P10-R1-F2     | State-vocab mismatch: `running/done/error` (export-jobs.ts:37) vs 7-state table; client loop only matches done/error → would poll forever on completed/partial/failed; `partial` unreachable | R1       | High | YES (verified consumers admin.ts:1741-42, client:252-53) | C                          | accepted — contract change (route+client) |
| **P10-R1-F5** | **SCHEMA GAP: `vq_export_jobs` has NO `ids` column** — worker can't render on a reclaiming machine; also no `attempt_count` for bounded requeue                                              | R1       | High | **YES (0008 + local DB columns dumped; no ids/attempt)** | **E (additive migration)** | **DECISION → see below**                  |
| P10-R1-F3     | No idempotent create wired (partial-unique index unused) → double-click = duplicate renders                                                                                                  | R1       | Med  | YES                                                      | C                          | accepted (10A.1)                          |
| P10-R1-F4     | MAX_ACTIVE/TTL/timeout all process-local; no lease/reclaim → stuck `processing` on machine recycle                                                                                           | R1       | Med  | YES                                                      | C                          | accepted (10A.1)                          |
| P10-R1-F6     | Runner folds render exceptions into `skipped` → `failed_count` never populated (column exists, unused)                                                                                       | R1       | Med  | YES (local DB has failed_count col)                      | A/C                        | accepted (10A.1)                          |

## LOAD-BEARING DECISION D3 (owner) — additive migration for durable exports

Wiring durable exports properly requires an **additive** migration `migrations-vq/0012_export_jobs_ids_attempt.sql`:
`ALTER TABLE vq_export_jobs ADD COLUMN IF NOT EXISTS ids jsonb; ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;`

- Purely additive, idempotent, vq\_-only. Applyable to the **LOCAL throwaway DB** now (for integration tests) — that is authorised (local only).
- Applying to **staging/prod is owner-gated** (protected action). It must be applied to staging (already has 0008) and prod (does NOT yet have vq_export_jobs at all — 0008 itself is unapplied on prod) before durable exports activate there.
- **Recommendation:** author 0012, apply to local DB, wire + locally verify, and defer staging/prod application to 10B/10C with the other migrations. This keeps 10A local-only.

## Rejected / clean (R1)

- Pure core `export-job-state.ts`, schema 0008 (minus the ids/attempt gap), `vq-keys.ts` (`vq/exports/` allowed), `r2.ts` helpers, graceful-shutdown framework, `safe()`/42P01 degrade precedent, owner identity (`session.adminEmail`) — all sound; wiring consumes them.

## R2 — generation idempotency & spend (verified)

| P10-R2-F1 | 4 paid routes, none idempotency-guarded (charge @ higgsfield.ts:316) | R2 | Crit | YES | C |
| P10-R2-F2 | client mints NO idempotency key; refs don't survive reload/tab/machine | R2 | High | YES | C |
| P10-R2-F3 | providerJobId not surfaced until full completion → can't persist "immediately after create" | R2 | Crit | YES (higgsfield.ts:328 vs 369) | **F/D refactor** |
| P10-R2-F4 | NO spend-config surface exists (no vq_config/env for ceilings) | R2 | Crit | YES (grep empty) | **E/D new store** |
| P10-R2-F5 | VQ kill-switch (vqFeatureState) not called by any generation route | R2 | High | YES | C |
| P10-R2-F6 | no atomic claim primitive; scan-ingest TOCTOU pattern to avoid | R2 | High | YES | C |

## R5 — artwork revisions & B2 (verified)

| P10-R5-F1 | card-art readers re-derive vqArtKey, ignore stored pointer → versioned keys break card reads (chars OK) | R5 | High | YES (render-saved.ts:65; admin.ts:1518) | C code-fix |
| P10-R5-F2 | approve sites overwrite-in-place; need upload→verify→insert→swap with per-step compensation | R5 | High | YES | C |
| P10-R5-F3 | no prod backfill; legacy flat-key art has no revision row/hash — reads must stay working | R5 | Med | YES | G (staging backfill plan) |
| P10-R5-F4 | B2 vq worker must be NET-NEW separate file, hard-isolated from cert worker | R5 | High | **DONE (10A-8): `server/vault-quest/lib/vq-b2-backup.ts` + `scripts/vq-backup-artwork-to-b2.ts`, zero shared code with `server/workers/r2-to-b2-archival.ts`, every key asserted via `assertVqBackupKey`; 8 local-DB integration tests incl. an explicit hard-isolation proof (a grading-shaped key is rejected without ever calling B2)** | A code (done) / C run (local-verified) / D confirm (staging — 10B) |
| P10-R5-F5 | VQ writes need UNPOOLED Neon host + search_path=public (deploy-time) | R5 | Med | **written into the runbook (10A-8) — see deployment-state.md "Deploy-time DB requirement"; still unverified against a real deployed 2-machine env (10B gate), so stays "plausible" until then** | C/D |

## Additional LOAD-BEARING DECISIONS (owner)

- **D4 — spend-config surface** (R2-F4): the ceilings need a home. Recommend a small additive
  `vq_config` table (key/value) OR env vars, seeded with conservative staging defaults, values
  owner-set for prod. Author + apply to LOCAL DB only this phase.
- **D5 — provider-signature refactor** (R2-F3): split `generateHiggsfieldArtwork` so the caller
  gets `jobId` right after `create` (persist `provider_submitted` before poll/download). Touches
  higgsfield.ts + all 4 callers. Locally mockable; real sandbox = 10B.

## R3 — Higgsfield status (verified)

| P10-R3-F1 | "connected" from env-presence → expired oat\_ token shows green everywhere | R3 | High | YES (higgsfield.ts:55) | B |
| P10-R3-F2 | throw sites emit untyped Error; routes regex the message (429/5xx unclassifiable) | R3 | High | YES (admin.ts:414) | B |
| P10-R3-F3 | lastOutcome recorder missing + is per-machine (multi-machine caveat) | R3 | Med | YES | B / D(caveat) |
| P10-R3-F4 | HiggsfieldStatus enum has 5 states; scope needs 7 (rate_limited + disabled_by_owner) | R3 | Med | YES (provider-status.ts:48-53) | **A enum + B compose** |
| P10-R3-F5 | no zero-cost admin provider-status endpoint (must NOT paid-create to test) | R3 | Med | YES | B |
| P10-R3-F6 | kill-switch/feature guard unwired on generation routes | R3 | Med | YES | B (dup of R2-F5/R4-F1) |

## R4 — feature controls & observability (verified)

| P10-R4-F1 | feature-control layer fully unmounted; every paid/export/write route ungated | R4 | High | YES (grep) | C |
| P10-R4-F2 | getVqDbFlags() reader doesn't exist; must 42P01-soft-default to {} (default-on) | R4 | High | YES | C |
| P10-R4-F4 | audit-on-toggle has no route; re-enable route must NOT be behind requireVqFeature | R4 | Med | YES | C |
| P10-R4-F7 | ops /status endpoint doesn't exist; field list split now-available vs table-dependent; bounded aggregates only | R4 | High | YES | mixed A/C |
| P10-R4-F8 | in-memory export/provider counts are per-machine → must label "this machine only" | R4 | Med | YES | C |
| R4 clean | requireVqFeature guard rejects BEFORE any spend/write (middleware before handler); grading unaffected by construction; production routes share a mountable prefix | R4 | — | YES | — |

## Consolidated LOAD-BEARING DECISIONS surfaced by the gate (owner)

- **D3** vq_export_jobs +`ids`+`attempt_count` (additive 0012) · **D4** spend-config surface (new store) ·
  **D5** provider jobId-refactor · **D6 (R3-F4)** extend HiggsfieldStatus to 7 states + compose feature-flag ·
  **D7 (R5-F1)** convert card-art readers to dereference the pointer (code fix, no schema).
  All are locally implementable/testable (local PG + mocks); staging/prod migration application stays owner-gated.

## R6 — reconciliation / migration / rollout (verified)

| P10-R6-F1 | reconciler guards DB host but NOT R2 bucket identity → could list prod R2 on a "staging" run | R6 | High | YES (script:43-55) | C (add R2-identity guard) |
| P10-R6-F2 | grading drizzle.config.ts has NO tablesFilter → `npm run db:push` would DROP all vq* tables (0008-0011 enlarge blast radius) | R6 | High | YES (drizzle.config vs drizzle-vq.config) | \*\*C — add tablesFilter excluding vq*\* (protected config)\*\* |
| P10-R6-F3 | `backup-failure` reconcile category unrepresented (not even a deferred note) | R6 | Low | YES | C |
| R6 clean | migrations additive/FK-free/order-independent/idempotent; safe()/42P01 = the wiring degrade model; rollback order (flags off→revert→DROP) supported; drizzle-vq.config quarantines vq\_ | R6 | — | YES | — |

## INVESTIGATION COMPLETE (Stage 2). Consolidated decisions before wiring: D3 (0012 ids/attempt), D4 (spend-config store), D5 (provider jobId refactor), D6 (7-state enum + compose), D7 (card-reader deref fix), R6-F1 (R2-identity guard), R6-F2 (grading drizzle tablesFilter). All locally implementable/testable; staging/prod migration application owner-gated.

## Next: change manifest + implementation budget → implement 10A.1…10A.8 subsystem-by-subsystem, one commit each, local-DB integration tests guarded to TEST_DATABASE_URL only.
