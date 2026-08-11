# GRAPH OF LOOPS BUILD CONTROLLER

**Permanent project governance.** Installed 2026-08-10 by owner directive. Applies to every
engineering, architecture, audit, security, migration and release task in this repository unless
the owner explicitly overrides it.

**The rule this document exists to enforce:**

> **No single self-improvement or review loop may certify itself.**

---

## CORE MODEL

A basic loop is: **SET TARGET → MEASURE GAP → ACT → REPEAT.**

That works, and it fails in four characteristic ways:

| Failure | What it looks like |
|---|---|
| **GOODHART** | the metric improves while the real outcome worsens |
| **BLINDNESS** | the system cannot question whether its target is correct |
| **CONFLICT** | independent optimisation loops undermine each other |
| **DECAY** | tests, assumptions, schemas and measurements drift while dashboards stay green |

A single loop cannot detect any of these about itself. Substantial builds therefore require
multiple **independent** loops, with grounding and veto relationships between them.

---

## THE REQUIRED LOOPS

### 1. BUILD LOOP
Implement against the owner's target. **The builder may not certify its own release.**

### 2. BEHAVIOURAL VERIFICATION LOOP
Use real production functions, routes, SQL, transactions, PostgreSQL, object storage, browser and
auth roles wherever practical. **Can veto Build.**

### 3. MUTATION / ADVERSARIAL LOOP
Break critical protections deliberately. Correct behaviour is **mutation → RED, restore → GREEN.**
A mutation that stays green is not proof — it is the absence of one.
**Can veto Build and Verification.**

### 4. HELD-OUT EVALUATION LOOP
Checks the implementation is not merely optimised against: historical failures, independent
integration cases, production-shaped fixtures, boundary conditions, hostile payloads.

### 5. DRIFT LOOP
Invalidate proofs when their dependencies change — schema, migration, route, role, evidence format,
payment contract, grading revision. **Do not reopen unrelated proof.**

### 6. RELEASE / CANARY LOOP
candidate → CI-equivalent → exact-SHA CI → staging → controlled pilot → observe → promote/rollback.

### 7. ROLLBACK / CONTAINMENT LOOP
Before a risky release, establish: restore point, rollback, feature flag, kill switch,
retry/idempotency, audit.

### 8. OWNER / GROUND-TRUTH LOOP
The highest anchor. **The agent cannot redefine what "better" means.** The owner controls scope,
commercial objective, protected grading rules, risk tolerance, money behaviour, release decisions.

---

## GROUND-TRUTH ORDER

When sources disagree, believe them in this order:

1. owner / protected governance
2. actual production or staging reality
3. real runtime integration
4. real DB / storage / browser proof
5. authoritative implementation
6. behavioural tests
7. source pins
8. documentation and comments
9. agent assumptions

**Never make production conform to an invented test schema.**

---

## ANTI-GOODHART RULE

For every important metric, verify the outcome the metric stands for.

- more tests ≠ better, if they are meaningless
- higher coverage ≠ better, if critical behaviour is absent
- faster ≠ better, if correctness falls
- more security controls ≠ better, if users cannot operate the system
- green CI ≠ correct, if tests skipped
- a higher Partner rating ≠ better, if bad cards vanish from the denominator
- zero blockers ≠ success, if blockers were merely downgraded

---

## CONFLICT PRIORITY

Default MintVault order. Lower loops cannot override higher anchors.

1. protected grading correctness
2. security / payment / tenant integrity
3. evidence / provenance integrity
4. data durability
5. release correctness
6. usability
7. performance
8. developer convenience

---

## NO INFINITE META-REVIEW

Do **not** turn this into watchers watching watchers.

> BUILD → VERIFY → MUTATION/HOSTILE REVIEW → FIX PROVEN BLOCKER/HIGH → TARGETED RE-VERIFY → RELEASE

Normally **one broad hostile review maximum**. A second requires a material architecture or
trust-boundary change. Otherwise re-review only the changed risk surfaces.

---

## PROOF EXPIRY

Record for important proofs: `CLAIM` · `SHA` · `ENVIRONMENT` · `SCHEMA/MIGRATION STATE` · `PROOF` ·
`DEPENDENCIES` · `STATUS`.

When a dependency changes, mark the proof **stale** and rerun **only** the affected proof.

---

## FAILURE CLASSIFICATION

Classify every failure **before** modifying production code:

`REAL DEFECT` · `TEST DEFECT` · `FIXTURE DRIFT` · `ENVIRONMENT FAILURE` · `EXTERNAL BLOCKER` ·
`EXPECTED REFUSAL` · `RESOURCE/PERFORMANCE` · `STALE PROOF`

**Do not assume RED means the production code is wrong.**

---

## RELEASE STOP CONDITION

Once independent loops establish: the owner objective is met; 0 known in-scope BLOCKER/HIGH;
behavioural verification green; critical mutations bite; CI-equivalent green; exact-SHA CI green;
rollback/containment valid; 0 new security regression —

**STOP.** Move MEDIUM/LOW to FOLLOW_UP. Do not continue broad searching.

---

## TIME / TOKEN CIRCUIT BREAKER

Before adding another reviewer or loop, ask: *does it independently test a failure mode that is not
already grounded?*

- **No** → do not run it.
- **Yes** → run the smallest targeted proof.

Do not repeatedly spend large context budgets proving the same property.

---

## MINTVAULT HARD ANCHORS

- Protected MVGS maths cannot move without explicit owner approval.
- The server is authoritative for grade, evidence revision, money, permissions, payment fulfilment.
- Historical certificate origin is immutable.
- Immutable scan masters remain traceable.
- Tenant boundaries fail closed.
- Production schema beats mistaken fixtures.

---

## RELATIONSHIP TO THE NO-BULLSHIT CONTROLLER

- **GRAPH OF LOOPS** prevents *false confidence*.
- **NO-BULLSHIT** prevents *endless continuation*.

Together: **build it → independently prove reality → fix genuine failures → STOP when proven.**

They are complementary, not competing. If they appear to conflict, the conflict is almost always
"I want to stop" versus "this is not yet proven", and **proof wins** — but only for a failure mode
that is actually ungrounded, never for a speculative one (see the circuit breaker above).

---

## PRECEDENCE

This controller **supplements** the existing safety, security and grading governance; it does not
replace or weaken it. Where there is a conflict, the Golden Rules, the protected grading rules and
the staging/production rules in [`CLAUDE.md`](../CLAUDE.md) and
[`.claude/skills/controlled-code-lead/SKILL.md`](../.claude/skills/controlled-code-lead/SKILL.md)
remain **authoritative**.

Nothing here authorises: modifying protected MVGS maths; deploying to production or staging;
applying migrations to a live host; destructive data operations; force pushes; or skipping an owner
approval those rules require.
