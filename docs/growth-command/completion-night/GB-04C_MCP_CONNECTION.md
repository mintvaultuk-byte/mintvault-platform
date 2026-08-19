# GB-04C MCP Connection

## Shipped boundary

- Remote endpoint: `https://mintvaultuk.com/mcp/growth`
- Transport: stateless MCP over Streamable HTTP JSON responses (`2025-03-26`)
- Authentication: dedicated bearer token; only its SHA-256 hash is stored as `GROWTH_MCP_TOKEN_SHA256`
- Rate budget: 30 requests/minute/IP plus one fixed tool allowlist
- Audit: every tool call writes `growth_mcp_tool_called` with tool, bounded period and aggregate-read scope; token and result data are never logged
- Scope: aggregate Growth, pulse, health, capacity, acquisition, campaigns, Partner pipeline totals, SEO, conversion, reviews and deterministic insights
- Writes: none. No lead detail/mutation, DB query, customer data, payment, grading, Partner, Scanner, migration or deploy capability exists.

The endpoint fails closed with `503` until the token hash is configured. Generate the raw token off-platform, store only its hash through the approved Fly secret workflow, and retain the raw token only in the approved ChatGPT/OpenAI connection secret field. Do not paste either value into a task, log, document or shell history.

## External connection state

OpenAI's remote-MCP interface accepts a remote `server_url` and an `authorization` value, and supports Streamable HTTP. ChatGPT custom apps require developer mode, an eligible account/workspace, endpoint metadata and an authentication mechanism selected in the app setup. This repository cannot prove the owner's current ChatGPT plan/workspace controls.

After a reviewed deployment and secret configuration:

1. Confirm an authenticated `initialize` and `tools/list` against the production endpoint.
2. In ChatGPT web, enable Developer mode, create a custom app, supply the endpoint, select the available bearer-token authentication mechanism and scan tools.
3. If the UI offers only OAuth for this workspace, stop: do not choose no authentication. Record OAuth as the remaining external follow-up while the same endpoint can be used through the OpenAI Responses API `authorization` field.

Revocation is one server-side secret rotation/removal; it does not affect owner, Super Admin, Partner or Scanner credentials.
