# Rollout — partner-full-pilot continuation

1. Commit and push the bounded repair without force.
2. Require terminal CI on the exact pushed SHA.
3. Reconcile current staging release and deploy with the safe staging script.
4. Verify `/api/version`, the certificate picker, and the two-card connector projection on staging.
5. Resume the existing deterministic two-card grading pilot; do not touch production.
