# Change manifest — partner-full-pilot continuation

| File | Change | Class | Rollback |
| --- | --- | --- | --- |
| `server/partner/assignment-certificate-query.ts` | New read-only projection for legacy-card and Partner-imported certificate assignment. | C | Revert commit. |
| `server/routes/grader.ts` | Route the existing Super Admin picker to that adapter; no grading operation changes. | C / protected-adjacent | Revert commit; protected regression confirms MVGS code unchanged. |
| `server/partner/connector-admin-service.ts` | Represent valid per-card credit reservations as a list/count instead of an error. | C | Revert commit. |
| `client/src/pages/admin/partner-network.tsx` | Display the authoritative reservation list/count. | C | Revert commit. |
| focused tests | Pin the operator surface and genuine two-card database behaviour. | A | Revert commit. |
| task ledger records | Record evidence/rollback for this staging activation. | A | Retain as audit history. |

No schema, payment, auth, R2-signing, secret, or production action is part of this manifest.
