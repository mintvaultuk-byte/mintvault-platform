# Project Control read-only boundary review

The public PCD surface is GET-only under `/api/super-admin/project-control/*`. `rg` and route inspection found no PCD insert, update, delete, transaction, deployment, feature-flag write, Git mutation or shell command. Repeated page loads scan and cache evidence in memory only; they do not generate database rows. The UI has no mutation control.

The migration defines `project_control_evidence`, `project_control_status_history`, and `project_control_prompt_snapshots` for a future explicitly approved governance writer. A real PostgreSQL execution test inserted one row into each and proved UPDATE, DELETE and TRUNCATE fail through database triggers. This protects immutability even if an approved writer is added later.

Continuation prompts are deterministic/content-addressed for identical evidence inputs. They are not persisted in `project_control_prompt_snapshots`, and therefore must not be described as retained immutable snapshots. UI wording now says “Content-addressed Prompt.” Durable prompt/evidence/status persistence, retention limits and writer authorization remain a founder/design decision before that capability is enabled.
