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

## H1b — owned local PostgreSQL orchestration

Baseline: `1ae1a7c5e54f4220a8bd1a0fd3a30166a6e2b561`. Existing
REPAIR-CI-TOPOLOGY / PROOF-CI packet; no product or schema changes.
Implementation scope: `scripts/ci/run-disposable-integration.mjs` and
`tests/disposable-integration-runner.test.ts` only. Lead integrates; an isolated
Terra worker may write those two files in a newly registered temporary worktree.

Reuse the two digest-pinned primary CI PostgreSQL images, per-suite environment
matrix, preparation script and Partner runner. Require an explicit Docker context,
unique labelled container identities and random loopback-only ports. Never adopt
an existing database/container, use fixed-name deletion, attach host data volumes,
load .env, or inherit provider/database credentials. Children receive an allowlisted
test process environment, C locale and owned service ports. Any preparation export
uses a new private temporary GITHUB_ENV file, never the caller's file. Validate
readiness and server majors before preparation. Preserve per-suite role topology.
No claimed object-storage/browser proof from this PostgreSQL-only subpacket; those
remain subsequent H1 work using the same lifecycle where appropriate.

Proof: executable lifecycle tests covering startup failure, child failure, owned
cleanup and environment isolation; actual PostgreSQL16/vector and PostgreSQL17
provisioning followed by the existing selected Partner runner. Do not lower floors,
skip failures or globally pin accounting URLs. Independent verifier checks the
integrated implementation and observed non-vacuous results. No release closure.
Rollback: revert these two files; stop/remove only resources created by that exact
run after validating their returned IDs and ownership label. Retain test reports.
Do not delete old worktrees, cached images or unrelated containers/data.

Lead integration amendment: `scripts/ci/script-syntax-baseline.json` must add the
one new runner using the existing generator (65 -> 66 modules); no existing entry
or syntax gate is removed. This is mechanical test-inventory wiring, not a lower
diagnostic floor. `engineering/INDEX.md` may add one usage pointer to the runner.
`scripts/ci/typecheck-baselines/tests.json` may refresh only its tracked file count
and path hash for the H1a/H1b added tests (498 -> 500). Preserve every diagnostic
fingerprint/count, compiler/config hash and no-check allowance; any new diagnostic
is repaired, never absorbed by baseline regeneration.
Architecture registration: add only the exact new runner path to
`scripts/architecture/authority-policy.json` with engineering-test ownership and
regenerate `scripts/architecture/generated/architecture-authority.json`. Its
cancellation timer is test infrastructure, not legacy runtime debt; do not extend
a broad scripts exemption or modify legacy authority entries.
Independent functional lifecycle proof is assigned to `/root/h1b_lifecycle_proof`
(Sol high); the restricted security investigation remains separate and untouched.

H1c diagnostic proof scope: a temporary, retained local script at
`/private/tmp/mintvault-r2-proof.hGKPpd/proof.mts` may exercise existing `server/r2.ts`
functions against an owned MinIO container only. Registry-resolved image index:
`minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`.
No product edits, scanner redesign, external provider or live configuration. Generate
synthetic credentials, use a random loopback port and bucket, verify ownership before
test/cleanup, remove only that run's container/test volume. Retain script and results;
this is local S3-compatible proof, not Cloudflare R2/staging certification or durable
CI integration. A checked-in reusable object-store gate remains subsequent work.
