# Hook upgrade roadmap — advisory → blocking (NOT YET ENABLED)

**Status: documentation only.** As of governance v1.1 the
`protected-action-guard.sh` hook is **advisory** — it prints a warning
banner and always exits 0. Nothing in this document is active. Enabling any
of it is a governance version bump requiring explicit owner approval and a
changelog entry.

## Why it is advisory today

`.claude/settings.local.json` contains dozens of owner-pre-approved command
patterns that legitimately match protected patterns (`fly deploy`,
`fly secrets`, `git push`, prod-`DATABASE_URL` migrations). A hard block
would fight permissions the owner already granted and brick existing
workflows. The binding gate in v1.x is procedural: the Lead asks the owner
before any protected action, per CLAUDE.md golden rules and SKILL.md.

## How it would become a blocking hook

Claude Code PreToolUse hooks control execution two ways:

1. **Exit code 2** — blocks the tool call; stderr is fed back to Claude as
   the reason.
2. **Structured stdout** — print JSON like
   `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}`
   (`"ask"` is also supported to force a user prompt — likely the right
   first step, since it routes the decision to the owner rather than
   hard-failing).

The upgrade path would change the final `exit 0` into a decision branch:
matched pattern + no valid approval → emit `"ask"` (phase 1) or `"deny"`
(phase 2). The detection patterns themselves need no change.

## Development mode vs production governance mode

A mode flag file, e.g. `.claude/governance-mode` containing `dev` or `prod`
(or an env var `GOVERNANCE_MODE` set in settings `env`):

- **`dev` (development mode)** — hook behaves exactly as today: advisory
  banner, never blocks. For local iteration where the owner is present and
  the conversation itself is the gate.
- **`prod` (production governance mode)** — matched protected actions
  return `"ask"`/`"deny"` unless a valid approval token exists. For
  unattended/background/cron sessions, or any time the owner wants
  machine-enforced gates.
- Missing/unreadable mode file → fail-safe to the **stricter** mode once
  blocking ships (until then, advisory).

## How approval tokens would work

Goal: "the owner approved THIS action" becomes machine-checkable, one-shot,
and non-replayable:

1. Lead requests approval in conversation, quoting the exact command.
2. Owner (or an owner-run helper script) writes a token file:
   `.claude/approvals/<sha256-of-exact-command>.token` containing an expiry
   timestamp (e.g. now + 30 minutes) and an optional note.
3. On a match, the hook hashes the incoming command, looks for the token,
   checks expiry, then **consumes it** (deletes the file) and allows the
   call. No token / expired token → `"ask"` or `"deny"`.
4. Tokens are exact-command-scoped — `git push origin main` approved does
   not approve `git push --force origin main`.
5. `.claude/approvals/` would be gitignored (session-local, never
   committed) and the token contains no secrets — just hash, expiry, note.

Open design questions to settle before enabling: token granularity for
multi-step operations (a deploy involves several commands), interaction
with `settings.local.json` pre-approvals (probably: pre-approved patterns
skip token checks in `dev`, still require tokens in `prod`), and whether
reviewer subagents inherit the hook (they should — defence in depth).

## Known limitations of the advisory pattern matcher (accepted in v1.1)

Found by the v1.1 adversarial audit; acceptable for an advisory layer,
must be solved before any blocking mode ships:

- **Keyword false positives** — the matcher sees protected strings anywhere
  in the command text, so read-only scans like `grep -rn "sk_live_" server/`
  (the pre-deploy secret-leak sweep), `grep TRUNCATE migrations/`, or
  `git log --grep "fly deploy"` trigger the banner. Harmless today (exit 0);
  a blocking hook would need context awareness (e.g. only flag when the
  token is the command word, not a quoted argument) or it will block
  legitimate audits.
- **Quote/obfuscation evasion** — `git pu''sh` and similar shell-quoting
  tricks evade any string matcher. Inherent; a blocking mode must not
  pretend to be a security boundary against a deliberately evasive actor —
  it is a mistake-prevention net.
- **Semantic gaps** — an unguarded `UPDATE ... SET` without `WHERE` is
  destructive but not reliably detectable by regex without unacceptable
  false positives; left to the procedural gate (owner approval for
  production writes) and the migration-discipline skill.

## Rollback

Every step of the upgrade is one-file reversible:

- **Disable blocking, keep advisory:** set `.claude/governance-mode` back
  to `dev` — no other change needed.
- **Disable the hook entirely:** remove the PreToolUse entry from
  `.claude/settings.json` (the script file can stay; unwired = inert).
- **Full revert:** restore `protected-action-guard.sh` from git history to
  the v1.1 advisory version. ⚠️ This requires the governance files to be
  committed first — as of v1.1 they are untracked, so git-based rollback is
  not yet possible. Committing `.claude/` governance files (owner-gated,
  like any commit) is the standing recommendation from the v1.1 audit.
- Rollback must be recorded as a governance changelog entry like any other
  governance change.
