# Issue register — governance-phase-9

Carried forward from the Phase-8 governance audit. Status against CURRENT source. No finding silently discarded.
Proof levels: Designed / Implemented / Locally-verified / Integration-verified / Staging-verified / Activated / Production-verified.

| ID | Finding | Verdict vs current source | Fixed in | Proof | Sub-phase |
|---|---|---|---|---|---|
| G1 | Framework untracked in git (0 tracked) | CONFIRMED (7 of 48 tracked at baseline) | 9A.2 | Implemented+Locally-verified (git ls-files after commit) | 9A |
| G2 | Stale "no test/lint scripts" guts Stage 6 over MVGS | CONFIRMED (21 tests, vitest/eslint/husky exist) | 9A.3 | Implemented+Locally-verified | 9A |
| G3 | Reviewer isolation unenforced (agent unspawnable mid-session) | CONFIRMED (fell back to general-purpose in audit) | 9B.1 | DEFERRED — needs post-restart proof | 9B |
| G4 | settings.local.json pre-approves protected actions (0 deny/ask) | CONFIRMED (265 allow, 0 deny/ask) | 9B.3 | DEFERRED | 9B |
| G5 | Live secrets embedded in settings.local.json | CONFIRMED (6 secret-prefix matches; file gitignored) | 9B.2 + rotation plan | DEFERRED (remove rules) / rotation = owner-gated | 9B |
| G6 | Hook coverage gaps (wrapper/SDK/additive-DDL/safe-deploy.sh) | CONFIRMED (empirical) | 9B.4 | DEFERRED | 9B |
| G7 | Hook Bash-only + advisory + fail-open | CONFIRMED | 9B.4 | DEFERRED | 9B |
| G8 | No durable per-task state ever produced | CONFIRMED → THIS task dir is the first | 9A(Stage0)+9A.6 | Implemented (this dir) | 9A |
| G9 | No session/compaction recovery; dangling reference | CONFIRMED (SKILL.md had no Session Recovery section) | 9A.5 | Implemented+Locally-verified | 9A |
| G10 | `.agents/skills` divergent untracked duplicate | CONFIRMED (db-migration diverged; no loader ref) | 9A.1 | Implemented (removed) | 9A |
| G11 | Skill duplication (cornelius-execution-style ×3) | CONFIRMED | 9A.1 | Designed (project copy is authoritative; global out of repo scope) | 9A/def |
| G12 | Manifest-before-edit unenforced | CONFIRMED | 9B.6 | DEFERRED | 9B |
| G13 | Protected-actions list missing golden rules (auth/deps/payment) | CONFIRMED | 9B.7 | DEFERRED | 9B |
| G14 | No multi-phase program model | CONFIRMED | 9C.1 | DEFERRED | 9C |
| G15 | CLAUDE.md broadly stale | CONFIRMED | 9A.3 (partial: test claim) / 9C (rest) | Partial | 9A/9C |
| G16 | Authority contradiction (Lead "only may approve" vs owner "every time") | CONFIRMED (SKILL.md L21/29 vs L249) | 9A.4 | Implemented+Locally-verified | 9A |
| G17 | "every time" vs standing grant undefined | CONFIRMED | 9A.4 | Implemented (standing-grant definition added) | 9A |
| G18 | Template gaps (provenance / proof-binding / R2-B2 identity / index) | CONFIRMED | 9C.3 | DEFERRED | 9C |
| G19 | Multi-repo scoping undefined | CONFIRMED | 9C.4 | DEFERRED | 9C |
| G20 | Parallel-session / multi-Lead unsafe | CONFIRMED | 9C.5 | DEFERRED | 9C |
| G21 | Project-memory unbounded flat file | CONFIRMED | 9C.6 | DEFERRED | 9C |

## Rejected / not-confirmed
- (audit) "governance-tests dir absent" — REJECTED: `.claude/governance-tests/` exists (5 scripts) at baseline. Evidence: `ls .claude/governance-tests/`. The framework was authored mid-session, hence the earlier miss.

## Deferred (unblock condition)
- G3,G6,G7,G12 — require a Claude Code RESTART so agent/hook registration loads, then in-process proof (9B).
- G4,G5,G13 — permission/secret remediation (9B); credential ROTATION is a separate owner-approved plan, not this phase.
- G14,G18–G21 — durable program workflow + scale (9C), after 9B.
