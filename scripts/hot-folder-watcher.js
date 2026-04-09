#!/usr/bin/env node
/**
 * MintVault Hot Folder Watcher
 * Runs locally on the grader's MacBook.
 * Watches ~/MintVault-Scans/ and auto-uploads new images to MintVault.
 *
 * Setup:
 *   1. Set your scanner to save scans to ~/MintVault-Scans/
 *   2. Run: MINTVAULT_ADMIN_TOKEN=your_token node scripts/hot-folder-watcher.js
 *      (get your token from the MintVault admin panel under Settings)
 *
 * Behaviour:
 *   - First scan detected → uploaded as FRONT image
 *   - Second scan         → uploaded as BACK image
 *   - Repeats for next card
 *   - Processed files moved to ~/MintVault-Scans/processed/
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── Configuration ──────────────────────────────────────────────────────────

const WATCH_DIR    = process.env.MINTVAULT_SCAN_DIR || path.join(os.homedir(), 'MintVault-Scans');
const API_BASE     = process.env.MINTVAULT_API      || 'https://mintvault.fly.dev';
const ADMIN_TOKEN  = process.env.MINTVAULT_ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.error('ERROR: MINTVAULT_ADMIN_TOKEN environment variable is required.');
  console.error('Run: MINTVAULT_ADMIN_TOKEN=your_token node scripts/hot-folder-watcher.js');
  process.exit(1);
}

// ── State ──────────────────────────────────────────────────────────────────

let currentSide = 'front'; // alternates: front -> back -> front -> back
let processing  = false;
const seen      = new Set(); // debounce duplicate events

// ── Startup ────────────────────────────────────────────────────────────────

if (!fs.existsSync(WATCH_DIR)) {
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  console.log(`✓ Created scan directory: ${WATCH_DIR}`);
}

const processedDir = path.join(WATCH_DIR, 'processed');
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

console.log('');
console.log('  MintVault Hot Folder Watcher');
console.log('  ────────────────────────────');
console.log(`  Watching:  ${WATCH_DIR}`);
console.log(`  Server:    ${API_BASE}`);
console.log(`  Next side: ${currentSide.toUpperCase()}`);
console.log('');
console.log('  Place a card on your scanner and press Scan.');
console.log('  First scan = front, second scan = back.');
console.log('  Press Ctrl+C to stop.');
console.log('');

// ── Watcher ────────────────────────────────────────────────────────────────

fs.watch(WATCH_DIR, async (eventType, filename) => {
  if (eventType !== 'rename' && eventType !== 'change') return;
  if (!filename) return;

  const ext = path.extname(filename).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.tiff', '.tif'].includes(ext)) return;

  const filepath = path.join(WATCH_DIR, filename);
  if (seen.has(filepath)) return;
  seen.add(filepath);
  setTimeout(() => seen.delete(filepath), 5000);

  // Wait for scanner to finish writing
  await sleep(1500);
  if (!fs.existsSync(filepath)) return;

  const stat = fs.statSync(filepath);
  if (stat.size === 0) return;

  if (processing) {
    console.log(`  ⏳ Busy — queuing ${filename}`);
    await waitUntil(() => !processing, 30000);
  }

  processing = true;
  const side = currentSide;
  console.log(`  📷 New scan: ${filename}  →  ${side.toUpperCase()}`);

  try {
    const result = await uploadImage(filepath, side);
    console.log(`  ✓ Uploaded ${side} for ${result.certId || '(cert auto-detected)'}`);

    // Move to processed folder
    const dest = path.join(processedDir, `${Date.now()}_${side}_${filename}`);
    fs.renameSync(filepath, dest);

    // Toggle side
    currentSide = side === 'front' ? 'back' : 'front';
    if (currentSide === 'front') {
      console.log('');
      console.log('  ── Card complete. Ready for next card. ──');
      console.log('  Place the next card on your scanner.');
      console.log('');
    } else {
      console.log(`  Flip the card and scan the BACK.`);
    }
  } catch (err) {
    console.error(`  ✗ Upload failed: ${err.message}`);
  } finally {
    processing = false;
  }
});

// ── Upload function ────────────────────────────────────────────────────────

function uploadImage(filepath, side) {
  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(filepath);
    const filename   = path.basename(filepath);
    const boundary   = '----MintVaultBoundary' + Date.now();

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="side"\r\n\r\n${side}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${side}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const parsed  = new URL(`${API_BASE}/api/admin/hot-folder-upload`);
    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Authorization':  `Bearer ${ADMIN_TOKEN}`,
      },
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json.error || `HTTP ${res.statusCode}`));
        } catch {
          reject(new Error(`Invalid response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function waitUntil(cond, timeout) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const id = setInterval(() => {
      if (cond()) { clearInterval(id); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(id); reject(new Error('Timeout')); }
    }, 200);
  });
}
