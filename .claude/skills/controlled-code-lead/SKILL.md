---
name: controlled-code-lead
description: Use this skill for EVERY MintVault task that touches code, debugging, review, architecture, databases, migrations, infrastructure, storage, providers, deployment, CI/CD, production, or staging. This is the default governance model for coding work in this repo — it defines the Lead Engineer / read-only-reviewer split, the mandatory Stage 0-7 workflow, evidence standards for findings, issue classifications (A-H), the protected-actions list requiring explicit owner approval, and the templates under .claude/skills/controlled-code-lead/templates/. Fire it before scoping any non-trivial coding task; skip only for pure conversation, pure research with no code/infra impact, or a single-line copy fix explicitly scoped as trivial by the owner.
---

# Controlled Code Lead

This is the standing governance model for coding work on MintVault. It exists
so that every non-trivial change — a bug fix, a review, a migration, an infra
change — goes through the same disciplined loop: baseline → plan → investigate
→ verify → authorise → implement → regress → report. It composes with, and
does not replace, the other project skills ([[mintvault-db-migration-discipline]],
[[mintvault-concurrent-session-discipline]], [[mintvault-silent-failure-prevention]],
[[mvgs-grading-protected]], [[cornelius-execution-style]]) — where those skills
give a specific check, this skill gives the surrounding process.

## Roles

### Lead Engineer — the primary Claude session, always

**Lead authority (what the Lead alone decides):**

- decide scope
- assign reviewer ownership
- accept or reject findings
- author edits and modify files (within the owner-authorised task scope)
- run safe local tests
- create LOCAL, unpushed commits within the authorised task scope

**Owner authority — the Lead can NEVER self-grant it.** Only the human owner may
authorise a *protected action* (see "Protected actions" below: push, deploy,
migration application, staging/production mutation, secret rotation, DNS/infra,
paid-provider calls, destructive storage/DB, package publication). The Lead may
*route* and *prepare* a protected action and *validate* an approval record, but the
Lead approving migrations/deploys/secrets on its own is a governance violation, not
Lead authority. Every protected operation must have an owner approval record.

Reviewer agents (see below) never make implementation decisions. They report
evidence; the Lead decides what to do with it — except protected actions, which
still require the owner.

### Reviewer agents — read-only, scoped, no authority

Use the `controlled-reviewer` subagent type (`.claude/agents/controlled-reviewer.md`)
for investigation fan-out. A reviewer:

- inspects only its assigned scope
- never edits files, commits, deploys, or mutates git
- never mutates databases, storage, staging, or production
- never invokes paid providers or rotates secrets
- never changes infrastructure
- returns evidence only, in the format in `templates/reviewer-report.md`

Spawn reviewers with the `Agent` tool, `subagent_type: "controlled-reviewer"`.
Give each a **non-overlapping** scope (a file set, a subsystem, or a specific
hypothesis) — overlapping scopes produce duplicate/contradictory findings that
waste the Lead's verification pass. For larger fan-outs (many independent
scopes, or an adversarial multi-reviewer pass on the same finding), use the
`Workflow` tool instead of spawning agents one at a time — but only when the
user has opted into multi-agent orchestration per the `Workflow` tool's own
gating rules; otherwise `Agent` calls are the default.

## When this fires

Any task involving: writing or editing code, debugging, code review,
architecture decisions, database work, migrations, infrastructure, storage
(R2/B2), external providers (Stripe, Resend, Higgsfield, TCGdex, etc.),
deployment, CI/CD, or anything touching staging or production.

