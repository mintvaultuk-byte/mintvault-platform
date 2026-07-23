# MintVault Engineering Governance System (MEGS) v1.1

## 04. AI Operations Manual

**Status:** v1.1 implementation baseline with open founder decisions explicitly marked  
**Created:** 2026-07-22  
**Updated:** 2026-07-22  
**Scope:** AI-assisted engineering, review, handover, and project-control work across MintVault.

---

## 1. AI Engineering Workflow

### 1.1 Default Workflow

1. Read governing documents.
2. Reconcile repository state.
3. Classify evidence.
4. Build internal backlog.
5. Execute only the current approved phase.
6. Stop at governance gates.
7. Report with evidence.

### 1.2 Non-Negotiable Rules

- Do not invent repository state.
- Do not infer completion.
- Do not treat skipped tests as passing.
- Do not deploy, push, merge, commit, apply migrations, or change production configuration without founder approval.
- Do not proceed through an unresolved architectural decision.

---

## 2. GPT-5.5

### 2.1 Founder Requirement

The founder requested GPT-5.5 Codex High for high-stakes Codex implementation and governance work.

### 2.2 Governance

When GPT-5.5 is available, use it for:

- Repository reconciliation.
- Architecture planning.
- High-risk implementation.
- Security-sensitive review.
- Migration planning.
- Project Control Dashboard work.

If GPT-5.5 is not available, record the actual model/tool surface used and classify that as evidence context.

### 2.3 Model and Effort Declaration

Every engineering task must state a recommended model and effort level when the prompt or handover provides it. GPT-5.5 Codex Medium is the default for most coding, bug fixes, tests, CI fixes, pull requests, and staging work. GPT-5.5 Codex High is preferred for large features and complex refactors.

If the requested model is not available in the active tool surface, the agent must record the actual model/tool surface used and must not claim the unavailable model as execution evidence.

---

## 3. Claude

Claude may be used for:

- Drafting large documents.
- Reviewing implementation proposals.
- Running parallel domain reviews.
- Producing founder-readable summaries.

Claude output is not evidence by itself. It must be tied to repository, test, database, production, or founder evidence before it can support completion.

Claude Opus High may provide independent architecture, security, and release reviews.

---

## 4. Terra

### 4.1 Status

Terra is founder-named but not defined by repository evidence in this MEGS pass.

### 4.2 Governance

Until Terra's role is defined, treat Terra as an AI or operational participant requiring:

- Named responsibility.
- Input/output format.
- Evidence obligations.
- Review boundaries.
- Founder approval before relying on it for gated decisions.

High-reasoning models such as Terra Extra High may support broad reconciliation, architecture, governance, and difficult cross-system review only after their role and evidence boundary are defined.

---

## 4A. Excluded Access

Sol is excluded from MintVault repository, filesystem, credentials, deployment, and engineering access.

---

## 5. Parallel Development

Parallel work is permitted only when:

- Workstreams have non-overlapping files or an integration owner.
- Each workstream has a branch/worktree.
- Base commit is recorded.
- Merge order is explicit.
- Conflicts are expected and reviewed.

Parallel agents must not independently apply migrations or deploy.

After G6D is resolved, controlled parallel development may use approximately three to five isolated sessions only when every session has its own worktree and branch, responsibility and file boundaries do not overlap, migration numbers and central-file collisions are prevented, unexpected changes stop the session, and integration review occurs before merge.

---

## 6. Integration Reviews

Integration review must verify:

- Branch ancestry.
- File overlap.
- Migration numbering.
- Test coverage.
- Security impact.
- Database impact.
- Feature flag state.
- Production/deployment compatibility.
- Whether any workstream has been superseded.

---

## 7. Prompt Standards

Prompts used for engineering agents must include:

- Objective.
- Governing documents.
- Scope.
- Forbidden actions.
- Evidence requirements.
- Stop gates.
- Expected deliverables.
- Reporting format.

Coding-agent prompts must be supplied as one uninterrupted copy-and-paste block.

Prompts used for AI generation, Vault Quest art, or customer-affecting text must also include versioning and review evidence.

---

## 8. Reporting Standards

Every phase report must include:

- Branch.
- Base commit.
- Worktree.
- Changed files.
- Migrations.
- Routes.
- Services.
- Tests.
- Pass/fail/skip.
- Security findings.
- Known issues.
- Repository status.
- Staged?
- Committed?
- Pushed?
- Merged?
- Deployed?
- Founder approval required?

If a field is not applicable, say `Not applicable`. If unknown, say `Unknown`.

---

## 9. Handover Templates

### 9.1 Implementation Handover

```markdown
## Handover

Objective:
Current phase:
Base commit:
Branch/worktree:
Changed files:
Requirement IDs:
Implemented:
Not implemented:
Evidence:
Tests run:
Tests skipped:
Known issues:
Security notes:
Database notes:
Next gate:
Founder approval required:
```

### 9.2 Review Handover

```markdown
## Review Handover

Reviewed scope:
Commit/file set:
Reviewer:
Findings:
Severity:
Evidence:
Required fixes:
Accepted risks:
Open questions:
Approval recommendation:
```

### 9.3 Deployment Handover

```markdown
## Deployment Handover

Target:
Commit:
Migration state:
Pre-deploy tests:
Rollback plan:
Approval:
Deploy command:
Post-deploy verification:
Known risks:
```
