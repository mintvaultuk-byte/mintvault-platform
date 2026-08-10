# Change Manifest — Graph of Loops controller installation

## Scope

Install the owner-provided Graph of Loops Build Controller as one canonical
repository document; make both root agent entry points load it alongside the
existing No-Bullshit Completion Controller; prevent either reference from
silently disappearing through the existing governance self-test suite.

## Approved changes

| File | Classification | Change | Why |
|---|---|---|---|
| `docs/GRAPH_OF_LOOPS_BUILD_CONTROLLER.md` | A | Create the canonical owner-provided controller. | One non-divergent authority for future engineering tasks. |
| `AGENTS.md` | A | Add a mandatory canonical-load reference. | Makes Codex load both controllers. |
| `CLAUDE.md` | A | Add the same mandatory canonical-load reference. | Makes Claude load both controllers. |
| `.claude/governance-tests/test-governance-files.sh` | A | Require the canonical file and both root references. | Detects deletion or disconnected loading paths. |
| `.claude/governance-version.md` | A | Advance governance version to 1.2. | Preserves versioned-governance record. |
| `.claude/governance-changelog.md` | A | Append the 1.2 installation record. | Preserves append-only governance history. |

## Explicitly out of scope

- Application, database, migration, authentication, Stripe/payment, grading,
  environment, deployment, and dependency changes.
- Any push, deployment, external provider call, or production/staging action.

## Verification and rollback

- Run `bash .claude/governance-tests/run-all.sh` and an adversarial temporary-copy
  mutation that removes one controller reference and must make the integrity
  test fail.
- Run `npm run check` and inspect the final diff and worktree.
- Roll back locally with `git revert <installation-commit>`; no external state
  is changed.
