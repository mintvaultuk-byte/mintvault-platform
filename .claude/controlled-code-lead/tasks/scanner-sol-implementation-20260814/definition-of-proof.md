# Definition of Proof — WP0/WP1

| Dimension | Status |
|---|---|
| Design | final for WP0 boundaries/contracts; full architecture remains owner-provided |
| Implementation | WP0 control plane complete pending local checkpoint |
| Verification | Local Proof |
| Activation | local isolated worktree only; not pushed/deployed |

## Evidence

- Exact Git ancestry/status/origin and Partner dirty-state inspection.
- Engineering OS 1.0.10 self-check, enrollment and HOSTILE preflight.
- Graphify 0.9.39 code graph for `d44a2c53` with 11,275 nodes / 25,295 edges.
- Source verification against real Scanner/native/Partner files.
- Governance, TypeScript, lint, production build, protected MVGS/label and targeted Scanner/Partner tests executed non-vacuously; full-suite baseline failures explicitly classified rather than hidden.

WP0 creates no production feature and makes no production/staging claim.

## WP1 proof boundary

| Dimension | Status |
|---|---|
| Design | helper filename, protocol, identifier, arm64 and macOS 12.0 candidate floor frozen |
| Implementation | runtime compilation removed; exact packaged/dev resource resolver and integrity verifier implemented |
| Verification | Local Proof: real Mach-O build/execute plus hostile fixtures and regression suites |
| Activation | none; generated ad-hoc helper is ignored build output, not a Developer-ID release artifact |

WP1 proves that runtime capture no longer requires or trusts a compiler/source
cache. It does not claim a Canon physical scan, Developer-ID signature,
notarised package, Gatekeeper result, clean macOS 12 endpoint, or production
activation. Those remain WP6/WP9/WP11/WP12 external or physical gates.
