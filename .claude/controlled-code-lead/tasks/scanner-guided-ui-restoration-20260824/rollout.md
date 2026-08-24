# Rollout — Scanner guided UI restoration (2026-08-24)

**Classification:** C

## Pre-rollout checklist

- [x] Scanner and project gates pass.
- [x] Fresh macOS arm64 package is built and verified.
- [x] The source version and package version match: 1.5.4.
- [x] One isolated Shop Games Scanner process was verified; it and all helpers exited cleanly.
- [x] State was read-only checked: no active capture, card job, pending start or upload; no station/approval/card/credit action was taken.

## Steps

1. Package the isolated Scanner source as a new arm64 `.app`.
2. Verify the compiled package launches directly, owns the expected isolated runtime manifest, and reports STAGING.
3. Observe the non-ACTIVE guided screen without clicking approval, signing in, enrolling, scanning, or opening billing.
4. Only after the owner visually accepts this repaired Scanner may the separate one-time staging approval acceptance proceed.

## Staging verification evidence (class C+ only)

- The exact 1.5.4 arm64 package declared STAGING in its own runtime manifest and was then cleanly quit. This package uses the existing staging API but performs no staging write in this rollout; staging remains `8b117946` / v589.

## Who/what is affected

- The single local Shop Games Scanner acceptance instance only. Shop 0, production, and all card/credit records remain out of scope.
