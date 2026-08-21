# Rollback and deployment boundary — Growth / Partner canonical reconciliation

This task has no deployment authority. The safe containment action is to leave the current production image and migration journal untouched.

If the candidate fails a local or remote gate, do not deploy, apply migrations, alter provider state, or rewrite history. Repair only a reproduced in-scope merge defect on this isolated branch; otherwise retain the existing live release and request the next owner approval.

If a later separately approved release needs rollback, roll application code back to the presently running production image only. Never delete migration journal rows or drop public-presence data as a rollback shortcut.
