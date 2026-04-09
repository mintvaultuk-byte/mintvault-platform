# CLAUDE.md — MintVault Project Guardrails

> **Owner:** Non-technical founder
> **Project:** MintVault — Collectibles grading & certification platform (PSA-style)
> **Stage:** MVP in progress
> **Last updated:** 2026-03-27

---

## 🔒 GOLDEN RULES — Never Break These

1. **Never delete or overwrite files without showing me exactly what will change first.** Always describe what you're about to do in plain English before doing it.
2. **Never run destructive database commands** (`DROP`, `DELETE`, `TRUNCATE`, schema removals) without my explicit approval. If you think a migration is needed, explain what it does and why before running `db:push`.
3. **Never change environment variables, secrets, or auth logic** without confirming with me first. This includes `ADMIN_PASSWORD`, `ADMIN_PIN`, `SESSION_SECRET`, Stripe config, and R2 credentials.
4. **Never push to production or deploy** unless I specifically say "deploy" or "push to production."
5. **Never install new dependencies** (`npm install <package>`) without telling me what the package does, why it's needed, and what alternatives exist.
6. **Never modify the Stripe webhook or payment flow** without a full explanation. Money is involved — treat payment code as high-risk.
7. **Never change the grading system logic** (grade types, numeric ranges, label rendering) without my approval. This is core business logic.
8. **Always preserve existing functionality.** If I ask for a new feature, do not break or remove what already works. If there's a conflict, stop and explain it to me.
9. **Always create a backup plan.** Before any risky change, tell me how to undo it if something goes wrong.
10. **Speak to me in plain English.** I am not a developer. Avoid jargon unless you explain it immediately. Use analogies when helpful.

---

## 🧭 How to Work With Me

### Communication style
- Explain what you're doing **before** you do it — like narrating your work
- When I ask a question, give me the short answer first, then the detail if I ask for it
- If you're unsure about something, **ask me** rather than guessing
- When showing me code changes, also show me what the **user will see** (UI impact)
- Flag risks clearly: use words like "⚠️ WARNING" or "🚨 RISKY" so I don't miss them

### Decision-making
- If a task has multiple approaches, give me 2–3 options with trade-offs in plain English
- For anything that touches **money, user data, security, or core grading logic** — always pause and confirm with me
- For small UI tweaks, copy fixes, or non-breaking improvements — go ahead and just do it, then show me the result

### When you encounter errors
- Don't silently retry 10 times. If something fails twice, explain the problem to me
- If a fix requires changing something outside the scope of what I asked for, flag it
- Never "fix" a problem by removing a feature

---

## 📋 Project Overview

### What is MintVault?
MintVault is a **collectibles grading and certification service** — similar to PSA or BGS but for a broader range of collectibles. Customers submit items, we grade them on a standardised scale, and issue tamper-evident certificates with labels, QR codes, and NFC verification. We accept **online payments via Stripe**.

### Business-critical features (do not break)
| Feature | Why it matters |
|---|---|
| Grading system (1–10 + special grades) | Core product — this IS our service |
| Label generation (PNG + PDF) | Physical product shipped to customers |
| Certificate lookup (by cert ID) | Public trust & verification — customers scan QR codes |
| Stripe payments | Revenue — we can't operate without this |
| Admin authentication (2-step) | Only I should have access to the admin panel |
| Image storage (R2 presigned URLs) | Customer item photos — privacy matters |
| Email notifications (Resend) | Customer communication |

### Things that are NOT yet built (potential future work)
- Public customer accounts / login
- Customer-facing submission portal
- Tracking / shipping integration
- Bulk grading workflows
- Marketing site / landing page improvements
- Analytics dashboard
- NFC tag writing/management

---

## 🏗️ Architecture & Tech Stack (Reference)

### Commands

```bash
# Development
npm run dev          # Start server (tsx server/index.ts, port 5000)

# Production build
npm run build        # Vite SPA → dist/public, esbuild server → dist/index.cjs
npm start            # NODE_ENV=production node dist/index.cjs

# Type checking
npm run check        # tsc (no emit)

# Database
npm run db:push      # Push schema changes via drizzle-kit
```

There are no test or lint scripts defined.

### Request flow

```
Browser → Express (server/index.ts)
  → /api/* routes (server/routes.ts)
    → Storage layer (server/storage.ts — IStorage interface)
      → PostgreSQL via Drizzle ORM
  → /* (static) → Vite-built SPA (dist/public)
```

### Key directories

- `server/` — Express API, label generation, email, R2, auth
- `client/src/` — React SPA (Wouter routing, TanStack Query, Shadcn UI)
- `shared/schema.ts` — **Single source of truth**: all Drizzle table definitions, Zod insert schemas, TypeScript types, pricing logic, grade constants. Imported by both server and client via `@shared/` alias.
- `migrations/` — Drizzle migration files (generated by `db:push`)

