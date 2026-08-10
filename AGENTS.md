# AGENTS.md — entry point for Codex and any non-Claude coding agent

This file exists so that an agent which does **not** read `CLAUDE.md` by convention still lands on
the same governance. It is deliberately a **pointer, not a copy** — divergent duplicates of project
rules are how two agents end up working to two different standards on the same branch.

---

## 1. ⛔ MANDATORY COMPLETION CONTROLLER — READ FIRST

Before every build, audit, repair, security, migration or release task, read and obey:

**[`docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md`](docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md)**

Permanent project governance. Applies to every future prompt unless the owner explicitly overrides
it. Core rule:

> **Fix all actionable in-scope BLOCKER/HIGH defects in the current pass.**
> **Do not stop merely to report another problem.**
> **Once the release bar passes, stop auditing and declare COMPLETE.**

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
