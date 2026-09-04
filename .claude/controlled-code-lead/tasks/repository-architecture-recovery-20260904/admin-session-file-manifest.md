# Admin identity/session exact file manifest

**Owner-directed checkpoint:** `2913bcb1092ea8f43ee1294b711a8df653a06a3d`
**Pre-wave dirty-diff SHA-256:** `e612faf38358956b1a0b485d365f545293359cbd440c9c631a28a7d7cc613633`
**Candidate:** local dirty WIP; no immutable candidate SHA exists
**Files:** 84
**Aggregate path/digest SHA-256:** `8d984be5b749eebde98fa5ebdef1b638306c5e866ecd37a7a110c3fddf3f3e35`

The aggregate hashes the sorted stream `path NUL file-sha256 LF`. Each row binds the
complete current bytes of a functional, executable-authority, or focused-proof file
changed by `REPAIR-ADMIN-CONTRACTS`. It intentionally excludes mutable governance
records, this self-referential manifest, pre-existing Phase 2-only corrections, build
output, Graphify output, and dependency installation state.

| Path | Current SHA-256 |
| --- | --- |
| `client/src/App.tsx` | `3668fc98cdd74e32d058037d98de1b9076eb28878e8db86cea155e948d8882bf` |
| `client/src/components/admin/admin-shell.tsx` | `cfd24d06acb7422077017bda76e6eabf38da471d36828a8dc984f2abd3495eee` |
| `client/src/components/admin/admin-step-up.tsx` | `556cf1267aa299289ac93cbae552f5e5fcd90d2c4c8b27d57da9aa6c3b0fd335` |
| `client/src/components/card-identification/CardIdentifyPanel.tsx` | `43e899a18c8bdb64a9a6d4ec304b4e5c1b6141195fd6c00d37500df7e8bb138e` |
| `client/src/components/certificate-form.tsx` | `7a64552622e9f902ce279093c14eb0d574388bee81c02a5d2331e46445162674` |
| `client/src/components/grading-workflow/CertificatePreviewPanel.tsx` | `a88b03aa2e0b29e12d194446f6c924b2acce340553febefb22ca747db482528f` |
| `client/src/components/grading/ai-panel.tsx` | `cfb2f882f7624e1b488a17ca5dfc923cbcd92649d47f2ed226f786f07db62650` |
| `client/src/components/grading/capture-wizard.tsx` | `88f2ee51aeb0dc9438fa72f022ac98a7449392077fae94a066fbb21234294ec3` |
| `client/src/components/grading/crop-tools.ts` | `fb1550be369df9240dbe4be70e0328a00a63d5be41f905771d56cb9c83ec0e06` |
| `client/src/components/grading/grading-panel.tsx` | `157476a7554aaf1edcd311f5d94924eef1df0964353edbacc80613e9c066e06d` |
| `client/src/components/grading/grading-queue.tsx` | `e315b37bf7d18bf7fbdc7b303c15665229345c95e0719cd5bdfb773235e81e5b` |
| `client/src/components/grading/image-viewer.tsx` | `a3458c6677d71516b1f17d7e9457882b593f170beb3101e28cc5904de1175a6d` |
| `client/src/components/grading/manual-card-tool.tsx` | `3c3f57f6f144bc95a88b8c0b50dceb4d6bfb89f258726f1234abc520b13c3c5a` |
| `client/src/components/grading/manual-centering.tsx` | `8c3f1c80c4d249e24b634e1e203289800b35da537942cd338cd50253180ffac3` |
| `client/src/components/grading/manual-crop.tsx` | `f334acab265d8aae7a3b7d660683612ce2d66c1be30257a880b9f4acd4405de8` |
| `client/src/components/identity-tools.tsx` | `d141be680bdee65fc85a1610663ac37ac17ac9dac6ebf941db8222a0a6258d5a` |
| `client/src/components/ownership-section.tsx` | `7612339048154d807b48847350b0635c401ed98039ed26519a3e7d837c0ac866` |
| `client/src/components/vault-quest/workflow.tsx` | `f90d5e0de9976eb2b0407a900fe3cd0798e01fc5e8f46a7bb0438e39ba133e47` |
| `client/src/lib/admin-session.tsx` | `48984576a6c11b8215ed7d85d141985e9651173c48af4a783a78ce60ff655cbf` |
| `client/src/lib/queryClient.ts` | `3fcbab590bf8e8ab685ec1c6cbe16fecd458710b96b13accaca983da7d2c23e6` |
| `client/src/pages/admin-capture-health.tsx` | `d0cd74c4015b73557e77f680e7c66dd80e026e50e1b7eab383cc6df8c3f2857d` |
| `client/src/pages/admin-catalogue.tsx` | `422270c8d30b0236bbd18458fe582c3eecdb6c63a460343118859d6823eae936` |
| `client/src/pages/admin-cert-browser.tsx` | `ffffa349ff98f64fd8f2f76779cc92ac503b4dd6b855707b427886b42dfce742` |
| `client/src/pages/admin-claim-register.tsx` | `22f461a8811f6463e6680f73c093e7efc18956e7805eeced8b3bdc60a75b141d` |
| `client/src/pages/admin-command-centre.tsx` | `29e9127e49818b20fc8cc2eba1b9bb007032cb6521da26e0ab97a0523461230b` |
| `client/src/pages/admin-dashboard.tsx` | `1309f83f99b446dd582496319e3e6c1dfb1df18b867dc6a01a5a1c93ed6909a9` |
| `client/src/pages/admin-divergence.tsx` | `a10fd828c18784dc7ee8a8bb180e7fb6429abefe6aaf9f4dad082e904a194b57` |
| `client/src/pages/admin-graders.tsx` | `d163e11ab1ed7023c7d3a8cacc72703ac42dd37975f05a25a7bd83b0163432cf` |
| `client/src/pages/admin-instagram.tsx` | `dc7fecab3df7c842850ac6e02b63834f0ef1ebcac5b27b9cc7d8166e21e779f3` |
| `client/src/pages/admin-learning.tsx` | `0275e539bef72318247fc88dd676dcf028c3628cdcc44edfca90ed0d8fa53219` |
| `client/src/pages/admin-legacy-review.tsx` | `58b877a78cb802ebc178821e122340de655e50cc5a10d6193e8fba76d82d34fd` |
| `client/src/pages/admin-login.tsx` | `5f7de03f4b722943b500a311e4defb6d1eb3da729fd477748ba991ce5e0d0aa3` |
| `client/src/pages/admin-operator-stats.tsx` | `62872ea186d4c02837dd521cccc219e878a1f2659754b818140b19ca30efa9cb` |
| `client/src/pages/admin-pokemon-knowledge.tsx` | `b799b80381fba9355658b1a3fce992896e26795029110a68020f39a5e83f894a` |
| `client/src/pages/admin-printing.tsx` | `d4a86348a08c482b43df8e89c5d27c4b2529c4a417f71a555f2c4adccf2b2c04` |
| `client/src/pages/admin-scan-history.tsx` | `21fdaeeafb01bb063bc782addb62977b3b280e0082b13c8bda3b3429e671c51b` |
| `client/src/pages/admin-security.tsx` | `139a903c5eed53795ffdd5ea02840756f2c8fa2cb1b2e88ff77126e362bdfc68` |
| `client/src/pages/admin-sets.tsx` | `b5031fa58ed7c4a5f4c2c047a560a9f871d4033888d9bb93c5b0abd34f00f25c` |
| `client/src/pages/admin-social-studio.tsx` | `4eeab92f6d9b43454ed1fd55fe79741b60e86591c6446ed9f37a3052401f73c6` |
| `client/src/pages/admin-staff.tsx` | `d34740f109fd904a55f31879bdde00e36504a6d428d8a4c7e0af90338ecdd7b4` |
| `client/src/pages/admin-submissions.tsx` | `290321fff46251d1b09269a569f263bab7239bc3401229cdc527a9cac8bd91eb` |
| `client/src/pages/admin-vault-quest-card-factory.tsx` | `c8a3dc44a4954aacace3bcebbd1c39b2c623e545ffe801bd9a6e3bedafb346bf` |
| `client/src/pages/admin-vault-quest.tsx` | `15ffcaaa9145e307c1ecffb226aab1f516dcf1214b7d6cb37008d219ade0f61c` |
| `client/src/pages/admin-weekly-reel.tsx` | `dcaa7928505df193785fbd9bdd010f5728ad21729733bf322c099cd2512d4b11` |
| `client/src/pages/admin.tsx` | `36d1b97cbd4f86d194ad408bafd94c4dcb3e5cdb68f0d1ec7b8d61698b9eab49` |
| `client/src/pages/admin/community.tsx` | `1cb9c28e33f9a0185ca8516dd2961710068e311862650510548010d0dcf74a84` |
| `client/src/pages/admin/growth.tsx` | `345dfe22ab4db29fc3314233e6573736ecc4ae74397124ac70aa4232934ec986` |
| `client/src/pages/admin/partner-dashboard.tsx` | `27b13da7439fc64f36b057b5fd43c7a5909541a7071be6cd7170d3674c05db7e` |
| `client/src/pages/admin/partner-first-shop-onboarding.tsx` | `f6f0ee063bf77b83aa8dea488c23a94fc6d4382cac7404276c3df3f578ffc7ad` |
| `client/src/pages/admin/partner-management-detail.tsx` | `ab1909548b17be68ae5bf0abaab70c3dcdda17e3c9d6c662f987db7a1037ed6f` |
| `client/src/pages/admin/partner-management.tsx` | `0c469036984ccdaf399579d7b2c7dc683d0003bc8c9ecfe01a1eda47b1ef8ad6` |
| `client/src/pages/admin/partner-network-overview.tsx` | `3ff52a685cde88ad85ac19b62e3a7bbc29f1b8f227a4768f7411ebe4e9681d0c` |
| `client/src/pages/admin/partner-network-shops.tsx` | `f16ce3dc83b0a40e0c69c47084007e6dba996e428be660848fe22c9ba4c827bb` |
| `client/src/pages/admin/partner-network-stations.tsx` | `2265d8ee94818f12a737fd513a199c6780ef3d70a8c6bde96055aefe64ab8411` |
| `client/src/pages/admin/partner-network.tsx` | `127c02f00675a5b6f17ddda24bc10ca8485ccc380140e7c29741220774e1f158` |
| `client/src/pages/admin/partner-supplies-orders.tsx` | `430abb37813cb139f8616657e90a66b94803272964821028513dc4001d5e70b9` |
| `client/src/pages/admin/partner-supplies.tsx` | `9a99f660c6b19d6159793305e14b242f9cdece14c3cdd37fb1abbb73c8057ef9` |
| `client/src/pages/admin/project-control-package.tsx` | `d45cfb740f9edf96dc3201bee342e3f07b79b6bac62bda0b0d62af8867fda0dc` |
| `client/src/pages/admin/project-control-scanner.tsx` | `c6ca4d2af32f3f32de75779e6cce16da32e565a7f4209d5fd9670aaabf715896` |
| `client/src/pages/admin/project-control-shop-launch.tsx` | `b953030d5c3e4ce79c9e4516831bddb488344610970b2df4a53188d0ffe2447e` |
| `client/src/pages/admin/project-control.tsx` | `91efdbb1808c7fad06300fc610d1c494a2920250c25816350ad26287909ab6d8` |
| `client/src/pages/admin/supply-orders.tsx` | `370664bfea8f57a66ecdc46f6be2e8b4b1cf25db2eb4e4335830626d6eebe57a` |
| `client/src/pages/dev-admin-shell-geometry-harness.tsx` | `5b197551ff5224099c75b7194398f8a911e3be5a02458b227d4f570d555cd71b` |
| `client/src/pages/dev-canonical-workstation-harness.tsx` | `920d094c37f7a47b070c30e63518abec786afbc8e0ecd6836543ecfe3436549d` |
| `client/src/pages/dev-growth-command-visual-harness.tsx` | `281af0ff41eb1af86c3a27154a731ee39364d0142a1d9194d4d9eebebb437748` |
| `client/src/pages/logbook.tsx` | `14c65b4edf281ac3a0e5b4772ee14cc9ce3f5c44dcb95ee2ebf728b26d9c1d7b` |
| `config/components/core-runtime.ts` | `debb4da97f3e221b03eaac94adfbe91dea6bba052ca93aa68b408ee2262a86db` |
| `config/components/identity-session.ts` | `f76865b25ec59f6cb31c9bbd69e109be1f8e6a1d22355803f739220a15e637a9` |
| `docs/engineering/ARCHITECTURE_AUTHORITY.md` | `0674dfd9b934ef56b9d1105d676556fd5877b46c117d315c307ab4e68e0def85` |
| `scripts/architecture/authority-policy.json` | `2697c9b0ccdebc9b17a5f05080575453eab4a113eefeca9a5b1fbb0131271c92` |
| `scripts/architecture/check-architecture.mjs` | `05c5526de75244da433636dd2a2e2bd040c48fead854c4490c856291ad926242` |
| `scripts/architecture/generated/architecture-authority.json` | `32ea0261f094aa6bfb816bf35b71defe45bc56f2126550e8a774295d9b4c27d5` |
| `scripts/architecture/legacy-authority.json` | `dc3dd75e2c89a3c684401e36e31bb3b131f7d78a7681fe2380e663a14afc1e00` |
| `scripts/ci/typecheck-baselines/architecture.json` | `44cbc1fe5a4c6a1fbde8933598a3c440ec1b0f07e9997629b48f0d7cba59fc0f` |
| `scripts/ci/typecheck-baselines/tests.json` | `7fcf04884d882d40708faf852b482d7b9208960ad2536b10e00d82c70c71c4ac` |
| `server/routes/auth.ts` | `c000c3f9632df4d486da2d842a88726599970497e00d96da9d9529c33b780db4` |
| `tests/admin-auth-reliability.test.ts` | `310d433952b04dc7e18d6d34ccd4f8d8a2e1a30fcd36c058d5430c52437020fd` |
| `tests/admin-session-contracts.test.ts` | `45a436b4b5a95b8fc1152595f993f63aed0c103fe5b35afdb62416c0686c39a5` |
| `tests/admin-station-approval-step-up-ui.test.ts` | `4172abc6aeb86eedb2e1370776a4260c93fdee17ef1747eba488ed2aec4d4a0f` |
| `tests/architecture-authority.test.ts` | `f83bdce92f68c111d2c1d053d22a40fadd6f6e6eb8252a056de7db3cad1ae513` |
| `tests/command-centre-ui-runtime.test.ts` | `d0f0109ea3a2a0ca85b7f1598c6a10bf883dd3315036c5b52644bd54b549a299` |
| `tests/partner-dashboard-admin-ui.test.ts` | `ab5f8a6e7d4a15b773d998a11bf706698571c507e5087f92789116e2f6c4683a` |
| `tests/partner-management-admin-ui.test.ts` | `20dfcca0682328e73f0986b823575667928c1c71ac931df37cc02ee762cbba13` |
| `tests/partner-network-admin-ui.test.ts` | `22efb63613b73fe42b4e1a40d149a5051b808774ef272f461616fa12a14cd6f7` |

Any row mismatch invalidates this manifest. Regenerate it only after adjudicating the
change; never silently adopt drift. The historical Phase 2 manifest remains a separate
boundary and must not be rewritten to absorb this product repair.
