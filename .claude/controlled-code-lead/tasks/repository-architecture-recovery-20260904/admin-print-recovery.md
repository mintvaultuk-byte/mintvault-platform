# Admin print/reprint recovery packet

**Wave:** `REPAIR-ADMIN-PRINT`
**Pre-wave checkpoint:** `2913bcb1092ea8f43ee1294b711a8df653a06a3d`
**Pre-wave tracked dirty-diff SHA-256:** `12dda2cf31173444a33347dcf5a763788084e530381e11dfe042e5c2ee45c04c`
**Pre-wave untracked path/content aggregate SHA-256:** `6a4c86f18e3e23551d6ba6c65b728349ccd7de9b84de74cf4db11972d4d869e2`
**Owner authority:** `owner-approval-record.md` authorises every listed owner gate, directs the Lead to choose the safest behavior-preserving option, and says not to pause between waves. Production/staging deployment, migration application, protected MVGS work, secrets, paid providers, object deletion, and release remain excluded.

## Reproduced contract damage

1. The mounted Admin Certificate Browser exposes a Reprint action for every row and posts to removed `POST /api/admin/printing/reprint/:certId?side=both`. The server deliberately has no such handler, so the visible command always reaches the unmatched-API JSON 404.
2. The live direct-artifact route `POST /api/admin/print-batch/reprint` returns before its old per-certificate `audit_log action='reprint'` block. Its `auditRows` response is synthesized as successful even though those rows are not written. The durable reason-bearing evidence actually lives in `print_events`, `reprint_log`, and `print_batches`.
3. The separate live Print Queue command `POST /api/admin/printing/workflow/reprint` has no idempotency key. Because the state machine permits `reprint_required -> reprint_required`, an uncertain retry writes duplicate `print_events` and `reprint_log` rows.
4. Required release readiness does not require migration `0022_print_workflow_lifecycle.sql`, the live print relations, `certificates.print_state`, or unique batch identity. Always-mounted print routes can therefore be admitted against an incomplete estate.
5. `createBatchAtomic` checks mutable certificate existence and Partner eligibility before returning an already-COMMITTED artifact operation. A lost-response retry can be denied after the artifact and evidence committed, encouraging a second key and duplicate action. Its existing intent comparison also omits role, notes, and normalized reason/category fields.
6. Artifact retrieval rechecks current certificate state but resolves missing/empty batch membership from mutable `label_prints.sheet_ref`. Reprinting one member moves that pointer, so an older sheet can be validated as only a subset and served with a now-revoked certificate still embedded in its bytes.
7. Initial print readiness checked selected columns/indexes but not generated IDs, primary-key/sequence ownership, or defaults omitted by reachable inserts. Dropping or retargeting those defaults could leave readiness green while the next batch/event/cache/evidence write fails.

These are three facets of one split print-command authority, not an isolated button defect.

## Owner-authorised decision and canonical contract

Retain the Certificate Browser reprint capability and rewire it to the existing direct-artifact command. This is the safest behavior-preserving interpretation of the blanket owner instruction. Do not restore the removed raw 72x22 PDF endpoint and do not point the browser at the state-only Print Queue command.

The canonical direct-artifact contract is:

- `POST /api/admin/print-batch/reprint`
- `Idempotency-Key`: required, non-empty, at most 200 characters; one key per logical operator intent, retained across transport or unknown-outcome retries and rotated only after success, known terminal abandonment, or an explicitly new intent.
- JSON body: `{ certIds: string[1..8], reason: trimmed string[10..500] }`.
- JSON response: durable `batchId`, `certIds`, `pdfUrl`, optional `pngUrl`/`cricutSvgUrl`, layout/page metadata, and only per-certificate `auditRows` committed by the same artifact-finalization transaction.
- The Certificate Browser action is offered only for already-produced certificate states. Unprinted certificates continue through normal Sheet Printing or Print Queue flows.
- Authentication/authorization remains the existing Admin session contract. Existing `can_print` staff aliases remain capability-gated and are not expanded.

The authority hierarchy remains the repository's documented one: `certificates.print_state` is current lifecycle state; `print_events` is append-only who/why history; `print_batches` is batch identity/membership/status authority; `object_write_operations` and `object_write_items` are artifact publication and direct-command idempotency authority. `audit_log` is an append-only compliance and command-receipt projection; `label_prints` and `reprint_log` are compatibility projections only. The existing response/UI compatibility promise is retained by moving per-certificate `audit_log action='reprint'` writes into verified artifact finalization. A successful response can therefore never advertise evidence that failed to commit.

The direct request body has no reason category, so it persists `null` consistently. It must not fabricate the out-of-vocabulary `legacy_unspecified` value in `print_batches` while writing `null` to the corresponding event.

