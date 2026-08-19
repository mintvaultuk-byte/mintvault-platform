# External Blockers

Nothing in this file is a global blocker unless explicitly marked. Provider/account gaps must leave truthful safe states and allow other packages to continue.

| Blocker | Package | Impact | Can continue without it? | Exact owner action | Status |
| --- | --- | --- | --- | --- | --- |
| Approved public review destination absent | C | Neutral requests remain scheduled but unsent as `NOT_CONFIGURED` | Yes | Approve one canonical HTTPS review destination, then set the documented server-only review destination secret through the normal Fly secret workflow | CONFIRMED EXTERNAL |
| Dedicated MCP credential and ChatGPT connection absent | B | Transport can deploy disabled; external reads cannot authenticate until connected | Yes | Generate one high-entropy token, configure only its SHA-256 hash as documented, then add the production `/mcp/growth` URL and bearer token to the approved ChatGPT connection | CONFIRMED EXTERNAL |
| Fly metrics authority absent | E | CPU/RAM/RPM/p95/5xx/machine metrics remain `NOT_CONNECTED` | Yes | Create a least-privilege Fly read token scoped to `mintvault` and add it through the approved server-side secret/change process before adapter activation | CONFIRMED EXTERNAL |
| Search Console identity/property absent | E | Search metrics remain `NOT_CONNECTED` | Yes | Grant a read-only service identity to the canonical `https://mintvaultuk.com/` Search Console property, then add the server-side credential/property through the approved secret process | CONFIRMED EXTERNAL |
| Current main lacks Engineering OS enrollment | Release proof | Cannot run honest `engineering preflight/postflight` | Yes; controller + Graphify + repo gates remain | Integrate current-lineage enrollment in a separately reviewed governance change | CONFIRMED INTERNAL GAP |
| Git push / PR / merge | CI/release | Exact-SHA product CI triggers only for a PR to main or a main push | Yes for local work | Owner authorises publishing this exact reviewed candidate through the normal PR/main path after local gates | GATED |
