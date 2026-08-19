# GB-04 — Zero-dead-UI sweep

| Control | Expected action | Authority/destination | Verification |
| --- | --- | --- | --- |
| Admin sidebar: Growth Command | Opens Growth Command and marks link active | `/admin/growth`, existing `AdminShell` | Super Admin session gate + route/source test |
| Period selector | Reloads aggregate data for fixed allowed period | `GET /api/super-admin/growth/summary?period=…` | service period validator + focused test |
| Retry summary/leads/link options | Refetches its failed query | Same read endpoint | rendered error state calls query refetch |
| Lead Review | Loads selected application detail | `GET /api/super-admin/growth/leads/:id` | Super Admin-gated detail endpoint |
| Open website/profile | Opens only validated applicant `http(s)` URL | Applicant-provided business URL | `safeExternalUrl` regression test |
| Contacted / Qualified / Not a fit / Onboarding | Updates only existing Growth lead state | `POST /api/super-admin/growth/leads/:id/status` | strict enum + transactional audit |
| Partner Management handoff | Opens canonical operational workflow with opaque lead context | `/admin/partners/settings?growthLead=<uuid>` | rendered only after `ONBOARDING`; never provisions |
| Campaign generator selects | Restricts input to server-owned choices | `GET /api/super-admin/growth/link-options` | controlled registry |
| Generate tracked link | Generates MintVault-owned deterministic URL | `POST /api/super-admin/growth/links` | strict Zod target/token validation |
| Copy Link | Writes generated URL to clipboard or reports failure | Browser Clipboard API/fallback | `copyTrackedLink`; failure message is visible |

All controls are either a real request/navigation or become unavailable with a visible loading/error/empty-state explanation. There are no decorative tabs, placeholder actions, or inactive active-looking buttons. The release gate requires `BROKEN = 0` after rendered desktop/mobile acceptance.
