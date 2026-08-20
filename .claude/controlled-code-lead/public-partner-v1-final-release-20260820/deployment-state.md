# Deployment state — Public Partner Network v1 final release

- Production `mintvault`: Fly `v1110`, commit `facfd36f`, two healthy `lhr` machines at Stage 0.
- Staging `mintvault-v2`: Fly `v542`, two healthy `lhr` machines; public `/api/version` needs target-time retry because the Fly domain rejected the initial TLS probe.
- Main: `f4285b71`; candidate: `132e9ab4`; no candidate code has been pushed, merged, deployed or migrated.
- Immediate containment: public-directory exposure remains absent/off; the release must add an operator-visible fresh-step-up kill switch before activation.
- Schema containment: a public consent/approval rollback is intentionally destructive and is not a production rollback. Production containment is flag-off followed by safe application rollback.
