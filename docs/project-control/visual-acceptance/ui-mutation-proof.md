# Project Control UI mutation proof log

Date: 2026-08-02  
Branch: `codex/project-control-live-ui`  
Starting proof HEAD: `74b6be7b1bd1df7480e44141c5a970aba5bda426`  
Scope: temporary UI/test mutations only. All mutations below were applied with `apply_patch`, verified RED, restored with
`apply_patch`, scanned for residue, and followed by a green focused baseline.

This log records the mutation evidence in-repository so final acceptance does not depend on chat transcript memory.

## Baseline before mutation battery

- `npm test -- tests/project-control-rendered-ui.test.ts tests/project-control-github-sync-rendered.test.ts tests/project-control-visual-fixture.test.ts`: passed, 3 files / 24 tests.
- `npm test -- tests/project-control-*.test.ts`: passed, 32 files / 741 tests.
- After adding package/rendered guards: `npm test -- tests/project-control-rendered-ui.test.ts tests/project-control-package-rendered.test.ts tests/project-control-visual-fixture.test.ts tests/project-control-github-sync-rendered.test.ts`: passed, 4 files / 31 tests.
- After adding package/rendered guards: `npm test -- tests/project-control-*.test.ts`: passed, 33 files / 748 tests.
- `npm run check`: passed.

## UI1 — unknown evidence as zero

File: `client/src/components/admin/project-control/compact-live-evidence.tsx`  
Pre-restore hash: `c96858d3e2a2ff5c1bb73556791bb3481b1a25c91d40ae58ec0df91feed2f7eb`

Temporary diff:

```diff
- {github?.snapshot?.defaultBranchSha?.slice(0, 12) ?? (evidenceUnavailable ? "Unavailable" : "Unknown")}
+ {github?.snapshot?.defaultBranchSha?.slice(0, 12) ?? (evidenceUnavailable ? "0%" : "0%")}
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-rendered-ui.test.ts
exit 1
RED: distinguishes stale, unavailable, contradiction and failed refresh states
Assertion: unavailable live evidence unexpectedly contained "0%".
```

Restore proof:

```text
shasum -a 256 client/src/components/admin/project-control/compact-live-evidence.tsx
c96858d3e2a2ff5c1bb73556791bb3481b1a25c91d40ae58ec0df91feed2f7eb
rg '0%|MUTATION|mutation' client/src/components/admin/project-control/compact-live-evidence.tsx
exit 1 / no output
npm test -- tests/project-control-rendered-ui.test.ts
exit 0
```

## UI2 — clear previous evidence during refresh

File: `client/src/components/admin/project-control/project-control-dashboard.tsx`  
Pre-restore hash: `d80263749c35659ba97ded661017369dd9ed6f8f0b3ff372e5790e0fb45d1f28`

Temporary diff:

```diff
- liveEvidence={liveEvidence}
+ liveEvidence={refreshing ? undefined : liveEvidence}

- evidence={liveEvidence}
+ evidence={refreshing ? undefined : liveEvidence}
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-rendered-ui.test.ts
exit 1
RED:
- retains previous evidence while GitHub refresh is running and disables only GitHub refresh controls
- renders empty and loading states without treating unknown as zero
Observed loss of 74b6be7b1bd1 retained evidence while refresh state was RUNNING.
```

Restore proof:

```text
shasum -a 256 client/src/components/admin/project-control/project-control-dashboard.tsx
d80263749c35659ba97ded661017369dd9ed6f8f0b3ff372e5790e0fb45d1f28
rg 'refreshing \\? undefined|MUTATION|mutation' client/src/components/admin/project-control/project-control-dashboard.tsx
exit 1 / no output
npm test -- tests/project-control-rendered-ui.test.ts
exit 0
```

## UI3 — polling continues after terminal state

File: `client/src/hooks/project-control/use-github-sync.ts`  
Pre-restore hash: `dc07f04a05deb5f9d5688d4e02c9564fe9b0e15fe096b969a5ee1eeeb9afc411`

Temporary diff:

