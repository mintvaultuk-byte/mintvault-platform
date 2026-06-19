---
name: mintvault-concurrent-session-discipline
description: Use this skill BEFORE dispatching any MintVault Claude Code prompt and BEFORE any deploy. Fires whenever a prompt is about to be sent to a Claude Code terminal, whenever a fly deploy is being prepared, and whenever there is any chance another session has touched main or prod since you last looked. The skill enforces: check git log and git status to see what other sessions merged, reconcile what is ACTUALLY running on prod (fly releases + live bundle) against what you THINK is running, confirm the prompt matches the current conversation's intent, and keep prod deploys serialized and human-gated. Without this skill, MintVault has had prod silently deployed to a new version by a concurrent session (v889 grader-v2, deployed without the architect's awareness), a main branch braided from parallel-session commits, and queued prompts from earlier sessions firing unexpectedly. Fire on every dispatch and every deploy — the check costs two commands; a wrong assumption about prod's state costs an incident.
---

# MintVault concurrent-session discipline

This skill exists because MintVault is built by an architect-in-chat dispatching prompts into Claude Code while **other sessions are running in parallel**, and those sessions land commits on `main` and deploys on prod without the dispatching session knowing. The failures:

- **Prod was somewhere you didn't think it was.** A pre-flight assumed prod sat on `55bb364` (security-only). The live DB and `fly releases` showed prod had been deployed to grader-v2 (release **v889**, 2026-06-18 17:32) by a concurrent session. The whole "significant deploy" was operating on a wrong mental model of prod's current state.
- **`main` is a braid.** Multiple parallel-session commits interleaved on `main` all session, making "what's on main" a moving target between one prompt and the next.
- **Queued prompts fire late.** A prompt written for an earlier session's intent can fire in a later context and do the wrong thing (this is already a locked pre-dispatch rule).

The locked rules behind this skill: **before dispatching any Claude Code prompt, verify it matches the current conversation's intent — queued prompts from earlier sessions can fire unexpectedly**; and **deploy discipline: verify `git status` is clean and reconcile state before any deploy.**

## When this skill fires

Fire automatically when ANY of these is true:

- A Claude Code prompt is about to be sent to a terminal
- A `fly deploy` (staging or prod) is being prepared
- You are about to state "prod is on X" or "main has Y" as a basis for a decision
- Any work spans more than one session, or you know another session is active
- A pre-flight or deploy plan assumes a specific current commit/release

## The protocol — reconcile before you act

### Before dispatching a prompt — see what changed under you

    git log --oneline -10
    git status
    git branch --show-current

If commits you don't recognize are on `main`, **stop and identify them** before layering a new prompt on top. The braid is real; assume nothing.

### Before any deploy — reconcile ACTUAL vs ASSUMED state

Never deploy on a remembered mental model. Check what is genuinely running:

    fly releases --app <mintvault|mintvault-v2> | head -5
    curl -s "https://<host>/" | grep -oE '/assets/index-[A-Za-z0-9._-]+\.js' | head -1
    # For prod, also reconcile the live DB schema (see mintvault-db-migration-discipline Check 1/5)

Compare against what you _think_ is deployed. If the release was deployed by someone/something you didn't expect, or recently, **find out what it was before deploying on top of it.** A surprise release means a concurrent session got there first.

### Pre-dispatch intent check

Before sending the prompt, confirm in one line that it matches THIS conversation's current intent — not an intent from an earlier session. Queued prompts fire unexpectedly. If the prompt references state ("merged", "the fix from earlier") that a concurrent session may have changed, re-verify that state first.

### Prod deploys are serialized and human-gated

- Only one prod deploy at a time, initiated explicitly by Cornelius — never by an autonomous flow or a background agent.
- Staging (`-c fly.v2.toml`, app `mintvault-v2`) always first; prod (`fly deploy --app mintvault`) only after an explicit go.
- After any deploy, record the new release + bundle hash so the next session has a true baseline.

### Worktree isolation for parallel writers

When work genuinely must run in parallel and writes files, isolate it in a git worktree (`isolation: worktree` for a Claude Code sub-agent, or a manual worktree) so two writers don't braid onto the same working tree. Reserve it for actual parallel writers — read-only investigation doesn't need it.

## What to say to Cornelius when this skill fires

Terse. Report the reconciliation, not the protocol. Format:

    git log — [recent commits; any from another session flagged]
    Prod release — [vNNN, deployed by X at T — matches expectation / SURPRISE]
    Live bundle — [hash; matches expected build / mismatch]
    Intent — [prompt matches current conversation / stale-prompt risk]
    Status — [SAFE TO DISPATCH/DEPLOY / RECONCILE FIRST: <what>]

## Anti-patterns — do NOT do these

- **Don't deploy on a remembered state.** Reconcile `fly releases` + live bundle + (for prod) live DB first.
- **Don't assume `main` is where you left it.** Check `git log` before every dispatch.
- **Don't fire a prompt that references "the fix from earlier" without re-verifying that fix landed.** Another session may have changed it.
- **Don't let a background agent or autonomous flow deploy to prod.** Prod is human-gated and serialized.
- **Don't ignore a surprise release.** A release you didn't expect means a concurrent session deployed — understand it before stacking on top.
