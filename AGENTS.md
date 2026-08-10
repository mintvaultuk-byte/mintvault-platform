# MintVault Agent Instructions

## MANDATORY COMPLETION CONTROLLER

Before every build, audit, repair, security, migration or release task, read and obey:

[`docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md`](docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md)

This controller is permanent project governance.

It applies to every future prompt unless the owner explicitly overrides it.

Its core rule is:

Fix all actionable in-scope BLOCKER/HIGH defects in the current pass.

Do not stop merely to report another problem.

Once the release bar passes, stop auditing and declare COMPLETE.

## Existing Project Guardrails

Read and obey [`CLAUDE.md`](CLAUDE.md) as the repository's detailed safety, security,
grading, data, payment and deployment governance. The completion controller supplements
those rules. Where rules conflict, protected grading, security, payment, production-data,
deployment and destructive-action rules remain authoritative.
