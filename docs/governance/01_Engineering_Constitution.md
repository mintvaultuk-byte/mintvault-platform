# MintVault Engineering Governance System (MEGS) v1.1

## 01. Engineering Constitution

**Status:** v1.1 implementation baseline with open founder decisions explicitly marked  
**Created:** 2026-07-22  
**Updated:** 2026-07-22  
**Scope:** All MintVault platform, Partner Network, Vault Quest, AI operations, repository, database, testing, release, and evidence-governance work.  
**Authority:** MEGS v1.1 is the active engineering baseline for implementation work authorised by the founder on 2026-07-22. Requirements marked open, contradictory, or founder-decision-required remain blocked for the affected scope.

---

## 1. Founder Charter

### 1.1 Founder Authority

The founder is the final authority for:

- Business rules.
- Pricing, wallet, credit, and financial-accounting behaviour.
- Grading and MVGS logic.
- Certificate issuance, correction, ownership, and public verification rules.
- Partner Network launch sequencing.
- Vault Quest world, game, art, card, release, and commercial decisions.
- Production deployment approval.
- Any decision marked `Founder approval required`.

### 1.2 Plain-English Accountability

Engineering agents must communicate risks, trade-offs, status, and blockers in plain English. Technical detail is allowed, but it must not hide the user-visible impact, money impact, security impact, or operational risk.

### 1.3 Evidence Before Completion

No agent may claim a requirement, phase, deployment, migration, review, or readiness state is complete unless there is evidence tied to that claim. Evidence must identify where it came from and whether it is repository, database, production, test, human-review, or founder evidence.

---

## 2. Engineering Principles

| Principle | Rule |
|---|---|
| Preserve trust | Do not break certificate lookup, grading, labels, payments, ownership, auth, or public verification. |
| Fail closed for risk | Security, accounting, auth, partner isolation, and migration uncertainty must stop the operation rather than guess. |
| Append evidence | Status changes, readiness changes, review decisions, and audit records should be append-only unless an explicit correction record is created. |
| Separate implementation from verification | A feature being built does not prove it works in production. A deployment does not prove business readiness. |
| Prefer small reversible changes | High-risk work should be phased, tested, reviewed, and reversible. |
| No silent scope expansion | If a change touches money, grading, auth, security, database schema, production, or founder-locked rules, surface it as a gate. |
| Unknown means unknown | Unknowns must be recorded. They must not be converted into assumptions unless labelled as assumptions. |

---

## 3. Repository Governance

### 3.1 Verified Repository Facts

The Phase 0 reconciliation on 2026-07-22 verified:

- Remote `origin/main` existed at commit `12139b6ce14c36381294076b5a9ac6f201ac7b82`.
- The then-current local branch was `codex/super-admin-correction-mode`.
- The then-current local worktree was dirty and behind `origin/main`.
- The repository uses React, Express, Drizzle, PostgreSQL, Vitest, ESLint, Vite, and Fly deployment configuration.
- Numbered SQL migrations exist under `migrations/`.
- Vault Quest SQL migrations exist under `migrations-vq/`.
- CI exists at `.github/workflows/ci.yml`.

These facts are time-bound. Future scans must refresh them before action.

### 3.2 Repository Rules

- `origin/main` is the default authoritative source for new implementation unless the founder approves a different base.
- A dirty worktree must not be treated as a clean implementation base.
- Unrelated user changes must not be reverted by an agent.
- Generated build output must not become governing evidence unless tied to a build command and commit.
- All non-document implementation changes require a branch or worktree strategy before editing.

---

## 4. Branch & Worktree Rules

### 4.1 Branch Rules

- Use branch prefix `codex/` for Codex-generated implementation branches unless the founder asks otherwise.
- Do not create implementation branches during documentation-only phases.
- Do not merge without founder approval.
- Do not push without founder approval.

### 4.2 Worktree Rules

- Do not create a worktree unless the current phase requires implementation isolation or the founder instructs it.
- Worktree creation is a governance event and must be reported.
- Worktrees must record:
  - Path.
  - Branch.
  - Base commit.
  - Purpose.
  - Whether it is clean.

### 4.3 Stale Worktree Rule

If a worktree is behind `origin/main`, it is stale for new implementation unless explicitly selected for repair, audit, or archaeology.

---

## 5. Review Process

### 5.1 Required Review Classes

