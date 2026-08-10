# Change manifest — mintvault-partner-onboarding-readiness

| Area                    | Change                                                                                                         | Classification | Recovery                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------- |
| Admin readiness service | Add explicit tenant-scoped MFA, wallet/credit, and public-listing summary reads to the existing read-only DTO. | D              | Revert the DTO additions. |
| Admin detail UI         | Render source-backed onboarding facts, correct the checklist, and link to the existing wallet drilldown.       | D              | Revert UI wiring.         |
| Local browser fixture   | Seed a synthetic active MFA factor and immutable ledger credit for the all-migrations proof.                   | A              | Revert fixture-only seed. |
| Focused tests/docs      | Pin tenant-source, truthfulness, checklist and browser proof expectations.                                     | A/D            | Revert with feature.      |

No authentication behaviour, payment flow, wallet/credit mutation, public-listing mutation, database
migration, RLS policy, device/station registry, scanner telemetry, provider credential, deployment,
or live environment is changed.
