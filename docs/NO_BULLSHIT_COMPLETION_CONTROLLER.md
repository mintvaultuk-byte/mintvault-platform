# NO-BULLSHIT COMPLETION CONTROLLER

**Permanent project governance.** Installed 2026-08-09 by owner directive. Applies to every
engineering task — MintVault, Partner Network, grading, games, websites, apps, backend, frontend,
migrations, security, deployment, audits, bug fixing, release work, and every future software
project — unless the owner explicitly overrides it.

---

## OBJECTIVE

Stop endless prompt chaining. The following pattern is the failure this document exists to end:

> build → audit → find problem → **stop** → ask for another prompt → fix one thing → audit again →
> find another thing → **stop** → another prompt → repeat for weeks.

The objective is to **FINISH the approved scope**.

---

## CORE RULE

If you discover a defect during the current pass and it is inside the approved release/build scope:

**FIX IT IN THE SAME PASS.**

Do not stop merely to tell the owner you found another problem. Reproduce it. Fix it. Test it.
Prove it. Continue.

---

## THE ONLY VALID STOP CONDITIONS

You may stop before completion **only** for:

1. **A genuine OWNER DECISION** that materially changes: product behaviour; money/payment
   behaviour; legal/compliance risk; production data; protected grading maths; destructive
   architecture.
2. **An external dependency you genuinely cannot access:** a credential; physical hardware; a
   third-party account; an unavailable external service.
3. **A destructive action requiring explicit approval:** production deployment; production
   migration; destructive data operation; force push / history rewrite; irreversible external
   action.
4. **A hard system/tool/session/context limit** that physically prevents continuation.

Everything else is FIX-NOW work.

---

## NO SPECULATIVE BLOCKERS

A finding is not BLOCKER/HIGH merely because a reviewer thinks it might be dangerous. Before
treating something as release-blocking, prove:

- reachability;
- reproducibility;
- material impact;
- relevance to the current release.

If it is not proven: **FOLLOW_UP**. Do not prolong the release for speculation.

---

## ONE AUTHORITATIVE ISSUE REGISTER

Every serious build maintains one register. Each issue carries: `ID`, `severity`, `source`,
`reproduction`, `reachability`, `impact`, `repair`, `test`, `mutation/proof where useful`, `status`.

Allowed statuses: `OPEN` · `IN_PROGRESS` · `FIXED` · `PROVEN` · `FOLLOW_UP` · `OWNER_DECISION` ·
`EXTERNAL_BLOCKER`.

Never rediscover the same issue under a new name. Never reopen PROVEN work unless its relevant
source changed, or new behavioural evidence contradicts the previous proof.

---

## NO REDISCOVERY LOOPS

At the start of a continuation, read: current HEAD; `git status`; the issue register; the
authoritative `.md` design/handoff; previous proof state.

Do not restart the project audit. Do not repeatedly inspect systems already PROVEN.

---

## FINISH ALL KNOWN IN-SCOPE BLOCKERS

Do not fix one BLOCKER and stop while five other actionable in-scope BLOCKER/HIGH issues are
already known. Continue through the list.

The pass ends when **(A)** scope is complete, or **(B)** one of the four legitimate stop conditions
occurs.

---

## NO "NEXT PROMPT" PROJECT MANAGEMENT

A new prompt is not a milestone. Do not deliberately split work into another prompt merely because
the task is long, another issue was found, another reviewer could be run, or a clean checkpoint
exists.

Clean checkpoints are good. Stopping unnecessarily is not.

If context/tool limits genuinely force a stop: commit a clean checkpoint; update the issue
register; save exact continuation state; return **ONE** precise blocker.

---

## HOSTILE REVIEW LIMIT

Normal maximum review cycle:

> BUILD/FIX → HOSTILE REVIEW → REPAIR REPRODUCED BLOCKER/HIGH → FINAL TARGETED RE-REVIEW OF CHANGED
> RISK SURFACES → RELEASE.

Do not repeatedly launch full ten-agent hostile panels after every repair. A full new panel is
justified only when repairs materially changed architecture or trust boundaries. Otherwise
re-review only: the changed surface; immediate trust boundaries; the affected migration/security
boundary; affected tests.

---

## SEVERITY RULE

- **BLOCKER/HIGH** — release-blocking only when proven.
- **MEDIUM/LOW** — FOLLOW_UP unless combined evidence proves release failure.

