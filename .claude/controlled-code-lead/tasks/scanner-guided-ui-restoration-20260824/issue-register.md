# Issue register — Scanner guided UI restoration (2026-08-24)

| ID         | Summary                                                                                                                                                                                                                         | Reviewer/Source                                                                  | Severity | Confidence | File:Line                                                                   | Class | Lead-verified | Proof level       | Impl commit                    | Staging                     | Prod      | Activation    | Status   | Notes  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- | ---------- | --------------------------------------------------------------------------- | ----- | ------------- | ----------------- | ------------------------------ | --------------------------- | --------- | ------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SCN-UX-002 | Non-ACTIVE stations still render operational capture/billing UI; a prior billing modal can remain visually above the guided setup modal; an uncalibrated ACTIVE station can be blocked from calibration by zero-credit billing. | Independent physical screenshots; direct renderer/CSS trace and integration test | high     | confirmed  | `renderer/app.js` station/billing render paths; `renderer-workflow.test.js` | C     | yes           | Package + runtime | this Scanner UI release commit | `8b117946` / v589 untouched | untouched | not-activated | accepted | PROVEN | Operational UI is hidden by default and only rendered after `ACTIVE` + `VALID` calibration; non-operational transitions close billing. Scanner 165/165, compiled proof 41/41, package verifier and root gates pass. Exact 1.5.4 arm64 package declared STAGING with no active capture/card job/pending start/uploads, then exited cleanly. No Fly, database, station, approval, card or credit mutation. |

## Rejected findings (with reason)

- None.

## Deferred findings (with unblock condition)

- Physical desktop screenshot capture is deferred only as an external observation constraint: macOS Accessibility permission is not granted to Computer Use. The packaged app will still be exercised with deterministic renderer integration tests and the exact live process will be inspected read-only.

## Fixed findings (with evidence)

- SCN-UX-002 — proved by deterministic renderer/package tests and read-only packaged runtime inspection; direct Computer Use screenshots remain an external observation constraint only.
