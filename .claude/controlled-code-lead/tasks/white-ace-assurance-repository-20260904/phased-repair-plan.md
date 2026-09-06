# Phased multi-agent repair plan — White Ace repository program

> **Superseded as the repository-wide plan — 2026-09-04:** This remains the nested
> release-integrity subgraph only. It did not re-audit architectural wiring and cannot
> stand as the whole-repository remediation plan. The authoritative parent is
> [`../repository-architecture-recovery-20260904/phased-repair-plan.md`](../repository-architecture-recovery-20260904/phased-repair-plan.md).

## Outcome and present state

The repair graph is materialized in `repair-graph.json` against baseline
`09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`. Structural validation passes with
34 nodes across 7 phases. Readiness correctly fails: no candidate SHA exists, five
owner decisions are open, protected repairs have not started, and required external
evidence is unavailable.

This plan turns the accepted White Ace release-integrity findings into one nested repair
subgraph. It does not cover the repository's full client/server/data/runtime architecture,
approve protected changes, apply migrations, deploy, or infer external proof.

The graph normalizes repository state vocabulary without changing the canonical issue
register. In particular, `WAA-GATE-001` is `OPEN` in the graph because the register's
`PROVEN` records that the deficiency was proven, while graph `PROVEN` means the repair
has independently closed the finding.

## Orchestration contract

- Codex Lead is the sole shared-workspace writer and the sole owner of the graph,
  canonical issue/proof ledgers, manifests, integration, and completion claims.
- Helper agents are read-only. At most the Lead plus three specialists run at once.
  The release/supply observer rotates in when a specialist finishes.
- No helper spawns children. No reviewer reviews another reviewer.
- Parallelism is for evidence, reproduction, and proof. Product changes are sequential
  in this shared filesystem. If a future runtime supplies isolated worktrees, any
  writer still receives a distinct worktree, exact scope, dependency pin, and Lead-led
  integration.
- A repair author never certifies its own work. Critical source mutations occur only in
  disposable isolated worktrees and must prove byte-identical restoration or disposal.
- Timeout, skipped execution, unavailable environment, or missing evidence is
  `UNKNOWN`, not `PASS`.

## Agent lanes

| Lane | Scope | Write authority | Required return |
|---|---|---:|---|
| Codex Lead | Authority, adjudication, implementation, integration, graph/ledger state | Sole shared writer | Exact diff, targeted proof, rollback, graph transition |
| Credit investigator/verifier | `WAA-CREDIT-001` | Read-only | UTC boundary, reserve/refund, replay, concurrency, mutation evidence |
| Image/storage investigator/verifier | `WAA-IMAGE-001/002/003`, `REL-IMAGE-001` | Read-only | Writer inventory, atomicity/recovery, audit identity, 0122 proof |
| Identity/migration investigator/verifier | `REL-TOKEN-001` and proposed 0123 | Read-only | Six-family reachability, rolling compatibility, digest/expiry/consumption proof |
| Release/supply observer | Secret metadata, `WAA-GATE-001`, `REM-SUPPLY-001`, `REM-GH-001`, `REL-ENV-001` | Read-only | Metadata/gate topology and exact external evidence or `UNKNOWN` |
| Claude Opus High | One independent hostile pass after integration | Read-only | Reproduced BLOCKER/HIGH only, clean lenses, unknowns |

Investigation and verification are separate assignments even when they concern the
same domain. The verifier identity recorded in graph evidence must not be the repair
author.

## Phase 0 — Reconcile authority and recovery baseline

Current state: locally complete, but owner target remains open.

1. Preserve the existing White Ace WIP; do not reset, stash, or absorb it.
2. Confirm whether the target ends at repository-ready, authorised staging acceptance,
   or observed production release. The graph assumes repository-ready plus authorised
   staging evidence, with production separate.
3. Confirm how the existing dirty WIP will be checkpointed or otherwise owned before
   product repair begins.
4. Re-run Engineering OS preflight after any baseline or governance change.

Exit gate: `OWNER-TARGET` is `PROVEN`, the exact baseline/dirty state is durable, and
there is no concurrent-writer ambiguity.

## Phase 1 — Approve narrow repair packets

Read-only agents may re-check drift in parallel; they do not repeat the repository-wide
audit. Codex Lead verifies any changed dependency in source and updates the graph before
writing.

Owner decisions are deliberately separate:

1. `OWNER-SECRET`: approve `chmod 0600` for the eight exact ignored credential files;
   separately decide deletion and provider-side rotation.
2. `OWNER-CREDIT`: approve one UTC-day authority for anonymous reserve, comparison,
   and refund behavior.
3. `OWNER-IMAGE`: approve the 0122 certificate/object/evidence repair package,
   including atomic or forward-recoverable dual-side publication and phone writer
   enrollment.
4. `OWNER-TOKEN`: separately approve authentication behavior changes and authoring the
   additive 0123 migration. Migration application remains unapproved.

Safe independent work may proceed when it does not cross a closed gate. An unapproved
packet remains `OWNER_DECISION`; it is never silently removed from release ancestry.

Exit gate: each executable wave has exact approval, scope, rollback, and proof. All
other waves have one explicit recorded blocker.

