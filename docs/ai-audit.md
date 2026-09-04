# MintVault AI/LLM Call Audit

**Date:** 2026-05-07
**Branch / SHA:** main / 1237085 (currently deployed v545)
**Scope:** every Anthropic / OpenAI API call site in the server, with cost + storage + trigger mapping. Read-only investigation — no code changes.

---

## Models in use

| Model | Pricing per 1M tokens (input / output / cache-write / cache-read) | Used for |
|---|---|---|
| `claude-opus-4-7` | $5 / $25 / $6.25 / $0.50 | Full multi-image grading; centering; defect detection; standalone grade-card; legacy v1 analyze |
| `claude-haiku-4-5-20251001` | $1 / $5 / $1.25 / $0.10 | Card identification; defect-candidate suggestions; cheap "Option A" grade pass; marketing description; public AI Pre-Grade tool |
| `claude-sonnet-4-6` | $3 / $15 / $3.75 / $0.30 | Defined in pricing table (`ai-grading-service.ts:684`) but **no active call uses it**. One reference in `account-auth.ts:301` writes the literal string `'claude-sonnet-4-6'` to `grading_sessions.model_version` — appears to be legacy/incorrect tag, not an actual API call |
| `gpt-4o` (OpenAI) | not in our pricing table | Second-opinion identification only; runs in parallel with Haiku, results reconciled. Gated by presence of `OPENAI_API_KEY` env var (silently skipped if absent) |

Pricing constants live at `server/ai-grading-service.ts:683-695` (input/output/cache splits per model).

---

## Per-call inventory

### 1. Card identification (Haiku + optional GPT-4o second opinion)

| | Detail |
|---|---|
| **File / line** | `server/ai-grading-service.ts:914` (`identifyCardFromBuffer`); `:1305` (`identifyCard` — R2-key variant) |
| **Model** | `claude-haiku-4-5-20251001`; in parallel `gpt-4o` via OpenAI SDK at `:827` (`identifyWithGpt`) |
| **Triggered by** | Admin endpoints: `POST /api/admin/certificates/:id/identify-only` (`routes.ts:8016`), `POST /api/admin/certificates/:id/identify-and-analyze` (`8469`), `POST /api/admin/identify-image` (`8810`). Also called inside `scan-ingest-service.ts:197` on every scanner upload |
| **Returns** | `{ detected_name, detected_set, detected_number, set_code, copyright_year, detected_game, confidence, reasoning }` (Claude → reconciled with GPT) |
| **Stored at** | `certificates.card_name`, `set_name`, `card_number_display`, `card_game`, `rarity`, `year_text`, plus full snapshot in `certificates.ai_analysis` jsonb under `identification` key |
| **Downstream usage** | Drives label printing, registry listing, public cert display, TCG-API verification path |
| **Per-call cost (rough)** | Haiku ~$0.003 (1 image, 1024 max-out, ~1.5K image tokens + ~256 prompt + ~250 output). GPT-4o second opinion (when enabled) ~$0.005-0.010 per call |
| **Calls per card processed** | 1× Haiku + (0 or 1)× GPT-4o per scan-ingest. Admin can re-trigger via the identify endpoints |

### 2. Defect-candidate suggestion (Haiku, conservative)

| | Detail |
|---|---|
| **File / line** | `server/ai-grading-service.ts:1021` (`suggestDefectsFromBuffer`) |
| **Model** | `claude-haiku-4-5-20251001` |
| **Triggered by** | `scan-ingest-service.ts:198` only — runs on every scan ingest in parallel with identify and quick-grade |
| **Returns** | Array of `{ type, severity (minor/moderate/significant), description, location, x_percent, y_percent }` |
| **Stored at** | `certificates.ai_defect_candidates` jsonb (raw); promoted to `verified_defects` only on admin grade approval (`routes.ts:2300-2304`) |
| **Downstream usage** | Drives the "Suggested Defects" pins admin sees during grading; admin confirms/rejects each. Not visible to customer until verified-and-approved. |
| **Per-call cost** | ~$0.005-0.010 (front+back, 2048 max-out) |
| **Calls per card** | 1× per scan-ingest |

### 3. Quick grade prediction — "Option A" (Haiku)

