# Phase 2 exact file manifest

**Committed baseline:** `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`  
**Owner-directed WIP checkpoint:** `2913bcb1092ea8f43ee1294b711a8df653a06a3d`

**Reviewed post-checkpoint executable/dependency diff:** SHA-256 `776721dfcd7cca0196bea0b1e5eedaa98d53efa44a76ebec622ea06c45e9c8f6`

**Candidate:** uncommitted local WIP; no immutable candidate SHA exists

**Digest:** SHA-256 of the complete file bytes  
**Generated:** after the final local Phase 2 gates, clean hostile round 2, and independent Scanner dependency review

This manifest defines the behavior-preserving architecture/readiness and CI-control
boundary. It does not include the five pre-existing White Ace test edits,
`.gitleaksignore`, the nested White Ace task, build output, Graphify output, dependency
installation state, or protected product behavior. It includes the two nested Scanner
package authority files changed for test isolation. The architecture intake/assessment, baseline,
phased plan, and validator records predate Phase 2 and are retained on rollback.

This is the historical Phase 2 boundary at the owner-directed checkpoint and its reviewed
post-checkpoint corrections. The later owner-authorized Admin identity/session wave
legitimately changes several shared architecture, component, test-baseline, documentation,
and ledger paths, so their live bytes no longer match the historical rows below. Do not
refresh those rows and misattribute the later behavior change to Phase 2. For current
Admin-wave content and rollback authority, use `admin-session-file-manifest.md`,
`admin-session-change-manifest.md`, and the Admin section of `rollback.md`.

## Tracked files modified from the baseline

| Path | Baseline Git blob | Current SHA-256 |
| --- | --- | --- |
| `.claude/controlled-code-lead/INDEX.md` | `74d5ad64ed384d232cb0e3f412c3b536423af919` | `74dcc225518e2cdfb96f1ae851ba0def8baec7d6586585870f286cf0562f0b12` |
| `.github/workflows/ci.yml` | `d6c66bb2126c084696569e1401a68fd5483149df` | `77c43107c200c22d55d22dedf253a5b8c576f5a0beb1cbb8314cdefa0a407ddf` |
| `CLAUDE.md` | `ab49225bea8da730830f16ccaa3595a2b9388d1f` | `1e3b961dc3eed8be665ee39f6579490409b3ff973db3eaa9472e9c3294b8ac27` |
| `engineering/ISSUE_REGISTER.md` | `995f6f3e00eebfb7892fb1c8ad66f33e55c8737d` | `57ecc20b81cab3f8d1bd412f3778be9fa247ca41347779f195e309b08b7baf6d` |
| `engineering/PROOF_LEDGER.md` | `82e066516ac86dbe67e98a52faf16b72dd4ce997` | `3551d5a23be1c4ee3e688e0547fe61be60450a18b1663956db01dd311dc364fd` |
| `package.json` | `6605378b38f16b0c5e408c2a98e30e1aa0029cb7` | `782cc701394c0075c3667060d7dda8fe05f686cea8f47011bdbd2c0ee3bd3d93` |
| `scripts/ci/partner-suite-env-matrix.mjs` | `e952d854790fff4d80423b1123db074bd90ddc4f` | `4ef2ab08d52a26fa6ca5afdee17aee65e18049dd7b86e1fd511c476c06007811` |
| `scripts/ci/partner-suite-verdict.mjs` | `480c11fc3a643fe99d5857b6ea10340c8eb7a01a` | `407ac6823bbbc6959e42062adeb88d4013a9b33b04ea49084e51515cae6e7e6f` |
| `scripts/ci/run-partner-suite.mjs` | `e5f1f9a93eaf3a10c886859b688bab52452fd445` | `f79c6086d121aa616e0f566765b56549dfc372d336f30ccf0bdd774ad019a67d` |
| `scripts/scanner-app/package-lock.json` | `814ff41109782165777671e20f33e57e88565ac7` | `fd5683844d123b835e40a55a9a1a6d65ed62e02e30777e1be3700ed6bc650abe` |
| `scripts/scanner-app/package.json` | `69c5e548e0f6800429e500e99eee25a21b41335d` | `15ea0e628c13d51379155afe3a24bc848aa3a45d43caed433b901f93ecbf0b3f` |
| `server/readiness.ts` | `fa5edc6ce5741be177d3babe119cbbfccc05f491` | `5a8a2d302d32e4ad0d95acd838ab34a960f955ea822ff3296647603e8386b3c4` |

The canonical issue/proof ledgers and task index contained pre-existing WIP. Rollback
must reverse only the Phase 2 reconciliation hunks; their baseline blobs are evidence,
not authority to overwrite the whole files.

## New implementation and proof files

