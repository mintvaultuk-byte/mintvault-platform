# GB-04F change manifest

## Evidence-led scope

The current Fly p95 is a five-minute, maximum-per-machine provider aggregate. Live production at 2026-08-20 20:53 UTC showed `83d479c745d0d8` at 10,000 ms p95 with about 2 requests/minute, while both machines were healthy, max CPU was 0.514%, max memory was 17.642%, observed 5xx was 0%, and current-process database readiness was 4 ms. The provider aggregate contains neither route, traffic class, response sample count nor dependency attribution. It cannot truthfully identify the slow source.

## Permitted change set

1. Extend the existing bounded, process-local request telemetry ring with safe route-template and traffic-class aggregates, a machine identifier, deterministic low-sample handling, and a fixed dependency-timing summary.
2. Expose read-only performance diagnostics through the existing Super Admin Growth intelligence response, including top slow safe route groups, traffic-class p95s, sample sizes, dependency measurements and a deterministic evidence-only insight.
3. Correct capacity evidence so fleet p95 is explicitly contextual while customer/revenue route evidence determines whether latency is actionable; no mutation control is added.
4. Replace the semicircle gauge presentation with reusable premium radial-ring, digital/sparkline and status-tile components in Growth Command only.
5. Add focused tests and update governance records.

## Explicitly excluded

No database migration; no Fly, Neon, R2, Resend, Stripe, Google/Search Console or other provider configuration; no secret mutation; no CPU/RAM/machine count change; no auto-scaling; no payment, Partner, Scanner or separate AI programme mutation; no external telemetry service; no unbounded per-request storage; no PII, identifiers, query strings, payloads or tokens in the telemetry contract.

## Runtime behaviour

The response lifecycle remains fail-open: aggregation runs only after `finish` and is wrapped by the existing telemetry failure boundary. No request is blocked, delayed, retried or sent externally. The only new authenticated surface is data embedded in the existing Super Admin intelligence payload.
