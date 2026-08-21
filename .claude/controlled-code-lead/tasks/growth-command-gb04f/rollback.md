# GB-04F rollback

Rollback is a guarded application release to the currently recorded production image `deployment-01M0G52W5NQV0XWV0ECK5BP8AN` / GB-04E candidate `1e868cc7`, using the repository's guarded release procedure only. No database, provider or infrastructure state is changed by this pass, so no schema or configuration rollback exists. Trigger rollback if the exact release introduces a response failure, authentication regression, telemetry leakage, or UI accessibility break verified in production.
