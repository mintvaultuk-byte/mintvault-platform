# Admin print/reprint exact file manifest

**Owner-directed pre-wave checkpoint:** `2913bcb1092ea8f43ee1294b711a8df653a06a3d`
**Pre-wave tracked dirty-diff SHA-256:** `12dda2cf31173444a33347dcf5a763788084e530381e11dfe042e5c2ee45c04c`
**Pre-wave untracked aggregate SHA-256:** `6a4c86f18e3e23551d6ba6c65b728349ccd7de9b84de74cf4db11972d4d869e2`
**Candidate:** owner-directed wave-end WIP checkpoint commit (self)
**Files:** 26
**Aggregate path/digest SHA-256:** `87d755e7563bff6a68a1f9eb2dc3dd628ade070666d24b63f77efc313138535c`

The aggregate hashes the sorted stream `path NUL file-sha256 LF`. Each row binds the complete
bytes of a functional, executable-authority, or focused-proof file changed by
`REPAIR-ADMIN-PRINT`. Mutable governance records, this self-referential manifest, unrelated
pre-existing WIP, build output, Graphify output, and dependency installation state are
excluded.

| Path | Current SHA-256 |
| --- | --- |
| `client/src/pages/admin-cert-browser.tsx` | `c3c860511bc80cfacf77b053daa90c1587fee8f1af848b43452fd1e578b586fb` |
| `client/src/pages/admin-print-queue.tsx` | `7a30a748060fbfe08a4fca499e60720ba664b0528c008881f2a891ffe751b473` |
| `client/src/pages/admin-printing.tsx` | `a15fe3b43e9d083c5e9acd352a12a13b18e92c6a4cc9c6255417ae987aa70a0e` |
| `config/components/index.ts` | `6a3d27d58728786bafaa2e40798a6edb750a0fe1dda5506ee7d4620cd379f42b` |
| `config/components/print-workflow.ts` | `eb24cc7d8db7be140be07893522cac1d53b84e313726b85699728a37aa578a15` |
| `docs/print-workflow/AUTHORITY.md` | `a4425026a5109b54ce080e215efa3d8d97a32243f23d6409bb380a9a0508a111` |
| `scripts/architecture/authority-policy.json` | `8342eeed32e22b284313b721e368398eb81c2e230a0a55e9a88d8ece61eca34e` |
| `scripts/architecture/generated/architecture-authority.json` | `0933daee49b85d777df873d96d36fe0306f5fe70660c0ca1f4795a20f6e9d2bc` |
| `scripts/architecture/legacy-authority.json` | `0b973a2f1010dc546182916efa9725efc31b824ae1c7dbbf5d5123f64d754db7` |
| `scripts/ci/typecheck-baselines/architecture.json` | `729739def6eddd0241904eb6bf10521987b29c2a7334fea678850942b6c06249` |
| `scripts/ci/typecheck-baselines/tests.json` | `9dd11c1587f1832c392ca6311e3ad563b8d2590b24b7d241e0c3a0dca7f3a5a3` |
| `server/lib/print-artifact-persistence.ts` | `1b6642d4d94270e6a3946fd28ad8c40a870f054977ecdcbf8ebbc3b61273fd4a` |
| `server/lib/print-output-eligibility.ts` | `86b80aab5419b752119ed2848e20ffc019196b32d16ff2d387db60d8e2f5c836` |
| `server/print-workflow.ts` | `cae3cab6522e4629646b8b5f5b3e7cb599037c2633932adf072d1ffb0955328b` |
| `server/readiness.ts` | `fc4f213abe0f9c931702e080602a97203338cd7d03e32ad2a8681e31175a2ab3` |
| `server/routes.ts` | `2055c1ec6601a0b1906f5eddb20e366bcab33a94863ee49f64552e1110ba77a6` |
| `server/routes/print-workflow.ts` | `0d2bf20411e809f818571f413ded1dd2ac09948eda9c0134afebd453fd1cb47a` |
| `tests/admin-print-contracts.test.ts` | `5c9d5dbefd9edbfe60bbadfbf78f0ff82daaef6fba3baf19602901bf06a3199e` |
| `tests/architecture-authority.test.ts` | `3a4ce407b75250a73ff0de7c398ed3baa12c7c57644d1633353729af4e5f0679` |
| `tests/main-runtime-role-readiness.test.ts` | `b66b0a89bbf39c2c9478e0bb6b9cadca776bafcade81c9cb009eb720c2688974` |
| `tests/partner-card-job-output.test.ts` | `003372548ba478f76792ff5d525ae3bacfc761c2d11903f9bd686d25fda51d4c` |
| `tests/print-approval-gate.test.ts` | `eb74b4f37c6a155e1c2ed9b5c7f19fc1ea5bc6b279503409f67dd686e5b5a28f` |
| `tests/printable-grade-safety.test.ts` | `bd8cc8106a39c4b8bb60db2ec4a5f0641a0c77c106d642875835b981a463b0d9` |
| `tests/print-workflow-readiness.test.ts` | `34159241b9097c6fcb830360c31ecad4eab21f8313fbff40e85e817810bf849f` |
| `tests/print-workflow-routes.test.ts` | `928e2875a680e183b389cea16e6c7c1c69fef7292135ed20a09d072d3f25d03d` |
| `tests/print-workflow-service.test.ts` | `9dfbd033ca5a46cc2e1903fe245cc014b1ea90ab362e63e17c9a8bb39be845d2` |

Any row mismatch invalidates this manifest. Regenerate it only after adjudicating the change;
never silently adopt drift. The historical Phase 2 and Admin identity/session manifests remain
separate and must not be rewritten to absorb this product repair.