| | Detail |
|---|---|
| **File / line** | `server/ai-grading-service.ts:1164` (`gradeCardFromBuffer`) |
| **Model** | `claude-haiku-4-5-20251001` |
| **Triggered by** | `scan-ingest-service.ts:199` — runs in parallel with identify + suggest-defects on scan ingest |
| **Returns** | Subgrades (centering ratios + 4-corner, edges, surface), overall grade, confidence values per axis |
| **Stored at** | `certificates.ai_analysis` jsonb under `grading` key. NOT written to top-level grade columns until admin approves |
| **Downstream usage** | Pre-fills the admin grading UI. Not customer-visible. |
| **Per-call cost** | ~$0.013 (front+back, 3072 max-out, larger prompt) |
| **Calls per card** | 1× per scan-ingest |

### 4. Full grade analysis — "Option B" / admin-triggered (Opus 🔥)

| | Detail |
|---|---|
| **File / line** | `server/ai-grading-service.ts:581` (`analyzeCardFromBuffers`); `:1437` (`analyzeCard` — R2-key variant). Both use `thinking: true` + multi-image input |
| **Model** | `claude-opus-4-7`, `max_tokens: 4096`. Includes ALL image variants: front + back + 2× greyscale + 2× highcontrast + angled + closeup (8 images per call) |
| **Triggered by** | Admin button **"Analyze with AI (Full)"** in cert form (`grading/ai-panel.tsx`) → `POST /api/admin/certificates/:id/analyze` (`routes.ts:8438`); also via `POST /api/admin/certificates/:id/identify-and-analyze` (`8469`) and the admin scan-ingest fallback (`8728`). `POST /api/admin/certificates/:id/analyze-v1-legacy` is retired as an authenticated unconditional 410 tombstone and no longer invokes a model. |
| **Returns** | Full `GradingAnalysis`: per-side centering ratios, 8-corner subgrades, 4-axis subgrades, defect array with positions, authentication notes, overall grade |
| **Stored at** | `certificates.ai_analysis` jsonb. Subgrades + grade copied to dedicated columns (`centering_score`, `corners_score`, etc.) only on admin **Approve Grade** click |
| **Downstream usage** | Authoritative grade source the admin reviews. Customer cert reflects values once approved |
| **Per-call cost** | ~$0.16-0.25 (8 images × ~1.5-2K tokens each = ~14K input + ~5K prompt + ~3K output, all at Opus rates). **Single most expensive AI call in the system.** |
| **Calls per card** | 0-many — admin chooses. Re-Analyze button = each click = another full Opus call |

### 5. Centering measurement (Opus)

| | Detail |
|---|---|
| **File / line** | `server/routes.ts:8135-8260` (`POST /api/admin/certificates/:id/measure-centering`) — direct `anthropicFetch` call at `:8172` |
| **Model** | `claude-opus-4-7`, `max_tokens: 2048` |
| **Triggered by** | Admin button (likely in image-viewer.tsx) — surface measurement on demand |
| **Returns** | Front/back centering ratios |
| **Stored at** | `centering_left_pct`, `centering_right_pct`, etc. on certificate row |
| **Per-call cost** | ~$0.05-0.10 (front+back high-detail) |
| **Calls per card** | 0-many on demand |

### 6. Defect detection on demand (Opus)

| | Detail |
|---|---|
| **File / line** | `server/routes.ts:8261-8350` (`POST /api/admin/certificates/:id/detect-defects`) — direct `anthropicFetch` at `:8297` |
| **Model** | `claude-opus-4-7`, `max_tokens: 4096` |
| **Triggered by** | Admin button on grading page |
| **Returns** | Defect array with positions |
| **Stored at** | `ai_defects` jsonb |
| **Per-call cost** | ~$0.10-0.15 |
| **Calls per card** | 0-many on demand |

### 7. Standalone grade card (Opus)

| | Detail |
|---|---|
| **File / line** | `server/routes.ts:8351-8437` (`POST /api/admin/certificates/:id/grade-card`) — direct `anthropicFetch` at `:8396` |
| **Model** | `claude-opus-4-7`, `max_tokens: 2048` |
| **Triggered by** | Admin button (smaller scope than full /analyze) |
| **Returns** | Subgrade summary + overall |
| **Per-call cost** | ~$0.08-0.12 |

### 8. Marketing description generation (Haiku)

