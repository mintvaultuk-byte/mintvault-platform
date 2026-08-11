# Permanent Skill Installation — Graph of Loops Build Controller

This is a permanent engineering governance skill.

Install it alongside the existing No-Bullshit Completion Controller.

It applies to every future engineering, build, and release task unless the owner explicitly overrides it.

Do not replace or weaken the No-Bullshit controller.

The two controllers serve different purposes:

- No-Bullshit Controller = finish the approved scope and stop endless prompt chaining.
- Graph of Loops Controller = prevent a single optimisation/review loop from producing a false green.

## Core principle

A reliable engineering system must not rely on one loop:

    TARGET → MEASURE → ACT → REPEAT

A single loop can optimise the measurement instead of the real objective.

This creates:

- Goodhart failure: the metric improves while the real outcome gets worse.
- Blindness: the loop never questions whether the target itself is correct.
- Conflict: different optimisation loops work against each other.
- Decay: tests, fixtures, schemas, assumptions, and metrics drift while dashboards remain green.

Therefore every serious build must use a Graph of Loops with explicit veto and grounding relationships.

## The required loop graph

For substantial work, use these loops where relevant.

### Loop 1 — Build loop

Purpose: implement the requested product/change.

    owner target → inspect current authority → implement → local test → repair → repeat

The Build Loop does not get to certify itself for release.

### Loop 2 — Behavioural verification loop

Purpose: prove the shipped behaviour actually works.

Use the strongest practical evidence:

- real function
- real route
- real HTTP
- real SQL
- real transaction
- real PostgreSQL
- real object storage
- real browser
- real role/auth context
- real CI topology

Source-string assertions alone are not release proof for behavioural claims.

This loop can veto the Build Loop.

### Loop 3 — Adversarial / mutation loop

Purpose: prove important protections actually bite.

For critical guarantees:

    deliberately break the invariant → require RED → restore byte-identically → require GREEN

Examples:

- remove tenant check
- remove revision CAS
- allow stale evidence
- remove approval gate
- trust client price
- remove idempotency
- allow cross-card binding

A mutation that does not cause the intended test to fail is not proof.

This loop can veto the Build Loop and Verification Loop.

### Loop 4 — Held-out / independent eval loop

Purpose: prevent implementation from merely learning the visible tests.

Maintain independent checks where practical:

- production-shaped fixture
- separate integration corpus
- hostile payloads
- boundary cases
- known historical failures
- real browser viewport
- real migration estate

The implementation should not redefine these tests merely to get green.

If a held-out check disagrees with implementation, investigate the implementation first.

### Loop 5 — Drift loop

Purpose: detect when previous proof is no longer valid.

A proof becomes stale when its relevant dependency changes. Examples:

- schema changes
- migration changes
- route changes
- auth changes
- grading revision changes
- storage format changes
- role grants change
- browser contract changes

Maintain dependency-aware proof invalidation.

Do not repeatedly re-audit unrelated settled systems. Re-open only the affected proof surface.

### Loop 6 — Release / canary loop

Purpose: prove the integrated release rather than isolated components.

    clean candidate → CI-equivalent proof → exact SHA CI → staging/canary → smoke → controlled pilot → observe → promote or rollback

A local green is not automatically a staging green. A staging green is not automatically a production green.

### Loop 7 — Rollback / containment loop

Purpose: ensure failure has a safe exit.

For migrations, releases, payment, and security changes, establish before rollout:

- rollback
- feature flag
- kill switch
- restore point
- safe retry
- idempotency
- audit trail

The Rollback Loop may veto release if failure cannot be safely contained.

### Loop 8 — Owner / ground-truth loop

This is the highest-level anchor. The agent does not get to redefine what “better” means.

Owner decisions define:

- product objective
- commercial objective
- acceptable risk
- protected grading rules
- release scope
- money behaviour
- user experience
- production authority

Examples:

- more tests does not automatically mean a better product;
- a faster workflow is not better if accuracy falls;
- a higher rating is not better if the metric can be gamed;
- more audit findings are not better if the release is already proven.

The graph itself cannot override the owner target.

## Ground-truth hierarchy

When evidence conflicts, prefer:

1. actual owner decision / protected governance
2. actual production/staging schema and behaviour
3. real runtime integration behaviour
4. real database/object-storage/browser proof
5. authoritative application implementation
6. behavioural tests
7. source assertions
8. comments/docs
9. agent assumptions

Do not change production architecture merely because a stale fixture expects something else.

## Anti-Goodhart rule

Never optimise one metric without checking the outcome it stands for.

