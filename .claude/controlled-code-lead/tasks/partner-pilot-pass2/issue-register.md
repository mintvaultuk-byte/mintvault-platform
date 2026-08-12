# Issue register — Partner Pilot Pass 2

All issue IDs are `PP2-F<n>`. Findings are accepted only after Lead source and
behavioural verification. Historical ledgers are evidence, not current truth.

| ID | Summary | Source | Severity | Confidence | File/route | Class | Lead-verified | Proof level | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| PP2-F1 | Production Partner runtime topology mismatch closes routes. | runtime reviewer + live proof | blocker | confirmed | `server/partner/db.ts:54-80`; Partner routes | D/G | yes | Production Proof of safe refusal | external blocker | Owner must change only the restricted same-database runtime URL; no fallback exists. |
| PP2-F2 | Pass 1 server-authority commit is not in current mainline. | runtime reviewer + `git merge-base` | high | confirmed | `7368b07e` | B | yes | 204 focused tests + bundle/source boundary proof | source resolved | Integrated with `-x`; browser scoring modules removed and server resolves output. |
| PP2-F3 | Unapplied 0074 permits pg_temp provenance forgery. | runtime reviewer + `3df3e40e` | high | confirmed | `migrations/0074...:131-157` | E | yes | 17 real-PostgreSQL migration tests | source resolved | Hardened source is integrated; production application remains owner-gated. |
| PP2-F4 | Production migration journal is unknown. | runtime reviewer | high before migration | confirmed | migration inventory | E | yes | Historic evidence only | owner gate | Read a redacted journal immediately before any authorised migration. |
| PP2-F5 | Scoped Partner grading flag is unused. | credits/QA reviewer | high | confirmed | `server/partner/flags.ts`; grading routes | B | yes | focused route/source proof | source resolved | Every grading endpoint runs behind the restricted tenant/location flag resolution and fails closed. |
| PP2-F6 | Partner QA/print gate is incomplete. | credits/QA reviewer | high | confirmed | Partner preview and `server/print-workflow.ts` | B/C | yes | 107 print/credit tests + focused output boundary proof | source resolved / runtime gate | One authority now blocks Partner preview, batches, cached artefacts and mark-printed until exact mapping, QA, credit, evidence, station, MV and print state are proven. Live proof awaits PP2-F1 and the owner migration gate. |
| PP2-F7 | Scanner allocation records Partner cards as HQ origin. | credits/QA reviewer | high | confirmed | connector import + `0076` | B/E | yes | migration/source contract proof | source resolved / migration gate | 0076 allocates one immutable Partner-origin certificate per imported item through a narrow definer; imports fail closed if the enabled Pilot lacks the routine. |
| PP2-F8 | Partner UI cannot arm a scanner target. | scanner reviewer | blocker | confirmed | Partner grading UI; station route | B | yes | 21 focused scanner boundary/schema tests | source resolved / migration gate | Canonical Partner page now lists only scoped ready stations and arms the existing signed-station target endpoint. |
| PP2-F9 | Station has no one-active-target invariant. | scanner reviewer | high | confirmed | `server/scanner-capture-service.ts` | B/E | yes | source/migration boundary proof | source resolved / migration gate | 0075 adds a partial unique index; route fails closed until it is applied after PP2-F4. |
| PP2-F10 | Scanner completion needs explicit Next Card gate. | scanner reviewer | high | confirmed | scanner capture service/routes/watcher/renderer | B | yes | 35 scanner tests + focused capture boundary proof | source resolved | Server derives `card_registered` only from captured front/back sessions; scanner persists it through restart and clears it only on explicit Next Card acknowledgement. |
| PP2-F11 | Station approval lacks pending/reject operations UI. | scanner reviewer | high | confirmed | station admin service/routes/client | B | yes | fleet boundary proof + typecheck/build | source resolved | Canonical Partner Management now shows the server fleet and requires a recorded reason for approve/reject/suspend/revoke; reject is PENDING-only and records `station_rejected`. |
| PP2-F12 | Scanner upgrade path is unsafe/unclear. | scanner reviewer | high | confirmed | `scripts/scanner-app/main.js`, `update.sh` | B/D | yes | scanner source/test proof | source resolved / release gate | Below-minimum stations show UPDATE REQUIRED; Git/npm self-update is retired. Owner must provide the signed package distribution procedure before a real station rollout. |
| PP2-F13 | Startup can overwrite service-tier pricing. | scanner reviewer | commercial high | confirmed | `server/routes.ts` | B/F | yes | Source proof | deferred | Not a controlled-test-credit Pilot 1 blocker; owner approval needed before payment changes. |

## Deferred findings

- PP2-F13 remains a commercial owner decision: boot-time tier-price mutation is
  not required for the controlled-credit Pilot 1 path, but must be removed or
  explicitly reconciled before live Partner payment launch.

## Rejected findings

- None yet.
