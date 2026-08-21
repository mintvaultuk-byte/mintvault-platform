# Implementation budget — Growth Command approved visual target

**Written:** 2026-08-20, at Stage 4, before source edit

## Estimate

| Metric | Estimate |
|---|---|
| Files expected to change | 2 (`growth.tsx`, focused test) |
| Estimated lines changed | ±700 (revised before further source edits) |
| Estimated commits | 1 local checkpoint |
| Estimated tests | 1 focused regression plus type-check/build/browser render |
| Estimated duration | one session |

## Basis for the estimate

The existing intelligence response and component primitives contain every required authority. The scope is a single Overview composition plus a small deterministic presentation helper and test.

## The 25% rule

If actuals exceed any estimate by more than ~25%, stop editing, explain the diagnosis or scope drift, and revise this budget before continuing.

## Revision — 2026-08-20

The initial 360-line estimate omitted the dedicated presentational renderers required to keep all unavailable, low-sample, and safe-route semantics visible in the dense layout. The implementation remains within the approved single-route UI scope and the same two planned files; it does not add an API, telemetry collector, control, provider integration, or protected-system mutation. The Lead reauthorises this revised budget. No owner decision is required because the visual target explicitly requires these independently truthful panels and the scope has not broadened.

## Actuals (fill at Stage 6/7)

| Metric | Actual | Within 25%? |
|---|---|---|
| Files changed | 4 product/test files (plus task evidence) | revised for owner-approved DEV-only visual acceptance harness |
| Lines changed (`git diff --numstat`) | pending visual-harness finalisation | pending |
| Commits | 0 — local uncommitted candidate | yes |
| Tests | TypeScript; 19 focused Growth/telemetry tests; production build; graph; targeted changed-file lint; governance | yes |
| Duration | one session | yes |

**Overrun explanation (if any):** initial estimate was too low for the required explicit empty-state and evidence rendering.

## Revision — 2026-08-21 local visual acceptance

The owner separately authorised a safe non-production authenticated render only. No reusable Growth auth harness existed, so this revision adds a DEV-only route and in-browser synthetic fixture that mounts the shipping page and blocks every unknown `/api/` request. It is not part of the production bundle, does not change production authentication or server routing, and has no database or provider connection. This is a local visual-acceptance aid only; it is not production evidence.
