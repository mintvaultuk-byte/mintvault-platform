# Phase 2 exact file manifest

**Committed baseline:** `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`  
**Candidate:** uncommitted local WIP; no candidate SHA exists  
**Digest:** SHA-256 of the complete file bytes  
**Generated:** after the local Phase 2 gates and before independent hostile round 2

This manifest defines the behavior-preserving architecture/readiness and CI-control
boundary. It does not include the five pre-existing White Ace test edits,
`.gitleaksignore`, the nested White Ace task, build output, Graphify output, dependency
state, or protected product behavior. The architecture intake/assessment, baseline,
phased plan, and validator records predate Phase 2 and are retained on rollback.

## Tracked files modified from the baseline

| Path | Baseline Git blob | Current SHA-256 |
| --- | --- | --- |
| `.claude/controlled-code-lead/INDEX.md` | `74d5ad64ed384d232cb0e3f412c3b536423af919` | `74dcc225518e2cdfb96f1ae851ba0def8baec7d6586585870f286cf0562f0b12` |
| `.github/workflows/ci.yml` | `d6c66bb2126c084696569e1401a68fd5483149df` | `77c43107c200c22d55d22dedf253a5b8c576f5a0beb1cbb8314cdefa0a407ddf` |
| `CLAUDE.md` | `ab49225bea8da730830f16ccaa3595a2b9388d1f` | `1e3b961dc3eed8be665ee39f6579490409b3ff973db3eaa9472e9c3294b8ac27` |
| `engineering/ISSUE_REGISTER.md` | `995f6f3e00eebfb7892fb1c8ad66f33e55c8737d` | `ea32801dd9d5bbf323dd962ca394aa1882339197de50e02b3356191da1e3fa72` |
| `engineering/PROOF_LEDGER.md` | `82e066516ac86dbe67e98a52faf16b72dd4ce997` | `2dc4b3d94a475c1d570b471f5911e049188cffcfceb165ec0e29ccf7789ea2ae` |
| `package.json` | `6605378b38f16b0c5e408c2a98e30e1aa0029cb7` | `782cc701394c0075c3667060d7dda8fe05f686cea8f47011bdbd2c0ee3bd3d93` |
| `scripts/ci/partner-suite-env-matrix.mjs` | `e952d854790fff4d80423b1123db074bd90ddc4f` | `4ef2ab08d52a26fa6ca5afdee17aee65e18049dd7b86e1fd511c476c06007811` |
| `scripts/ci/partner-suite-verdict.mjs` | `480c11fc3a643fe99d5857b6ea10340c8eb7a01a` | `407ac6823bbbc6959e42062adeb88d4013a9b33b04ea49084e51515cae6e7e6f` |
| `scripts/ci/run-partner-suite.mjs` | `e5f1f9a93eaf3a10c886859b688bab52452fd445` | `f79c6086d121aa616e0f566765b56549dfc372d336f30ccf0bdd774ad019a67d` |
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
| `docs/engineering/ARCHITECTURE_AUTHORITY.md` | `a85114bdd57d75aa9acd9d065cd96c8c5e459ccb162ce0cc539d7fce5e103f8b` |
| `scripts/architecture/authority-policy.json` | `e39b08b3a94ae5ebe44eb92f2e628e2a7b5f28a2960d8230be3633e5f3a26b95` |
| `scripts/architecture/check-architecture.mjs` | `7ee534814f70de4774cd2bfcebf796fa0b151bdca6fb6352a7df53824ebe0409` |
| `scripts/architecture/generated/architecture-authority.json` | `ea15fd116861ced11120e310ecd2153c519d057239e5c32c3bdfa6278cd18e82` |
| `scripts/architecture/legacy-authority.json` | `80952493c9766c60077f057e8122fbc8b343d9e72a72ddfd82af076cc8029413` |
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
| `scripts/ci/verify-ci-topology.mjs` | `843ddec9b0d4cae07531302e667773d8365e8742e035b12cd0bc16d2a5bbaf13` |
| `server/lib/component-readiness-registry.ts` | `f3ee58fd9a0750e648b31ced2ee883c039b7cbe0f20afdf502101090e349d209` |
| `tests/architecture-authority.test.ts` | `849ecf6b3b3e6932c594a221418a1064c9a7a69b9f42bab540e25bc519369f88` |
| `tests/ci-proof-topology.test.ts` | `a35308e2f8014dc2ee9ce08e92a75fb15588bc4331f9b37ebeece57a759cb6b6` |
| `tsconfig.architecture.json` | `e52430f7e907f07385c91e3c99fe217f7fc8b357b9dc928d0f837df61746a52b` |
| `tsconfig.scripts.json` | `2b939b0c699a3a593941bab4aeda184f8b4c6f48d7c048ad5a3a09a8b1c7fb35` |
| `tsconfig.tests.json` | `4c66478b4fa09b5213fbe84b9404f4e669258fd3323fe05746ee47e1b12ce6fe` |

## Phase 2 program records

These records are new relative to the committed baseline, but rollback retains the
architecture program and marks the Phase 2 state rolled back rather than deleting the
assessment history.

| Path | Current SHA-256 |
| --- | --- |
| `change-manifest.md` | `b2388158df22799b27b8b1947a5296821224c0f3546317892936714160adaf57` |
| `rollback.md` | `bedba4b4b49dd48e01934415a4aa3adb2cbc826176cb39df98a606ea8de1b862` |
| `task-ledger.md` | `d4d5cacf066eb8e8b431b6b948e1304450d9659c2f7b03146d470967b27852dc` |
| `reviewer-status.md` | `a073652a3c28b08724309c0ed2adddf169e3cc358fb1e4fd4ef2988835cb9584` |
| `issue-register.md` | `871f5053c1535fbc30c8a0c8b56008bd67f5e153b2b5ac04b0f0bb28fc1458bd` |
| `repair-graph.json` | `aa4af16aab3817b6e4d67263b64ceb0bfba0098cbb979249c87aa99777239d58` |

This file intentionally has no self-digest. Any later edit to a listed file invalidates
its row and requires manifest regeneration before rollback or proof may rely on it.
