# Rollback — mintvault-final-integration-local-proofs

1. Stop the local app process.
2. Remove only Docker containers bearing label `mintvault.local-proof=mintvault-final-integration`.
3. Verify no task-labeled container remains with `docker ps --filter label=mintvault.local-proof=mintvault-final-integration`.
4. No application source, environment file, staging/production database, live bucket, or remote git state requires rollback.
