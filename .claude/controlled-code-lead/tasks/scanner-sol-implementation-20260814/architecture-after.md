# Architecture — AFTER — Scanner SOL campaign

**State:** WP1 capture-helper edge AS-BUILT locally; remaining graph PROPOSED until later WPs and final WP9/WP12 confirmation.

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
every spawn. Identity, queue, server-policy and package edges remain pending
implementation, behavioural/mutation/hostile proof and final P14 reconciliation.
