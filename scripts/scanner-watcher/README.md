# MintVault Scanner Watcher

Watches a local folder for scanned card images and automatically uploads them to MintVault for AI grading.

## Setup

```bash
cd scripts/scanner-watcher
npm install
```

## Configuration

Set these environment variables:

| Variable | Required | Description |
|---|---|---|
| `MINTVAULT_API_URL` | Yes | Base URL (e.g. `https://mintvault.fly.dev`) |
| `MINTVAULT_ADMIN_COOKIE` | Yes | Admin session cookie (`mv.sid=s%3A...`) |

### Getting the admin cookie

1. Log into MintVault admin panel in your browser
2. Open DevTools (F12) → Application → Cookies
3. Copy the full value of the `mv.sid` cookie
4. Pass it as: `MINTVAULT_ADMIN_COOKIE="mv.sid=s%3Axxxxx..."`

## Usage

```bash
MINTVAULT_API_URL=https://mintvault.fly.dev \
MINTVAULT_ADMIN_COOKIE="mv.sid=s%3A..." \
npm start
```

## How it works

1. Place scanned card images into `~/mintvault-scans/inbox/`
2. The watcher detects new files and pairs them as front + back
3. Each pair is uploaded to MintVault's scan-ingest endpoint
4. A new certificate is created and AI grading runs automatically
5. Processed files move to `~/mintvault-scans/processed/`
6. Failed uploads move to `~/mintvault-scans/failed/`

## File pairing

**Explicit pairing** (recommended): Name files with `_front` or `_back` suffix:
- `charizard_front.jpg` + `charizard_back.jpg`

**Auto pairing**: Drop two files within 60 seconds — first = front, second = back.

**Single image**: If no pair arrives within 60 seconds, the file uploads as front-only.

## Folder structure

```
~/mintvault-scans/
  inbox/       ← Drop scans here
  processed/   ← Successfully uploaded
  failed/      ← Upload failures (check logs)
```

All folders are created automatically on first run.