```diff
- const TERMINAL = new Set<SyncStatus["state"]>([
-   "SUCCEEDED",
-   "PARTIAL",
-   "FAILED",
-   "RATE_LIMITED",
-   "UNAVAILABLE",
-   "CANCELLED",
-   "EXPIRED",
- ]);
+ const TERMINAL = new Set<SyncStatus["state"]>([]);
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-github-sync-rendered.test.ts
exit 1
RED:
- polling stops on terminal SUCCEEDED
- polling stops on terminal PARTIAL
- polling stops on terminal FAILED
- polling stops on terminal RATE_LIMITED
- polling stops on terminal UNAVAILABLE
- polling stops on terminal CANCELLED
- polling stops on terminal EXPIRED
- polls every five seconds while non-terminal and keeps refresh button disabled
- failed refresh request keeps retry available and hides raw backend errors
Observed terminal pcGet call counts continuing and retry controls staying disabled.
```

Restore proof:

```text
shasum -a 256 client/src/hooks/project-control/use-github-sync.ts
dc07f04a05deb5f9d5688d4e02c9564fe9b0e15fe096b969a5ee1eeeb9afc411
rg 'new Set<SyncStatus\\[\"state\"\\]>\\(\\[\\]\\)|UI[0-9]+_MUTATION|MUTATION_MARKER' client/src/hooks/project-control/use-github-sync.ts
exit 1 / no mutation output
npm test -- tests/project-control-github-sync-rendered.test.ts
exit 0
```

## UI4 — all refresh controls disabled

File: `client/src/components/admin/project-control/partner-shop-launch-progression.tsx`  
Pre-restore hash: `39863e026a67a32d98e9ecca1ac11116c3aa78da1d99ac66f9bad5c2fa9fcf03`

Temporary diff:

```diff
 <button
   type="button"
   className="pc-gate-toggle"
+  disabled
   onClick={() => setOpen(expanded ? null : key)}
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-rendered-ui.test.ts
exit 1
RED:
- uses accessible launch gate disclosures and toggles aria-expanded
- retains previous evidence while GitHub refresh is running and disables only GitHub refresh controls
Observed gate disclosure disabled and aria-expanded not toggling.
```

Restore proof:

```text
shasum -a 256 client/src/components/admin/project-control/partner-shop-launch-progression.tsx
39863e026a67a32d98e9ecca1ac11116c3aa78da1d99ac66f9bad5c2fa9fcf03
rg 'disabled|UI[0-9]+_MUTATION|MUTATION_MARKER' client/src/components/admin/project-control/partner-shop-launch-progression.tsx
exit 1 / no output
npm test -- tests/project-control-rendered-ui.test.ts
exit 0
```

## UI5 — stale evidence mapped as current

File: `client/src/components/admin/project-control/evidence-state.tsx`  
Pre-restore hash: `d8ad1182c6c2758dc74b74058dbbb06286b1a0025b49c41ab579576e675bf456`

Temporary diff:

```diff
- if (normalized === "stale") return "stale";
+ if (normalized === "stale") return "current";
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-rendered-ui.test.ts tests/project-control-ui-live.test.ts
exit 1
RED:
- Project Control rendered dashboard proof > distinguishes stale, unavailable, contradiction and failed refresh states
- Project Control approved hybrid UI state vocabulary > marks stale and contradictory evidence explicitly
Observed "Last known good" missing and evidenceStateFrom("stale") returning "current".
```

Restore proof:

```text
shasum -a 256 client/src/components/admin/project-control/evidence-state.tsx
d8ad1182c6c2758dc74b74058dbbb06286b1a0025b49c41ab579576e675bf456
npm test -- tests/project-control-rendered-ui.test.ts tests/project-control-ui-live.test.ts
exit 0
```

## UI6 — contradiction warning removed

File: `client/src/components/admin/project-control/compact-live-evidence.tsx`  
Pre-restore hash: `c96858d3e2a2ff5c1bb73556791bb3481b1a25c91d40ae58ec0df91feed2f7eb`

Temporary diff:

```diff
- const contradiction = Boolean(
-   evidence?.deployment &&
-   (evidence.deployment.stagingMatchesMain === false ||
-     evidence.deployment.productionMatchesMain === false ||
-     evidence.deployment.stagingMatchesProduction === false)
- );
+ const contradiction = false;
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-rendered-ui.test.ts
exit 1
RED: distinguishes stale, unavailable, contradiction and failed refresh states
Observed pc-contradiction-warning missing.
```

Restore proof:

```text
shasum -a 256 client/src/components/admin/project-control/compact-live-evidence.tsx
c96858d3e2a2ff5c1bb73556791bb3481b1a25c91d40ae58ec0df91feed2f7eb
rg 'const contradiction = false|UI[0-9]+_MUTATION|MUTATION_MARKER' client/src/components/admin/project-control/compact-live-evidence.tsx
exit 1 / no output
npm test -- tests/project-control-rendered-ui.test.ts
exit 0
```

