# Consolidated defect register

| ID | Severity / confidence | Evidence and correction | Status / gates |
|---|---|---|---|
| PCD-HIGH-001 | High / high | Readiness could be inflated by lifecycle labels, duplicates and weak evidence; failed/skipped tests did not govern outcome. Conservative engine, de-duplication and adversarial tests added. | Fixed; no block |
| PCD-HIGH-002 | High / high | PCD governance records could be updated, deleted or truncated. Append-only function/triggers and real DB test added. | Fixed; no block |
| PCD-HIGH-003 | High / high | Direct runtime Sharp version had a high libvips advisory. Upgraded to 0.35.3; compatibility types fixed and verification rerun. | Fixed; no block |
| PCD-MED-001 | Medium / high | Separate endpoint loads repeated expensive scans. 30-second snapshot cache and in-flight de-duplication added. | Fixed |
| PCD-MED-002 | Medium / high | Scanner/database errors and values could expose paths, payloads or upstream details. Bounds, redaction and generic 503 errors added. | Fixed |
| PCD-MED-003 | Medium / high | “Snapshot” wording implied durable immutable persistence although prompts are in-memory. Changed to content-addressed wording; no writer exists. | Fixed wording; durable retention remains open |
| MIG-MED-001 | Medium / high | Numbered migrations cannot bootstrap legacy core tables from zero. Local disposable fixture was required. | Open; staging runbook gate |
| MRG-HIGH-001 | High / high | G6D owns unmerged `0019`; candidate owns `0020`. Future migration order is unsafe unless lineage is resolved. | Open; blocks merge/staging/production migration |

No critical defect was opened. Unresolved founder decisions and independent review are gates, not evidence that this candidate is deployed or approved.