## Phase 2 — Sequential repair waves

Codex Lead implements in this dependency order:

1. **Local containment:** `REPAIR-SECRET-PERMS`, after `OWNER-SECRET`. Change file modes
   only; do not display values, delete backups, or rotate providers without the separate
   dispositions.
2. **Gate topology:** `REPAIR-GATE-TOPOLOGY`. Provide one explicit local gate that
   provisions disposable PostgreSQL where required and reports rather than hides every
   skip/external dependency.
3. **Credit authority:** `REPAIR-CREDIT-UTC`, after `OWNER-CREDIT`. Preserve the public
   contract while making reserve, compare, and refund use the same UTC-day authority.
4. **Image core:** `REPAIR-IMAGE-CORE`, after `OWNER-IMAGE`. Resolve stale dual-side
   pointer expectations and make each audit tuple identify one exact stored object.
5. **Image writer convergence:** `REPAIR-IMAGE-PHONE`, after image core. Enroll the
   phone path and every verified reachable writer in the 0122 create-only intent,
   finalizer, and reconciliation authority.
6. **Bearer-token convergence:** `REPAIR-TOKEN-0123`, after `OWNER-TOKEN`. Build
   additive rolling compatibility before finalization; never apply the migration in
   this local phase.

After each node: run narrow red/green proof, inspect unexpected diff, check relevant
Graphify/source drift, update graph and canonical ledgers, and mark only `FIXED`.

Exit gate: every authorised repair node is `FIXED`; no repair is self-certified.

## Phase 3 — Independent behavior and hostile proof

Read-only verifiers may run the credit, image, token, secret-metadata, and gate lanes in
parallel once their repair nodes are integrated.

- Credit: real PostgreSQL at UTC midnight and non-UTC session zones; second admission,
  refund, replay, and concurrency. A mutation removing the UTC authority must turn red.
- Image: dual-side fault injection; pointer/audit transaction state; SHA/size/type of
  the exact named object; phone and all reachable writers; retry and reconciliation.
- Token: clean and historical 0123 paths; old/new rolling binaries; digest-only new
  writes; all six lookup/expiry paths; readiness; atomic stolen-report consumption.
- Secret metadata: exact modes/ownership only, with no content read or copy.
- Gate topology: prove the full suite executes non-vacuously and that an injected
  critical failure makes the gate red.

Then run one broad Claude Opus High hostile review against the integrated changed risk
surfaces. New reproduced in-scope BLOCKER/HIGH findings become graph nodes and enter a
targeted repair/proof loop. Re-review only changed risk surfaces unless architecture
changes.

Exit gate: every repaired finding and proof node is `PROVEN`, critical mutations bite,
and no actionable in-scope BLOCKER/HIGH remains locally.

## Phase 4 — Rollback and exact candidate

1. Prove 0123 rolling compatibility and forward/backward recovery without applying it
   to shared or external databases.
2. Prove 0122 reconciliation, credit recovery, secret-mode recovery, and one immutable
   rollback target.
3. On one clean candidate SHA, run MVGS freeze/diff, Graphify freshness, check, lint,
   the full non-vacuous engineering suite, build, full-history gitleaks, runtime/native
   dependency checks, and Engineering OS postflight.
4. Bind every proven release-veto evidence record to that exact `candidate_sha`.

Exit gate: `ROLLBACK-CANDIDATE` and `INTEGRATE-CANDIDATE` are `PROVEN`; local state is
clean and immutable.

## Phase 5 — External exact-candidate evidence

These nodes require separate authority or external state and cannot be manufactured by
local proof:

- `EXTERNAL-SUPPLY`: upstream managed-workflow exact pins plus native linux/amd64 boot,
  SBOM, vulnerability, readiness, and SIGTERM evidence.
- `EXTERNAL-GITHUB`: enforced ruleset/reviewer control, deliberately blocked PR, and
  terminal-green hosted CI on `candidate_sha`.
- `EXTERNAL-STAGING`: authorised role/readiness, retention/restore, migration recovery,
  provider, physical Scanner/NFC, and environment-identity evidence on the candidate.

Exit gate: each external evidence record names the exact candidate and observer. Any
unavailable dependency remains `EXTERNAL_BLOCKER`.

## Phase 6 — Owner release boundary

Run the validator with `--ready`. Present the exact candidate, evidence index, remaining
MEDIUM/LOW follow-up, rollback, CI/staging state, and production prohibitions. Deployment,
migration application, provider mutation, push, publish, and release still require an
explicit new owner instruction.

Stop the repair program when every in-scope BLOCKER/HIGH is fixed and independently
proven, the exact-candidate graph is ready, and the declared owner target is met. Do not
continue auditing a green release bar. Before then, stop only at one recorded owner,
external, destructive-action, or hard-system boundary.

## Current next step

The immediate next owner is the repository owner. Required decisions are represented by
`OWNER-TARGET`, `OWNER-SECRET`, `OWNER-CREDIT`, `OWNER-IMAGE`, and `OWNER-TOKEN`. Until
those decisions are recorded, the plan is ready to execute but protected repairs are
not authorised.
