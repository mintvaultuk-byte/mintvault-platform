#!/usr/bin/env bash
# Static integrity checks for MintVault's local, privacy-first Graphify setup.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
fail=0

require_file() {
  if [ -s "$root/$1" ]; then echo "ok: $1"; else echo "FAIL: missing $1"; fail=1; fi
}
require_text() {
  if grep -Fq -- "$2" "$root/$1"; then echo "ok: $1 contains $2"; else echo "FAIL: $1 missing $2"; fail=1; fi
}

require_file .graphifyignore
require_file .claudeignore
require_file docs/engineering/GRAPHIFY.md
for entry in '.env' 'uploads/' 'attached_assets/' '.claude/' '.codex/' '*.md' 'graphify-out/'; do
  require_text .graphifyignore "$entry"
done
require_text .gitignore 'graphify-out/'
require_text .dockerignore 'graphify-out/'
require_text AGENTS.md 'Graphify-first navigation'
require_text CLAUDE.md 'Graphify-first navigation'
require_text docs/engineering/GRAPHIFY.md '--code-only'
require_text docs/engineering/GRAPHIFY.md 'local, deterministic, code/AST-first'

node - "$root/package.json" <<'NODE'
const pkg = require(process.argv[2]);
const expected = {
  'graph:build': 'PYTHONHASHSEED=0 GRAPHIFY_QUERY_LOG_DISABLE=1 graphify extract . --code-only',
  'graph:check': 'PYTHONHASHSEED=0 GRAPHIFY_QUERY_LOG_DISABLE=1 graphify check-update .',
  'graph:update': 'PYTHONHASHSEED=0 GRAPHIFY_QUERY_LOG_DISABLE=1 graphify extract . --code-only',
  'graph:architecture': 'PYTHONHASHSEED=0 GRAPHIFY_QUERY_LOG_DISABLE=1 graphify export callflow-html',
};
for (const [name, command] of Object.entries(expected)) {
  if (pkg.scripts?.[name] !== command) throw new Error(`unexpected ${name} command`);
}
NODE

if git -C "$root" ls-files --error-unmatch graphify-out/graph.json >/dev/null 2>&1; then
  echo 'FAIL: generated Graphify output is tracked'; fail=1
else
  echo 'ok: generated Graphify output is untracked'
fi

exit "$fail"
