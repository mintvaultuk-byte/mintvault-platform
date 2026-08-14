# Architecture — AFTER — Scanner SOL campaign

**State:** WP1 capture-helper, WP2 identity/client, WP3 live-authority, WP5 encrypted-queue, WP6 credential-independent package and WP7 fail-closed updater/login edges are AS-BUILT locally; real signed release and final server edges remain gated.

```mermaid
flowchart LR
  R["Sandboxed renderer\nzero authority"] -->|versioned validated IPC| M["Electron main\norchestration only"]
  M -->|signature/team verify then spawn| CH["Bundled signed arm64\nmv-capture-helper"]
  CH -->|ImageCaptureCore locked profile| CANON["Canon LiDE 400"]
  M -->|signature/team verify then spawn| IH["Bundled signed arm64\nmv-identity-helper"]
  IH --> SE["Secure Enclave P-256"]
  IH --> KC["Device-only Keychain\nSE-wrapped Ed25519 + queue key"]
  M --> Q["Authenticated encrypted queue"]
  Q -->|fresh grant each attempt| API["Partner API authority"]
  API --> DB["Station epoch + idempotency + Card Job + credit + profile"]
  API --> R2["Digest/size verified immutable evidence"]
  POLICY["MintVault min-version / rollback policy"] --> M
  PKG["Signed notarised DMG + ZIP feed"] --> M
```

## Intended changes

| Change | Why | Class |
|---|---|---|
| Precompiled helpers + runtime designated-requirement verification | Remove runtime toolchain and helper replacement | D/F |
| Native SE/Keychain identity and signing | Clone resistance and key isolation | D |
| Versioned schema-validated IPC | Renderer compromise containment | A/B |
| Server capture authorisation/profile/op-ID/epoch contracts | Preserve sole business authority | B/E (migration authored, application separately gated) |
| Encrypted queue + plaintext sweep + fresh grants/dispositions | Evidence confidentiality/durability | D/B |
| Electron builder/updater and policy checks | Production install/update/rollback | D/F |

## Deliberately unchanged

- Partner server owns every business decision.
- Protected MVGS calculation and grading boundaries.
- Production/staging/legacy cutover remain owner-authorised operations.

## AS-BUILT confirmation

WP1 confirms main-process configuration of one exact resource path and
verification of the capture helper's sealed digest, arm64 architecture, macOS
floor, signature, identifier, protocol and matching production Team ID before
every spawn.

WP2 confirms helper-owned Ed25519 generation/import/signing, device-only
SE-P256 wrapping, exact Keychain namespace enforcement, prove-then-retire v1
migration, separate human session storage, one process-wide signed-request
queue, durable exact-payload operation IDs and fail-closed identity recovery.
Production helper calls additionally require a signed parent matching app ID,
pinned Team and designated requirement. Production entitlements/package
execution and server epoch/idempotency/session authority remain later edges.

WP5 confirms that TIFF/Preview bytes enter a device-bound AES-256-GCM queue
with a fully authenticated index and immutable authority/provenance binding.
Plaintext is unlinked or swept to quarantine, each upload attempt requests a
fresh grant, and only a tuple-exact canonical server disposition permits local
resolution. Rescan replacement is atomic and ACCEPTED is a restart-convergent
deletion journal. The Partner API nodes remain proposed until frozen-P14
server semantics are reconciled and proven end to end.

WP6 confirms an arm64-only Electron app with exact MintVault identity, macOS
12.0 floor, frozen helper locations and runtime-only ASAR boundary. One fresh
preparation binds source/mode/Team/helper bytes; independent JS and compiled
Team pins prevent a candidate trust file from choosing its own authority.
Local app, ZIP and DMG copies are independently verified and share one bundle
digest/source/helper set. The `PKG` edge remains only locally AS-BUILT: its real
Developer-ID/notary authority and deployed update feed are R-3/WP7/WP9 gates.

WP7 confirms that `POLICY`, not `PKG`, selects a release. Authenticated station
status supplies one short-lived exact target/direction/minimum/Team/source and
artifact set; static metadata is cross-checked but cannot choose any older or
newer candidate. The ZIP path comes from the real MacUpdater event and is
rehash-bound immediately before install. Reinstall privately downloads and
hashes the exact DMG before local open. Login startup uses the post-enrolment
main-app service. Authenticated update bodies are bounded while streaming and
preserve the capture reserve; one install-quiesce latch spans MacUpdater's
delayed native quit and every physical/recovery watcher edge. The exact P14 policy response and physical Apple installation remain
reconciliation/external gates.
