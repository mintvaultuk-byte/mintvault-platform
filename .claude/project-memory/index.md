# Project memory — index

Replaces the single unbounded `.claude/project-memory.md` with indexed sections, so
memory stays navigable and merge-friendly at scale (audit finding G21). Entries must be
concise, DATED, SOURCED (link the evidence/commit/memory-file), and NOT transcript dumps.
The cross-session auto-memory index remains at
`~/.claude/projects/-Users-cornelius-mintvault-platform/memory/MEMORY.md` — this in-repo
structure is the committed, curated companion.

## Sections
| File | Contents |
|---|---|
| `architecture.md` | request flow, module map, key invariants |
| `infrastructure.md` | Fly (2 machines, lhr), regions, CI/CD, startup/readiness |
| `providers.md` | Stripe, Resend, Higgsfield (oat_ token), TCGdex, Anthropic, Neon/R2/B2 |
| `databases.md` | Neon staging (`ep-purple-voice`) vs prod (`ep-wispy-morning`); cert_counter; vq_ tables |
| `security.md` | auth model, secrets inventory, known posture, settings.local.json (local secrets) |
| `migrations.md` | migration conventions, drizzle-vq.config, applied-where matrix |
| `deployment-history.md` | notable deploys/incidents (e.g. v889 grader-v2 silent deploy) |
| `accepted-risks.md` | risks the owner has knowingly accepted (with date + reason) |
| `technical-debt.md` | known debt + deferred items with unblock conditions |

## Migration status
Structure created in Phase 9C. Content is being migrated incrementally from the flat
`.claude/project-memory.md` and the auto-memory index — do NOT bulk-copy; curate per entry.
Seeded high-value sections: `databases.md`, `providers.md`, `accepted-risks.md`. The rest
are titled and populated as touched. The flat file remains until fully migrated.
