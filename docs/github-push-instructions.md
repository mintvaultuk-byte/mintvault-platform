# MintVault UK — GitHub Push Instructions
### How to export the full codebase to GitHub for Claude handover

---

## Option A — Automated script (recommended)

### Step 1: Download the Replit project

In Replit, go to **Files** (left sidebar) → click the three-dot menu → **Download as zip**.

Extract the zip on your local machine.

### Step 2: Create a GitHub repository

1. Go to [github.com/new](https://github.com/new)
2. Repository name: `mintvault-uk` (or your preferred name)
3. Set to **Private** (contains business logic)
4. Click **Create repository** (leave it empty — no README, no .gitignore)
5. Copy the repo URL: `https://github.com/YOUR_USERNAME/mintvault-uk.git`

### Step 3: Create a Personal Access Token (PAT)

1. Go to [github.com/settings/tokens/new](https://github.com/settings/tokens/new)
2. Note: `MintVault push`
3. Expiration: 7 days (one-time use)
4. Scopes: tick **repo** (full control)
5. Click **Generate token**
6. Copy the token (starts with `ghp_...`)

### Step 4: Edit and run the push script

Open `docs/github-push-script.sh` and fill in the three variables at the top:

```bash
GITHUB_USER="your-username-here"
GITHUB_REPO="mintvault-uk"
GITHUB_PAT="ghp_xxxxxxxxxxxxxxxxxxxx"
```

Then run:

```bash
cd /path/to/extracted/mintvault
chmod +x docs/github-push-script.sh
./docs/github-push-script.sh
```

---

## Option B — Manual git commands

Run these from inside the extracted project folder:

```bash
# 1. Initialize git (if not already a repo)
git init
git branch -M main

# 2. Add the remote (replace YOUR_USER, YOUR_REPO, YOUR_PAT)
git remote add origin https://YOUR_PAT@github.com/YOUR_USER/YOUR_REPO.git

# 3. Stage everything (respects .gitignore — secrets are excluded)
git add -A

# 4. Commit
git commit -m "MintVault UK — full codebase export March 2026"

# 5. Push
git push -u origin main
```

---

## Option C — GitHub Desktop (no terminal)

1. Download [GitHub Desktop](https://desktop.github.com/)
2. Click **Add** → **Add Existing Repository** → select the extracted folder
3. Create a new repository on GitHub.com via the app
4. Click **Publish repository**

---

## What gets pushed (included)

```
client/                     ← Full React frontend
  src/
    App.tsx                 ← All routes
    components/             ← 10 shared components (layout, seo-head, faq, etc.)
    pages/                  ← 25 pages + 6 SEO pages
    lib/                    ← Utilities, option lists, API client
    data/                   ← 15 static guide articles
    hooks/

server/                     ← Full Express backend
  routes.ts                 ← All 42+ API routes (2,300+ lines)
  storage.ts                ← Data access layer
  db.ts                     ← Drizzle connection
  auth.ts                   ← Admin 2-step login
  labels.ts                 ← Front/back label canvas generation
  claim-insert.ts           ← Claim insert card generator
  label-sheet.ts            ← A4 batch sheet generator
  email.ts                  ← Resend transactional emails
  r2.ts                     ← Cloudflare R2 image storage
  packingSlip.ts            ← PDF packing slip
  stripeClient.ts           ← Stripe initialisation
  webhookHandlers.ts        ← Stripe webhook
  config.ts                 ← Env var validation
  index.ts                  ← App entry point
  *.png                     ← Brand logo + label templates (embedded)

shared/
  schema.ts                 ← Drizzle schema + Zod + pricing logic (671 lines)

docs/                       ← Project documentation
  implementation-blueprint.md     ← Full technical spec v2
  content-inventory.md            ← All page copy, headings, messages
  asset-register.md               ← All images, icons, logos
  label-print-production-spec.md  ← Label geometry (LOCKED values)
  github-push-instructions.md     ← This file

public/
  brand/                    ← logo.png, nfc-tap-icon-white.png, nfc-tap-icon.png
  images/                   ← Hero images (WEBP + PNG)

README.md                   ← Full project overview + structure
package.json                ← Dependencies
drizzle.config.ts           ← DB config
tailwind.config.ts          ← CSS config
tsconfig.json               ← TypeScript config
vite.config.ts              ← Vite config
components.json             ← Shadcn config
postcss.config.js
.gitignore
```

---

## What gets EXCLUDED (by .gitignore)

| Excluded | Reason |
|---|---|
| `node_modules/` | Regenerated via `npm install` |
| `dist/` | Build output — regenerated |
| `.env`, `.env.*` | Secrets — NEVER commit |
| `*.pem`, `*.key` | Cryptographic keys |
| `.replit`, `replit.nix`, `.upm`, `.local` | Replit-specific internals |
| `.cache/`, `.config/` | Replit runtime cache |
| `attached_assets/` | Raw binary uploads (docs copied to /docs instead) |
| `uploads/` | User-uploaded files |
| `ebay_sniper.py`, `telegram_test.py` | Unrelated scripts |
| `seen*.json`, `sold_cache*.json`, `sniper*.json` | Unrelated script data |
| `data/` | Unrelated local data files |
| `package-lock.json` | Lockfile (regenerated) |
| `*.log` | Log files |

**No secrets are committed.** The repo contains zero API keys, database URLs, Stripe keys, or credentials of any kind. All secrets are loaded at runtime from Replit's environment variable system.

---

## After pushing — how Claude reads it

When handing this to Claude, share the GitHub repo URL and say:

> "Here is the full MintVault UK codebase. The docs/ folder contains the complete technical spec, content inventory, asset register, and print production spec. The main app code is in client/ (React frontend), server/ (Express backend), and shared/schema.ts (database schema + pricing logic). The README.md gives an architectural overview."

Claude should start with:
1. `README.md` — overview and architecture
2. `docs/implementation-blueprint.md` — full technical spec
3. `shared/schema.ts` — data model
4. `server/routes.ts` — all API routes
5. `client/src/App.tsx` — all frontend routes

---

## Current DB state (as of March 2026)

- **5 test certificates** (all Charizard, admin-created, no real customers)
- **0 submissions, 0 users, 0 payments**
- Database URL: `MINTVAULT_DATABASE_URL` → EU Neon PostgreSQL
- Stripe: connected, never used in production
- All ownership/NFC/claim tables now exist in live DB (applied March 2026)

---

*Last updated: March 25, 2026*
