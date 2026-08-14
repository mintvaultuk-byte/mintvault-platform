# Rollback — Scanner SOL campaign

## Before push/deploy

- Work is isolated on `codex/scanner-sol-implementation-20260814` at a recorded base.
- Revert specific local commits; never reset/clean another worktree.
- Engineering OS enrollment can be removed with a reviewed `engineering uninstall <isolated-path>` if the owner rejects it; do not run blindly once application changes exist.

## Package rollback

- Failed install/update must leave Secure Enclave/Keychain identity, encrypted queue and central state intact.
- Reinstall the last server-authorised compatible DMG. A static feed or merely old signed artifact cannot authorise downgrade.
- Emergency rollback requires authenticated MintVault policy or the separately pinned rollback-key directive.

## Server/migration rollback

- No migration is applied by this campaign without a separate approved operation and target-specific backup/rollback evidence.
- Prefer additive schema and dual-read/dual-write compatibility during cutover; reverse application code before considering destructive schema removal.
- Accepted evidence, Card Jobs, MV lineage, credits already consumed/settled and audit events are immutable; rollback never deletes or rewrites them.

## Pilot containment

- Before cutover preserve legacy state and central data, prove the RC, and keep an explicit stop path.
- If RC fails before legacy revoke, stop RC and restore the previous service without mixing two Canon owners.
- After server-side legacy revoke, rollback requires an explicit owner operational decision; never silently re-enable the token.

## Verification

- Exact package version/signature, one active Scanner process, server min-version policy, identity continuity, queue reconciliation and canonical authority refusal of retired credentials.
