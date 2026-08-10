# Change manifest — partner-full-pilot continuation

| File | Change | Class | Rollback |
| --- | --- | --- | --- |
| `server/partner/assignment-certificate-query.ts` | New read-only projection for legacy-card and Partner-imported certificate assignment. | C | Revert commit. |
| `server/routes/grader.ts` | Route the existing Super Admin picker to that adapter; no grading operation changes. | C / protected-adjacent | Revert commit; protected regression confirms MVGS code unchanged. |
| `server/partner/connector-admin-service.ts` | Represent valid per-card credit reservations as a list/count instead of an error. | C | Revert commit. |
| `client/src/pages/admin/partner-network.tsx` | Display the authoritative reservation list/count. | C | Revert commit. |
| focused tests | Pin the operator surface and genuine two-card database behaviour. | A | Revert commit. |
| task ledger records | Record evidence/rollback for this staging activation. | A | Retain as audit history. |
| `server/partner/connector-import-service.ts` | Start a completed Partner intake destination in the established `in_grading` state, so its later all-approved settlement follows the database's valid `in_grading → ready_to_return` transition. | C | Revert the bounded repair commit; no schema or data rollback. |
| `server/partner/grading-assignment.ts` | Correct the adjacent lifecycle documentation to match the importer state. No assignment or grading logic changes. | A | Revert the bounded repair commit. |
| `tests/partner-connector-runtime.test.ts` | Prove the real importer creates an immediately settleable `in_grading` destination, closing the draft-to-settlement gap. | A | Revert the bounded repair commit. |
| `tests/partner-connector-{import-service,g3f-blockers,scale}.test.ts` | Re-pin importer and scale proofs from the obsolete `draft` state to the real `in_grading` lifecycle; retain the no-payment/no-Stripe invariant. | A | Revert the CI-repair commit. |

No schema, payment, auth, R2-signing, secret, or production action is part of this manifest.
