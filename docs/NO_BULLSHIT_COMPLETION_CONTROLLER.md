PERMANENT BUILD GOVERNANCE INSTALLATION
NO-BULLSHIT COMPLETION CONTROLLER

This is not a one-off instruction.

I want this installed as a PERMANENT DEFAULT RULE for EVERY engineering/build task you perform for me now and in future.

It applies to:

- MintVault
- Partner Network
- grading systems
- games
- websites
- apps
- backend work
- frontend work
- migrations
- security work
- deployment work
- audits
- bug fixing
- release work
- and every future software project unless I explicitly override it.

==================================================
OBJECTIVE
==================================================

Stop endless prompt chaining.

I do NOT want this pattern:

build
→ audit
→ find problem
→ stop
→ ask me for another prompt
→ fix one thing
→ audit again
→ find another thing
→ stop
→ another prompt
→ repeat for weeks.

The objective is to FINISH the approved scope.

==================================================
CORE RULE
==================================================

If you discover a defect during the current pass and it is inside the approved release/build scope:

FIX IT IN THE SAME PASS.

Do not stop merely to tell me you found another problem.

Reproduce it.
Fix it.
Test it.
Prove it.
Continue.

==================================================
ONLY VALID STOP CONDITIONS
==================================================

You may stop before completion ONLY for:

1. A genuine OWNER DECISION that materially changes:
   - product behaviour;
   - money/payment behaviour;
   - legal/compliance risk;
   - production data;
   - protected grading maths;
   - destructive architecture.

2. An external dependency you genuinely cannot access:
   - credential;
   - physical hardware;
   - third-party account;
   - unavailable external service.

3. A destructive action requiring explicit approval:
   - production deployment;
   - production migration;
   - destructive data operation;
   - force push/history rewrite;
   - irreversible external action.

4. A hard system/tool/session/context limit that physically prevents continuation.

Everything else is FIX-NOW work.

==================================================
NO SPECULATIVE BLOCKERS
==================================================

A finding is not BLOCKER/HIGH merely because a reviewer thinks it might be dangerous.

Before treating something as release-blocking prove:

- reachability;
- reproducibility;
- material impact;
- relevance to the current release.

If it is not proven:

FOLLOW_UP.

Do not prolong the release for speculation.

==================================================
ONE AUTHORITATIVE ISSUE REGISTER
==================================================

Every serious build must maintain one issue register.

Each issue has:

ID
severity
source
reproduction
reachability
impact
repair
test
mutation/proof where useful
status.

Allowed statuses:

OPEN
IN_PROGRESS
FIXED
PROVEN
FOLLOW_UP
OWNER_DECISION
EXTERNAL_BLOCKER

Never rediscover the same issue under a new name.

Never reopen PROVEN work unless:

- its relevant source changed; or
- new behavioural evidence contradicts the previous proof.

==================================================
NO REDISCOVERY LOOPS
==================================================

At the beginning of a continuation:

read:

- current HEAD;
- git status;
- issue register;
- authoritative .md design/handoff;
- previous proof state.

Do not restart the project audit.

Do not repeatedly inspect systems already PROVEN.

==================================================
FINISH ALL KNOWN IN-SCOPE BLOCKERS
==================================================

Do not fix one BLOCKER and stop if five other actionable in-scope BLOCKER/HIGH issues are already known.

Continue through the list.

The pass ends when:

A. scope is complete;

or

B. one of the four legitimate stop conditions occurs.

==================================================
NO "NEXT PROMPT" PROJECT MANAGEMENT
==================================================

A new prompt is NOT a milestone.

Do not deliberately split work into another prompt merely because:

- the task is long;
- another issue was found;
- another reviewer could be run;
- a clean checkpoint exists.

Clean checkpoints are good.

Stopping unnecessarily is not.

If context/tool limits genuinely force a stop:

1. commit a clean checkpoint;
2. update the issue register;
3. save exact continuation state;
4. return ONE precise blocker.

==================================================
HOSTILE REVIEW LIMIT
==================================================

Normal maximum review cycle:

BUILD/FIX
→ HOSTILE REVIEW
→ REPAIR REPRODUCED BLOCKER/HIGH
→ FINAL TARGETED RE-REVIEW OF CHANGED RISK SURFACES
→ RELEASE.

Do not repeatedly launch full ten-agent hostile panels after every repair.

A full new panel is justified only when repairs materially changed architecture/trust boundaries.

Otherwise re-review only:

- changed surface;
- immediate trust boundaries;
- affected migration/security boundary;
- affected tests.

==================================================
SEVERITY RULE
==================================================

BLOCKER/HIGH:
release-blocking only when proven.

MEDIUM/LOW:
FOLLOW_UP unless combined evidence proves release failure.

Do not hold a commercially usable release hostage to unrelated polish.

==================================================
TESTING RULE
==================================================

Tests must exercise the real shipped behaviour wherever practical:

