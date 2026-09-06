# GitHub Repository Controls

This runbook defines the GitHub-side controls required before MintVault can be treated as a customer-facing release repository. Workflow files are versioned here, but repository rulesets and settings live in GitHub and must be applied by the repository owner or an authorised administrator.

## Observed live state — 2026-08-30

The unauthenticated GitHub API currently reports no repository rulesets. `main` is protected only by legacy branch protection, with status-check enforcement at `non_admins` and these contexts: `Lint, Type Check, Test & Build`, `linux/amd64 image build & boot`, `CodeQL (SAST) (javascript-typescript)`, `PR dependency review`, and `Secret scan (gitleaks)`. It does not require `engineering-check`, and the old matrix-suffixed CodeQL context will not match this workflow's corrected `CodeQL (SAST)` job name.

Pull request 334 is the latest merged release PR visible at the time of inspection. The public record shows the same owner account as author and merger, with no submitted reviews. That is evidence that the current controls do not provide independent, consequence-bearing review. A CODEOWNERS file naming only that account documents ownership but cannot create reviewer independence or separate emergency bypass authority.

This is an external release blocker, not a code-level exception. Reproduce the public portion with:

```sh
curl -fsSL https://api.github.com/repos/mintvaultuk-byte/mintvault-platform/rulesets
curl -fsSL https://api.github.com/repos/mintvaultuk-byte/mintvault-platform/branches/main
curl -fsSL https://api.github.com/repos/mintvaultuk-byte/mintvault-platform/pulls/334
curl -fsSL https://api.github.com/repos/mintvaultuk-byte/mintvault-platform/pulls/334/reviews
```

The detailed legacy-protection endpoint requires an authorised GitHub session. An owner must still export the complete review, dismissal and bypass configuration before release.

## Required `main` ruleset

Create an active ruleset targeting the default branch with bypass restricted to an emergency owner role. Configure it to:

1. Require a pull request before merge; prohibit direct pushes.
2. Require at least one approval and a CODEOWNER approval. Use two approvals for protected grading, authentication, tenant isolation, payments, credits, migrations, certificate identity, NFC locking, scanner evidence, or release infrastructure.
3. Dismiss stale approvals when new commits are pushed and require approval of the most recent reviewable push by someone other than its author.
4. Require all review conversations to be resolved.
5. Block force pushes and branch deletion.
6. Require linear history. Prefer squash merge so each merged change has one auditable repository SHA.
7. Require branches to be current with `main` before merge. Do not enable a merge queue until every required workflow has an explicitly tested `merge_group` trigger.
8. Require the status checks listed below. Do not permit a bypass merely because a job was skipped.

Required checks from the versioned workflows:

- `Lint, Type Check, Test & Build`
- `PR dependency review`
- `Secret scan (gitleaks)`
- `CodeQL (SAST)`
- `linux/amd64 image build & boot`
- `engineering-check`

If GitHub displays a different fully-qualified check name, select the check emitted by the current default-branch workflow and record the exact name in the repository ruleset evidence.

## Pull-request evidence

Every consequence-bearing pull request must use the repository template and identify:

- issue/register authority and risk classification;
- protected areas and customer-visible behaviour;
- focused regression proof plus repository-wide gates;
- migration, rollback or forward-recovery design;
- skipped or environment-dependent tests;
- an independent hostile review; and
- the exact commit SHA that was both reviewed and tested.

An approval on an earlier SHA is not release evidence after code changes. Re-run the gates and repeat independent review on the final candidate SHA.

## Workflow and dependency hygiene

GitHub Actions must be pinned to full commit SHAs with the human-readable release in a comment. Dependabot is configured to propose Action updates and npm dependency updates. HIGH or CRITICAL dependency findings are blocking; suppressions require a time-bounded, owner-approved exception with exploitability evidence and a removal date.

The generated `.github/workflows/engineering-governance.yml` is owned by Cornelius Engineering OS and must never be hand-edited. OS release 1.0.13 still emits mutable Action tags and service-image tags; this is an open release blocker, not an accepted exception. Correct it in the Engineering OS master generator, publish/install a reviewed immutable OS release, then run `engineering upgrade` so the managed checksum remains valid.

Production base images and CI service images are pinned to OCI index digests as well as human-readable tags. Review those digests at least monthly and immediately for a base-image security notice; update the tag, digest, Docker proof, and lockstep regression in one pull request. A digest pin prevents silent upstream replacement but does not provide security updates by itself.

The native production-image job generates a CycloneDX SBOM named for the full commit SHA, retains it as CI evidence, and blocks fixable HIGH or CRITICAL OS/library vulnerabilities. An unfixed finding is not silently waived: record it in the issue register with reachability, compensating controls, an upstream tracking reference, and a review date. Build-once registry promotion and signed provenance remain owner-controlled infrastructure work; this workflow deliberately neither pushes nor deploys an image.

Workflows use least-privilege read-only repository permissions unless a named job has a narrower, documented need for more. Concurrent superseded runs are cancelled to prevent stale SHAs consuming runner capacity or being mistaken for the final proof.

## Owner verification record

After applying the ruleset, capture a screenshot or exported ruleset JSON and record:

- repository and ruleset name;
- effective date and owner;
- default branch;
- required check names;
- bypass actors;
- review requirements; and
- a test pull request proving a direct push, missing approval, stale approval, and failed required check are all blocked.

Store only non-secret evidence. Repository settings are external state: local CI passing does not prove these controls are enabled.

## Release boundary

Merging does not authorise deployment. Deployment, database migration, payment configuration changes, secret rotation, and release remain explicit owner decisions governed by the project controllers and production runbooks.

The production deploy wrapper additionally fails closed unless the checkout is clean and its full commit SHA exactly matches the freshly fetched `origin/main`. It does not honour `--allow-behind` for production. This prevents a local modification, untracked build input, unreviewed ahead-of-main commit, or stale branch from becoming the production artifact. That local guard supplements GitHub rules and CI evidence; it does not prove either one passed.
