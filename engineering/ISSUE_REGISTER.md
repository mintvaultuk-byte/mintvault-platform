# Engineering issue register

| ID      | Severity | Source                   | Reproduction                                                                       | Reachability | Impact                                                               | Repair                                     | Proof                    | Status |
| ------- | -------- | ------------------------ | ---------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- | ------------------------------------------ | ------------------------ | ------ |
| GOV-001 | MEDIUM   | Graphify governance test | Run `bash .claude/governance-tests/test-graphify-integration.sh` before the repair | Always       | The test could not verify the required `--code-only` privacy command | Pass a literal pattern separator to `grep` | The repaired test passes | PROVEN |
