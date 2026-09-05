# Engineering navigation and current authority

Start here for remediation state. This index points to existing authorities; it does not
create another master prompt, issue register, repair graph or release approval.

## Current program

- [Execution plan and checkpoints](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/phased-repair-plan.md)
- [Current task ledger](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/task-ledger.md)
- [Owner authority and exclusions](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/owner-approval-record.md)
- [Issue register](ISSUE_REGISTER.md) and [proof ledger](PROOF_LEDGER.md)
- [Existing repair graph](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/repair-graph.json), including its required White Ace subgraph
- [Bounded dispatch and reports](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/hygiene-reports.md)
- [Exact active repair manifests](../.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/hygiene-repair-manifest.md)

Current status is candidate-specific. Historical "complete", "unpushed", "unavailable"
or "owner approval required" statements do not override newer scoped evidence/approval.
Committed, pushed, CI-green, merged and deployed are separate facts. No release is implied.

## Source and configuration authority

- [Project profile and gates](../.engineering/project.yaml) defines runtime/gate configuration.
- [Architecture authority](../docs/engineering/ARCHITECTURE_AUTHORITY.md) defines bounded
  ownership; verify generated navigation against actual routes/services/schema/tests.
- [Agent instructions](../AGENTS.md) and [protected project rules](../CLAUDE.md) retain
  the completion controllers, frozen MVGS and owner deployment/destruction boundaries.
- Numbered SQL in migrations/ and existing migrations-vq/ retain their identities.
  The schema-convergence repair must reconcile those lineages; never renumber or squash
  applied migrations to tidy folders. db:push is not migration-history authority.

Tests use newly owned disposable PostgreSQL/object-storage services and process-only
test configuration. Do not source .env or use npm run dev during remediation: the existing
dev script loads .env. Follow the approved harness, not copied staging/live credentials.
Same-database accounting identities and distinct restricted runtime roles must remain
consistent with scripts/ci/partner-suite-env-matrix.mjs; a universal database override
is not a valid substitute for isolated suites.

The owned PostgreSQL runner is `node scripts/ci/run-disposable-integration.mjs
--docker-context <dedicated-local-context> --all --json <report-directory>`.
Add `--prepare` to exercise the existing shared-schema/VQ test preparation first.
It creates fresh CI-pinned PG16/vector and PG17 services on random loopback ports,
then removes only its verified containers and their anonymous test volumes. It
never adopts an existing database. Use the pinned Node20 runtime and an explicit
test-only PATH/native PostgreSQL17 installation; do not load local environment files.
This runner does not yet provision object storage or certify browser/hardware proof.

## Retention and consolidation

| Material | Ownership and rule |
| --- | --- |
| engineering/ | Current index, issue/proof ledgers and durable decisions; link instead of duplicate |
| docs/ | Supported product/operator guidance; historical material must be labeled before relocation |
| .claude/controlled-code-lead/ | Retained task history and active graph paths; no mass move or deletion |
| scripts/architecture/generated/ | Generated, reviewed navigation with real gate consumers; remove/shard only after deterministic regeneration and mutation-equivalence proof |
| script/, scripts/ | Preserve npm/CI/Docker/operator entrypoints until a consumer-by-consumer migration is proven |
| Registered worktrees | Unknown ownership/activity is not deadness; exact retention/backup reconciliation before any removal |

Use Engineering OS for repository governance and Graph Loop Repair for this explicitly
requested phased program. Load another skill only when its trigger actually applies.
Astra owns orchestration/adjudication; cheaper scoped workers supply implementation or
independent evidence. Shared workspace has one writer. Missing/restricted review is
UNKNOWN, not a pass; no model substitution to bypass a platform restriction.