- Test count must not rise by adding meaningless tests.
- Coverage must not improve while critical behaviour is untested.
- Latency must not improve by weakening correctness.
- Security must not improve by making the product unusable.
- Pass rate must not improve by skipping tests.
- Rating must not improve by excluding bad samples.
- Blocker count must not go to zero by downgrading genuine blockers.
- CI green must not come from disabling a gate.

Every important metric needs at least one independent outcome check.

## Conflict rule

Loops can conflict. Default priority for MintVault:

1. protected grading correctness
2. security / tenant isolation / payment integrity
3. evidence/provenance integrity
4. data durability
5. release correctness
6. usability
7. performance
8. implementation convenience

Speed may not override correctness. UI convenience may not override tenant isolation. Automation may not override irreversible owner decisions.

If the priority is genuinely unclear, ask one owner question.

## No watchers-watching-watchers loop

A Graph of Loops must not become an infinite review graph.

Normal release structure:

    BUILD → BEHAVIOURAL VERIFY → MUTATION / HOSTILE VERIFY → FIX REPRODUCED BLOCKER/HIGH → TARGETED RE-VERIFY CHANGED SURFACES → RELEASE

Do not create:

    reviewer → reviewer of reviewer → reviewer of reviewer of reviewer → endless new audits

Maximum normal broad hostile-review cycle: one.

A second broad review requires a material architecture/trust-boundary change. Otherwise use targeted re-verification only.

## Proof expiry

Every major proof should record:

- what was proven
- against which SHA
- against which schema/migration state
- using which environment
- which dependencies invalidate it

If those dependencies change, mark that proof stale. Do not pretend a test from an old architecture proves the new architecture.

## Evidence ledger

For important release claims maintain one proof ledger. Each claim should identify:

- claim
- source of truth
- proof
- result
- SHA
- dependencies
- status

Example:

- Claim: Partner cannot approve its own grade.
- Proof: real HTTP Partner request against PostgreSQL role matrix.
- Result: 403 / no DB mutation.
- SHA: exact candidate SHA.
- Status: PROVEN.

## Independent vetoes

A release may be vetoed by:

- behavioural proof
- security proof
- migration proof
- payment integrity proof
- protected grading guard
- owner decision
- rollback/containment failure

A release may not be vetoed indefinitely by:

- unproven speculation
- unrelated MEDIUM/LOW findings
- old issues already fixed/proven
- duplicate findings
- reviewer preference
- style disagreement

## Failure classification

Every failure must be classified:

- real product defect
- test defect
- fixture drift
- environment failure
- external dependency
- expected safe refusal
- performance/resource limit
- stale proof

Do not immediately modify production code whenever a test turns red. Find the real class first.

## Release stop condition

Once all of the following are true, stop:

- owner target is satisfied
- all known in-scope BLOCKER/HIGH are FIXED + PROVEN
- behavioural proof passes
- critical mutations bite
- CI-equivalent suite passes
- exact SHA CI passes
- rollback/containment is valid
- zero new security regression exists

Do not continue looking for increasingly speculative problems. Remaining MEDIUM/LOW issues become FOLLOW_UP.

The graph exists to improve reliability, not make completion impossible.

## Token / time / complexity circuit breaker

Review depth has a budget.

If another review loop is proposed, ask: Will this check a genuinely independent failure mode?

If no, do not add it. If yes, run the smallest check that proves that failure mode. Do not spend large token/time budgets repeatedly proving the same invariant.

## MintVault-specific anchors

For MintVault:

- Protected MVGS grading maths is an immutable owner anchor unless explicitly changed.
- Evidence must remain traceable to immutable source evidence.
- Partner/HQ tenant boundaries are hard security anchors.
- Paid state must come from authoritative payment fulfilment.
- Client values do not override server-authoritative money, grade, evidence, or permissions.
- Historical certificate provenance remains immutable.
- Production schema is authoritative over mistaken fixtures.

## Relationship to the No-Bullshit Completion Controller

These two skills must operate together.

The Graph of Loops Controller says: use independent loops so one metric, test, or reviewer cannot fool the system.

The No-Bullshit Completion Controller says: once those independent loops have proven the release, stop and ship.

Neither overrides protected grading governance, security governance, payment governance, deployment authorisation, or destructive-action approval.

## Permanent installation and verification

This is the single canonical repository copy. Root instruction entry points must reference it rather than copying divergent versions.

After changing this controller or its references:

1. confirm the canonical file exists;
2. confirm AGENTS.md references it;
3. confirm CLAUDE.md references it where appropriate;
4. confirm the No-Bullshit controller remains referenced;
5. confirm protected grading, security, and payment rules remain intact;
6. run governance tests;
7. keep a governance test ensuring neither controller can disappear silently.

Commit locally. Do not push unless the current workflow already authorises it.

For every future substantial task, read this controller together with NO_BULLSHIT_COMPLETION_CONTROLLER.md.
