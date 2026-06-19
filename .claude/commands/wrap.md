---
description: Wrap up the session — commit, push to git, then code-review + OWASP-review the work
argument-hint: [optional one-line summary of what this session did]
---

# /wrap — end-of-session: save to git, then review

You are wrapping up a MintVault work session. Do the steps below **in order**.
Optional context from the user about this session: "$ARGUMENTS"

This command **pushes code to git and reviews it. It does NOT deploy.**
Deploying to Fly stays a separate, human-gated step (CLAUDE.md Golden Rule #4).

---

## Step 1 — Recon (look before touching anything)

Run these and read the output before doing anything else:

```bash
git status
git diff --stat
git log origin/main..HEAD --oneline   # what is already committed but unpushed
```

- Note the current branch and how far ahead of `origin` it is.
- List **untracked** files separately. Do NOT blindly `git add -A`.
  Junk/scratch files (e.g. `DEBUG_REPORT.md`, `clear-batches.js`, `*.log`,
  one-off scripts) must NOT be committed unless the user clearly intended them.
  If an untracked file is ambiguous, ask in ONE line whether to include it.

## Step 2 — Commit the session's work

- Stage only the **tracked, intended** changes (and any new files the user
  obviously created as part of the work).
- Write ONE clear Conventional-Commit message summarising the session. Use the
  user's `$ARGUMENTS` summary if given; otherwise derive it from the diff.
- Commit. End the message with the standard co-author trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- If the working tree is already clean (nothing to commit), say so and skip to
  Step 3 to push whatever is already committed-but-unpushed.

## Step 3 — Push to git

```bash
git push        # current branch → its origin upstream
```

- If the branch has no upstream, set it: `git push -u origin HEAD`.
- Report the push result (branch, commit range, remote).
- ⚠️ Pushing ≠ deploying. Do **not** run `fly deploy`. If the user wants it
  live they will say "deploy".

## Step 4 — Code review the work

Invoke the **`code-review`** skill on this session's diff (the commits just
pushed, i.e. `origin/main..HEAD` before the push, or the session's changes).
Default effort: **high**. Surface correctness bugs and clear reuse/simplify
wins. Report findings grouped by severity.

## Step 5 — OWASP / security review

Invoke the **`owasp`** skill and run its OWASP Top-10 checklist against the
**same diff**. Focus on anything the session touched in these high-risk areas:

- New/changed API routes & input validation (injection, mass assignment)
- Auth, sessions, admin gating (`require_admin`), access control
- File uploads / R2 presigned URLs / SSRF
- Payment & Stripe webhook code
- Secrets, logging of PII, error leakage
- Dependency changes (`npm audit` if `package.json` changed)

For every finding give: OWASP category, file:line, severity, and a one-line fix.
If the diff touches none of these areas, say "No OWASP-relevant surface changed
in this session" rather than inventing findings.

## Step 6 — Report back (terse)

Output a short wrap-up:

- **Pushed:** branch, commit SHA(s), remote
- **Code review:** N findings — list Critical/High inline, summarise the rest
- **OWASP:** N findings by category/severity, or "clean"
- **Next session:** one line on the highest-priority unfixed item

Do not auto-fix review findings unless the user asks — list them so they can
decide. Keep the whole report tight.
