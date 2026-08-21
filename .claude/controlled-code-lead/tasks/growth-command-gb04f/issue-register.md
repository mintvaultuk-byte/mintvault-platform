# GB-04F authoritative issue register

No finding is accepted before production and source attribution. The observed red p95 is an investigation input, not yet a capacity or application defect.

| ID | Summary | Source | Severity | Confidence | Class | Status |
|---|---|---|---|---|---|---|
| GB04F-OBS-001 | Fly aggregate p95 is a maximum-per-machine five-minute value. At 20:53 UTC, the 10s p95 belonged to `83d479c745d0d8` at ~2 rpm, with CPU/RAM/DB/observed 5xx healthy. Route, sample and dependency source are absent. | Live authenticated Growth proof + `fly-telemetry-service.ts` | MEDIUM | high for authority limitation; route cause intentionally pending production samples | H | LOCAL_PROOF_COMPLETE |