| | Detail |
|---|---|
| **File / line** | `server/routes.ts:7126-7260` (`POST /api/admin/certificates/:id/generate-description`) — direct `anthropicFetch` at `:7193` |
| **Model** | `claude-haiku-4-5-20251001`, `max_tokens: 600` |
| **Triggered by** | Admin button after grade approval — generates prose description from approved subgrades + verified defects |
| **Returns** | Plain text marketing description |
| **Stored at** | `certificates.description` |
| **Audit** | Writes audit_log row at `:7228-7240` with `generate_description` action including model + cost estimate + token counts |
| **Per-call cost** | ~$0.001-0.003 (text-only prompt, no images) |
| **Calls per card** | 1× typically, after approval |

### 9. Public AI Pre-Grade tool (Haiku — billed via credits)

| | Detail |
|---|---|
| **File / line** | `server/routes.ts:8909-9090` (`POST /api/tools/estimate`) — direct `anthropicFetch` at `:9028`. Imports `PRE_GRADE_PROMPT` from `server/grading-prompt.ts` |
| **Model** | `claude-haiku-4-5-20251001`, `max_tokens: 2048` |
| **Triggered by** | Public-facing AI Pre-Grade tool at `/tools/estimate` (any user, gated by `estimateRateLimit` + AI credit balance — first one free per device per day, then credit packs from £2 / 5 estimates) |
| **Returns** | Single-photo subgrade estimate + predicted overall + confidence |
| **Stored at** | Returned to client only; not persisted on a cert |
| **Per-call cost** | ~$0.013-0.020 (single image, 2048 max-out) |
| **Calls per card** | N/A (no cert involved). Customer-facing volume — usage scales with marketing reach |

---

## Summary table — per-card AI cost path

For one card going through the full graded lifecycle:

| Stage | Trigger | Model | Calls | Approx cost |
|---|---|---|---|---|
| Scan ingest | Scanner upload (`POST /api/admin/scan-ingest`) | Haiku × 3 (identify + suggest defects + quick grade) | 3 | ~$0.020-0.030 |
| Identify-second-opinion | Same as above (parallel) | GPT-4o (optional) | 0 or 1 | +$0.005-0.010 |
| Full analysis | Admin clicks "Analyze with AI (Full)" | Opus + 8-image multi-variant + thinking | 1× per click | **~$0.16-0.25** |
| Defect / centering re-runs | Admin one-off buttons | Opus | 0-many | ~$0.05-0.15 each |
| Approval | Admin clicks "Approve Grade" | none (DB write only) | 0 | $0 |
| Description | Admin clicks "Generate Description" | Haiku, text-only | 1 | ~$0.002 |
| **Per-card baseline** | scan + 1 full analysis + description | | **5 API calls** | **~$0.18-0.28** |
| **Public Pre-Grade tool** | Visitor triggers `/tools/estimate` | Haiku | 1 per estimate | ~$0.013 |

Public tool volume is decoupled from card-grading flow and bills via user credits, but the API cost still hits us. With first-free-per-device-per-day, the steady-state public cost = `~$0.013 × free-tier visitors per day`.

---

## Existing feature-flag system

**Server source of truth:** [`server/config/feature-flags.ts`](server/config/feature-flags.ts) — env-var-backed object, `as const`.

```ts
export const FEATURE_FLAGS = {
  LEGAL_PAGES_LIVE: process.env.LEGAL_PAGES_LIVE === "true",
  TRANSFER_FLOW_LIVE: process.env.TRANSFER_FLOW_LIVE === "true",
} as const;
```

**Client read-path:** `GET /api/config/public-flags` (`server/routes.ts:741-745`) → `useFeatureFlagsQuery` hook in [`client/src/hooks/use-feature-flags.ts`](client/src/hooks/use-feature-flags.ts) → consumed via `useFeatureFlags()` in `App.tsx`, `submit.tsx`, `legal-page.tsx`, `footer-v2.tsx`.

**Existing flags:** 2 only — `LEGAL_PAGES_LIVE`, `TRANSFER_FLOW_LIVE`. Both gate marketing/legal pages, not AI.

**Implicit AI kill-switch today:** every AI route checks `process.env.ANTHROPIC_API_KEY` and returns 503 if absent. Removing the secret from Fly disables ALL Anthropic AI calls in one shot. No per-feature granularity.

**No DB-driven runtime toggle table.** Adding/changing a flag today requires editing the file + redeploying (or setting env var + redeploying — Fly secrets restart machines).

---

## Recommendation — where toggles should live

**Per-feature env-var flags inside the existing `FEATURE_FLAGS` object.** Matches the established pattern, deploys via `fly secrets set`, no new infra. Granularity at the feature level (not per route) is enough for what we need.

