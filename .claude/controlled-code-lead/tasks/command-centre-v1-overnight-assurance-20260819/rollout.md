# Rollout control

1. Complete local targeted, protected and full gates with no open in-scope blocker/high/release-medium except any explicitly owner-blocked protected authority defect.
2. Capture exact live staging image tag, digest, version and SHA before deploy.
3. Commit the exact candidate locally; run `scripts/safe-deploy.sh staging --yes --partner-network-consolidation true` under the task's staging-only authority so every Command Centre Partner deep link is compiled to its canonical destination.
4. Require both staging machines healthy and `/api/version` equal to the candidate SHA.
5. Run persisted Pilot Flag ON -> OFF -> ON, direct API/route fail-closed checks and Partner Management smoke.
6. Run complete live controls, stable views, deep links, responsive/keyboard, controlled 1/5/10/20 load, post-timeout recovery, logs and bounded soak.
7. Keep production forbidden. Owner production authorisation is a later decision only after all gates pass.