### Path aliases

- `@/` → `client/src/`
- `@shared/` → `shared/`

### Data layer

Drizzle ORM with PostgreSQL (Neon). All queries live in `server/storage.ts` behind the `IStorage` interface. Tables and types are defined in `shared/schema.ts` using Drizzle's `$inferSelect`/`$inferInsert`.

Database URL env var: `MINTVAULT_DATABASE_URL` (validated at startup in `server/config.ts`).

### Auth

Two-step admin-only auth — no public user accounts. Flow: POST `/api/admin/login` (email + `ADMIN_PASSWORD`) → POST `/api/admin/pin` (6-digit `ADMIN_PIN`) → session cookie `mv.sid`. Sessions stored in PostgreSQL via `connect-pg-simple`. Protected routes use `require_admin` middleware.

### Image storage

Cloudflare R2 (S3-compatible) via `server/r2.ts`. Images uploaded to keys like `images/{certId}/{front|back}.jpg`. All access is via presigned URLs (1-hour expiry) — never long-term public. R2 credentials: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.

### Label generation

`server/labels.ts` renders labels as PNG (Canvas 827×236 px @ 300 DPI) and wraps them into PDFs via pdfkit. The front label has a left text panel (card name/set/variant) and a right gold grade panel. The back has a QR code, NFC icon, and logo. `applyLabelOverrides()` merges display-only field overrides before rendering.

### Stripe

Uses Replit's managed connector (credentials fetched from Connectors API, not env vars). Webhook route at `/api/stripe/webhook` must be registered **before** `express.json()` middleware (raw body requirement).

### Certificate ID normalisation

`certId` values are stored and looked up in normalised form: `MV-0000000001` → `MV1`. Use `normalizeCertId()` from `server/routes.ts` when accepting external input.

### Grading system

Grade types: `numeric` (1–10) or non-numeric (`NO` = Not Graded, `AA` = Authentic Altered). Constants and helpers (`gradeLabel`, `gradeLabelFull`, `isNonNumericGrade`) are in `shared/schema.ts`.

### Frontend state

TanStack Query v5 for all server state. No global client state store. API calls go through `apiRequest()` in `client/src/lib/queryClient.ts`. The query client invalidates on mutations by query key.

### Environment variables

| Variable | Purpose |
|---|---|
| `MINTVAULT_DATABASE_URL` | PostgreSQL connection string |
| `ADMIN_PASSWORD` | Admin login password |
| `ADMIN_PIN` | Admin 2-step PIN (6 digits) |
| `SESSION_SECRET` | Express-session signing secret |
| `SIGNED_URL_SECRET` | HMAC key for presigned image URLs |
| `RESEND_API_KEY` | Transactional email (Resend) |
| `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Cloudflare R2 |
| `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN` | Used for email callback URLs and Stripe webhook registration |

---

## 🛡️ Code Quality Rules

### Before making any change, Claude Code must:
1. Confirm which file(s) will be modified
2. Explain the change in plain English
3. Check that `npm run check` (TypeScript) still passes after changes
4. Verify the dev server still starts with `npm run dev`

### Coding standards
- All types and schemas go in `shared/schema.ts` — never duplicate type definitions
- All database queries go through `server/storage.ts` via the `IStorage` interface
- All API routes live in `server/routes.ts`
- Use existing patterns — if similar code exists elsewhere in the project, follow that style
- Never use `any` type — always use proper TypeScript types
- Never store secrets in code — use environment variables
- Never commit `.env` files or log secrets to the console

### When adding a new feature:
1. Add types/schema to `shared/schema.ts`
2. Add storage methods to `server/storage.ts`
3. Add API routes to `server/routes.ts`
4. Add UI components to `client/src/`
5. Run `npm run check` to verify types
6. Test with `npm run dev`

---

## 📓 Obsidian Integration Guide

This section helps you connect your Obsidian vault to your MintVault project management workflow.

### Recommended vault structure

Create these folders in your Obsidian vault:

```
📂 MintVault/
├── 📂 Daily Notes/          ← What you worked on each day
├── 📂 Decisions/            ← Record of every major decision
├── 📂 Features/             ← One note per feature (status, requirements, notes)
├── 📂 Bugs/                 ← Bug reports and fixes
├── 📂 Meetings/             ← Notes from any calls or meetings
├── 📂 Resources/            ← Links, docs, reference material
├── 📄 Dashboard.md          ← Your project overview (pin this)
├── 📄 Backlog.md            ← Everything you want to build, prioritised
└── 📄 CLAUDE.md             ← This file (copy it into your vault too)
```

### Dashboard.md template

Copy this into your vault as your main project hub:

```markdown
# MintVault Dashboard