Suggested set:

```ts
// AI feature toggles — disable individually if cost / quality / availability bites
AI_IDENTIFY_ENABLED:           process.env.AI_IDENTIFY_ENABLED         !== "false",  // default ON
AI_DEFECT_SUGGEST_ENABLED:     process.env.AI_DEFECT_SUGGEST_ENABLED   !== "false",  // default ON
AI_HAIKU_QUICK_GRADE_ENABLED:  process.env.AI_HAIKU_QUICK_GRADE_ENABLED !== "false", // default ON
AI_FULL_GRADE_ENABLED:         process.env.AI_FULL_GRADE_ENABLED       !== "false",  // default ON (Opus £££)
AI_CENTERING_ENABLED:          process.env.AI_CENTERING_ENABLED        !== "false",
AI_STANDALONE_DETECT_ENABLED:  process.env.AI_STANDALONE_DETECT_ENABLED !== "false",
AI_DESCRIPTION_GEN_ENABLED:    process.env.AI_DESCRIPTION_GEN_ENABLED  !== "false",
AI_GPT_SECOND_OPINION_ENABLED: process.env.AI_GPT_SECOND_OPINION_ENABLED === "true", // default OFF (already gated by OPENAI_API_KEY presence)
AI_PUBLIC_ESTIMATE_ENABLED:    process.env.AI_PUBLIC_ESTIMATE_ENABLED  !== "false",  // default ON
```

**Default-on** for the workflows that customer-facing flows depend on (scan-ingest pipeline, full-grade analysis, description) so the change is non-disruptive at deploy. **Default-off** for GPT-4o (already gated by API-key presence anyway, so the flag is just an explicit kill-switch).

**Where to wire each gate:**

| Flag | Add check at | Disabled behaviour |
|---|---|---|
| `AI_IDENTIFY_ENABLED` | `identifyCardFromBuffer` and `identifyCard` entry; routes 8016, 8469, 8810 | Return 503 + cert keeps existing identification (or none) |
| `AI_DEFECT_SUGGEST_ENABLED` | `suggestDefectsFromBuffer` entry | scan-ingest pipeline writes `ai_defect_candidates: []` and continues |
| `AI_HAIKU_QUICK_GRADE_ENABLED` | `gradeCardFromBuffer` entry | scan-ingest skips quick-grade, admin grades manually |
| `AI_FULL_GRADE_ENABLED` | `analyzeCardFromBuffers` and `analyzeCard` entry; routes 8438, 8469, 2148, 8728 | Admin button returns 503 + admin grades manually |
| `AI_CENTERING_ENABLED` / `AI_STANDALONE_DETECT_ENABLED` | routes 8135, 8261, 8351 | Admin button shows "AI off" |
| `AI_DESCRIPTION_GEN_ENABLED` | route 7126 | Admin writes description manually or skips |
| `AI_GPT_SECOND_OPINION_ENABLED` | `identifyWithGpt` entry at `:827` | Reconciliation falls back to Claude-only (already supported) |
| `AI_PUBLIC_ESTIMATE_ENABLED` | route 8909 (`/api/tools/estimate`) | Pre-Grade tool returns 503; user-facing message "AI service paused" |

**Optional — surface to admin UI:** add a `GET /api/admin/feature-flags` endpoint (admin-only, mirrors `/api/config/public-flags` for AI flags) so an admin tools page can see which AI features are live. Not required for v1 — `fly secrets set` is enough.

**If runtime toggle without redeploy is later required** → migrate to a small `feature_overrides` table keyed on flag name, read at request-time, populated via admin UI. Probably overkill right now.

---

## Files referenced