## UI7 — backlog blocks pilot / phase 11

File: `client/src/components/admin/project-control/partner-shop-launch-progression.tsx`  
Pre-restore hash: `39863e026a67a32d98e9ecca1ac11116c3aa78da1d99ac66f9bad5c2fa9fcf03`

Temporary diff:

```diff
- {LAUNCH_GATE_KEYS.map((key, index) => {
+ {[...LAUNCH_GATE_KEYS, "pn-backlog"].map((key, index) => {
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-rendered-ui.test.ts
exit 1
RED: renders the ten Partner Shop Launch gates in exact declared order and keeps backlog separate
Observed received list containing extra "Permanent G7-G20 backlog".
```

Restore proof:

```text
shasum -a 256 client/src/components/admin/project-control/partner-shop-launch-progression.tsx
39863e026a67a32d98e9ecca1ac11116c3aa78da1d99ac66f9bad5c2fa9fcf03
rg '\\[\\.\\.\\.LAUNCH_GATE_KEYS|UI[0-9]+_MUTATION|MUTATION_MARKER' client/src/components/admin/project-control/partner-shop-launch-progression.tsx
exit 1 / no output
npm test -- tests/project-control-rendered-ui.test.ts
exit 0
```

## UI8 — navigation entry removed/miswired

File: `client/src/components/admin/admin-shell.tsx`  
Pre-mutation state: no diff against HEAD.

Temporary diff:

```diff
- { href: "/admin/project-control", label: "Project Control", icon: Radar },
+ { href: "/admin/project-control", label: "Programme Control", icon: Radar },
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-visual-fixture.test.ts
exit 1
RED: keeps the production Admin shell navigation entry wired to Project Control
Observed expected Project Control nav entry missing.
```

Restore proof:

```text
git diff -- client/src/components/admin/admin-shell.tsx
exit 0 / no diff
npm test -- tests/project-control-visual-fixture.test.ts
exit 0
```

## UI9 — search/refetch loses focus equivalent

The approved Project Control UI branch does not expose a dashboard search/refetch input in the touched surface. The
faithful equivalent used was package-edit controls staying mounted after a failed package save/refetch path.

File: `client/src/pages/admin/project-control-package.tsx`

Temporary diff:

```diff
- <StatusEditor
-   pkg={pkg}
-   onSave={(body) => patch.mutate({ ...body, expectedVersion: pkg.version })}
-   saving={patch.isPending}
- />
+ {!conflict && (
+   <StatusEditor
+     pkg={pkg}
+     onSave={(body) => patch.mutate({ ...body, expectedVersion: pkg.version })}
+     saving={patch.isPending}
+   />
+ )}
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-package-rendered.test.ts
exit 1
RED: retains operator-entered values after a failed mutation and keeps retry available
Observed q("pcp-edit-remaining") returned null after conflict.
```

Restore proof:

```text
npm test -- tests/project-control-package-rendered.test.ts
exit 0
```

## UI10 — mutation failure clears input

File: `client/src/pages/admin/project-control-package.tsx`

Temporary diff:

```diff
- onClick={() =>
+ onClick={() => {
+   setRemainingWork("");
+   setReason("");
    onSave({
      status,
      declaredCompletion: completion,
      reviewState,
      deploymentState,
      productionVerification,
      risk,
      remainingWork,
      reason,
-   })
- }
+   });
+ }}
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-package-rendered.test.ts
exit 1
RED: retains operator-entered values after a failed mutation and keeps retry available
Observed remaining textarea value became "" instead of operator-entered retry text.
```

Restore proof:

```text
npm test -- tests/project-control-package-rendered.test.ts
exit 0
```

## UI11 — every 409 treated as version conflict

File: `client/src/pages/admin/project-control-package.tsx`

Temporary diff:

```diff
 if (error.status === 409 || error.message.includes("409")) {
-  if (code === "illegal_transition") { ... }
-  if (code === "override_required") { ... }
-  if (code === "version_conflict" || !code) { ... }
-  return "This update conflicts with the current work package state. Your entered values are still available; review the latest package state and try again.";
+  return "Someone else changed this work package while you were editing it. Reload the page so you do not overwrite their change.";
 }
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-package-rendered.test.ts
exit 1
RED:
- renders distinct safe 409 copy for illegal_transition
- renders distinct safe 409 copy for override_required
- renders distinct safe 409 copy for generic_conflict
Observed all three variants received the optimistic-lock copy.
```