The Print Queue request command remains a separate, intentional state transition because it records an operator-selected reason category before a later batch is generated. It must require its own idempotency key, bind that key to actor plus canonical payload, return the original result on a same-payload retry, and reject key reuse with a different payload. It must not duplicate state or evidence.

## Compatibility boundary

- No schema or migration is authored or applied by this wave.
- No label dimensions, cut geometry, render layout, grade/MVGS rule, claim-code format, storage provider, retention rule, payment, entitlement, or production data changes.
- Existing Sheet Printing, Print Queue, artifact retrieval, mark-printed, completion, Admin, and capability-gated staff surfaces remain reachable.
- Existing durable print history is retained. Migration `0022_print_workflow_lifecycle.sql` is additive history authority and is never dropped as rollback.
- The enabled print workflow is a required release component. Readiness requires applied migration 0022; every live print relation and runtime-consumed column; exact generated-ID primary-key, owned-sequence, and default authority; all runtime-omitted defaults; required unique identities/indexes; and the production runtime role's exact table/sequence privileges.
- The direct artifact command continues to use its actor/key-bound `PRINT_ARTIFACT` coordinator. Same actor/key/same payload replays; changed payload conflicts.
- A validated COMMITTED command result is returned before current certificate or Partner eligibility preflight. Mutable checks apply only to fresh/nonterminal command work; a replay never changes the already-committed result. Artifact bytes are separate: every download rechecks current output eligibility for every member from authoritative non-empty `print_batches.cert_ids`; legacy sheets without immutable membership fail closed and `label_prints` is never a membership fallback.
- The workflow request command uses existing persistent print evidence and transaction locking; it does not rely on process memory.
- The workflow receipt path uses transaction advisory serialization plus SELECT/INSERT only, matching append-only `audit_log` runtime authority. Stored `legacy_unspecified` is accepted solely as read-time compatibility with canonical `null`; new commands never write it.

## Failed-cut recovery and rollback

If render fails before the durable coordinator prepares the operation, no batch/event/log is committed; a defensively minted claim code may remain. If a proven domain invariant fails after reservation, the coordinator abandons the operation, restores `printing` to the reserved source state, marks the batch failed, records abandonment, and leaves explicit reprint evidence intact. An ambiguous store or verification failure becomes `RECONCILIATION_REQUIRED`; it is not guessed safe or immediately restored, and the nonterminal operation remains finalizable by the registered reconciler. Claim-code minting that precedes coordination is not reversed.

If the workflow request fails before transaction commit, no state or evidence change is visible and the same key may be retried. If the response is lost after commit, a same-key/same-payload retry returns the recorded result without writing another event/log row. A same-key/different-payload retry fails closed.

If the coordinator returns a known terminal/abandoned operation, the client retires that key and may begin a new attempt. In-progress/unknown outcomes retain the key. This distinction must not be collapsed into generic retry behavior.

Application rollback reverses only the declared `REPAIR-ADMIN-PRINT` client/server/test/readiness hunks. It must not reset the pre-existing Admin/Phase 2 WIP, delete receipts or print history, delete artifacts, drop migration objects, rewrite already-committed evidence, or strand a nonterminal object-write operation. Fully reverting workflow idempotency while leaving its mutation live would reopen the HIGH; the safe degraded rollback disables only that reprint mutation while queue reads, batching, mark-printed, and existing history remain available. If the retained browser shortcut must be disabled during recovery, hide that shortcut and keep the established Sheet Printing/Print Queue paths available.

## Proof requirements

- Mounted UI proof for a produced-state-only browser action, 10-500 character reason gate, stable logical-attempt key, canonical JSON request, and artifact-URL handling.
- Direct HTTP proof for auth, invalid reason, missing/oversized key, payload normalization, response truthfulness, same-key replay, changed-payload conflict, durable reason evidence, failed publication recovery, and removed-route JSON 404.
- Workflow route/service proof for required key, same-key/same-payload replay without duplicate `print_events`/`reprint_log`, changed-payload conflict, concurrent retry serialization, permissions, and staff alias behavior.
- Component/readiness proof for migration 0022, required relations/columns/defaults, generated IDs, primary-key and exact owned-sequence authority, required unique identities/indexes, exact runtime ACLs/sequence privileges, and hostile removal/retarget mutations against both standalone and full release readiness.
- Direct-command proof that the complete actor/role/kind/certs/reason/category/notes intent is key-bound and a committed replay survives later certificate or Partner-eligibility drift without any new effect.
- Full-route artifact proof that current approval/validity drift blocks a committed sheet and that a legacy sheet whose mutable label pointers under-report its members fails closed before any object read.
- Independent client and server hostile review plus graph mutations and repository gates.

Invalidators: owner decision change; direct or workflow route/payload/header/response change; print state-machine, actor, permission, evidence, object-write, label, render, or idempotency change; migration/schema change; recovery-procedure change; candidate-base change; or any pre-wave digest mismatch.
