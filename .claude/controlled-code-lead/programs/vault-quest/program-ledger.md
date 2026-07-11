# Program ledger — vault-quest (VQ) hardening program

A PROGRAM spans multiple phases, each with its own task cycle. Program-scoped IDs
(`VQ-P<phase>-F<n>`) never collide across phases; deferred/rejected items carry
forward (see `deferred-carry-forward.md`); rollback covers the whole commit chain.
Indexed from real evidence (commit messages + memory); nothing invented.

## Phase index + commit chain (on `main`, unless noted; NOTHING pushed/deployed)
| Phase | Commit | Scope | Proof level |
|---|---|---|---|
| 1 | `1a2aeac` | frontend review — 23 client bugs | Locally verified |
| 2 | `0fcaaf8` | backend review — 13 route/storage fixes | Locally verified |
| 3 | `bc6fd3d` | DB integrity guards (app-only) | Locally verified |
| 4 | `7ffa25a` | artwork-gen data-loss/financial-honesty | Locally verified |
| 5 | `6229840` | R2 keyspace + upload hardening | Locally verified |
| 6 | `d286dfd` | prod-readiness count(*) fix | Locally verified |
| 7A | `76bf2f2` | durable export jobs (pure core + 0008) | Implemented (migration unapplied) |
| 7B | `d343bdc` | generation idempotency (pure core + 0009) | Implemented (unapplied) |
| 7C | `1351d5a` | Higgsfield status + rotation runbook | Implemented |
| 7D | `145db20` | artwork revisions/backup (pure core + 0010) | Implemented (unapplied) |
| 7E | `6439350` | reconciler + feature flags (pure core + 0011) | Implemented |
| 8A | `32f3f2b` (branch `vq-phase8-staging-integration`) | migrations 0008–0011 APPLIED to STAGING; verified 14/14 | Staging verified (DB only) |

## Program status
- Substrate implemented + (8A) applied to STAGING. Live-route wiring + multi-machine
  acceptance NOT done — need a deployed 2-machine staging env. Prod: unchanged.
- Migrations 0008–0011: applied to STAGING only; NOT prod. drizzle-vq.config only.

## Program rollback
- Per-commit revert (never rewrite pushed history — nothing is pushed).
- Staging DB rollback: `DROP TABLE IF EXISTS vq_export_jobs | vq_generation_requests |
  vq_artwork_revisions | vq_feature_flags;` (FK-free; app degrades if absent).
- See each phase's own rollback + `docs/phase8/8A-migration-evidence.md`.

## Not-closed (a substrate/design landing ≠ closed)
Every 7A–7E item is Implemented, NOT Activated. Do not mark closed until wired +
staging-verified + (owner-gated) prod-applied. See `deferred-carry-forward.md`.
