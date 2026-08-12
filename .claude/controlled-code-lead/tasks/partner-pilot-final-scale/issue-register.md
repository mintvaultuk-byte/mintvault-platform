# Issue register — Partner Pilot final-scale completion

| ID | Summary | Source | Severity | Confidence | File/route | Class | Lead-verified | Proof level | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Scanner cannot atomically reserve one credit and create its own card workflow. | workflow/security + scanner review | blocker | confirmed | `renderer/app.js:537-559`; `station-routes.ts`; `submission-service.ts:894-927` | B/C | yes | Designed | accepted | Existing Scanner can only claim a pre-armed target; local repair must reuse server credit/connector authority. |
| F2 | Imported uncaptured certificates are presented as Ready to Grade. | workflow/security + scanner review | blocker | confirmed | `grading-routes.ts:417-499` | B | yes | Designed | accepted | Queue needs both current station-bound TIFF masters, and safe image facts, before visibility. |
| F3 | Scanner version enforcement can permanently reject a newly upgraded app. | scanner review | high | confirmed | `station-service.ts:396-477`; `main.js:405-415` | B | yes | Local Proof | implemented / locally verified | `signedHeartbeatAppVersion()` accepts only signed heartbeat JSON, persists only a forward version in the replay-safe update, and focused test + typecheck pass. |
| F4 | R2 finalisation materialises a full TIFF in Node heap; admission is process-local. | scanner/scale review | high | confirmed | `routes.ts:10408-10422`; `scanner-evidence-admission.ts` | C/F | yes | Designed | accepted | Needs streamed staging retrieval/bounded finalisation and a durable retry-safe boundary; R2 integration evidence remains external. |
| F5 | No measured 5,000-station/1,000-finalisation evidence exists. | scanner/scale review | blocker for scale verdict | confirmed | Scanner cadence, Partner pools, no harness | C/D | yes | Designed | accepted | Build a non-production harness and record only real measured results; no scale claim before it runs on an explicit safe target. |
| F6 | Partner production runtime URL points at a nonexistent/different database target. | runtime/migration review + live probes | blocker | confirmed | live Fly v1076; `partner/db.ts:54-80` | D/G | yes | Production Proof of safe refusal | external owner gate | Role is correctly restricted; the configured URL cannot resolve and does not target primary `neondb`. |
| F7 | Required Partner migrations are pending, including 0075/0076; 0076 also depends on 0041–0043. | runtime/migration review + production journal | high before migration | confirmed | production journal through 0073; `migrations/0075`, `0076` | E/G | yes | Production Proof of absence | external owner gate | Do not broad apply. 0074 is security follow-up, not first-card runtime prerequisite. |

## Rejected findings

- None. F1/F2 duplicate reviewer observations are consolidated rather than counted twice.

## Deferred/externally gated findings

- F6 — owner must supply the actual restricted same-production-database runtime endpoint; secret values are never read or recorded.
- F7 — each migration requires a fresh redacted journal check and specific owner approval before execution.
