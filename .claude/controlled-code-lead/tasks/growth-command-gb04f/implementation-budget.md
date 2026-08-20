# GB-04F implementation budget

| Area | Maximum intended change | Guardrail |
|---|---:|---|
| Runtime telemetry | One existing process-local module and its response-finish caller | 60-minute bounded ring; fixed enums/templates only; no payload/path persistence |
| Growth intelligence | Existing aggregation service/types only | Read-only Super Admin response; deterministic insight only |
| Growth UI | Existing Growth page and focused tests | Reusable display components; no global style system or unrelated Admin changes |
| Capacity | Existing pure decision model and tests | Preserve manual mode and no-scale default |
| Tests | Focused telemetry/intelligence/UI contracts | No skipped/deleted tests |

Any need to change a payment, Partner, Scanner, AI, deployment, provider or schema surface stops this pass for owner direction.
