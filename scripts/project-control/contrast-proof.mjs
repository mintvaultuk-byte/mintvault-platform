/**
 * Project Control — REAL-BROWSER contrast proof for the loading and failure states.
 *
 * WHY THIS EXISTS
 *
 * The loading and failure screens return BEFORE AdminShell mounts, so they used to render outside
 * `.admin-root` — directly on `body`, which is `#ffffff` with `#1a1a1a` text. The loading line was
 * gold on white (2.10:1) and the failure card's explanatory paragraph was near-black on the dark
 * `.admin-panel` gradient (1.06:1): the one sentence telling the operator what to do was
 * effectively invisible.
 *
 * No existing test could catch it. vitest runs happy-dom with `css: false`, so no style is ever
 * computed; and the responsive browser proof renders the visual FIXTURE, which wraps everything in
 * `.admin-root` already — so the fixture was correct and the product was not.
 *
 * This measures the ACTUAL composition: the real admin stylesheets, the real class names, the real
 * nesting, in real Chrome, reading `getComputedStyle` and compositing against the true painted
 * background. Contrast is computed per WCAG 2.1 relative luminance.
 *
 * Usage:  node scripts/project-control/contrast-proof.mjs
 * Exits non-zero if any sampled pair falls below its WCAG AA threshold.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** WCAG 2.1 relative luminance + contrast ratio. */
const PROBE = `(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  /** Walk up until a non-transparent background is actually painted. */
  const paintedBg = (el) => {
    let n = el;
    while (n) {
      const s = getComputedStyle(n);
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) return c;
      const img = s.backgroundImage;
      if (img && img !== "none") {
        // Gradients: sample the darkest declared stop, the worst case for light text.
        const stops = [...img.matchAll(/rgba?\\(([^)]+)\\)/g)].map((m) => parse("rgb(" + m[1] + ")"));
        if (stops.length) return stops.sort((a, b) => lum(a) - lum(b))[0];
      }
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const samples = [];
  for (const [name, sel, min] of window.__TARGETS__) {
    const el = document.querySelector(sel);
    if (!el) { samples.push({ name, selector: sel, error: "not found" }); continue; }
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const bg = paintedBg(el);
    const size = parseFloat(s.fontSize);
    const bold = parseInt(s.fontWeight, 10) >= 700;
    // WCAG large-text exemption: >=24px, or >=18.66px bold.
    const large = size >= 24 || (bold && size >= 18.66);
    samples.push({
      name, selector: sel,
      fg: s.color, bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(",") + ")",
      fontSize: size, large,
      ratio: Math.round(ratio(fg, bg) * 100) / 100,
      required: min ?? (large ? 3 : 4.5),
    });
  }
  return samples;
})()`;

async function cdp(page, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = page.nextId++;
    page.pending.set(id, { resolve, reject });
    page.ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "pc-contrast-"));
  const html = buildHarness();
  const file = join(profile, "contrast.html");
  writeFileSync(file, html, "utf8");

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ]);
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Chrome did not report a DevTools endpoint")), 20000);
    chrome.stderr.on("data", (d) => {
      const m = String(d).match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
  });

  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  const page = { ws, nextId: 1, pending: new Map() };
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const p = page.pending.get(msg.id);
    if (!p) return;
    page.pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  await new Promise((r) => ws.on("open", r));

  const { targetId } = await cdp(page, "Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp(page, "Target.attachToTarget", { targetId, flatten: true });
  const send = async (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = page.nextId++;
      page.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `file://${file}` });
  await new Promise((r) => setTimeout(r, 1200));

  const targets = [
    ["loading text", "[data-testid='pc-loading']", null],
    ["failure explanation", "[data-testid='pc-failure'] p", null],
    ["failure panel title", "[data-testid='pc-failure'] .admin-panel__title", null],
    ["failure panel sub", "[data-testid='pc-failure'] .admin-panel__sub", null],
    ["retry button", "[data-testid='pc-retry']", null],
  ];
  await send("Runtime.evaluate", { expression: `window.__TARGETS__ = ${JSON.stringify(targets)};` });
  const { result } = await send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
  const samples = result.value;

  let failed = 0;
  console.log("\nProject Control — loading / failure contrast (real Chrome, real admin CSS)\n");
  for (const s of samples) {
    if (s.error) { console.log(`  ✗ ${s.name}: ${s.error} (${s.selector})`); failed++; continue; }
    const ok = s.ratio >= s.required;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${s.name.padEnd(22)} ${String(s.ratio).padStart(6)}:1  (needs ${s.required}:1)  ${s.fg} on ${s.bg}  ${s.fontSize}px`
    );
  }
  console.log("");

  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`${failed} sample(s) below the WCAG AA threshold.\n`);
    process.exit(1);
  }
  console.log("All sampled text meets WCAG AA against its painted background.\n");
}

/**
 * The harness reproduces the PRODUCT's composition, not the fixture's: the real stylesheets, and
 * the exact nesting project-control.tsx returns from its two early-return branches.
 */
function buildHarness() {
  const css = ["client/src/index.css", "client/src/styles/admin-tokens.css", "client/src/styles/project-control.css"]
    .map((p) => readFileSync(join(ROOT, p), "utf8"))
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${css.replace(/@import[^;]+;/g, "")}
</style></head><body>
<div class="admin-root">
  <div class="p-8" data-testid="pc-loading" role="status" aria-live="polite">Loading Project Control…</div>
</div>
<div class="admin-root">
  <div class="p-8" data-testid="pc-failure" role="status" aria-live="polite">
    <section class="admin-panel">
      <header class="admin-panel__head">
        <h2 class="admin-panel__title">Project Control is switched off here</h2>
        <p class="admin-panel__sub">The activation flag is not enabled in this environment.</p>
      </header>
      <div class="admin-panel__body">
        <p>This message does not diagnose a migration and does not expose a backend error.</p>
        <button type="button" class="admin-btn admin-btn--gold" data-testid="pc-retry">Try again</button>
      </div>
    </section>
  </div>
</div>
</body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
