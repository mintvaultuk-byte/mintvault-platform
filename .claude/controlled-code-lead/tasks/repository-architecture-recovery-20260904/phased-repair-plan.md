# Phased multi-agent graph-loop architecture recovery plan

## Current entry point — senior remediation plan, 2026-09-05

This section is the current **execution sequencing and hygiene addendum**, not another
master build or a release approval. The product phases below and the existing parent
and White Ace graphs remain in force. Use their stable issue IDs; do not restart their
completed investigations. The original planning pass authorized only assessment and
dispatch controls. The subsequent Sep5 owner continuation authorizes execution with Astra
orchestration and cheaper scoped workers, as recorded in owner-approval-record.md.
Deployment, shared migrations, destructive cleanup and other listed exclusions remain gated.

**Assessment:** salvageable without a rewrite. The valuable foundations are frozen
grading rules, canonical migration tooling, durable payment/object-write authorities,
real PostgreSQL tests and non-skipping critical gates. The main problems are competing
authorities, incomplete integration, unclosed proof, repository/worktree sprawl and weak
enforcement of the intended review process. More skills or more code are not the goal.

### Verified baseline and GitHub disposition

Observed 2026-09-05; repeat remote checks before acting. No deployment state was queried.

| Fact | Evidence / disposition |
| --- | --- |
| Local branch | `fix/resource-hardening-staging-20260827`, clean before this planning change |
| Local HEAD | `80a20611ff5e8928fd6380961ca6bd420abe4727` |
| Actual remote branch | `2913bcb1092ea8f43ee1294b711a8df653a06a3d`, verified by `git ls-remote` |
| Actual remote main | `01d5e4daab30d58ad53943585ebecc972befaa8a`; local cached main matches it |
| Local-only commits | `c3534c85` Admin print checkpoint and `80a20611` legacy AI checkpoint; GitHub cannot resolve the latter SHA |
| Branch divergence | Local HEAD is 50 commits ahead / 0 behind this main; ancestry is not behavioral parity |
| Local main-to-HEAD diff | 491 files, 238,558 insertions, 11,899 deletions; a two-tree diff, not all historical worktrees combined |
| Largest contributor | `scripts/architecture/generated/architecture-authority.json`: 164,197 inserted lines (about 69%); `legacy-authority.json`: another 16,905 |
| Application subset | `server`, `client`, `shared`: 19,637 insertions; migrations: 3,300; tests: 18,572. The headline is not 250,000 new handwritten runtime lines |
| Pushed PR | [Draft PR #336](https://github.com/mintvaultuk-byte/mintvault-platform/pull/336): 48 commits, 412 files, +222,979 / -10,440 at the remote SHA; not merged |
| PR estate | 46 open, including 12 drafts and 29 Dependabot PRs; older integration/security PRs require reconciliation, not automatic closure |
| Worktrees | 97 registered, 30 dirty, 7 detached; none missing, locked or marked prunable; six groups share HEADs. These are not proven dead or safe to remove |
| Tracked estate | 2,355 tracked files, including 433 under `.claude`, 92 under `docs`, 177 under `scripts`; agent/task material is a substantial part of the sprawl |
| Source shape | 819 tracked JS/TS-family files under server/client/src/shared, 297,655 lines; 59 exceed 1,000 lines, 17 exceed 2,000. `server/routes.ts` has 12,285 lines |
| Duplication | Whole-file byte-hash scan of those 819 files found no exact duplicate files. Existing Sep 4 AST assessment found 54 function-clone groups / 145 definitions; that historical metric needs scope-aware revalidation, not blind deduplication |

Remote evidence came from `git ls-remote`, `gh pr view 336`, open-PR listing, the
main branch-protection API, rulesets API and job-step APIs. Worktree counts used
`git --no-optional-locks -C <path> status --porcelain` without editing any worktree.
Old documents saying this branch was not pushed or GitHub authentication is unavailable
are stale for these observations; they must not be used as current blockers.

### Current gates: configured is not passing, passing is not enforced

- Local ESLint on HEAD: **0 errors / 2,876 warnings / 1,589 files checked**. Warnings
  include 2,055 explicit `any`, 333 unused-variable and 359 require-import warnings.
  `server/routes.ts` alone has 611 warnings. Warning-only policy explains the green exit.
- Earlier same-HEAD assessment passed TypeScript, architecture (8,621 records), CI topology,
  frozen MVGS hashes, 25 architecture assertions and five legacy-route assertions. The
  latter required permission to bind a local listener. These narrow results are not a
  full current-candidate pass. Local Node is 24.14.1; application support pins 20.20.2.
- [CI run 33912428226](https://github.com/mintvaultuk-byte/mintvault-platform/actions/runs/33912428226)
  on the pushed line is red: architecture drift gate, downstream Partner execution-floor
  assertions, and production-image development-toolchain exclusion. Classify primary
  failure versus cascading missing reports before repairing tests.
- `engineering-check` is red at the Engineering anti-drift step. The CodeQL analysis job
  succeeds but the separate CodeQL result check fails. Its annotations include regex,
  XSS and CSRF alerts; these need current-source reachability/reproduction and baseline
  adjudication, not blanket dismissal or an assertion that every alert is a new exploit.
- Main protection requires five contexts, strict up-to-date checks and no force-push or
  deletion. However, approvals required = **0**, code-owner review = **false**, last-push
  approval = **false**, admin enforcement = **false**. Rulesets API returns none.
  `engineering-check` is not in the required list. The required CodeQL context is
  `CodeQL (SAST) (javascript-typescript)`, whereas the observed names are `CodeQL (SAST)`
  and `CodeQL`; reconcile exact names and demonstrate enforcement on a controlled PR.
- Main CI has real PostgreSQL, 70 critical Partner suites, Scanner, MVGS, migration,
  dependency, secret, image, SBOM and vulnerability gates. The managed workflow still
  uses mutable Action/image references and Node 24. Its configuration must be reconciled
  through the managed source, not by bypassing its checksum guard.
- `.engineering/project.yaml` has an empty `integration_test`. Current tracked CI has no
  MinIO/browser proof lane. The image gate's invalid R2 endpoint tests boot configuration,
  not an object round-trip. Test JSON is not uploaded like the SBOM. Restore/reuse earlier
  proof harnesses where available instead of reinventing completed product work.

### Checkpoints and order of work

Checkpoints are acceptance conditions, not invitations to stop after each repair. Keep
working through the authorized scope. Each accepted HIGH retains its repair and independent
proof nodes. Separate the software-pilot milestone from full architectural cleanup;
the existing full-program graph must not be marked ready just because the pilot is ready.

| Checkpoint | Work / accountable lane | Exit evidence |
| --- | --- | --- |
| H0 — Preserve and reconcile | Lead + Git lane: pin HEAD/remote/PR, inventory dirty and detached worktrees, reconcile approval record and existing FIXED work, establish one integration queue | No lost/absorbed edits; every worktree has owner, purpose, baseline, unique-commit/dirty disposition and retention decision; current SHA and scope pinned |
| H1 — Make execution reproducible | CI, DB and security lanes: reproduce current failed job steps; unify runtime/install/service preparation; reconcile managed governance | One clean checkout can run a documented local CI-equivalent command, no inherited live credentials, no critical all-skips, failure artifacts retained |
| H2 — Consolidate authority and documentation | Docs lane + Lead: canonical index and supersession map, correct stale ledgers/approvals, define generated-artifact retention, register all wiring boundaries | One current source per decision/status; root instructions agree; links/entry points work; no frozen/evidence/history loss |
| H3 — Close existing product HIGHs | Contract and runtime lanes: existing Partner orders/RBAC/pricing, White Ace image/UTC/token, VQ schema/readiness/social nodes; independently prove already-fixed Admin/legacy work | Real HTTP/SQL/object/browser proof with negative roles, replay/fault paths and exact candidate; no duplicate finding IDs or reopened unaffected proven work |
| H4 — Bounded decomposition | Client/server/runtime/scanner lanes: characterize before extracting; remove only proven unreachable paths; consolidate shared authority, not protected historical versions | Route/API/import/side-effect parity, no new cycles/clones, warning ratchet improves, scanner package dependency boundary proven; no cosmetic mass moves |
| H5 — Integrate and enforce | Lead + independent proof + Git/security lanes: integrate reviewed increments, exact-SHA hosted gates, protections, rollback and artifact provenance | Required checks terminal green, meaningful independent approval, security disposition, tested recovery, clean immutable candidate; no bypass or hidden skipped gate |
| H6 — Owner release boundary | Lead presents exact SHA/image/schema/rollback/pilot checklist | Explicit approval before staging/deploy/shared migrations; physical gates tracked separately; production untouched without its own authority |

H0/H1 must precede further wide product editing. H2 can proceed alongside service
preparation; H3 can proceed once its own prerequisites and approvals are reconciled.
Unrelated folder cleanup must not delay containment of a reachable money/security defect.
Medium-only cleanup remains required for the full architecture target, but is not silently
converted into a software-pilot BLOCKER. Do not lower a real severity to fit a milestone.

### GitHub and worktree operating policy

1. Preserve the current branch and its two local checkpoints. Before an authorized push,
   verify secrets/diff/base/remote, then normal fast-forward push only. Never force-push
   this recovery line to manufacture a tidy history. Current planning pass does not push.
2. Use PR #336 as the integration anchor. Reconcile its description, baseline, migrations,
   generated diff, proof links and rollback after authority to update it. Keep it draft
   until its bar passes. Do not open another competing “final integration” PR.
3. Each implementation increment gets one logical commit and a reviewable manifest.
   Prefer under 500 handwritten changed lines where practical; larger domain repairs need
   explicit rationale and proof, not artificial splitting. Show generated diff separately.
   The recorded owner-approved `--no-verify` WIP cadence is backup policy, not release proof.
4. Triage all open PRs: integrate, already absorbed, superseded, blocked, or intentional
   follow-up, with patch/semantic evidence and owner. Handle urgent dependency/security
   fixes separately from broad major upgrades. Do not bulk merge/close Dependabot PRs.
5. Protect the actual integration target: reconcile check names, require engineering gate,
   at least one independent approving reviewer and protected-path code-owner approval,
   dismiss stale approvals, cover latest push, and remove routine admin bypass. Changes to
   GitHub controls need explicit scope and a reviewer's real GitHub identity; never create
   a fictitious second reviewer when only the owner account exists.
6. Worktree registry fields: path, branch/detached SHA, task owner, lifecycle, last activity,
   tracked/untracked/ignored-data disposition, unique commits versus integration/main,
   remote backup ref, PR, retention reason, cleanup eligibility. Age or same HEAD alone
   never proves deadness. Account for processes/active tasks and ignored credentials/data
   through metadata only before proposing exact removals.
7. New default concurrency is Lead + at most three bounded agents. No more than one
   shared-tree writer. Create isolated writer worktrees only when needed, register them
   first, integrate sequentially, preserve unique commits, then request exact safe cleanup.
   Do not delete branches/worktrees or rewrite history during inventory.

### Folder, document, generated-file and skill consolidation

Keep existing runtime roots (`server`, `client`, `shared`) and migration paths stable
during containment. Do not move hundreds of files merely to make the root look smaller.

| Current material | Target ownership / action |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md`, two controllers | Thin entry points and protected rules; shared process referenced once; remove stale architectural prescriptions only under reviewed governance change |
| `engineering/` | Canonical current issue/proof/decision/security/release/worktree state; add an index here during H2, not a new parallel management tree |
| `docs/` | Supported product/operator runbooks; map scanner variants and mark retired instructions, preserving necessary historical evidence |
| `.claude/controlled-code-lead/tasks/` | Existing program evidence and historical packets; active graph stays here initially. Mark superseded packets in an index; relocate only with complete link/hash/validator migration |
| `scripts/architecture/` | Small reviewed policy and legacy authority; generated snapshot has explicit generator/version/hash. Evaluate deterministic regeneration plus bounded CI artifact, or domain-sharded reviewed snapshot. Do not delete it until drift/mutation equivalence is proven |
| `script/` and `scripts/` | Inventory actual npm/Docker/CI consumers first; consolidate only after all entry points and build-context tests are changed together |
| `migrations/` and `migrations-vq/` | Reconcile through `ARCH-SCHEMA-001`; do not renumber/move applied SQL or alter checksums to achieve cosmetic uniformity |
| screenshots/logs/reports/binaries | Secret-safe artifacts with retention and SHA references; never customer media, dumps or credentials in Git; retain required audit/provenance evidence |

Every proposed move has old→new path, owner, reference inventory, checksum/retention
classification, tests and rollback. First commit is moves-only where safe; behavior changes
are separate. No bulk deletion, broad formatter run, migration squash, frozen-MVGS
deduplication or deletion of evidence linked by a graph. Use domain ownership and churn
as extraction criteria, not arbitrary line-count targets.

Default skill set: Engineering OS for process; Graph Loop Repair for multi-domain repair;
Graphify for local navigation only. Load specialist skills only for their actual task
trigger, and record why. Do not activate media/research/deployment/skill-creation tools
because those words occur in source or a plan. Preserve protected product rules while
reconciling the older controlled-code-lead process with the Codex-lead/independent-reviewer
model. No global skill installation/removal/update is authorized by this plan.

### Database configuration and disposable test substrate

Use the existing single PostgreSQL database / distinct login-role design for application
and Partner accounting; separate databases would break atomic settlement. Distinct test
databases are appropriate for isolated suites, not splitting a single accounting flow.

| Authority | Variable / required boundary |
| --- | --- |
| Main application | `MINTVAULT_DATABASE_URL`: restricted `mintvault_app`; never migrator credentials |
| Partner tenant runtime | `PARTNER_DATABASE_URL`: restricted `partner_runtime`, no BYPASSRLS, transaction-local tenant context |
| Partner administrator | `PARTNER_ADMIN_DATABASE_URL`: explicit separate operational capability, least required grants |
| Connector | `PARTNER_CONNECTOR_DATABASE_URL`: separate narrowly scoped login |
| Migrator | `MINTVAULT_MIGRATION_DATABASE_URL`: dedicated direct backend; checksum/lock/dry-run authority |
| Disposable proofs | `TEST_DATABASE_URL` plus suite-specific matrix keys, generated test-only values in child processes |

These are variable names/contracts, not permission to read or use existing secrets.
The harness must discard inherited application/Partner/provider secrets and must not load
`.env`. If the app requires its normal variable names, populate them **only in its child
process with newly generated local test values**, never the user's live configuration.
Do not use `npm run dev` for proof boot: it loads `.env`.

- Reuse PG16/pgvector and PG17 topology in `scripts/ci/partner-suite-env-matrix.mjs`
  (defaults 55432/55433), `prepare-engineering-governance-db.mjs` and main CI. Unify the
  duplicated setup only after equivalence tests. Preparation's child-process env does not
  export itself into the next local shell; a parent orchestrator must own the whole run.
- Add run-owned MinIO/S3-compatible service, unique bucket/prefix and generated credentials;
  recover existing real-R2 proof entry points and define the exact `PARTNER_REAL_R2_PROOF_*`
  contract when promoted. No invented claim that these variables are currently wired.
- Require service/container identity plus run ID, database allowlist, assigned port and
  ownership manifest before any test database recreation. Loopback alone is insufficient
  because a local tunnel could reach a shared database. Refuse unknown occupants; never
  stop someone else's container or database to claim a port. Cleanup only owned resources.
- Create deterministic test-only Partner Owner/Manager/Finance/Technician/Reception/Trainee/
  Scanner Operator and Super Admin identities through existing bootstrap/fixture mechanisms;
  include second-tenant identities and missing/revoked privilege cases. No privileged
  production bootstrap endpoint or authentication bypass.
- Verify database/environment identity, remote verified TLS, role membership/table/sequence
  grants, RLS, search path, timezone, statement/lock/acquisition timeouts, aggregate pool
  budget, application identity, startup/readiness and shutdown. Record sanitized metadata.
- Prove empty bootstrap and historical production-shaped lineage upgrade, checksum drift
  refusal, concurrent migrator locking, rollback where safe and otherwise forward recovery,
  preflight before/after, runtime no-DDL and restore. Use synthetic fixtures, not live dumps.
  Do not rewrite applied migrations or “fix” schema to match an obsolete fixture.
- `npm run db:preflight` currently reads the main DB variable; the migrator reads the
  dedicated migration variable. Document that difference. `db:push` is not a rollout tool.

### Complete wiring / proof inventory

Each lane must trace UI/trigger → route/middleware → command → persistence/provider →
read model/cache → audit/retry/recovery → observable output. A manifest entry alone is
not end-to-end proof. This inventory bounds investigation; it does not reopen all prior work.

| Pipeline | Required proof and current issue ownership |
| --- | --- |
| Public/Admin/staff/Partner authentication | session lifecycle, CSRF, step-up, expiry/logout/cache isolation, role transitions and cross-tenant denial; preserve `ARCH-SESSION-001` repair, independently bind proof |
| Catalogue/pricing/submission/grading-payment | one typed price projection, server quote and pence/tax authority, signed webhook/replay, credit/receipt/outbox; `ARCH-PRICING-001`, existing payment/White Ace IDs |
| Supplies/checkout/order/admin/refund | resolve legacy request vs paid-order shadowing without losing history; address/tax snapshots, correct role grants, webhook authoritative PAID, replay, full/partial refund and post-dispatch exception policy; `ARCH-SUPPLY-001`, `ARCH-ROLE-001` |
| Capture/grading/approval/certificate | station/tenant/evidence binding, frozen MVGS hash and golden vectors, authorization/CAS, immutable public provenance; rerun only invalidated proof, no scanner redesign |
| Images/R2/archive/print/NFC | intent→upload→verify→DB pointer/audit→reconcile, two-sided replacement and exact bytes, print replay/current eligibility, QR/public resolution and physical-lock truth; White Ace image IDs and existing print proof |
| Invitations/reset/notification/email | digest/token expiry, transactional encrypted outbox, retries and provider-accepted/unknown outcome; `REL-TOKEN-001`, existing notification authority |
| VQ/growth/social/export/jobs | schema/readiness and disabled-component truth, durable lease/retry/idempotency, no pool lock held across delays, recovery/retention, worker startup and SIGTERM; existing schema/social/pool/export IDs |
| Source→CI→image→runtime→pilot | root/nested locks and runtimes, test services, build context, native image/SBOM/scan, migrations/readiness/version, exact-SHA checks, approved rollout and rollback |

Provider simulations establish local behavior only. MinIO does not prove live R2/B2
retention or Stripe endpoint configuration. Future authorized staging proof must bind actual
TEST account/endpoint, signing secret identity (never value), delivery/replay, order/audit
counts and exact staging SHA. V850, printer, NFC and unavailable current-browser hardware
stay explicit EXTERNAL PILOT GATES. Software browser automation should run locally where
provisionable and must not be relabeled a physical-hardware gate.

### Test, security and checkpoint acceptance

Run root Node 20.20.2, nested Scanner's declared runtime/lock and frozen installs. Retain
current commands: `check`, `lint`, `architecture:check`, `migration:references:check`,
`check:tests`, `check:scripts`, `check:unreachable`, `check:script-syntax`, `ci:topology`,
`test:engineering`, `test:partner:critical`, `test:scanner:critical`, `build`, plus
`node --import tsx scripts/mvgs/verify-freeze.ts`. Execute service-dependent commands only
inside the owned disposable harness. Add the aggregate integration command to the manifest
and CI once implemented; do not list it as existing today.

Ratchet existing lint/type debt by rule and file; fail new actionable warnings in touched
code, avoid a blanket zero-warning migration that encourages suppressions. Prioritize empty
catch/async/constant-condition warnings and boundary `any` over mechanical style. Establish
checked unused-export/import-cycle/clone inventories with reviewed exceptions for frozen
versions, generated files and intentionally independent fixtures. Prove old callers gone
before deleting code. Current lint green does not mean no dead code.

Security lane owns current CodeQL annotation adjudication, secret-scanning exact refs and
allowlist review, dependency/image/SBOM provenance, test artifact redaction, least-privilege
CI tokens, fork-safe secrets and environment protection. No `continue-on-error`, broad
allowlists, test skips, severity downgrade or hash reseal to clear gates. Recheck ignored
secret-file permissions through metadata; rotation/backups remain owner actions. Retain
reports/traces on failure with SHA, runtime, schema, test counts and bounded retention;
absence/all-skip/setup abort is UNKNOWN/FAIL, never PASS.

At each checkpoint record exact commit/diff, file manifest, tests actually executed,
classification of failures, independent observer, proof invalidators and rollback. The
lead integrates sequentially, then independent proof runs on the combined candidate.
One broad hostile review maximum; thereafter changed-risk surfaces only.

### Mandatory next graph-loop dispatch

`hygiene-dispatch.json` assigns nine bounded lanes in three waves. It is a dispatch
contract referencing the existing graph, **not a second issue register or release graph**.
At continuation, validate it, pin the actual execution SHA and dispatch read-only agents
for those assignments. Reports may use existing proven evidence with explicit invalidators;
do not make agents re-audit completed systems. Before product writes, every lane must have
an actual agent ID and a PASS/FAIL/UNKNOWN investigation report. UNKNOWN blocks only its
dependent work. Lead adjudicates accepted repairs into the existing graph and register,
updates file manifests and approvals, validates both graphs, then starts authorized waves.

```
python3 .claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/validate-hygiene-dispatch.py
python3 .claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/validate-hygiene-dispatch.py --dispatched
python3 .claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/validate-program.py
```

The second command intentionally fails until real dispatch/report records exist. These
records contain `sha`, `observer`, `result`, repository-relative `ref` and
`content_sha256`; the retained Markdown/JSON report must contain the lane ID, observer
and exact execution SHA. Store concise reports in this existing program directory or
the canonical engineering ledger, not a new task-folder tree. The checker pins each
lane's required issue coverage and checks report existence/content binding. The Lead
must still verify actual agent provenance and evidence: a hash is not an independent
signature, and an investigation PASS is not repair certification. These
are local governance controls, not yet required GitHub checks. H1 must wire the dispatch
coverage check into the supported governance gate and prove deletion/missing-lane/stale-SHA
failures. The plan alone must never be reported as agents dispatched or repairs completed.

Rollback for this planning change: revert only this addendum, its dispatch/checker and
the additive instruction/ledger references; no application/schema/provider rollback is
needed. Starting and final committed SHA for this pass remain `80a20611`; no commit,
push, merge, worktree removal, provider operation, migration or deployment is performed.

## Outcome

Recover MintVault to one inspectable executable architecture without a big-bang rewrite:
contain every accepted HIGH defect, establish contract and ownership foundations, then
extract one bounded context at a time under independent proof. The plan ends at an exact
repository candidate; deployment and release remain separate owner actions.

`repair-graph.json` is the machine authority. The earlier White Ace graph is a required
nested release-integrity subgraph. `validate-program.py` runs the Graph Loop validator
over both graphs and, in readiness mode, requires both to be ready on the same candidate
SHA; manually closing the umbrella node cannot bypass a nested veto.

## Orchestration model

- Codex Lead is the only shared-workspace writer and graph/ledger integrator.
- Read-only agents independently inventory server, client, data/runtime, proof drift,
  rollback, and hostile behavior. A repair author never certifies its own work.
- Product writes are sequential in the shared tree. Parallelism is used for read-only
  investigation and verification, or for distinct isolated worktrees when the runtime
  can guarantee non-overlap.
- Every accepted BLOCKER/HIGH has a reproduction node, an owner-gated repair node where
  required, and a directly dependent independent proof node.
- Every veto flows transitively into rollback, exact-candidate integration, external
  acceptance, and the owner release boundary.
- Missing environments, skips, timeouts, unavailable providers, or absent credentials
  are `UNKNOWN`/blocked evidence—not a pass.

## Phase 0 — Correct authority and freeze the baseline

1. Preserve the current White Ace WIP and exact committed baseline.
2. Mark the earlier “bounded/concentrated” conclusion as withdrawn.
3. Publish the executable topology, accepted issue set, protected actions, and graph.
4. Re-run preflight if governance, branch, baseline, or worktree ownership changes.

Exit: one baseline and one repository-wide graph are authoritative.

## Phase 1 — Reproduce and gate every HIGH

Read-only lanes maintain exact evidence for client/server route parity, session/cache
transitions, Partner order/role contracts, pricing authority, legacy AI reachability,
VQ migration/readiness, CI topology, external-publication jobs, and the nested White Ace
findings.

Owner gates are deliberately narrow: Admin session/cache, Admin reprint, Partner paid
orders versus legacy requests, Partner RBAC, pricing, each legacy AI route, VQ
schema/readiness, object lifecycle, social publication, Partner pool budgets, VQ export
retention, protected server extraction, client surfaces, Scanner distribution/retirement,
and each existing White Ace decision are recorded separately. A deletion approval must
name its exact targets and retention rules.

Exit: every repair packet has an exact gate and required pre-wave recovery packet.
Unapproved protected waves remain blocked, but they do not prevent owner-independent
Phase 2 authority/CI foundations from proceeding.

## Phase 2 — Make the gate and contracts truthful

This owner-independent foundation precedes broad decomposition. In parallel, the Lead
prepares the graph's session, commerce, grading, schema, provider, object, pool, VQ
export, server, client, Scanner, and nested-White-Ace recovery packets; each protected
repair depends on its packet being accepted before implementation.

1. Generate/check an HTTP manifest with method, path, order, actor/capability, request,
   response, command owner, provider effects, and retirement state.
2. Generate/check role, session/principal, pricing, table-owner, object-writer, job,
   migration-inventory, and component-readiness registries. Preserve current readiness
   semantics while deriving them from bounded component manifests.
3. Invoke the isolated Partner matrix, Scanner suites, and dedicated script/test
   typechecks from hosted CI; label historical/unshipped migration tests accurately.
4. Add runtime import/layer gates and unreachable-code enforcement at a ratcheted
   baseline.

Exit: the gate fails when executable topology or ownership drifts.

## Phase 3 — Immediate containment

The Lead remains the sole shared-tree writer, but the graph contains only semantic and
proof-invalidation dependencies. Independent authorised packets need not wait for an
unrelated owner decision. Each write is still scheduled sequentially and followed by
independent verification:

1. Fix/remove the broken Admin reprint action against the canonical idempotent command.
2. Centralize Admin session/logout/cache behavior and prove principal-change erasure.
3. Converge Partner checkout/order routes, permissions, shell composition, and
   `SCANNER_OPERATOR` role parity.
4. Establish one inventoried commercial pricing projection from Admin through every
   public/variant/SEO/help/Vault Club/pre-grade display and metadata surface to selection,
   quote, charge, and receipt.
5. Under grading owner approval, tombstone the obsolete AI route with zero provider,
   R2, and DB calls; separately decide `grade-with-ai` support.
6. Run the existing White Ace protected HIGH graph under each of its exact gates. This
   work is not delayed behind Medium client/Scanner decomposition.

Exit: no accepted reachable HIGH behavior defect remains uncontained.

## Phase 4 — Server, data, and runtime strangler waves

1. Give VQ one shipped checksummed migration authority and required/optional readiness
   semantics; prove fresh and historical convergence before removing fallbacks. VQ
   currently uses the main database; a distinct credential/RLS boundary would be a new
   owner decision, not something this plan assumes.
2. Establish behavior-preserving declarative job composition before moving any job;
   preserve current order, schedule, and shutdown behavior while removing route-local
   worker starts.
3. Convert social publication to a numbered durable-state substrate and explicit
   component-readiness manifest, release database locks before delay/provider work,
   and distinguish provider-accepted/persistence-unknown.
4. Bound Partner runtime/admin/connector acquisition, statement, lock, and aggregate
   connection budgets against the measured provider ceiling.
5. Add VQ export report-only sizing, stuck-processing reclaim, expiration, an explicit
   scheduler registration, and only then exact owner-approved object cleanup/restore.
6. Derive object readiness from the complete writer inventory. Keep the community
   publication defect as a candidate until independent DB/object/audit fault injection
   and a mechanically release-vetoing Lead adjudication accept or reject it.
7. Extract root-imported helpers, break root↔leaf and VQ provider cycles, move route-local
   work into bounded commands/repositories, and replace recursive staff/grader request
   redispatch with typed actor/capability commands.
8. Split worker bootstrap from HTTP composition, including print reconciliation,
   Scanner cleanup/capture expiry, and VQ reclaim scheduling; remove unreachable print
   bodies after characterization.

Exit: server/data/runtime contexts have enforceable inward dependencies and recoverable
side effects.

## Phase 5 — Client and operational convergence

1. Split `App.tsx` into public/admin/staff/partner route registries with generated API
   checks and a shared principal transition contract.
2. Owner-select canonical home/pricing/admin surfaces; retire variants and dead deep
   links only after parity and analytics/SEO/product acceptance.
3. Split giant grading/certificate/admin/partner components by commands, queries, and
   feature boundaries—not arbitrary line counts.
4. Contain Scanner contradictions and unreachable bodies before packaging. Produce an
   exact-source signable package and rollback artifact, obtain signed/notarized/stapled
   clean-Mac physical acceptance, then retire only the separately installable watcher
   and named incident executables. The accepted Scanner source subtree must remain
   byte-identical through final integration.

Exit: one supported surface and one operational authority exist per capability.

## Phase 6 — Independent proof, rollback, and integration loops

Independent lanes run in parallel after their authoring wave:

- Endpoint parity/collision/precedence and tombstone zero-effect mutation proof.
- Cross-principal auth/session/cache hostile tests.
- Partner paid-checkout-to-order-list and least-privilege scanner-role end to end.
- Pricing display/quote/charge/receipt parity.
- Fresh/historical migration and component-readiness proof, pool-budget capacity, and
  VQ export lease/retention/restore proof.
- DB/R2/audit/provider fault injection and social crash-boundary reconciliation.
- Import DAG, ownership/layer, no-unreachable, no-orphan-route, and clone-drift gates.
- Full mechanically linked nested White Ace proof and one Claude Opus High hostile review.
- Forward recovery and rollback at each schema/object/provider/principal boundary.

New reproduced in-scope BLOCKER/HIGH findings enter the same repair→proof loop. Medium
architecture nodes remain vetoes for this architecture-recovery program even if they are
not general release blockers.

Exit: one clean immutable candidate passes every local veto with non-vacuous evidence.

## Phase 7 — External evidence and owner release boundary

On the exact candidate only: hosted CI/rulesets, native image, real migration/readiness
parity, connection-budget capacity, two-machine failure injection, provider idempotency,
retention/restore, confirmation that the already accepted Scanner source subtree is
unchanged, and authorized staging.

Production deployment remains an explicit owner decision. No graph node grants itself
authority to deploy, migrate shared environments, publish, rotate secrets, or delete
durable data.
