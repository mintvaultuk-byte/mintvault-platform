# Rollback

Bootstrap changes are Markdown/state only. Before commit, remove only these new files after checking `git status`; after commit, use a non-destructive `git revert` of the bootstrap commit. Never reset or clean the dirty launch/main worktrees.

Runtime/package rollback will be specified before Stage 5 and must cover application, database, provider, email/review and public-indexing effects.