| Path | Current SHA-256 |
| --- | --- |
| `config/components/commerce.ts` | `941623ef0d7385deb45c1ba303daf64284399823fb06d4115f08901feb982b95` |
| `config/components/core-runtime.ts` | `6521ff8aeb4d4e1f334dd32c008a29c97846a2c60c265c4a48354c42b444cbce` |
| `config/components/customer-notifications.ts` | `e2b4f9ccd84ef236bfd15599420b606c5c91baef8277249fbaa396c2ffb1991b` |
| `config/components/identity-session.ts` | `d5523b040394ade5e11327e493da1a10b14e7baec6edafd7c7253adfb27d7221` |
| `config/components/index.ts` | `7607c36263ac90edbe9e6bdcf7434671222e47f0ee587a5adbcda0ca8dcf7dba` |
| `config/components/object-write.ts` | `71fa84349461bfeffa4097c2f2235acece397f18f5dbfbfc1174a3c215159c23` |
| `config/components/partner-operations.ts` | `60b45060cd85abc1da7bb537c5711df6690c02fef8de8d3cf02c5103965f9db0` |
| `config/components/scanner-ingest.ts` | `cc4e3a75b926223927b584dc3dbf1dfaa1811b6171a979807f15709cbfb8a61e` |
| `docs/engineering/ARCHITECTURE_AUTHORITY.md` | `fffb0f338632d5bac68306e67559357e87a408f3f5497b3b9c1e336e31fe1458` |
| `scripts/architecture/authority-policy.json` | `e39b08b3a94ae5ebe44eb92f2e628e2a7b5f28a2960d8230be3633e5f3a26b95` |
| `scripts/architecture/check-architecture.mjs` | `440a18d93ab939038745b6eb6a0e0a4337be863547826b99440152dd3f84f3b7` |
| `scripts/architecture/generated/architecture-authority.json` | `7c571c0f2a4dcc719f44467f14938bde0a1efc7860ab4f5c1e83046eb7371959` |
| `scripts/architecture/legacy-authority.json` | `b1489a083e35a9ec846b4471e92c9fe992c858d6d32d7ba96e2a92dc2257aebf` |
| `scripts/ci/check-migration-references.mjs` | `d1ccebd19b28b24897eb79fcf1f65b23bc79b463f3b592cf414935cdf69b0974` |
| `scripts/ci/check-script-syntax.mjs` | `df167e1fdf75e94e84b48b5d878bfe9d3c7e1d020f57cd837e1e253a850fc7d9` |
| `scripts/ci/migration-reference-policy.json` | `c88ff7eb35f0264b453715adb3d0656d022c69be94ba1174d74a95253e22f113` |
| `scripts/ci/partner-suite-floors.json` | `1365f8f16da249ac65cc13d105cb4d3cdd4156dcccda77ab4518f335595dfe3c` |
| `scripts/ci/run-scanner-suite.mjs` | `59a366d977f7eba62f7092ddd152a6f426bbb677058a08f7cd5e033953487fd0` |
| `scripts/ci/run-typecheck-ratchet.mjs` | `ef27f39b3d87d7f5ce1b3a24422fcf37163223311db71eb1d2a4c10998d6b0cd` |
| `scripts/ci/script-syntax-baseline.json` | `f1a64f14dd5b57c46059ccb7107df552f4cba60b0f48e7aeb07b34787cc6100d` |
| `scripts/ci/typecheck-baselines/architecture.json` | `7a84032133013a586fad6c55a54a733c15025a6b77d62cee3c843b42ed5b4530` |
| `scripts/ci/typecheck-baselines/scripts.json` | `73f2f92e141307d9d918fe8ad7a71c05b3303fcfd3c5276bc4aad5455566e6ea` |
| `scripts/ci/typecheck-baselines/tests.json` | `abdb783fd465a07ff0e1b114025943beec9df32662b62a20064fa9cc53a6deab` |
| `scripts/ci/update-partner-suite-floors.mjs` | `925a28149e26001c14bb8c1eb2100df6f13a9c1dac02572bf9cd46f222d4594a` |
| `scripts/ci/verify-ci-topology.mjs` | `c0dba2768bd3c0de3e655e0346c0936797ca8d0c5ad89906a7a7c7ce38d0b893` |
| `server/lib/component-readiness-registry.ts` | `2d3e4ec224f3e35719a315c6f2f28a6d68124edbc59f40183779c16388fcdfd6` |
| `tests/architecture-authority.test.ts` | `ebeae4f55857a79ff11fb69cfbdcfd4e036215b7d54c73ef73606d90a9a89177` |
| `tests/ci-proof-topology.test.ts` | `7b7c4bff023f19cccd2801ecc7d4d1804533319d18d450a0470a336b84eabe10` |
| `tsconfig.architecture.json` | `e52430f7e907f07385c91e3c99fe217f7fc8b357b9dc928d0f837df61746a52b` |
| `tsconfig.scripts.json` | `2b939b0c699a3a593941bab4aeda184f8b4c6f48d7c048ad5a3a09a8b1c7fb35` |
| `tsconfig.tests.json` | `4c66478b4fa09b5213fbe84b9404f4e669258fd3323fe05746ee47e1b12ce6fe` |

## Phase 2 program records

These records are new relative to the committed baseline, but rollback retains the
architecture program and marks the Phase 2 state rolled back rather than deleting the
assessment history.

| Path | Current SHA-256 |
| --- | --- |
| `change-manifest.md` | `7753d296bd5c07fcbbc2035321a9241400f424ad4339c95f56860812fd1081b4` |
| `rollback.md` | `320c37db180610f25c934827c91b994319a9f58c8fe209a862d6989d478f07df` |
| `task-ledger.md` | `364560df8e2a4124a16dd3a48965b3a4c0d75a56d56e8f2c6e4069d85ad2df7a` |
| `reviewer-status.md` | `c2791458b007c333a641d67293a92b687d4a72efaf4f2487bdc6140008f6a127` |
| `issue-register.md` | `9682002f800171cc7d53eb3dc0be7599040f3045784b36e1cbd2b52cc474ad7a` |
| `repair-graph.json` | `ec72658328c3d30452ca3138fa27f8cad55b0d19021e0bcf849a2c4b06b622de` |

This file intentionally has no self-digest. Any later edit to a listed file invalidates
its row and requires manifest regeneration before rollback or proof may rely on it.
