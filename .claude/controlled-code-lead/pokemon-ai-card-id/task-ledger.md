# Task: Pokémon AI Card Identification Assistant + Quick Identify
Branch: codex/pokemon-ai-card-id (off main 64379730 = prod v1043)
Scope: LOCAL ONLY — no push/PR/merge/deploy, no prod data, NO real provider calls, zero credits.
Protected: grading maths, cert numbering, issued certs, labels, payments, VQ, Social Studio,
  Knowledge Hub, visual picker. AI output is SUGGESTION ONLY — never auto-save/submit/grade.

## Architecture
Staged pipeline: image-integrity → deterministic parse (collector#, set code, language) →
  Knowledge Engine query (reduce candidates) → AI vision (explicit click only, flag+spend gated,
  MOCKABLE) → validate every field vs KE/catalogue → structured CardIdentificationSuggestionV1 →
  human Accept/Change/Reject. Reuse existing Anthropic image client + spend guard + AI flag +
  image validators + requireCapability("grade"). Flag AI_CARD_IDENTIFICATION default OFF.

## Stage log
- [x] Stage 0 baseline: main 64379730, branch created, flag system + existing /identify found
- [ ] Stage 2 audit (backend-reviewer running)
- [ ] shared contract + parsers  - [ ] server pipeline+routes  - [ ] client UI  - [ ] analytics  - [ ] tests  - [ ] gates  - [ ] commits
