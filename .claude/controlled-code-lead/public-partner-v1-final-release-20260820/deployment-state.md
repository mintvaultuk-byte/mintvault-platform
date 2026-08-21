# Deployment state — Public Partner Network v1 final release

- Production `mintvault`: Fly `v1110`, commit `facfd36f`, two healthy `lhr` machines at Stage 0.
- Staging `mintvault-v2`: Fly `v542`, two healthy `lhr` machines; public `/api/version` needs target-time retry because the Fly domain rejected the initial TLS probe.
- Main baseline: `f4285b71`; candidate: `132e9ab4`; reconciled local checkpoint: `7e99a638` plus a final local test-proof checkpoint. Neither is pushed, deployed or migrated.
- Immediate containment: public-directory exposure remains absent/off. The local release adds an operator-visible, reasoned and fresh-step-up protected kill switch; it has not been used against any environment.
- Schema plan: current main owns Growth `0101`; public presence is now `0102`; optional Google is `0103` and is explicitly excluded. This is a revised production scope requiring a fresh owner decision before any target-time preflight.
- Schema containment: a public consent/approval rollback is intentionally destructive and is not a production rollback. Production containment is flag-off followed by safe application rollback.
