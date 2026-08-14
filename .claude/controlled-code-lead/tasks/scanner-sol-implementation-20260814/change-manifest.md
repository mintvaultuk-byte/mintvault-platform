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

## WP2 planned change manifest (before application edits)

| Finding | Planned safe-isolated surface | Repair class |
|---|---|---|
| R-4/R-14/R-19 | signed arm64 Swift identity helper; SE-P256 wrapping; explicit device-only non-sync Keychain; helper-owned Ed25519 signing | D |
| R-21 | explicit identity state machine; v1→v2 prove-then-retire migration; namespace/schema drift tests | D |
| R-6/R-13/R-20 | inactive v2 request/resync canonical contracts and tests; no authority route wiring before P14 | B |
| R-12/R-26 | persisted UUIDv4 semantic-operation store/client framework; final universal server registry deferred | A/B |
| Request ordering | one main-process station-signed request queue | A |
| R-27 | separate operator-session envelope and binding-ready client DTO; final access/refresh authority deferred | B |

No Partner auth/RBAC/location/station/Card Job/credit schema, route or migration
will be authored in this pass. That is the explicit A4/Lead response to the
moving-P14 isolation rule, not a downgrade of the registered HIGH findings.

## WP2 actual changes

- Added a dependency-free arm64 Swift identity helper. Production identity
  access requires the release-signed helper plus an authenticated dynamic
  parent matching the exact Scanner app ID, pinned Team and designated
  requirement. Ad-hoc builds are constrained to bounded test namespaces.
- Production v2 identity uses a permanent application-tagged Secure Enclave
  P-256 key in the frozen Team access group to wrap Ed25519 under
  HKDF-SHA256/AES-256-GCM. The generic Keychain envelope is exact-access-group,
  `AfterFirstUnlockThisDeviceOnly` and non-sync. Missing entitlement, alternate
  attributes, missing SE key, schema drift and corruption fail closed.
- Migrates the legacy v1 key through bounded stdin, verifies pair/fingerprint
  and possession, converges same-key retries, then retires v1. Human session is
  a separate safeStorage envelope and never enters the helper.
- Preserved signed-request v1 while adding inactive v2/resync domains and
  strict-newer-epoch state. All current station-signed exchanges share one
  queue from signature allocation through response consumption.
- Added a durable exact-payload semantic-operation store and restart-safe NEW
  and enrolment coordinators. Ambiguous NEW outcomes retain the same operation;
  completed history compacts without deleting unresolved work.
- Disabled multipart evidence fallback for active signed stations because its
  bytes were not signature-bound. Production must use staged digest-bound
  grant/finalisation; explicit local legacy-token proof remains isolated.
- Added explicit identity-recovery UI state; missing/corrupt identity can no
  longer be presented as a new-station registration.

Hostile A3/A4 findings were repaired in the same pass. Final server enrolment
idempotency, replay/resync and station-bound refresh remain deliberately
inactive until frozen P14 reconciliation; no server authority or migration was
changed in WP2.
