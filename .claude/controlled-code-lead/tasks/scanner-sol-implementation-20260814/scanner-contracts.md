# Frozen Scanner compatibility contracts — implementation baseline

These values are frozen for the campaign. A change requires an explicit contract
migration plus drift tests; silent second namespaces or identities are forbidden.

## Evidence map

| ID | Contract surface |
|---|---|
| WP0-CON-01 | Bundle/helper/Keychain identity namespaces and migration |
| WP0-CON-02 | Human session, station binding and live status |
| WP0-CON-03 | Tenant/location/station isolation and transfer |
| WP0-CON-04 | Replacement and in-flight recovery |
| WP0-CON-05 | Semantic operation IDs, NEW/CANCEL/FIX idempotency |
| WP0-CON-06 | Replay epoch, sequence and bootstrap-independent resync |
| WP0-CON-07 | Locked capture profile revision and provenance |
| WP0-CON-08 | Capture authorisation, encrypted queue, fresh grants and evidence finalisation |
| WP0-CON-09 | Update, minimum-version and rollback authority |
| WP0-CON-10 | Owner-gated Pilot/legacy cutover containment |
| WP0-CON-11 | Hostile verification and mutation gate |

| Contract | Value / rule |
|---|---|
| App display/install | `MintVault Scanner` at `/Applications/MintVault Scanner.app` |
| App bundle ID | `com.mintvault.scanner` (preserves the canonical existing service namespace) |
| Capture helper executable | `Contents/Helpers/mv-capture-helper` |
| Identity helper executable | `Contents/Helpers/mv-identity-helper` |
| Capture helper bundle ID | `com.mintvault.scanner.capture-helper` |
| Identity helper bundle ID | `com.mintvault.scanner.identity-helper` |
| Team requirement | Same designated Developer ID Team as the signed app; injected by release credentials and checked at runtime |
| Keychain service | `com.mintvault.scanner.identity` |
| Keychain account | `station-identity-v2` |
| Keychain access group | `$(AppIdentifierPrefix)com.mintvault.scanner`; release entitlement must resolve to the app Team prefix |
| Keychain accessibility | device-only, non-sync (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` or stricter compatible setting) |
| Identity schema | v2: public key + SE key reference + wrapped Ed25519 ciphertext + algorithm/namespace metadata; no plaintext private key |
| Legacy identity schema | v1 Electron `safeStorage` envelope; migration only: read → write v2 → unwrap/sign proof → retire v1 |
| Queue namespace/schema | `com.mintvault.scanner.queue`, schema v1; authenticated canonical metadata + encrypted artifact only |
| Capture profile schema | `mintvault-capture-profile-v1`, immutable server revision/digest |
| IPC schema | `mintvault-scanner-ipc-v1`; explicit allowlist, request/response validation, no generic invoke/send |
| Signed request current compatibility | `mintvault-station-request-v1` remains accepted until server/client v2 epoch transition is jointly wired |
| Signed request target | v2 binds station, epoch, sequence, method, path, body digest and semantic operation ID |
| Semantic operation ID | UUIDv4 generated/persisted before first I/O; never reused across semantic operations |
| Capture authorisation | opaque server ID; server-time issue/expiry; exact job/side/revision/profile/operator/station/location/tenant/purpose binding |
| Artifact algorithms | SHA-256 digest; AES-256-GCM queue encryption with unique 96-bit nonce and authenticated metadata |
| Canon final profile | CanoScan LiDE 400, ImageCaptureCore, arm64 helper, 1200 DPI, RGB 8-bit/channel, lossless TIFF, locked server profile revision |
| Setup preview | 300-DPI JPEG, local and non-authoritative, never eligible for upload/finalisation |
| Update artifacts | signed/notarised/stapled arm64 DMG + signed/notarised ZIP + `latest-mac.yml` + SHA-256 MintVault manifest |
| Login behavior | Electron `app.setLoginItemSettings()` after enrolment, default on; no production LaunchAgent/KeepAlive |

## Migration failure rule

If legacy identity lookup/migration cannot be proven on the same Mac, surface
`IDENTITY_RECOVERY_REQUIRED`; never generate a replacement identity or request a
new station automatically. Replacement remains a new enrolment + Super Admin
approval transaction.
