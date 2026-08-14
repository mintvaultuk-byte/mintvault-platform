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

## MANDATORY GRAPH OF LOOPS CONTROLLER

For every substantial engineering, build, audit, repair, security, migration, or release task, read and obey:

[`docs/GRAPH_OF_LOOPS_BUILD_CONTROLLER.md`](docs/GRAPH_OF_LOOPS_BUILD_CONTROLLER.md)

Use it together with [`docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md`](docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md).

The Graph controller prevents false-green optimisation. The No-Bullshit controller prevents endless non-completion. Both are permanent project governance unless explicitly overridden by the owner.

## Existing Project Guardrails

Read and obey [`CLAUDE.md`](CLAUDE.md) as the repository's detailed safety, security,
grading, data, payment and deployment governance. Both controllers supplement
those rules. Where rules conflict, protected grading, security, payment, production-data,
deployment and destructive-action rules remain authoritative.
<!-- cornelius-engineering-os:begin id=codex-project v=1 -->
## Cornelius Engineering OS (managed)

This managed block defines HOW work is performed. The rest of this file defines WHAT this product is; on any conflict the project rules and protected areas win.

Codex is the implementation lead. Claude Opus High is the independent hostile reviewer; it has no implementation ownership of what it reviews.

The project profile, declared protected areas and gate commands live in `.engineering/project.yaml`; read it before answering questions about them.

Before substantial work, read `.engineering/project.yaml`, the issue register, and proof ledger.
Run `engineering preflight` before significant changes and `engineering postflight` afterwards.
Preflight classifies risk and sets the execution mode floor; never select a weaker mode than it requires.
Use graph-first navigation but verify real source for authority. Preserve project facts and protected areas.
Never deploy, publish or release on your own authority; that decision belongs to the owner.
<!-- cornelius-engineering-os:end id=codex-project -->
