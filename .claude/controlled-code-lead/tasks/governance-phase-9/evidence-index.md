# Evidence index — governance-phase-9

Pointers to the proof behind each 9A claim (evidence lives in the conversation transcript + git).

| Claim | Evidence |
|---|---|
| Framework was 7/48 tracked | `git ls-files .claude/ \| wc -l` vs `find .claude -type f` (Stage 0 inventory) |
| settings.local.json gitignored | `git check-ignore .claude/settings.local.json` → match |
| Secrets present (count-only) | `grep -cE 'sk_live_\|re_\|postgres://…:…@' .claude/settings.local.json` = 6 prefix matches; NO values recorded |
| 265 allow / 0 deny/ask | `grep -cE '"Bash\('` = 265 ; `grep -cE '"(deny\|ask)"'` = 0 |
| Hook coverage gaps | empirical re-implementation of the hook's grep patterns vs 9 candidate commands (audit) |
| Tests exist (G2) | `package.json` scripts + `ls tests/*.test.ts` (21 files incl. mvgs-scoring/pristine/centering) |
| `.agents/skills` divergent + unused | `diff` (db-migration differs) + `grep -rl '.agents' <configs>` = 0 loader refs |
| Governance snapshot | `governance-snapshot.json` (per-file sha256 + combined `0e91bb65…`) |
| SKILL.md had no Session Recovery | `grep -ci 'session recovery' SKILL.md` = 0 (pre-9A) |

Post-9A verification (gates, git ls-files, snapshot recompute) appended at commit time.
