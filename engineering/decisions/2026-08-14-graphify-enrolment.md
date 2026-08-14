# Graphify enrolment decision

## Decision

MintVault uses Graphify only through committed local code-only scripts and a
privacy boundary that excludes secrets, customer material, scanner media,
agent state, generated output, and prose. The graph is navigation evidence,
not product authority.

## Worktree behaviour

Engineering OS enrolment detected an existing Git hook path and intentionally
did not replace it. Linked worktrees use the explicit `npm run graph:build`
and `npm run graph:update` commands to avoid racing active MintVault worktrees.

## Scope

This decision changes governance only. It does not alter product logic,
protected MVGS rules, scanner behaviour, payments, data, or deployment.
