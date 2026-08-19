# Growth Infrastructure Control Design

## Authority now

The implemented authority is strictly:

`MONITOR → DETECT → RECOMMEND`

The active control mode is `MANUAL`. Fly machine count/CPU/RAM, Neon compute/storage, production database capacity and infrastructure spend cannot be changed by the Growth UI, its Super Admin read endpoint, or the Growth MCP identity. There is no Scale, Resize, Budget write, automatic shutdown, or automatic-spend control.

Current data truth:

- MintVault commercial money is verified GBP and rendered as GBP/`£`.
- Fly fleet telemetry is `NOT_CONNECTED`; the client receives no machine rows, token, host, provider configuration, or invented fleet count.
- Neon database availability is the bounded application readiness check. Neon connection pressure, latency, compute, storage and point-in-time recovery telemetry are `NOT_CONNECTED`.
- Fly, Neon, R2 and Resend billing are `NOT_CONNECTED`; no cost, trend, unit cost or FX-normalised total is estimated.
- The monthly infrastructure budget is `NOT_CONFIGURED`; its state never shuts down production or authorises spend.

## Read-side adapter boundary

A later provider adapter may be connected only after the owner approves the exact provider contract and a least-privilege server-side read identity. It must:

1. Run server-side; no credential, raw provider response, internal host, or provider control endpoint reaches the browser or MCP response.
2. Request only the exact production app/project/account and only the metrics or billing fields approved for display.
3. Use bounded timeouts, bounded result size, bounded refresh/cache cadence, and a last-success timestamp.
4. Return `NOT_CONNECTED`, `STALE`, `ERROR`, or `UNKNOWN` when authority is absent or incomplete. It must never turn absence into zero or green.
5. Preserve each authoritative provider cost in its source currency. A GBP-normalised total requires a separately approved, dated and traceable FX authority.
6. Contain no write method. Read connection approval does not imply scaling, budget or database mutation approval.

When Fly read authority exists, each safe machine row may contain only a non-secret display reference, status, region, CPU, memory, request pressure, p95/latency, 5xx health, and deployed version/SHA where the disclosure is approved. Overall Fly status remains unknown unless the required fleet-wide signals are complete.

## Future `GUARDED AUTO` package

`GUARDED AUTO` is a design state, not an available mode. Activation requires a separate infrastructure-control package, owner approval and hostile review. It must use a separately scoped privileged identity that is unavailable to the Growth read endpoint and Growth MCP identity.

Before any write, the package must enforce all of these durable owner-approved limits:

| Guardrail                        | Required behaviour                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Minimum machine count            | Never cross the production redundancy floor.                                                                              |
| Maximum machine count            | Reject scale-up above the exact approved fleet count.                                                                     |
| Maximum approved capacity        | Bound per-machine and total CPU/RAM; reject unapproved shapes.                                                            |
| Monthly infrastructure budget    | Refuse new automated spend above the approved ceiling; do not shut down production merely because the ceiling is reached. |
| Cooldown period                  | Prevent repeated actions before the fleet stabilises and fresh telemetry is available.                                    |
| Sustained pressure window        | Require multiple complete windows; a single spike cannot spend.                                                           |
| Sustained low-utilisation window | Require a materially longer stable window before scale-down.                                                              |

Every proposed action also needs an explicit cost preview in authoritative currency, the post-action fleet shape, reason/evidence, owner confirmation policy, idempotency key, append-only audit record, bounded execution timeout, result verification and tested rollback/containment procedure. A recommendation or an AI/MCP request can never satisfy owner confirmation.

## Correlated Fly scale-up

A future scale-up recommendation may be eligible for guarded execution only when complete fleet telemetry shows sustained correlated pressure. Examples:

- CPU above an approved threshold **and** p95 latency/capacity degradation; or
- memory above an approved threshold **and** p95 latency/capacity degradation; or
- degraded healthy-machine count where adding/replacing capacity is the reviewed remedy.

Request rate is context only and never an independent trigger. Elevated 5xx must be interpreted first: application, dependency, payment or database failures may not improve with more machines. Database pressure must route to investigation or a separately approved Neon recommendation, not blindly add Fly capacity.

## Safe scale-down

Scale-down requires complete healthy telemetry, a sustained low-utilisation window longer than the scale-up window, stable latency and error rate, no active revenue-path incident, no campaign-readiness red/amber restriction, no pending deployment, and expiry of the cooldown. The proposed shape must remain at or above the redundancy floor and retain sufficient regional/capacity headroom. A transient traffic fall, quiet hour, missing signal, cost threshold or budget breach is never sufficient.

## Neon and budget boundary

Neon remains monitor/recommend only. Future recommendations may be `NO ACTION`, `INVESTIGATE DATABASE`, `CONSIDER DATABASE CAPACITY`, or `DATABASE PRESSURE — OWNER ACTION REQUIRED`. Any Neon write needs its own privileged contract, cost/availability impact preview, explicit confirmation, audit, verification and rollback. It must not be coupled to Fly automation.

Budget states may later be green/amber/red from an owner-configured GBP budget and authoritative provider costs. They are decision support: revenue availability takes priority over blind cost cutting, and no budget state automatically stops production.

## MCP and AI boundary

Growth MCP exposes aggregate read tools with non-destructive annotations. It has no infrastructure provider credential and no scaling, database, budget, deploy or cost-write tool. Future infrastructure writes must remain in a distinct privileged service and identity. No autonomous AI infrastructure spending is permitted.
