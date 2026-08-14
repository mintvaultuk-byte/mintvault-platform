# MintVault Graphify navigation

Graphify is MintVault's **local, deterministic, code/AST-first** navigation
tool. It locates likely source relationships; source code, schemas, routes,
tests, protected-system rules, and owner decisions remain authoritative.

The root `AGENTS.md` and `CLAUDE.md` require Graphify-first navigation. This
runbook does not change MintVault product behaviour or grant permission to
change protected systems.

## Privacy boundary

The sanctioned commands below use `--code-only`, disable Graphify query logs,
and do not choose a semantic/cloud backend. `.graphifyignore`, `.gitignore`,
`.claudeignore`, and `.dockerignore` exclude credentials, environment files,
customer uploads, scanner image masters, binary media, dumps, agent state, and
generated Graphify output. `graphify-out/` is local-only and must never be
committed or sent in a Docker build context.

Do not run semantic extraction, URL/deep extraction, external export, database
graphing, watchers, a remote/MCP server, or provider-backed commands without a
separate owner-approved scope and allowlisted corpus. Do not use
`--no-gitignore`. Never provide Graphify with secrets, customer data, card
media, production dumps, or MVGS logic outside the ordinary source corpus.

## Supported local workflow

Graphify `0.9.39` is the reviewed local version for this integration. It is a
developer tool, not an npm dependency. A machine without it may install the
official SQL-capable tool with:

```sh
uv tool install 'graphifyy[sql]==0.9.39'
graphify --version
```

Use only the repository scripts:

```sh
npm run graph:build        # deterministic full code graph
npm run graph:check        # graph freshness check
npm run graph:update       # rebuild after structural source changes
npm run graph:architecture # optional local call-flow view
```

In a linked worktree, run `npm run graph:build` before relying on Graphify and
`npm run graph:update` after structural source changes. Existing hook paths are
intentionally left untouched by Engineering OS enrolment, avoiding races with
active MintVault worktrees; manual scripts are the safe workflow here.

## Query and verify

Start with a narrow graph query or `explain`, inspect whether relationships are
extracted or inferred, then read the reported source and tests. Useful anchors
include scanner ingest/evidence services, `buildMvgsInput`,
`computeMvgsScore`, Partner auth middleware, tenant-scoped storage, and credit
lifecycle services.

```sh
GRAPHIFY_QUERY_LOG_DISABLE=1 graphify query 'scanner ingest evidence'
GRAPHIFY_QUERY_LOG_DISABLE=1 graphify query 'buildMvgsInput computeMvgsScore'
GRAPHIFY_QUERY_LOG_DISABLE=1 graphify query 'partner tenant auth credit'
```

Graph results are navigation aids only. A missing path does not prove a
workflow is absent; a present inferred edge does not prove a security,
persistence, or grading fact. Verify the real implementation before acting.
