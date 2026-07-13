<!--
Template: reviewer report.
One of these per reviewer, per task. Reviewers fill this in and return it as
their final output — they do not edit any other file.
-->

# Reviewer report — <scope name>

**Reviewer scope:** <exact files/subsystem/hypothesis assigned by the Lead>
**Date:** <YYYY-MM-DD>

## Files reviewed
- `path/to/file.ts` (lines X-Y)
- ...

## Findings

### F<N> — <one-line summary>
- **Severity:** critical / high / medium / low
- **Confidence:** confirmed / plausible
- **File:** `path/to/file.ts`
- **Line(s):** L123-L140
- **Route/endpoint:** `POST /api/...` (if applicable)
- **Root cause:** <the actual mechanism, not just the symptom>
- **Proof:** <the concrete evidence — log output, query result, code excerpt
  that demonstrates the behavior>
- **Reproduction:** <exact steps or inputs that trigger it>
- **Safeguards already in place:** <any mitigating factor, or "none">
- **Proposed fix:** <what would fix it, at a sketch level — the Lead decides
  whether/how to implement>
- **Required testing:** <what would prove the fix works>
- **Contract impact:** <does this touch a type/DB column/API shape another
  caller depends on?>
- **Classification:** A / B / C / D / E / F / G / H

(repeat for each finding)

## Clean areas

What was checked and found fine — be specific, this is signal too:
- `path/to/file.ts` — <what was checked, why it's fine>

## Explicitly not covered

Anything in scope that time/access didn't allow covering, so the Lead knows
not to treat silence as a clean bill of health.
