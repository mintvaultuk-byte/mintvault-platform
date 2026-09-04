# Task ledger — repository architecture recovery

## Baseline

- Repository: `/Users/cornelius/mintvault-platform`
- Branch: `fix/resource-hardening-staging-20260827`
- Committed baseline: `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`
- Existing WIP: preserved and enumerated in `baseline-dirty-state.md`. Phase 2 changes
  only architecture/readiness/CI control surfaces; protected product behavior remains
  unchanged.
- Engineering preflight floor: `CRITICAL` / `HOSTILE`.
- Scope: replace the narrow repair framing with a whole-repository architectural damage
  assessment and executable phased multi-agent recovery graph.
- Prohibited without separate authority: protected auth/payment/grading/evidence/storage
  behavior, migration authoring/application, provider calls, secret mutation, staging or
  production mutation, deployment, push, publish, release, or destructive retirement.

## Stage progress

| Stage                      | Status                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority correction       | complete                           | Earlier bounded/concentrated conclusion withdrawn; prior graph retained as nested subgraph.                                                                                                                                                                                                                                                                                                       |
| Server architecture lane   | complete                           | Route/persistence/provider composition and reachable defects source-verified.                                                                                                                                                                                                                                                                                                                     |
| Client architecture lane   | complete                           | Routes/session/cache/pricing/Partner wiring source-verified.                                                                                                                                                                                                                                                                                                                                      |
| Data/runtime lane          | complete                           | Migration/readiness/jobs/CI/Scanner topology source-verified.                                                                                                                                                                                                                                                                                                                                     |
| Lead adjudication          | complete                           | Accepted findings and explicit non-findings recorded.                                                                                                                                                                                                                                                                                                                                             |
| Graph materialization      | complete                           | Parent graph maps 94 nodes/8 phases; the required 34-node White Ace graph remains separate but mechanically linked.                                                                                                                                                                                                                                                                               |
| Graph validation           | complete                           | `validate-program.py` structurally validates both graphs (128 total nodes). Parent has zero schema/dependency/writer/proof-ancestry errors; pinned identity/baseline/candidate and issue-register table-row checks pass; readiness fails closed because candidates and vetoes remain open. Nine hostile graph/register mutations are rejected.                                                    |
| Independent artifact QA    | complete / clean                   | Three lanes found missing stable IDs, bundled authority, false dependency chains, Scanner replacement-order/quarantine, nested-graph trust, recovery, VQ-identity/readiness/scheduler, pricing/Partner scope, pool/export, proof, metrics, and candidate-media defects. All were corrected; final changed-risk rechecks returned CLEAN.                                                           |
| Phase 2 authority controls | fixed in local WIP / proof pending | Executable route/middleware/client/component/table/object/provider/job/migration/role/session/pricing topology contains 8,704 records. Exact ownership, reachability, ordering, delegated effects, lineage, disabled-component and layer-drift mutations pass; focused authority/CI proof is 30/30. Independent hostile repair re-review is pending.                                              |
| Phase 2 CI topology        | in progress / blocked              | Workflow topology, migration references, 65-module JavaScript syntax inventory, and test/script/architecture TypeScript ratchets are locally green. Scanner proof correctly fails closed because `scripts/scanner-app` does not declare/install `happy-dom`; dependency and lockfile mutation require owner approval. Hosted exact-SHA and full Partner service proof remain unavailable locally. |
| Engineering postflight     | pending rerun                      | Prior postflight was red on package-egress policy, preserved dirty WIP, protected paths relative to `origin/HEAD`, and Graphify refresh; no `--accept-protected` override will be used.                                                                                                                                                                                                           |
| Product remediation        | not started                        | Requires sequential wave authority and protected owner approvals.                                                                                                                                                                                                                                                                                                                                 |

## Agent lanes used

| Lane                       | Mode                    | Result                                                           |
| -------------------------- | ----------------------- | ---------------------------------------------------------------- |
| Server architecture/wiring | independent read-only   | Completed; no file edits.                                        |
| Client architecture/wiring | independent read-only   | Completed; no file edits.                                        |
| Data/runtime/migrations/CI | independent read-only   | Completed; no file edits.                                        |
| Lead                       | sole writer/adjudicator | Corrective assessment, graph, and Phase 2 authority/CI controls. |

## Next authorised action

Obtain explicit owner approval to add `happy-dom` to the nested Scanner manifest and
lockfile, then finish the exact-runtime Scanner CI gate and independent Phase 2 proof.
Each Phase 3–5 product repair remains blocked only by its own exact owner/recovery gates.
