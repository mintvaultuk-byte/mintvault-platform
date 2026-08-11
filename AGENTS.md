# AGENTS.md — entry point for Codex and any non-Claude coding agent

This file exists so that an agent which does **not** read `CLAUDE.md` by convention still lands on
the same governance. It is deliberately a **pointer, not a copy** — divergent duplicates of project
rules are how two agents end up working to two different standards on the same branch.

---

## 1. ⛔ MANDATORY CONTROLLERS — READ BOTH FIRST

Before every substantial engineering, build, audit, security, migration or release task, read and
obey **both**:

**[`docs/GRAPH_OF_LOOPS_BUILD_CONTROLLER.md`](docs/GRAPH_OF_LOOPS_BUILD_CONTROLLER.md)**
> **No single self-improvement or review loop may certify itself.** Independent build,
> verification, mutation, held-out, drift, release and rollback loops, with the owner as the
> highest ground-truth anchor.

**[`docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md`](docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md)**
> **Fix all actionable in-scope BLOCKER/HIGH defects in the current pass.**
> **Do not stop merely to report another problem.**
> **Once the release bar passes, stop auditing and declare COMPLETE.**

GRAPH OF LOOPS prevents false confidence; NO-BULLSHIT prevents endless continuation. Both are
permanent governance and apply unless the owner explicitly overrides them. These are the same
canonical files Claude loads — there is deliberately no Codex-specific copy.

**Neither controller authorises anything.** They SUPPLEMENT the guardrails in section 2, and those
remain **authoritative** and win any conflict. Specifically, neither ever authorises modifying
protected MVGS maths, deploying, applying migrations to a live host, destructive data operations,
force push, or skipping an owner approval those rules require. "Do not stop merely to report a
problem" applies to work you are already permitted to do — it is not permission to widen scope.

## 2. Project guardrails — authoritative, and they win any conflict

Read **[`CLAUDE.md`](CLAUDE.md)** in full before touching code. It carries the Golden Rules, the
architecture reference, the protected-grading rules and the staging/production rules. The
completion controller SUPPLEMENTS those; it never overrides them.

In particular, and without exception:

- **Never** modify protected MVGS grading maths, weights, thresholds, brackets, centering, pristine
  logic or Black Label gates without explicit owner approval. See
  `CLAUDE.md` and `.claude/skills/mvgs-grading-protected/`.
- **Never** deploy to production or staging, apply a migration to a live host, run a destructive
  data operation, or force push, without explicit owner authorisation.
- **Never** change environment variables, secrets, auth logic, or the Stripe/payment flow without
  confirming first.

## 3. Engineering process

`.claude/skills/controlled-code-lead/SKILL.md` defines the Lead Engineer / read-only-reviewer split,
the evidence standards for findings, and the protected-actions list. Follow it for any non-trivial
coding task.

## 4. Current programme state

The authoritative issue register for the Partner Network release lives at
`.claude/controlled-code-lead/tasks/partner-final-blocker-repair/issue-register.md`. Read it at the
start of a continuation rather than re-auditing work already marked PROVEN.
