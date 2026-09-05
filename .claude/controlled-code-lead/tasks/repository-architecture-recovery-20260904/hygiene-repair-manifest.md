# Hygiene repair manifest — authorized launch

Baseline: `80a20611ff5e8928fd6380961ca6bd420abe4727`.
Lead: Astra / codex-lead. Shared workspace: Lead is sole writer.
All nine lane dispositions are retained in hygiene-reports.md; dispatch validation
and its 13 negative self-tests pass. HY-SECURITY is UNKNOWN due to platform restriction;
no security-sensitive dependent repair or release certification is unlocked by this file.

## H1a — production dependency classification

Existing graph: ARCH-CI-001 -> REPAIR-CI-TOPOLOGY -> PROOF-CI. Authority controls already
FIXED; existing owner continuation permits build repair and dependency maintenance.
This does not close the broader CI, supply-chain or hostile-review nodes.

Reproduction: pinned Node20.20.2 Linux npm10.8.2 clean omit-dev install resolves tsx.
Its production ancestry is tailwindcss-animate -> tailwindcss -> postcss-load-config
-> optional tsx. Only source consumer: build-time tailwind.config.ts:110.

Exact implementation scope:

- package.json: move unchanged tailwindcss-animate version to devDependencies.
- package-lock.json: pinned-npm mechanical classification regeneration; no upgrades.
- tests/production-dependency-boundary.test.ts: build-only declaration/lock regression.

Keep Dockerfile and hosted image negative check unchanged. No blanket optional-dependency
omission, forced package deletion, native dependency removal or scanner changes.
Budget: one classification change, one regression test; investigate unexpected lock
version/integrity changes rather than accept them.

Proof: pre-fix clean-install tsx presence; candidate clean omit-dev absence of tsx,
vitest/typescript/eslint/prettier and presence of canvas/sharp; full build and actual
native/image readiness remain required separately. Independent read-only worker verifies
consumers and changed lock, not the author's final certification. Exact-SHA hosted proof
and required hostile review remain open.

Rollback: revert only this packet's package/test diff, then deterministic npm ci or
image rebuild. No database/object/provider rollback is involved. Preserve builder CSS
output and all existing tests. No deployment.

## Subsequent packets

H2a approved documentation-only scope: engineering/INDEX.md, README.md,
CLAUDE.md (unmanaged architectural/process paragraphs only), and
.claude/controlled-code-lead/INDEX.md. Existing REPAIR-AUTHORITY-CONTROLS owns this
packet. Preserve Golden Rules, managed blocks, historical task paths, migration files
and evidence. Replace misleading all-in-one architectural prescriptions with actual
bounded-context authority; point current-status consumers at the existing plan/graph.
Verify local relative links, managed-block byte preservation and architecture checks.
Rollback is the exact documentation diff only; no runtime behavior changes.

H1b owned PG16/vector + PG17 + object-store orchestration and process-only environment
requires its exact lifecycle/test manifest before writing. H2 documentation consolidation
starts with one engineering index and thin references; do not move/delete histories.
Runtime and product packets retain their existing graph dependencies and approval records.
The platform-restricted security lane is not rerouted to a different model/provider.