| Review | Required When |
|---|---|
| Security review | Auth, session, PII, public endpoints, uploads, partner isolation, AI provider calls, or admin surfaces change. |
| Database review | Any schema, migration, query isolation, RLS, ledger, or data-retention change. |
| Financial/accounting review | Wallet, credits, Stripe, ledger, pricing, refunds, reservations, or balances change. |
| Grading review | MVGS, grade calculation, label output, certificate status, grading workflow, or correction mode changes. |
| Frontend review | User-facing or admin-facing UI changes. |
| Deployment review | Before staging or production release. |
| Founder review | Every governance gate and every unresolved architectural decision. |

### 5.2 Review Evidence

Review evidence must identify:

- Reviewer or agent.
- Scope.
- Commit or file set reviewed.
- Findings.
- Severity.
- Resolution.
- Remaining risk.

---

## 6. Acceptance Gates

### 6.1 Mandatory Gates

Stop and obtain founder approval before:

- Applying migrations to staging or production.
- Committing.
- Pushing.
- Merging.
- Deploying.
- Changing auth, secrets, production configuration, payment behaviour, wallet/ledger behaviour, MVGS grading logic, certificate-origin logic, or founder-locked business rules.
- Resolving a material architectural question.

### 6.2 Evidence Gate

A phase may be marked complete only when:

- Requirements are mapped to evidence.
- Tests are run or explicitly marked skipped with reason.
- Known issues are recorded.
- Unknowns are recorded.
- The final phase report includes all fields required by the reporting contract.

---

## 7. Deployment Governance

### 7.1 Verified Deployment Facts

As of the Phase 0 reconciliation on 2026-07-22:

- Production `https://mintvault.fly.dev/api/version` reported commit `e6fd64da`.
- Staging `https://mintvault-v2.fly.dev/api/version` reported commit `0fedce6e`.
- The repository contains `scripts/safe-deploy.sh`, which embeds and verifies `GIT_SHA` through `/api/version`.

These facts must be refreshed before any deployment decision.

### 7.2 Deployment Rules

- Deployment is never automatic unless the founder explicitly approves.
- A successful deploy command is not production verification.
- Production verification requires live endpoint, database, and user-flow evidence appropriate to the change.
- Rollback information must be available before deployment.

---

## 8. Evidence Standards

### 8.1 Evidence Categories

Every material claim must record exactly one evidence classification:

- `Locked Founder Requirement`
- `Proven from repository`
- `Proven from production`
- `Proven from database`
- `Proven by tests`
- `Proven by human review`
- `Reported but Unverified`
- `Assumption`
- `Future roadmap`
- `Open Question`
- `Unknown`
- `Stale Evidence`
- `Contradiction`
- `Superseded Decision`

Evidence classification never implies lifecycle completion.

### 8.2 Evidence Record Minimum

Each evidence record must include:

- Source category.
- Source path, command, URL, database query class, test name, or reviewer.
- Timestamp or commit where available.
- Summary.
- Linked requirement IDs.

### 8.3 Lifecycle States

Each requirement, phase, evidence item, and Project Control status must separately record exactly one lifecycle state:

- `not started`
- `proposed`
- `in progress`
- `implemented`
- `test evidence missing`
- `tests failing`
- `review pending`
- `review failed`
- `review passed`
- `deployment pending`
- `deployed`
- `production verification pending`
- `production verified`
- `blocked`
- `stale`
- `unknown`
- `superseded`

Readiness, completion, confidence, and recommendations must be calculated from lifecycle state plus evidence records. They must not be inferred from source-code presence alone.

---

## 9. Versioning

### 9.1 MEGS Versioning

MEGS uses semantic documentation versions:

- Major: governance model or authority changes.
- Minor: new sections, requirement categories, roadmap expansions.
- Patch: wording corrections and reference updates.

### 9.2 Requirement ID Stability

Requirement IDs must never be reused. If a requirement is superseded, keep the old ID marked `Superseded` and create a new ID.

---

## 10. Document Hierarchy

1. Founder written instruction in the current task or approved decision.
2. `docs/governance/01_Engineering_Constitution.md`.
3. Domain governance documents:
   - `02_MintVault_Platform_Governance.md`
   - `03_VaultQuest_Governance.md`
   - `04_AI_Operations_Manual.md`
4. `05_Founder_Decision_Log.md`.
5. `06_Requirements_Traceability_Matrix.md`.
6. Existing repository runbooks and specifications.
7. Repository code and tests.
8. Reported memory or agent summaries.

If documents conflict, record the contradiction and stop at the appropriate gate.

A Founder Decision Log entry has authority only when its status is `Locked Decision` and it includes direct founder approval evidence. A `Locked Decision` overrides a conflicting domain-governance statement. A `Historical Decision`, repository fact, reported statement, or agent conclusion does not create founder authority. Every conflict must be entered in the Contradiction Register before implementation proceeds in the affected area.