real production function;
real route;
real SQL;
real role;
real transaction;
real PostgreSQL;
real CI topology.

Do not call a source-string assertion sufficient proof of behaviour.

Do not call a test green if the relevant feature never executed.

==================================================
NO VACUOUS GREEN
==================================================

Critical suites must fail if:

- zero tests execute;
- all tests skip;
- beforeAll/setup aborts;
- required report is missing.

Execution floors must stay close to actual measured counts.

==================================================
PRODUCTION SCHEMA IS AUTHORITATIVE
==================================================

Never invent a production field/table merely because a fixture expects it.

If:

real production schema != fixture

repair the fixture unless a genuine production migration is independently required.

Tests model production.

Production does not model mistaken tests.

==================================================
NO TEST-DRIVEN ARCHITECTURE DISTORTION
==================================================

Do not weaken correct architecture just to make an old test green.

If a test pins obsolete behaviour:

repair/re-pin the test to the stronger current invariant.

==================================================
OWNER DECISIONS MUST BE NARROW
==================================================

Do not ask me unnecessary architectural questions when the repository already establishes the correct pattern.

When owner approval genuinely is required:

ask ONE concise decision.

Explain:

recommended option;
material alternative;
why approval is required.

After approval:

continue automatically.

==================================================
MINTVAULT PROTECTED GRADING RULE
==================================================

For MintVault specifically:

Do NOT modify protected MVGS:

- maths;
- weights;
- thresholds;
- brackets;
- centering;
- pristine logic;
- Black Label gates;
- grading boundaries;
- defect deduction semantics

without explicit owner approval.

A non-maths repair in a protected file requires the narrowest possible authorisation and proof that unrelated scoring changes remain rejected.

==================================================
STAGING / PRODUCTION RULE
==================================================

Do not:

deploy production;
apply production migrations;
apply staging migrations;
perform destructive external actions

unless explicitly authorised.

Read-only verification is allowed when needed.

==================================================
BUILD COMPLETION RULE
==================================================

A release/build is complete when the agreed release bar passes.

Typical release bar:

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

Once this passes:

STOP AUDITING.

Move remaining MEDIUM/LOW issues to FOLLOW_UP.

Declare COMPLETE.

Do not run another speculative "just in case" audit.

==================================================
START-OF-PASS FORMAT
==================================================

Before editing, report concisely:

AUTHORITATIVE HEAD:
WORKTREE:
OPEN BLOCKER/HIGH:
OWNER DECISIONS REQUIRED:
PLAN:

Then execute.

Do not spend a large part of the context repeating history already recorded in the repository.

==================================================
END-OF-PASS FORMAT
==================================================

Return:

STARTING SHA
FINAL SHA
COMMITS
ISSUES CLOSED
REMAINING BLOCKER/HIGH
FOLLOW_UP
TESTS
MUTATIONS/PROOFS
CI
STAGING
PRODUCTION
NEXT BUILD OWNER

If:

REMAINING BLOCKER/HIGH = 0
AND release gates pass

end exactly:

NO-BULLSHIT RELEASE GATE: COMPLETE

If genuinely blocked:

NO-BULLSHIT RELEASE GATE: BLOCKED — <ONE EXACT REASON>

Do NOT end with vague statements such as:

"more work remains"
"another pass is recommended"
"worth reviewing"
"one more thing"
"continue work"

==================================================
INSTALL THIS PERMANENTLY
==================================================

Now install these rules into the persistent repository-level instructions used by your agent.

1. Find the authoritative agent instruction files in this repository/worktree.

For Claude this may include:
CLAUDE.md

For Codex this may include:
AGENTS.md
or the repository's existing Codex instruction file.

2. Save the full controller as:

docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md

3. Add a mandatory instruction near the TOP of the relevant agent instruction file:

MANDATORY COMPLETION CONTROLLER

Before every build, audit, repair, security, migration or release task, read and obey:

docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md

This controller is permanent project governance.

It applies to every future prompt unless the owner explicitly overrides it.

Its core rule is:

Fix all actionable in-scope BLOCKER/HIGH defects in the current pass.

Do not stop merely to report another problem.

Once the release bar passes, stop auditing and declare COMPLETE.

4. Do not delete or weaken existing safety/security/grading governance.

The new controller supplements those rules.

Where there is a conflict:

protected grading/security/data-safety rules remain authoritative.

5. If this repository has multiple agent instruction files, ensure the controller is referenced from every relevant root instruction entry point rather than copying divergent versions everywhere.

6. Commit the controller installation locally.

Do NOT push unless the current workflow already authorises pushing.

7. Verify by starting a fresh instruction resolution / reading the files and proving that the controller would be loaded for future work.

==================================================
RETURN
==================================================

Return:

- files created;
- instruction files modified;
- commit SHA;
- proof Claude/Codex will load it in future sessions;
- any repository scope limitation.

Then continue the CURRENT build using this controller.

Do not stop just because the controller installation is complete.
