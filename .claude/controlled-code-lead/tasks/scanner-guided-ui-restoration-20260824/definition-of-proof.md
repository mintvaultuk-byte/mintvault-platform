# Definition of Proof — Scanner guided UI restoration (2026-08-24)

## Statuses

| Dimension                 | Status                                                       |
| ------------------------- | ------------------------------------------------------------ |
| **Design Status**         | final                                                        |
| **Implementation Status** | complete                                                     |
| **Verification Status**   | local package, regression and physical-screen proof complete |
| **Activation Status**     | local package acceptance complete; no Fly activation         |

## Evidence

- **What was run:** Scanner suite (165/165), compiled Scanner/partner proof (41/41), package build/verifier, root typecheck/lint/build, full Vitest (6,088 pass, 1,015 skipped, five known database-env-only failures), runtime-manifest inspection, and foreground physical screen capture of the exact arm64 1.5.4 package.
- **Observed result:** operational content and billing are unavailable until setup is `ACTIVE` and calibration is `VALID`; a non-operational transition closes a visible billing overlay. The foreground runtime declared STAGING and showed Location/Station/Signed-in identity plus only `Calibrate this Scanner` and `CHECK SCANNER HEALTH`; no card controls, preview/capture surface, credit/top-up affordance or stale banner were visible.
- **Where evidence lives:** `issue-register.md` SCN-UX-002, `engineering/ISSUE_REGISTER.md`, the renderer tests, and the current worktree source.
