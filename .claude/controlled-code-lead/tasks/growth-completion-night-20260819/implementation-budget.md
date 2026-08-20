# Implementation Budget

| Package                         | Runtime/docs files | Net lines |    Focused tests | Local duration |
| ------------------------------- | -----------------: | --------: | ---------------: | -------------: |
| A — closeout                    |                  3 |        40 |           1 file |         20 min |
| B — MCP                         |                  4 |       450 |           1 file |         70 min |
| C — reviews                     |                  9 |       850 |          2 files |        120 min |
| D — authority/SEO               |                  6 |       420 |          2 files |         70 min |
| E — external boundaries         |                  3 |        80 |  contract checks |         20 min |
| F — conversion                  |                  5 |       420 |          2 files |         70 min |
| G — Growth integration          |                  4 |       350 |  1 file + render |         70 min |
| H — infrastructure/GBP addendum |                  7 |     1,000 | 2 files + render |        120 min |
| S — commercial scoreboard       |                  9 |     1,400 | 2 files + render |        150 min |
| Control/evidence updates        |                 12 |       500 |              N/A |         45 min |

Expected runtime ceiling: **30 distinct runtime/test files**, **2,750 net lines**, **one migration identity (`0101`)**, and no dependency change. Control/evidence files are tracked separately. Reconcile the manifest if a runtime estimate grows by roughly 25% or a boundary changes.

Commits are budgeted as logical local checkpoints: control pack; persistence/core; MCP; authority; UI/integration; proof/handover. Commit count may be compressed if a checkpoint cannot independently pass the repository gates.