Do not hold a commercially usable release hostage to unrelated polish.

---

## TESTING RULE

Tests must exercise the real shipped behaviour wherever practical: real production function; real
route; real SQL; real role; real transaction; real PostgreSQL; real CI topology.

Do not call a source-string assertion sufficient proof of behaviour. Do not call a test green if
the relevant feature never executed.

---

## NO VACUOUS GREEN

Critical suites must FAIL if: zero tests execute; all tests skip; `beforeAll`/setup aborts; or a
required report is missing. Execution floors must stay close to actual measured counts.

---

## PRODUCTION SCHEMA IS AUTHORITATIVE

Never invent a production field or table merely because a fixture expects it. If the real
production schema differs from the fixture, repair the **fixture** — unless a genuine production
migration is independently required.

Tests model production. Production does not model mistaken tests.

---

## NO TEST-DRIVEN ARCHITECTURE DISTORTION

Do not weaken correct architecture to make an old test green. If a test pins obsolete behaviour,
repair or re-pin the test to the stronger current invariant.

---

## OWNER DECISIONS MUST BE NARROW

Do not ask unnecessary architectural questions when the repository already establishes the correct
pattern. When owner approval genuinely is required, ask **ONE** concise decision, stating: the
recommended option; the material alternative; why approval is required. After approval, continue
automatically.

---

## MINTVAULT PROTECTED GRADING RULE

For MintVault specifically, do **NOT** modify protected MVGS maths, weights, thresholds, brackets,
centering, pristine logic, Black Label gates, grading boundaries, or defect deduction semantics
without explicit owner approval.

A non-maths repair in a protected file requires the narrowest possible authorisation **and** proof
that unrelated scoring changes remain rejected.

---

## STAGING / PRODUCTION RULE

Do not deploy production; apply production migrations; apply staging migrations; or perform
destructive external actions — unless explicitly authorised. Read-only verification is allowed
when needed.

---

## BUILD COMPLETION RULE

A release/build is complete when the agreed release bar passes. Typical release bar:

- all known in-scope BLOCKER/HIGH issues FIXED + PROVEN;
- migrations/rollback estate green;
- critical tests execute non-vacuously;
- CI-equivalent full suite green;
- build green;
- architecture-specific proof green;
- AMD64 green where required;
- PR-scoped secret scan clean;
- zero new CodeQL HIGH/CRITICAL;
- exact final SHA CI terminal green;
- authoritative docs current;
- worktree clean.

Once this passes: **STOP AUDITING.** Move remaining MEDIUM/LOW to FOLLOW_UP. Declare COMPLETE. Do
not run another speculative "just in case" audit.

---

## START-OF-PASS FORMAT

Before editing, report concisely:

```
AUTHORITATIVE HEAD:
WORKTREE:
OPEN BLOCKER/HIGH:
OWNER DECISIONS REQUIRED:
PLAN:
```

Then execute. Do not spend a large part of the context repeating history already recorded in the
repository.

---

## END-OF-PASS FORMAT

Return: `STARTING SHA` · `FINAL SHA` · `COMMITS` · `ISSUES CLOSED` · `REMAINING BLOCKER/HIGH` ·
`FOLLOW_UP` · `TESTS` · `MUTATIONS/PROOFS` · `CI` · `STAGING` · `PRODUCTION` · `NEXT BUILD OWNER`.

If `REMAINING BLOCKER/HIGH = 0` **and** release gates pass, end exactly:

```
NO-BULLSHIT RELEASE GATE: COMPLETE
```

If genuinely blocked, end exactly:

```
NO-BULLSHIT RELEASE GATE: BLOCKED — <ONE EXACT REASON>
```

Do **not** end with vague statements such as "more work remains", "another pass is recommended",
"worth reviewing", "one more thing", or "continue work".

---

## PRECEDENCE

This controller **supplements** existing safety, security and grading governance; it does not
replace or weaken it. Where there is a conflict, the protected grading, security and data-safety
rules in `CLAUDE.md` and
`.claude/skills/controlled-code-lead/SKILL.md` remain **authoritative**.

Specifically, this controller never authorises: modifying protected MVGS maths; deploying to
production or staging; applying migrations to a live host; destructive data operations; force
pushes; or skipping an owner approval that those rules require. "Fix it in the same pass" applies
to work you are already permitted to do.
