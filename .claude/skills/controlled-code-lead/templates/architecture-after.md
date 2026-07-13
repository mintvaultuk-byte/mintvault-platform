<!--
Template: After Architecture snapshot (governance v1.1).
Companion to architecture-before.md — same mandatory classes (D, E, F,
structural G, storage/deployment topology changes). Two moments:
(1) PROPOSED, written at Stage 4 alongside the change manifest;
(2) AS-BUILT, confirmed at Stage 6/7 from the live system. If proposed and
as-built differ, the difference must be explained in the Stage 7 report.
-->

# Architecture — AFTER — <task name>

**State:** PROPOSED (Stage 4) / AS-BUILT (Stage 6-7)
**Date:** <YYYY-MM-DD>

## Diagram

```mermaid
%% Same scope and notation as the BEFORE snapshot so the two diff cleanly.
flowchart LR
  A[Component] -->|flow| B[Component]
```

## What changed vs BEFORE

| Change | Why | Classification |
|---|---|---|
| <added/removed/rerouted component or flow> | <finding/decision it serves> | A-H |

## What deliberately did NOT change
<the invariants preserved — especially anything from protected-systems.md
that borders the change>

## AS-BUILT confirmation (fill at Stage 6/7)
- Verified against live system via: <commands/output>
- Deviations from PROPOSED: <none / listed and explained>