| Path | Role |
|---|---|
| `server/anthropic-fetch.ts` | Wrapped fetch with AbortController timeout. Single helper used by every direct AI call in routes.ts |
| `server/ai-grading-service.ts` | Top-level grading service. Hosts: `identifyCardFromBuffer`, `identifyCard`, `analyzeCardFromBuffers`, `analyzeCard`, `gradeCardFromBuffer`, `suggestDefectsFromBuffer`, `identifyAndAnalyze`, plus `identifyWithGpt` (private), `callClaude` helper, `MODEL_PRICING` table, `pricingFor()` |
| `server/scan-ingest-service.ts` | Scanner-upload pipeline. Calls 3 Haiku functions in parallel for every ingest |
| `server/grading-prompt.ts` | Static prompts — `GRADING_SYSTEM_PROMPT`, `HAIKU_GRADING_PROMPT`, `CARD_IDENTIFICATION_PROMPT`, `PRE_GRADE_PROMPT`, plus per-game modules |
| `server/routes.ts` | Hosts admin endpoints with direct `anthropicFetch` calls for: legacy v1 analyze, identify-only, identify-and-analyze, analyze, identify-image, measure-centering, detect-defects, grade-card, generate-description, public `/tools/estimate` |
| `server/account-auth.ts` | One reference at `:301` to model name `'claude-sonnet-4-6'` written to `grading_sessions.model_version` — appears to be a stale legacy tag, not an active API call |
| `server/config/feature-flags.ts` | Existing 2-flag system. Where new AI toggles should live |
| `client/src/hooks/use-feature-flags.ts` | Client hook (read-only — server is source of truth) |
| `client/src/components/grading/ai-panel.tsx` | Admin UI for "Analyze with AI (Full)" button |
| `client/src/components/grading/image-viewer.tsx` | Admin UI for "Mark Defects" / "Manual Crop" |
| `client/src/components/grading/grade-display.tsx` | Admin UI for "Override Grade" |
| `client/src/components/certificate-form.tsx` | Wraps the grading flow — calls `/analyze` and `/approve-grade` |

---

## Total issue / findings count

- **9 distinct AI call types** identified across server (matrix above)
- **2 model providers** (Anthropic Opus + Haiku as primary; OpenAI GPT-4o as optional second-opinion)
- **1 reference to claude-sonnet-4-6** that is a tag string, not an actual call — likely orphan from earlier version
- **No per-feature AI toggle exists today** — only `ANTHROPIC_API_KEY` presence as a global kill-switch
- **Feature flag pattern exists** (env-var → server const → public endpoint → client hook) — easy to extend

---

## Implemented toggles (2026-05-07)

10 env-var feature flags wired into `server/config/feature-flags.ts`. Gates inserted at the function entry-point (`ai-grading-service.ts`) or top of the route handler (`server/routes.ts`). Boot log writes `[ai-flags] { ... }` once on server start so resolved state is visible in Fly logs.

| Env var | Default | Gated function / route | Disabled behaviour |
|---|---|---|---|
| `AI_IDENTIFY_ENABLED` | **ON** (`!== "false"`) | `identifyCardFromBuffer`, `identifyCard` | `throw new Error("AI_IDENTIFY_ENABLED=false")` — caller's existing 5xx surface |
| `AI_DEFECT_SUGGEST_ENABLED` | **OFF** (`=== "true"`) | `suggestDefectsFromBuffer` | returns `[]` — scan-ingest already tolerates empty |
| `AI_HAIKU_QUICK_GRADE_ENABLED` | **OFF** | `gradeCardFromBuffer` | returns `null` — scan-ingest already null-checks |
| `AI_FULL_GRADE_ENABLED` | **OFF** | `analyzeCardFromBuffers`, `analyzeCard` | `throw new Error("AI_FULL_GRADE_ENABLED=false")` — Opus £££ kept off by default |
| `AI_CENTERING_ENABLED` | **OFF** | `POST /api/admin/certificates/:id/measure-centering` | `503 { error: "AI centering measurement is disabled" }` |
| `AI_STANDALONE_DETECT_ENABLED` | **OFF** | `POST /api/admin/certificates/:id/detect-defects` | `503 { error: "AI defect detection is disabled" }` |
| `AI_STANDALONE_GRADE_ENABLED` | **OFF** | `POST /api/admin/certificates/:id/grade-card` | `503 { error: "AI grade-card is disabled" }` |
| `AI_DESCRIPTION_GEN_ENABLED` | **ON** | `POST /api/admin/certificates/:id/generate-description` | `503 { error: "AI description generation is disabled" }` |
| `AI_GPT_SECOND_OPINION_ENABLED` | **OFF** | `identifyWithGpt` | returns `null` — reconciliation falls back to Claude-only |
| `AI_PUBLIC_ESTIMATE_ENABLED` | **ON** | `POST /api/tools/estimate` | `503 { error: "AI Pre-Grade tool is temporarily paused. Please try again later." }` |

To flip: `fly secrets set AI_FULL_GRADE_ENABLED=true -a mintvault` (sets Opus full-grade live). Machines restart after secret change. Confirm via the `[ai-flags]` line in `fly logs`.
