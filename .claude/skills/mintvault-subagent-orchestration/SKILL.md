---
name: mintvault-subagent-orchestration
description: Use this skill whenever a MintVault task is big enough to delegate across sub-agents — a full-system debug or audit, a multi-subsystem investigation, a parallel build-and-review, a "go fix everything / handle all of this" request, or any job whose investigation would flood the main context. Fires when Cornelius asks for comprehensive work done by agents, when a task spans multiple modules, or when an adversarial review panel would catch what one reviewer misses. The skill codifies HOW to employ sub-agents comprehensively on MintVault: fan out read-only investigation, build in an isolated worktree or the main session, run a multi-lens adversarial review panel, verify the artifacts, and keep prod deploys and approval-gated writes in the human-gated main session. Without this skill, delegated agents silently fail on approval-gated actions (they auto-deny and report success anyway) and autonomous flows deploy to prod unseen. Fire whenever delegation is on the table — structuring the fan-out costs a minute; an ungoverned agent swarm costs a prod incident.
---

# MintVault sub-agent orchestration

Cornelius wants sub-agents to do the work comprehensively — investigate, build, fix, verify, however many it takes. This skill is how to do that **correctly**, because the naive version ("agents go fix everything and deploy") reproduces the exact failures this codebase has been fighting.

The one fact that shapes everything (confirmed against Claude Code's documented behaviour):

> A sub-agent runs in an isolated context. Only the delegation prompt goes in; only its final message comes back. A sub-agent **cannot ask you a question**, and a **background sub-agent auto-denies any tool call that would otherwise prompt for approval — then continues, reporting success-shaped output for an action that never happened.** Sub-agents also cannot spawn sub-agents.

So the division of labour is non-negotiable: **sub-agents for investigation, build, and review; prod deploys and approval-gated mutations stay in the main foreground session, gated by Cornelius.** This is already what the working sessions do (the adversarial review panels). This skill makes it the standard.

## When this skill fires

Fire when ANY of these is true:

- Cornelius asks for comprehensive/autonomous work ("fix everything", "handle all of this", "go and sort it", "do whatever's needed")
- A task spans multiple subsystems or would require reading many files (investigation would flood main context)
- A full-system debug/audit, security review, or regression sweep is requested
- A change is risky enough to warrant a multi-lens adversarial review before deploy
- You're tempted to "just let an agent run and deploy" — fire specifically to stop that

## The standard MintVault orchestration shape

Run these phases in order. Investigation and review fan out; build is controlled; deploy is human-gated.

### Phase 1 — PLAN (main session)

In the main session, write the contract before any agent spawns: scope, the exact verification gate (the greps/curls/SQL that will prove done — see `mintvault-silent-failure-prevention`), and the rollback command. If the task can't be reduced to a contract, it's not ready to delegate.

### Phase 2 — FAN OUT INVESTIGATION (read-only sub-agents, parallel)

Spawn one read-only agent per subsystem. They are **read-only** — tools limited to `Read, Grep, Glob` (plus `Bash` only if needed for read-only psql/curl). Each gets a precise prompt (the only channel in) and is told to **return a summary, not a transcript**.

- Be explicit about parallelism and name the count ("three agents, one each for auth, DB, API") — Claude is conservative about fan-out by default.
- Each agent's summary returns to main context, so demand summaries — a fan-out of verbose reports refills the window you were protecting.
- For MintVault, the natural investigation splits: schema/DB layer, the affected endpoints + auth, the client surface, and the migration/cert-counter state.

### Phase 3 — BUILD (main session OR worktree-isolated agent — never a background agent)

Edits are approval-gated, so they do NOT go to a background sub-agent (auto-deny trap). Two valid options:

- Build in the **main foreground session** (prompts surface to Cornelius), or
- Delegate to a general-purpose agent with `isolation: worktree` so it gets an isolated repo copy and can't braid onto the working tree — run it foreground so approvals pass through.

Batch the fixes into one pass (locked token-efficiency rule): investigate + build + one type-check, not a deploy-then-see-what-breaks loop.

### Phase 4 — ADVERSARIAL REVIEW PANEL (read-only sub-agents, parallel)

Before deploy, spawn a panel of **differently-scoped read-only** agents on the same diff, each blind to the others, then reconcile and de-dupe in the main session. The MintVault lenses (mirror the locked deploy checklist):

1. **Security** — endpoint auth, SQL injection, PII in logs/responses, unauth endpoints (the OWASP skill is the reference)
2. **PII / tenant isolation** — no customer data leaking to grader/staff views; self-scoped queries
3. **Error paths** — R2 / DB / session / fetch failure modes
4. **Idempotency** — migrations + backfills resume-safe; no silent collisions
5. **Regression** — existing flows still work; DVLA/V5C parity where relevant

This is the pattern the working sessions already use (the review workflow with per-lens schemas and a verify pass). Each panelist returns only its findings; main session merges, de-dupes, sorts by severity, and fixes confirmed issues before deploy.

### Phase 5 — VERIFY (main session)

Run the silent-failure primitives on the actual artifacts: served bundle hash changed, marker present in served chunk, affected-row counts non-zero, live DB schema correct on the target. A sub-agent's "done" is not proof — verify the artifact (see `mintvault-silent-failure-prevention`).

### Phase 6 — DEPLOY (main session, human-gated, NEVER a sub-agent)

Staging first (`-c fly.v2.toml`, `mintvault-v2`), Cornelius eyeballs, then prod (`fly deploy --app mintvault`) on his explicit go. Reconcile prod's actual state first (see `mintvault-concurrent-session-discipline`). **No sub-agent, background task, or autonomous flow deploys to prod.**

## Sub-agent design rules (apply to every agent you spawn)

- **Scope tools explicitly. Omitting `tools` grants ALL tools, not none.** Read-only agents: `Read, Grep, Glob`. Research+web: add `WebFetch, WebSearch`. Never give an investigation agent Write/Edit.
- **Brief like a stranger.** The prompt is the only thing that crosses the boundary — paths, error messages, the relevant locked rule, the exact deliverable. The agent does not see this conversation.
- **Demand summaries, not transcripts.** "Report only the failing checks with file:line", not "report everything."
- **Name the parallelism.** "Use N agents" — don't say "parallelize."
- **Pick the model per role.** Read-only investigation -> a fast small model (Explore/Haiku-class). Building/consequential reasoning -> inherit the main model.
- **Sub-agents can't spawn sub-agents.** The orchestration lives in the main session; chain phases from there.
- **Worktree-isolate parallel writers.** Two agents editing the same tree braid; `isolation: worktree` prevents it.
- **Read-only panelists can't trip the approval trap.** A reviewer with no Write tool has nothing to be auto-denied — which is exactly why review fans out safely and edits/deploys do not.

## The hard gate (never cross this)

- **No sub-agent deploys to prod.** Ever. Human-gated, main session, foreground.
- **No background agent does an approval-gated edit/commit/deploy.** It auto-denies and reports false success. Foreground or main session only.
- **No autonomous "fix and ship" loop on prod.** Investigation and review autonomously, yes; the ship decision is Cornelius's.

## What to say to Cornelius when this skill fires

Terse. Tell him the shape, then run it. Format:

    Plan — [contract + verification gate, 1-2 lines]
    Investigation — [N read-only agents: <subsystems>] -> [key findings merged]
    Build — [main session / worktree agent] — [what changed]
    Review panel — [N lenses] -> [confirmed issues by severity, de-duped]
    Verify — [bundle changed / markers present / rows affected / live DB]
    Deploy — [staging up, awaiting your go for prod]

## Anti-patterns — do NOT do these

- **Don't tell an agent to "fix it and deploy."** Split: agents investigate/build/review; you gate the deploy.
- **Don't delegate an edit to a background agent.** Auto-deny -> false success. Foreground/main.
- **Don't omit `tools` on an investigation agent.** That grants it Write, Edit, and every MCP server.
- **Don't fan out without naming the count or demanding summaries.** You'll get conservative parallelism and verbose returns.
- **Don't trust the panel's silence as a pass.** Confirm each lens actually returned findings (or an explicit "clean").
- **Don't skip the verify phase because the agents said done.** Verify the artifact.
- **Don't let parallel writers share a working tree.** Worktree-isolate them.
