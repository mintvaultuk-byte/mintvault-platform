<!--
Template: Definition of Proof (governance v1.1).
Every completed feature/fix must fill this in as part of the Stage 7 report.
The four statuses are independent — a feature can be fully implemented but
only Local-Proof verified, and the report must say so.
-->

# Definition of Proof — <feature / fix name>

## Statuses

| Dimension | Status |
|---|---|
| **Design Status** | not started / drafted / reviewed / final |
| **Implementation Status** | not started / partial / complete / complete-but-unwired |
| **Verification Status** | one of the five levels below |
| **Activation Status** | not wired / wired but flagged off / live on staging / live on production |

## Verification levels

Pick exactly one — the **highest level actually evidenced**, not aspired to:

1. **Design Only** — a plan, schema, or document exists. No running code.
2. **Local Proof** — exercised on the developer machine (unit test, local
   run, `npm run dev`). Proves the code runs, not that it integrates.
3. **Integration Proof** — exercised against real integrated pieces
   (real DB schema, real route wiring, real render pipeline) end-to-end
   in a dev/local environment.
4. **Staging Proof** — exercised on staging with staging data and staging
   infra, evidence captured.
5. **Production Proof** — verified live on production (correct commit via
   `/api/version`, behaviour observed, evidence captured).

## Evidence

- **What was run:** <exact command / flow exercised>
- **Observed result:** <actual output, not expected output>
- **Where evidence lives:** <log excerpt, screenshot ref, test output>

## Language rules (hard)

- Never describe something as **"fixed"**, **"done"**, or **"working"** if
  Verification Status is Design Only or Local Proof. Say exactly what level
  it reached: "implemented and locally proven, not yet integration-verified."
- **Complete-but-unwired** implementation (a pure helper nobody calls, an
  authored-but-unapplied migration) is never "complete" in a report — name
  it as unwired/unapplied, per the v1.0 Definition of Done.
- Activation Status must be stated even when embarrassing ("wired but
  flagged off" is a valid, honest state).
