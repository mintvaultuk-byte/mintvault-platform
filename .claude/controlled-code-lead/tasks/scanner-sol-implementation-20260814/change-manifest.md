# Change manifest — WP0 factual baseline and campaign control plane

**Date:** 2026-08-14
**Lead session:** `codex/scanner-sol-implementation-20260814` at base `d44a2c53`

## Findings addressed

- WP0-1 — MintVault was not Engineering OS-enrolled and had no current graph — Class D.
- WP0-2 — No isolated Scanner branch/base/register/contracts existed — Class G.
- R-9 — P14 is not frozen; establish an explicit non-authority base and reconciliation boundary — Class H/G.

## Files changed in WP0

| Area | Change | Why | Class |
|---|---|---|---|
| `.engineering/**`, `engineering/**` | Enroll OS, define risk/protected paths, canonical issue/proof ledgers | Required governance and evidence source | D |
| `AGENTS.md`, `CLAUDE.md`, ignore files, governance workflow | Add OS-managed load/gate blocks | Deterministic future enforcement; additive only | D |
| `.claude/controlled-code-lead/INDEX.md` | Register campaign | Durable recovery | G |
| `tasks/scanner-sol-implementation-20260814/**` | Add baseline, manifests, contracts, architecture and reconciliation evidence | Mandatory Stage 0-4 control state | G |

The OS enrollment prerequisite was applied after a successful dry-run while the
new worktree was clean, because the enrollment command intentionally refuses a
dirty repository. Its generated plan is captured in command evidence.

## Explicitly not touched in WP0

- `scripts/scanner-app/**` — source verification only.
- `server/**`, `shared/**`, `migrations/**` — Partner/server authority remains unchanged.
- Active Partner pass2 — strictly read-only.
- MVGS scoring/threshold/label behavior — outside authorisation.

## Protected actions

- No push, deploy, migration application, secret access/change, Apple credential use, production/staging mutation, payment call or destructive operation.
- Owner approval for this isolated WP0 campaign is the attached master implementation prompt dated 2026-08-14.

## Order

1. Establish exact heads/status/origin and lineage.
2. Create isolated worktree from immutable committed Partner seed.
3. Enroll OS, preflight at HOSTILE, build graph.
4. Record canonical issues/proofs/contracts/reconciliation boundary.
5. Run WP0 governance and drift gates.

**Approved to proceed:** owner master prompt; no protected external action in WP0.

## WP1 planned change manifest (before application edits)

| Finding | Planned surface | Repair class |
|---|---|---|
| R-1 runtime compilation | `lib/lide400-controller.js`, new helper-integrity boundary | D |
| R-1 mutable unverified executable | generated helper manifest, exact-path/hash/architecture/signature/team/protocol verification | D |
| R-10 macOS floor drift | native build metadata, exact Electron pin, compatibility tests/docs | C |
| Native protocol ambiguity | `native/mintvault-lide-bridge.m` version fields and controller validation | C |

The local build may invoke Apple compilation/signing tools only as a build-time
operation in this isolated development worktree. Production runtime code will
contain no compiler/source fallback. Developer-ID signing/notarisation and the
complete release package remain WP6/R-3 work; WP1 establishes their nested
helper contract without claiming external-credential proof.

## WP1 actual changes

- Added `helper-integrity.js`, build/verify scripts, a generated-manifest
  contract and fail-closed checks for exact path, regular/executable file,
  bounded size, SHA-256, arm64-only, minOS 12.0, code signature, helper ID,
  production hardened runtime and application-matching Team ID.
- Removed every controller runtime compiler/source/cache path. Integrity now
  executes before every native operation.
- Added helper/protocol version to every native JSON result and rejects stale
  protocol responses in JavaScript.
- Exact-pinned Electron 42.2.0 and documented the candidate macOS 12.0 floor.
- Repaired the one pre-existing Scanner suite failure by aligning its stale
  source assertion and modal copy to the already-implemented target-bound FIX
  behaviour; no Partner/server authority was changed.

Protected systems untouched: MVGS math/labels, payments, migrations, production
data, active Partner pass2, staging/production, credentials, remote Git.