Skip it for: pure conversation, answering a question with no code/infra
change, or a change the owner has explicitly scoped as trivial (e.g. "just
swap this hex code"). When in doubt, use the lighter form — Stages 0, 4-6
collapsed into one pass — rather than skipping outright.

## The workflow

### Stage 0 — Baseline

Before anything else, record:

- current branch, current commit (`git rev-parse HEAD`, `git branch --show-current`)
- `git status` (uncommitted work you must not clobber)
- production commit, if the task is deploy-adjacent (`/api/version` or `fly releases`)
- current test/build status if relevant (`npm run check`, any test command)
- protected systems in play (grep `templates/protected-systems.md` and the
  live list — MVGS grading logic, Stripe webhook, auth, cert_counter, R2
  signing, etc.)
- explicit scope for this task, and explicit prohibited actions

Write this into a fresh task ledger — see "Where state lives" below.

### Stage 1 — Review plan

The Lead decides how many reviewers are needed and assigns each a scope.
Scopes must not overlap. For a small task this can be a single reviewer, or
the Lead can skip spawning a reviewer entirely and inspect directly — the
ceremony scales with the task, the discipline doesn't.

### Stage 2 — Reviewer investigation

Every reviewer returns a report matching `templates/reviewer-report.md`:
files reviewed, lines reviewed, findings, evidence, root cause, reproduction,
safeguards, proposed fix, required testing, and clean areas (what was checked
and found fine — absence of findings is itself a report, not silence).

No edits allowed at this stage, from anyone.

### Stage 3 — Lead verification

The Lead must, personally:

- wait for every reviewer before proceeding
- verify every accepted finding — re-read the cited lines, don't take the
  claim on faith
- reject speculation ("this could theoretically..." without a concrete
  repro is not an accepted finding)
- reject duplicates across reviewers
- trace callers of anything a fix would change
- verify contracts (types, API shapes, DB columns) against the live
  source of truth, not against the reviewer's assertion
- verify that any "previous fix" a finding references actually landed and
  actually works — a past commit message is not proof

### Stage 4 — Implementation authorisation

The Lead writes a change manifest (`templates/change-manifest.md`) listing
exactly what will change, file by file, and why. Editing may only begin
after this manifest exists. For protected actions (see below), the manifest
must be shown to the owner and explicitly approved before Stage 5 starts.

### Stage 5 — Implementation

Only the Lead edits files. One logical fix at a time — don't batch unrelated
fixes into one edit pass, since that's what makes Stage 6 regression checks
ambiguous when something breaks.

### Stage 6 — Regression

Run every required gate for the change. These scripts EXIST — use them (do not
claim "no tests exist"):

- `npm run check` (tsc) — **always**
- `npm test` (vitest, full suite) — **always for any code change**; for a
  grading-adjacent change the complete MVGS regression set (`mvgs-scoring`,
  `pristine`, `centering`, `mvgs-input-builder`, `mvgs-calibration-validation`)
  MUST pass and is non-negotiable
- `npm run lint` (eslint) — compare against baseline; add no new errors
- `npm run build` — for anything touching bundling/server bootstrap
- `npm run dev` starts cleanly for anything touching server bootstrap
- targeted manual/preview verification for any UI surface
- secret scan + changed-file allowlist review of the diff
- any project-specific gate the touched subsystem calls for (vq_* schema diff,
  label-render visual check, frontend/backend contract check)

After every logical change, also run drift prevention (below) before moving
to the next change.

### Stage 7 — Final report

Report to the owner: findings (fixed), findings (rejected, with reason),
fixes applied, deferred work (with why it's deferred and what unblocks it),
tests run, rollback plan, rollout plan, remaining risks. Use plain English
per the top-level CLAUDE.md communication rules — this stage is for the
owner, not for other engineers.

## Issue classifications

| Class | Meaning |
|---|---|
| A | Safe local application fix — no coordination, no staging dependency |
| B | Coordinated frontend/backend change — both sides must ship together |
| C | Requires staging verification before it can be called done |
| D | Infrastructure or configuration change |
| E | Migration (schema change, backfill, index) |
| F | External provider dependency (Stripe, Resend, R2/B2, Higgsfield, TCGdex, Anthropic API) |
| G | Operational action (a one-off script, a manual data fix, a rotation) |
| H | Recommendation only — not implemented this pass, logged for later |

Every finding and every manifest line gets a classification. Classes C-H
carry stricter gates (see Definition of done and Protected actions below).

## Mandatory evidence for findings

No vague findings. Every finding must include:

- ID (stable within the task — `F1`, `F2`, ...)
- severity and confidence
- exact file(s) and exact line(s)
- route/endpoint if applicable
- root cause (not just symptom)
- proof (the actual output/log/query result that demonstrates it)
- reproduction steps
- safeguards already in place, if any
- proposed fix
- contract impact (does this change a type, a DB column, an API shape a
  caller depends on?)
- classification (A-H)

A finding that can't fill in "proof" and "reproduction" is speculation, not
a finding — send it back to the reviewer or drop it in Stage 3.

## Where state lives

For any task big enough to warrant Stage 0-7 in full, create a per-task
directory:

    .claude/controlled-code-lead/<task-slug>/
      task-ledger.md
      issue-register.md
      deployment-state.md
      change-manifest.md
      rollout.md
      rollback.md

Seed each from `templates/`. Only the Lead updates these files — reviewers
never write to them, they only feed findings into the issue register via
their reports. `protected-systems.md` is a shared, slowly-changing reference
(not per-task) — keep one live copy at `.claude/controlled-code-lead/protected-systems.md`,
seeded from the template, and update it when a new protected system is
identified.

For a small task, the ledger can be a few lines inline in the conversation
instead of a file — don't create ceremony the task doesn't need. Use judgement;
the point is traceability, not paperwork.

## Drift prevention

After every logical change, before moving on, check:

- `git diff --stat` — does the file list match what the manifest said?
- any unexpected file touched?
- formatting drift (a "one-line fix" that reformatted the whole file — see
  the pre-commit prettier caveat: use `git commit --no-verify` if lint-staged
  would blow up the diff on an unformatted file, and say so in the report)
- generated files changed unexpectedly (build output, lockfiles)
- `package.json`/`package-lock.json` changed when the task didn't call for
  a dependency change

If anything unexpected shows up, stop and explain it before continuing —
don't fold it into the current change silently.

## Definition of done

A task is not complete unless:

- every accepted finding is fixed or explicitly deferred (with reason)
- every fix has a regression check — a Vitest test where the surface is
  testable, else a documented manual/preview verification step; say which
- all required gates pass: `npm run check` + `npm test` (full Vitest suite) +
  `npm run lint`, plus `npm run build` where bundling is touched. (This repo HAS
  Vitest + ESLint + Prettier + Husky — never assert otherwise.) For grading-
  adjacent work the MVGS regression tests passing is mandatory.
- a rollback exists and is written down
- a rollout plan exists (even if it's just "npm run dev restarts")
- documentation updated if the change affects how the system is used
- no debug code remains (console.log scaffolding, temp flags)
- no TODO stands in for missing work

**Never describe as a completed fix:** an unwired helper function, an
authored-but-unapplied migration, a design document, or documentation. Those
are legitimate deliverables in their own right (and often the correct
Stage-4 scope for a C/D/E-classified change), but they are not "done" —
report them as exactly what they are. This project's history has multiple
sessions where an authored migration or a pure-core helper got reported as
"shipped" when nothing was wired or applied; don't repeat that.

## Protected actions

These require explicit owner approval before execution, every time,
regardless of who initiated the task. The Lead cannot self-grant any of them:

- `git push` (incl. `git -C <dir> push`) and force-push
- deploy (`fly deploy`, `flyctl deploy`, `scripts/safe-deploy.sh`, or equivalent)
- migrations — `db:push`, `drizzle-kit push`, raw DDL (incl. additive `CREATE`/
  `ALTER ... ADD`), AND migration wrapper scripts (`npx tsx …apply-migrations…`)
  against any environment
- secret/env var changes; **credential rotation**
- DNS / infrastructure changes
- production writes; destructive staging writes (not routine dev iteration)
- paid provider calls (Stripe live mode, Higgsfield generation, etc.)
- storage deletion (R2/B2 object or bucket deletion) — incl. via the AWS/S3 SDK
- destructive SQL (`DROP`, `TRUNCATE`, `DELETE` without a `WHERE`, column drops)
- **dependency install/upgrade** (`npm install <pkg>`, lockfile change) — CLAUDE.md rule 5
- **authentication-logic edits** (admin/staff login, PIN, `mv.sid` session) — CLAUDE.md rule 3
- **payment / Stripe-webhook code edits** — CLAUDE.md rule 6
- edits to any protected system in `protected-systems.md` (grading, cert_counter, R2 signing)
- package publication; production cleanup

**Standing / durable authorisation.** A task prompt may carry a *durable* grant
for a named action class ONLY when it identifies the exact **operation category**,
**environment**, **scope**, and **expiry/phase**. A vague statement ("do what's
needed", "handle it") does NOT authorise any protected action. A standing grant
cannot be broadened by the Lead, and its use must be recorded (an approval record).
Absent such a specific grant, "every time" means each individual execution.

**Hook honesty (current state — hardening tracked for Phase 9B).** The current
`.claude/hooks/protected-action-guard.sh` is a **Bash-surface advisory reminder
only — NOT a security boundary.** It matches a literal-string blocklist on Bash
commands, does not see `Edit`/`Write`/MCP tools, always exits 0 (never blocks), and
misses wrapper/SDK forms (`safe-deploy.sh`, `npx tsx` migration wrappers, additive
DDL, SDK storage deletes, `git -C … push`). It also does NOT override owner
pre-approvals in `.claude/settings.local.json`. **The real gate is the Lead asking
the owner first** — do not treat the absence of a banner as permission.

## Composing with existing skills

- Any DB/migration work: run [[mintvault-db-migration-discipline]]'s five
  checks inside Stage 2/3 — it's the concrete DB verification protocol this
  skill's "verify contracts" step delegates to.
- Any dispatch to another session or any deploy: run
  [[mintvault-concurrent-session-discipline]]'s reconciliation check as part
  of Stage 0's baseline.
- Any "done"/"deployed"/"verified" claim, from a reviewer or from yourself:
  apply [[mintvault-silent-failure-prevention]] before writing it into
  Stage 7's final report.
- Anything touching `client/src/components/grading/`, `shared/mvgs-scoring.ts`,
  or the other files listed in [[mvgs-grading-protected]]: stop, that skill's
  approval gate applies before Stage 1 even starts.
- Communication style throughout all stages: [[cornelius-execution-style]]
  and the top-level CLAUDE.md plain-English rule — Stage 7's report is for a
  non-technical founder, not an engineering audience.

---

# Version 1.1 extensions (2026-07-11)

Everything below is **additive** to the v1.0 workflow above — nothing above
is loosened or replaced. Versioning lives in `.claude/governance-version.md`;
every future governance change bumps the version there and appends to
`.claude/governance-changelog.md` (append-only). The governance system
self-tests with `bash .claude/governance-tests/run-all.sh` — run it after
any change to governance files.

## Session recovery (mandatory session start)

Every new Claude Code session doing coding work must FIRST read:

1. `CLAUDE.md`
2. `.claude/governance-version.md`
3. `.claude/governance-changelog.md` (latest entry at minimum)
4. the current task ledger, if one exists under `.claude/controlled-code-lead/<task-slug>/`
5. the current issue register (same directory)
6. the current deployment state (same directory)
7. `.claude/controlled-code-lead/protected-systems.md`
8. `.claude/project-memory.md`

…and then restate to the owner, before continuing any work:

- current branch
- current commit
- last completed phase/stage of the active task
- active task (or "none — awaiting scope")
- outstanding reviewers (spawned but not yet verified in Stage 3)
- next authorised action (and what is NOT yet authorised)

If no task directory exists, say so and start at Stage 0. If the ledger and
reality disagree (branch moved, files changed), reconcile per
[[mintvault-concurrent-session-discipline]] before anything else.

## Permanent project memory

`.claude/project-memory.md` records long-term engineering knowledge
(architecture, provider/infra/DB decisions, production assumptions, caveats,
deferred work, tech debt, rollout/migration history, major design
decisions). Required reading at session start (step 8 above). Only the Lead
updates it — at the moment a decision is made or an assumption discovered,
as part of Stage 7, not retroactively. Never store secrets in it.

## Definition of Proof (Stage 7 requirement)

Every completed feature/fix fills in `templates/definition-of-proof.md`:
Design / Implementation / Verification / Activation status, with
Verification at exactly one evidenced level:
**Design Only → Local Proof → Integration Proof → Staging Proof →
Production Proof.**

Hard language rule: never describe work as "fixed", "done", or "working"
when it has only reached Design Only or Local Proof — state the level it
actually reached. This extends (does not replace) the v1.0 Definition of
Done's unwired-helper/authored-migration rule.

## Architecture snapshots (mandatory for D/E/F + structural G)

For any infrastructure, provider, storage, deployment, or database work:
`templates/architecture-before.md` captured from the LIVE system at Stage
1/2, and `templates/architecture-after.md` as PROPOSED at Stage 4, then
confirmed AS-BUILT at Stage 6/7. Proposed-vs-as-built deviations must be
explained in the Stage 7 report. Mermaid preferred, Markdown acceptable.

## Implementation budget (Stage 4 requirement)

Before Stage 5 editing begins, the Lead fills in
`templates/implementation-budget.md`: files expected, estimated lines
changed, estimated commits, estimated tests, estimated duration. If actuals
exceed the estimate by more than ~25%, STOP editing and explain (wrong
diagnosis? scope creep?) before continuing — a blown budget is a signal,
not an inconvenience.

## Confidence scoring (Stage 7 requirement)

Every engineering report ends with the four scores from
`templates/confidence-scoring.md`: Design, Implementation, Verification,
and Deployment Confidence — each a percentage with a short concrete
justification, consistent with the Definition of Proof level reached.
Never averaged into one number.

## Specialist reviewer library

`controlled-reviewer` (v1.0) is unchanged and remains the general-purpose
reviewer. v1.1 adds ten read-only specialists under `.claude/agents/`, all
carrying the identical hard-constraint block (self-tested):

`frontend-reviewer`, `backend-reviewer`, `database-reviewer`,
`security-reviewer`, `storage-reviewer`, `infrastructure-reviewer`,
`deployment-reviewer`, `provider-reviewer`, `performance-reviewer`,
`ui-reviewer`.

The Lead chooses which reviewers a task needs at Stage 1 (a specialist's
lens beats a generalist inside its domain; the generalist covers scopes no
specialist owns). Reviewers never edit files and never make implementation
decisions, exactly as in v1.0.

## Governance health report

`templates/governance-health-report.md` — produce one after any governance
version bump, whenever the owner asks about governance state, and
periodically at the Lead's judgement. Fill from live inspection (run the
self-tests; list actual files), never from memory. Keep dated copies under
`.claude/controlled-code-lead/`.

## Hook roadmap

The protected-action hook stays ADVISORY in v1.1. The designed-but-not-
enabled blocking mode (dev/prod governance modes, one-shot approval tokens,
rollback path) is documented in `.claude/hooks/HOOK-UPGRADE-ROADMAP.md`.
Enabling it is a governance version bump requiring explicit owner approval.

## Session Recovery (mandatory on every new session and after compaction)

The Lead is a single Claude session, so its working memory does NOT survive a
restart or a context compaction. Durable state on disk is the source of truth.
On session start OR after any compaction, before continuing ANY in-flight task,
the Lead MUST read, in order:

1. project `CLAUDE.md` and this SKILL.md
2. `.claude/governance-version.md` + `governance-changelog.md`
3. the active-task pointer / cross-task index, then the in-flight task dir under
   `.claude/controlled-code-lead/tasks/<task-slug>/`: `task-ledger.md`,
   `issue-register.md`, `change-manifest.md`, `reviewer-status.md`,
   `deployment-state.md`, `governance-snapshot.json`
4. live `protected-systems.md`
5. project memory (`.claude/project-memory.md` and the memory index)

Then RESTATE (out loud, in the response) before acting:

- repository, branch, commit, dirty/untracked state
- task/program ID and last completed stage
- governance version + snapshot hash (recompute and compare — STOP on unexpected drift)
- outstanding reviewers and whether reviewer isolation has been proven this process
- the single **authorised next action** from the ledger
- the protected actions that are NOT authorised

If the state cannot be reconstructed reliably from disk, **STOP** and report — do
not guess and continue. A past commit message is not a substitute for the ledger.

## Durable stage transitions (no inline-only ledger for material work)

For any task that is multi-agent, multi-phase, or touches migrations,
infrastructure, paid providers, staging/production, or a protected system, the
Lead MUST write durable state to the task dir at each of these transitions (not
just in conversation): baseline complete; review plan complete; each reviewer
report received; Lead verification complete; change-manifest approved; each
logical implementation complete; regression complete; final report complete.
The "few lines inline" escape hatch is permitted ONLY for a single-file Class-A
change with no protected action. If in doubt, write the file.

## Proof-state vocabulary (never say "fixed" without a level + evidence)

Every issue/feature tracks its state independently, and a report must cite the
level and an evidence reference:

`Designed` → `Implemented` → `Locally verified` → `Integration verified` →
`Staging verified` → `Activated` → `Production verified`.

An authored migration, an unwired helper, a runbook, a schema, an unwired route,
or a mocked test is at most `Implemented`/`Locally verified` — it is NOT an active
production fix. "Fixed"/"done"/"shipped" with no attached level and evidence
reference is forbidden (see `templates/definition-of-proof.md`). This is the
same discipline as [[mintvault-silent-failure-prevention]], made durable.

## Program, scale & scope layer (Phase 9C)

For multi-phase work, use the PROGRAM layer, not just per-task dirs:

- **Program dir:** `.claude/controlled-code-lead/programs/<program-id>/` —
  `program-ledger.md`, `deferred-carry-forward.md` (open items carry into the next
  phase's Stage 0), commit-chain, program-rollback. Finding IDs are program-scoped
  (`<PROG>-P<phase>-F<n>`) so they don't collide across phases. A landed
  substrate/design is NOT "closed" until its proof level is `Activated`.
- **Cross-task index:** `.claude/controlled-code-lead/INDEX.md` — find current state
  without grepping the repo. Update at Stage 0 and Stage 7.
- **Scope & concurrency:** `.claude/controlled-code-lead/scope-and-concurrency.md` —
  multi-repo scoping (STOP if a command/edit targets another repo; never apply
  MintVault protected-systems elsewhere) + the parallel-session lock model (default
  read-only under a live lock; shared state is append-only).
- **Owner approvals:** `.claude/controlled-code-lead/approvals/` (records gitignored).
- **Project memory:** `.claude/project-memory/` (indexed sections, not one flat file).
- **Risk & budget templates:** `templates/architecture-before.md` + `-after.md`,
  `templates/implementation-budget.md` (estimate files/lines/commits/tests up front;
  STOP + re-manifest if actuals exceed ~25%), `templates/confidence-scoring.md`
  (confidence never replaces evidence; each % cites its evidence + missing proof).
- **Self-tests:** `bash .claude/governance-tests/run-all.sh` — validates skill load,
  reviewer read-only allowlists, hook detection (incl. wrapper/SDK forms) + fail-closed,
  and state persistence. Keep it green.
