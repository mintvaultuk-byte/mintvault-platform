# Definition of proof — Partner queue evidence and shop-floor workflow

## Local proof completed

- Canonical working evidence is admitted only when its current immutable master is recorded as a
  Canon LiDE 400 1200-DPI TIFF and its `*_working` JPEG has exactly the master dimensions with
  `resize: null`.
- Partner queue side status and thumbnail URLs are generated from that same server verdict in a
  certificate-id keyed batch. Tests bind FRONT/BACK and separate cards independently and reject a
  stale URL without an admitted verdict.
- An evidence-missing or evidence-invalid row receives a visible non-ready workflow state; an
  accepted Card Job also requires `READY_TO_GRADE` before the queue labels it ready.
- Partner navigation and new-submission client controls were source-tested against existing server
  capabilities. Customer association remains nullable at the existing server authority; historical
  customer links and direct routes remain intact.
- Focused evidence, queue, navigation, Card Tool and protected MVGS regression suites, TypeScript,
  production build, full Vitest and diff hygiene have gates recorded in the manifest and ledger.

## Live proof deliberately pending

The current staging artifact is `ee7fbe43`, not this isolated candidate. Staging browser visual and
click acceptance are therefore pending a separately authorised guarded staging deployment. This
record does not substitute local tests for that acceptance.
