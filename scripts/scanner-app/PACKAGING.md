# MintVault Scanner packaging and release contract

Production Scanner releases are Apple-Silicon-only and install as
`/Applications/MintVault Scanner.app`. The frozen bundle ID is
`com.mintvault.scanner`; the supported floor is macOS 12.0. The shipped bundle
contains runtime JavaScript and production dependencies in ASAR, the two final
native executables in `Contents/Helpers`, their sealed manifests under
`Contents/Resources/helper-manifests`, and `release-trust.json`. Native source,
tests, package/build scripts, npm, Git, Node, Xcode, compiler tools, environment
files, API keys, database URLs and LaunchAgent/install scripts are excluded.

## Credential-independent structural proof

On Apple Silicon macOS with Node 24.14.1:

```sh
npm ci
npm test
npm audit
npm run package:mac:local
```

The local command creates and re-opens an arm64 application, DMG and ZIP, then
validates `latest-mac.yml`, `SHA256SUMS`, and
`mintvault-scanner-release.json`. It enumerates every Mach-O and rejects x64 or
universal files, a dependency floor above macOS 12, an unexpected ASAR/runtime
file, wrong app/helper identity, helper mutation, archive byte drift, stale
update metadata, and manifest/checksum disagreement.

Local outputs are deliberately ad-hoc, carry the impossible Team marker
`LOCALDEV00`, and set `releaseReady: false`, `notarized: false` and
`gatekeeperAssessed: false`. They are evidence of package structure only and
must never be installed as a production release.

Do not invoke `electron-builder` directly. A fresh UUID-bound preparation
record is required and the `beforePack` hook refuses stale or direct inputs.

## Protected signed release candidate

The manual `Scanner signed release candidate` GitHub Actions workflow is bound
to the protected `scanner-release` environment. Configure required reviewers
and its secrets before use. Release mode also remains hard-blocked until the
owner changes `build/release-authority.json` from `OWNER_REQUIRED` to `PINNED`
with the exact ten-character MintVault Developer Team ID in an independently
reviewed commit. The workflow accepts one owner-approved, credential-free
HTTPS update base URL and expects:

- `MINTVAULT_APPLE_TEAM_ID`
- `MINTVAULT_DEVELOPER_ID_APPLICATION`
- `MINTVAULT_DEVELOPER_ID_P12_BASE64`
- `MINTVAULT_DEVELOPER_ID_P12_PASSWORD`
- `MINTVAULT_NOTARY_API_KEY_ID`
- `MINTVAULT_NOTARY_API_ISSUER`
- `MINTVAULT_NOTARY_API_KEY_P8_BASE64`

The workflow imports the Developer ID Application identity into an ephemeral
keychain and materialises the App Store Connect API key only under the runner's
temporary directory. No credential enters an artifact or manifest.

The release order is fail-closed:

1. validate a clean exact source commit, Team, identity, update origin and one
   complete notarisation credential set;
2. build arm64 helpers at minOS 12.0;
3. Developer-ID-sign each helper with hardened runtime; the identity helper
   alone receives `<TeamID>.com.mintvault.scanner` as its Keychain access group;
4. hash those final signed helper bytes into the sealed manifests;
5. generate the Team/version/mode-bound trust record;
6. package and sign the outer app without re-signing either helper;
7. notarise, staple and Gatekeeper-assess the app before ZIP creation;
8. sign, separately notarise, staple and assess the final DMG;
9. mount the DMG, extract the ZIP, re-verify both application copies, canonicalise
   `latest-mac.yml` to the exact ZIP, and generate final SHA-256/MintVault ledgers.

The workflow uploads an immutable release-candidate evidence artifact. It does
not publish a GitHub Release, update a live feed, deploy, install, or cut over a
station. Those remain separate owner-authorised gates.

## Final external and physical gates

Without the owner-approved Developer ID private key, exact Team/prefix and
notarisation access, the real hardened Team/access-group, Apple acceptance,
stapling and Gatekeeper claims are unproved. A release also requires a clean
macOS 12 Apple-Silicon station with no development tooling to drag-install from
the DMG, launch through Gatekeeper, relaunch/reboot, and exercise update and
reinstall identity persistence. The current local structural artifact is not a
substitute for either gate.
