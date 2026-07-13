# Scope & concurrency (multi-repo + parallel sessions)

The governance framework lives in `mintvault-platform/.claude/`. It is SINGLE-REPO by
default. These rules stop it from silently mis-applying to other repos or racing
between parallel sessions.

## Multi-repository scoping (9C.4)
- **Stage 0 records the governed repository root** (`git rev-parse --show-toplevel`).
- Before ANY edit or command, resolve which repository the TARGET file/command belongs to.
- If a command or edit targets a DIFFERENT repository than the governed one:
  - STOP. Do not apply this repo's `protected-systems.md`, hook literals (`ep-wispy-morning`,
    Fly app names, MVGS paths), or memory to it — they are MintVault-specific and are both
    under- and over-inclusive elsewhere.
  - Load that repository's own governance (if any), establish its protected systems, and
    open a SEPARATE task ledger there.
- One repository's owner approval NEVER authorises another repository's operation.
- The hook is wired via `$CLAUDE_PROJECT_DIR` (the launch repo). Treat a banner (or its
  absence) as valid only for the launch repo.

## Parallel-session / multi-Lead safety (9C.5)
Every session believes it is "the Lead". There is no global election, so shared mutable
state (per-task ledgers, `protected-systems.md`, memory, git branches) can race.

**Lock model** (`.claude/controlled-code-lead/locks/<task-slug>.lock.json`, gitignored):
- `sessionId` (unique), `repository`, `branch`, `pid`/session metadata
- `acquiredAt`, `heartbeatAt`, `expiresAt` (stale after e.g. 2h with no heartbeat)
- `owner` (human-readable), append-only `events[]`

**Protocol:**
1. Before writing shared governance state or editing on a branch, check for a live lock on
   the same task/branch.
2. If another session holds a live lock → **default to READ-ONLY**; do not edit shared
   governance state or the same branch; report the conflict and require explicit coordination.
3. If no live lock (or it is expired) → acquire the lock, then proceed.
4. Heartbeat while working; release on Stage 7 (or let it expire).
- Your task ledger is yours (session-namespaced). `protected-systems.md`, `INDEX.md`, and
  memory are APPEND-ONLY shared state — never last-writer-wins rewrite them under contention.
- Prod deploys stay serialized + human-gated regardless (see
  [[mintvault-concurrent-session-discipline]], which covers git/prod; this covers the
  governance STATE files that skill does not).

## Minimal lock helper
A reference helper lives at `.claude/governance-tests/session-lock.sh` (acquire/check/release);
locks are gitignored. Absence of the helper does not waive the read-only-on-conflict rule.
