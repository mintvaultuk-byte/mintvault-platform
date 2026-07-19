# Trusted Intake Connector — G3F Load Model

Deterministic. The scale test seeds by a fixed integer sequence (no
`Math.random`, no wall-clock in IDs) so every run produces identical
inputs and identical expected outputs.

## Connector population (exactly 100)

| Category                | Count | Seeded state at run start                                                                                                | Expected terminal effect                                                                                    |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Valid, ready_for_import | 70    | `ready_for_import`, valid completed validation run, live claim released so a worker can claim                            | 70 destinations, 70 completed mappings, 70 completed attempt rows                                           |
| Stale-after-validation  | 10    | `ready_for_import` + a post-validation source mutation (customer/card edit) so the import-time fingerprint recheck fails | 0 destinations; each routed back to `validating`; 10 `stale` attempt rows                                   |
| Cancelled               | 5     | `cancelled` (terminal)                                                                                                   | 0 destinations; worker skips (not claimable)                                                                |
| Invalid/rejected        | 5     | `rejected` (terminal, validation produced blocking findings)                                                             | 0 destinations; worker skips                                                                                |
| Expired-claim           | 5     | `ready_for_import` with `claim_expires_at` in the past and a stale claimant                                              | recovered: reclaimed by a worker, then imported → 5 destinations                                            |
| Interrupted/reserved    | 5     | `ready_for_import` + a forced stale `reserved` mapping row (simulating a crash mid-reservation)                          | resumed in place → 5 destinations, 5 completed mappings (the SAME reserved row completed, not a second one) |

**Expected importable count = 70 (valid) + 5 (expired-claim) + 5
(interrupted) = 80 destinations, 80 completed mappings, 80 unique
references, 80 completed attempt rows.** The 10 stale + 5 cancelled + 5
rejected = 20 create no destination.

## Duplicate / lost-response pressure (layered on subsets of the 80 importable)

- **≥5 valid connectors × 20 concurrent duplicate import attempts each** —
  each set returns exactly one destination; 19 of 20 return
  `already_completed` with the identical destination id.
- **≥5 imported connectors × 20 post-commit retries each** — all 20 return
  `already_completed`, zero new submissions.
- **≥5 expired-claim connectors × 3 simultaneous reclaim attempts** —
  exactly one reclaim winner each; losers get `already_claimed`/`stale_claim`.
- **≥5 connectors × simulated lost-response after commit** — the harness
  discards the first successful response, then retries; the retry returns
  the same destination.

## Organisation / location / customer distribution

- **5 Partner organisations**, **2–3 locations each**.
- Connectors distributed round-robin across orgs/locations.
- **Repeated customer identity across organisations**: a fixed set of email
  addresses is reused across _different_ organisations. Assertion: each
  `(organisation, partner_customer)` pair resolves to its own MintVault
  user; the same email in two different orgs never cross-links to one user
  (proves the G3 `(org, partner_customer_id)` keying, never email).

## Item-count distribution (across the 80 importable, deterministic)

- 20 connectors × 1 item
- 20 connectors × 2–4 items (deterministic 2,3,4,2,3,4,… cycle)
- 20 connectors × 5–10 items (deterministic 5,6,…,10,5,… cycle)
- remaining 20 importable × deterministic mixed counts (1..8 cycle)

`submissions.card_count` must equal the exact number of `submission_items`
rows created for each (quantity-expanded where a Partner card quantity > 1,
though this load model uses quantity 1 throughout for count determinism).

## Concurrency parameters

| Parameter            | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| Concurrent workers   | 10                                                                                |
| Connector pool `max` | 12 (workers + small headroom; explicitly set via `PARTNER_CONNECTOR_DB_POOL_MAX`) |
| Claim lease          | short in test (e.g. 30s) so expiry cases fire deterministically                   |
| Retry limit (worker) | bounded (e.g. 3 per record)                                                       |
| Backoff              | deterministic (fixed small delay in test, no jitter needed for correctness)       |

## Expected aggregate outcomes

| Metric                                    | Expected                                                         |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Destination submissions                   | 80                                                               |
| Completed import mappings                 | 80                                                               |
| Completed provenance attempt rows         | 80                                                               |
| Unique tracking references                | 80 (all distinct)                                                |
| Duplicate destinations                    | 0                                                                |
| Duplicate mappings                        | 0                                                                |
| Duplicate completed provenance            | 0                                                                |
| Stale attempt rows                        | ≥10 (one per stale connector; possibly more if a worker retried) |
| Connectors routed to `validating` (stale) | 10                                                               |
| Connectors reaching `imported`            | 80                                                               |
| Cancelled/rejected creating destinations  | 0                                                                |
| Permanently stuck leases after run        | 0                                                                |
| Checked-out pool clients after run        | 0                                                                |
| Deadlocks                                 | 0                                                                |
| Unexpected `manual_review` rows           | 0                                                                |

Reported numbers in PERFORMANCE-RESULTS.md are actual observed values from
the run, not these expectations.