## Current Sprint
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

## Status
| Area | Status | Last Updated |
|---|---|---|
| Grading system | ✅ Working | |
| Label generation | ✅ Working | |
| Stripe payments | ✅ Working | |
| Admin panel | ✅ Working | |
| Certificate lookup | ✅ Working | |
| Customer portal | 🔲 Not started | |
| Marketing site | 🔲 Not started | |

## Recent Decisions
- [[Decisions/YYYY-MM-DD — Decision title]]

## Links
- Replit project: [link]
- Stripe dashboard: [link]
- Cloudflare R2: [link]
- Neon database: [link]
```

### Decision log template

Every time you (or Claude Code) make a significant decision, create a note:

```markdown
# Decision: [Short title]
**Date:** YYYY-MM-DD
**Status:** Decided / Revisiting / Reversed

## Context
What situation led to this decision?

## Options considered
1. Option A — pros / cons
2. Option B — pros / cons

## Decision
What we chose and why.

## Consequences
What changed as a result. Any follow-up actions.
```

### Feature note template

```markdown
# Feature: [Name]
**Status:** 🔲 Not started / 🟡 In progress / ✅ Done / ❌ Blocked
**Priority:** High / Medium / Low
**Date added:** YYYY-MM-DD

## What it does
Plain English description of the feature from a user's perspective.

## Why it matters
Business reason for building this.

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2

## Technical notes
Any relevant details from Claude Code sessions.

## Related
- [[other notes]]
```

### How to use Obsidian with Claude Code sessions

**Before a Claude Code session:**
1. Open your Dashboard.md — check what's in the current sprint
2. Open the relevant Feature or Bug note
3. Copy any requirements or context you want to give Claude Code

**During a Claude Code session:**
- Paste context from your Obsidian notes when starting a task
- Copy this CLAUDE.md into your project repo root so Claude Code reads it automatically

**After a Claude Code session:**
1. Update your Dashboard.md with task status
2. Create a Decision note if any significant choices were made
3. Add a Daily Note summarising what was done
4. Note any new bugs or follow-up tasks in your Backlog.md

### Connecting Obsidian to Claude Desktop (MCP)

To make Claude Desktop aware of your Obsidian vault, you can set up an MCP server. Here is how:

1. Install the Obsidian MCP plugin or use the filesystem MCP server
2. In Claude Desktop, go to **Settings → Developer → Edit Config**
3. Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/your/obsidian/vault/MintVault"
      ]
    }
  }
}
```

4. Replace `/path/to/your/obsidian/vault/MintVault` with the actual path to your vault folder
5. Restart Claude Desktop
6. You can now ask Claude Desktop to read and write to your Obsidian notes

**On Windows**, the config file is at:
`%APPDATA%\Claude\claude_desktop_config.json`

**On Mac**, it's at:
`~/Library/Application Support/Claude/claude_desktop_config.json`

---

## 🚨 Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Stripe webhook breaks | Payments fail, revenue lost | Never touch webhook code without explicit approval. Test in Stripe test mode first. |
| Database schema change breaks data | Existing records lost or corrupted | Always back up before migrations. Explain every schema change in plain English. |
| Auth bypass | Unauthorised access to admin panel | Never weaken auth. Never add public endpoints that expose admin data. |
| R2 images become public | Customer photos exposed | Always use presigned URLs. Never change URL signing logic. |
| Label rendering breaks | Wrong info on physical product | Test label changes visually before approving. Never change dimensions or DPI. |
| Dependency vulnerability | Security risk | Only add well-known, maintained packages. Check npm audit. |

---

## 📦 Change Log

Use this section to keep a running record of significant changes made during Claude Code sessions.

| Date | What changed | Files affected | Who approved |
|---|---|---|---|
| 2026-03-27 | Created CLAUDE.md guardrails | `CLAUDE.md` | Founder |
| | | | |

---

## ✅ Pre-Session Checklist

Before starting any Claude Code work session, make sure:

- [ ] You know what task you want to accomplish (check your Obsidian Dashboard)
- [ ] This CLAUDE.md file is in your project root
- [ ] Dev server runs without errors (`npm run dev`)
- [ ] You have a recent backup or your code is committed to git
- [ ] You've told Claude Code what you want in plain English

---

## 🆘 If Something Breaks

1. **Don't panic.** Most things can be undone.
2. **Stop Claude Code** from making more changes.
3. **Check git.** If you committed before the session, you can revert: `git checkout .` undoes all uncommitted changes.
4. **Check the dev server.** Run `npm run dev` — if it starts, the app still works.
5. **Check TypeScript.** Run `npm run check` — if it passes, the code is structurally sound.
6. **Ask Claude** (in a new chat if needed): "Something broke after [describe what was changed]. Help me fix it without changing anything else."