Restore proof:

```text
npm test -- tests/project-control-package-rendered.test.ts
exit 0
```

## UI12 — raw backend error rendered

File: `client/src/pages/admin/project-control-package.tsx`

Temporary diff:

```diff
- return "This update could not be saved. Your entered values are still available; review them and try again.";
+ return error.message;
```

Command/result:

```text
npm run check
exit 0

npm test -- tests/project-control-package-rendered.test.ts
exit 1
RED: retains operator-entered values after a failed mutation and keeps retry available
Observed conflict UI text "postgres://raw-secret stack trace" instead of safe fallback.
```

Restore proof:

```text
shasum -a 256 client/src/pages/admin/project-control-package.tsx
d17dc85c6d8b18a1be2b6669719fc39821f016759f42a18c29524c6ef6c1800f
rg 'UI[0-9]+_MUTATION|MUTATION_MARKER|postgres://raw-secret|return error\\.message|!conflict &&|setRemainingWork\\(\"\"\\)|setReason\\(\"\"\\)' client/src/pages/admin/project-control-package.tsx tests/project-control-package-rendered.test.ts
only intentional test fixture/assertion contains postgres://raw-secret
npm test -- tests/project-control-package-rendered.test.ts
exit 0
```

## Visual fixture production-exclusion positive control

File: `client/src/App.tsx`  
Pre-mutation state: no diff against HEAD.

Temporary diff:

```diff
 import { PartnerSessionProvider } from "@/hooks/use-partner-session";
 import { PartnerRouteGuard } from "@/components/partner/partner-route-guard";
+import "@/test-harness/project-control-visual-fixture";
```

Command/result:

```text
npm test -- tests/project-control-visual-fixture.test.ts
exit 1
RED:
- has no import edge from production client code
- is not registered as a production router path
Observed offenders ["client/src/App.tsx"] and App text containing "project-control-visual-fixture".
```

Restore proof:

```text
git diff -- client/src/App.tsx
exit 0 / no diff
npm test -- tests/project-control-visual-fixture.test.ts
exit 0
```

## Final gates

Pass 1:

```text
npm test -- tests/project-control-rendered-ui.test.ts tests/project-control-package-rendered.test.ts tests/project-control-github-sync-rendered.test.ts tests/project-control-visual-fixture.test.ts
4 files passed, 31 tests passed

npm test -- tests/project-control-*.test.ts
33 files passed, 748 tests passed

npm run check
passed

npx eslint <Project Control frontend/test scope>
passed

npm run build
passed; pre-existing PostCSS "from" warning emitted
```

Pass 2:

```text
npm test -- tests/project-control-rendered-ui.test.ts tests/project-control-package-rendered.test.ts tests/project-control-github-sync-rendered.test.ts tests/project-control-visual-fixture.test.ts
4 files passed, 31 tests passed

npm test -- tests/project-control-*.test.ts
33 files passed, 748 tests passed

npm run check
passed

npx eslint <Project Control frontend/test scope>
passed

npm run build
passed; pre-existing PostCSS "from" warning emitted
```

Final asset scan:

```text
rg -n 'Project Control visual fixture|project-control-visual-fixture|pc-g7-g20-backlog|pc-superseded-legacy-flags|pc-orphan-shop-csv' dist/public
exit 1 / no output
```

Wider repository regression:

```text
npm test
exit 1
Failed environment-gated suites:
- tests/auth-security-migration.test.ts: TEST_DATABASE_URL is required
- tests/rarity-structured-migration.test.ts: TEST_DATABASE_URL is required
- tests/vq-backend.test.ts: MINTVAULT_DATABASE_URL is not set
- tests/vq-fetch-art-stored-pointer.test.ts: MINTVAULT_DATABASE_URL is not set
- tests/vq-higgsfield-observability.test.ts: MINTVAULT_DATABASE_URL is not set
Summary before failure: 218 files passed, 53 skipped; 4080 tests passed, 961 skipped.
```

Final dirty-scope check before staging:

```text
git status --short | rg '^(.. )?(server|shared|migrations|drizzle|db|scripts/migrations)'
exit 1 / no output
```

Important scope note: this proves no new dirty backend/shared/migration files were part of this continuation. It does
not claim that the branch has no historical backend/shared/migration differences against `origin/main`.
