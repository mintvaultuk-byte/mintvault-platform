# Owner approval records

Every protected action (see SKILL.md "Protected actions") requires an owner
approval record BEFORE execution. The Lead may validate a record but can NEVER
create one on the owner's behalf.

## Rules
- Actual records (`*.record.md` / `*.record.json`) are **local + gitignored** — they
  are a per-machine audit trail, not committed (this README + `TEMPLATE.record.md`
  ARE committed). See `.gitignore`.
- **Never** put a credential/secret value in an approval record.
- A record is single-use unless it explicitly states a phase/expiry scope.

## Record fields (see TEMPLATE.record.md)
- approvalId, owner, timestamp
- operation + category (deploy / push / migration / secret-rotation / paid-provider / …)
- exact environment (local / staging / production) + repository + branch + commit
- permitted command or category (NOT a secret)
- expiry / phase, maximum scope
- rollback reference, status (unused / used / revoked / expired)

## Standing / durable grants
A task prompt may carry a durable grant ONLY if it names the operation category,
environment, scope, and expiry/phase. Record it here with `category: standing-grant`
and the exact scope. The Lead cannot broaden it.
