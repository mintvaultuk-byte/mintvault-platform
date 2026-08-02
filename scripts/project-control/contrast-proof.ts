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
 * Usage:  npx tsx scripts/project-control/contrast-proof.ts
 *         (tsx, not node: it imports the real React components to render the markup under test)
 * Exits non-zero if any sampled pair falls below its WCAG AA threshold.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
// MUST precede the renderer import: it puts React in scope for the classic JSX transform.
import "./react-global";
import { renderHarnessBody, CONTRAST_TARGETS } from "./render-contrast-harness";

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
  /**
   * Composite the real paint stack under 'el', and return the background that yields the WORST
   * ratio against 'fg' — not the darkest one.
   *
   * Three corrections over the first version, all found by hostile review:
   *   - background-IMAGE paints on top of background-COLOR, so the image must be considered first,
   *     not only when the colour is transparent;
   *   - "darkest stop = worst case" is backwards for light-on-dark: a darker ground RAISES contrast.
   *     The worst stop is whichever minimises the ratio, so that is what is searched for;
   *   - alpha was stripped when re-parsing gradient stops, turning 'transparent' into opaque black
   *     (luminance 0) — the most flattering possible background. Stops are now alpha-composited
   *     over what is already beneath them.
   */
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const over = (fgc, bgc) => {
    // Guard every component: a computed gradient can yield stops this regex parses only partially
    // (colour-stop positions, colour functions), and one NaN silently poisons the whole composite.
    const a = Math.min(1, Math.max(0, num(fgc.a, 1)));
    const mix = (f, b) => num(f, b) * a + num(b, 0) * (1 - a);
    return { r: mix(fgc.r, bgc.r), g: mix(fgc.g, bgc.g), b: mix(fgc.b, bgc.b), a: 1 };
  };
  const parseAny = (c) => {
    const m = c.match(/rgba?[(]([^)]+)[)]/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x.trim()));
    // A stop we cannot fully parse is DISCARDED, never guessed at. Guessing is how the first
    // version turned 'transparent' into opaque black — the most flattering possible background.
    if (![p[0], p[1], p[2]].every((v) => Number.isFinite(v))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1 };
  };
  const worstBg = (el, fg) => {
    // Collect el -> root. layers[0] is the element itself.
    const layers = [];
    let n = el;
    while (n) {
      const st = getComputedStyle(n);
      layers.push({
        color: parseAny(st.backgroundColor),
        stops:
          st.backgroundImage && st.backgroundImage !== "none"
            ? [...st.backgroundImage.matchAll(/rgba?[(]([^)]+)[)]/g)].map((m) => parseAny("rgba(" + m[1] + ")")).filter(Boolean)
            : [],
      });
      n = n.parentElement;
    }
    // The base is the NEAREST ancestor that paints an opaque colour — anything above it is hidden.
    let baseIdx = layers.length - 1;
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = 0; i < layers.length; i += 1) {
      const c = layers[i].color;
      if (c && c.a >= 1) { base = c; baseIdx = i; break; }
      }
    // Composite every semi-transparent colour BELOW the element back down onto that base.
    let ground = base;
    for (let i = baseIdx - 1; i >= 0; i -= 1) {
      const c = layers[i].color;
      if (c && c.a > 0) ground = over(c, ground);
    }
    // Gradients paint ON TOP of the colour, so build the candidate grounds layer by layer.
    //
    // Two rules, and the first is what the original version got backwards:
    //   - the worst stop is the one that MINIMISES the ratio against this foreground, not the
    //     darkest one. For light-on-dark a darker ground raises contrast, so darkest-stop sampling
    //     was the most flattering choice available;
    //   - a fully opaque stop COVERS what is beneath it, so the bare ground stops being a candidate.
    //     Without that, a gold button's dark label was scored against the dark panel behind the
    //     button rather than against the gold it actually sits on.
    let candidates = [ground];
    for (let i = baseIdx; i >= 0; i -= 1) {
      const stops = layers[i].stops;
      if (!stops.length) continue;
      const painted = [];
      for (const c of candidates) for (const stop of stops) painted.push(over(stop, c));
      const covers = stops.some((st) => (st.a ?? 1) >= 1);
      candidates = covers ? painted : candidates.concat(painted);
    }
    let worst = candidates[0];
    let worstRatio = ratio(fg, worst);
    for (const c of candidates) {
      const r = ratio(fg, c);
      if (r < worstRatio) { worstRatio = r; worst = c; }
    }
    return worst;
  };
  const samples = [];
  for (const [name, sel, min] of window.__TARGETS__) {
    const el = document.querySelector(sel);
    if (!el) { samples.push({ name, selector: sel, error: "not found" }); continue; }
    const s = getComputedStyle(el);
    const fgRaw = parse(s.color);
    // A partly transparent foreground (e.g. .admin-btn:disabled { opacity }) must be composited too.
    const opacity = parseFloat(s.opacity);
    const fg = { ...fgRaw, a: (fgRaw.a ?? 1) * (Number.isFinite(opacity) ? opacity : 1) };
    const bg0 = worstBg(el, { ...fg, a: 1 });
    const fgComposited = over(fg, bg0);
    const bg = bg0;
    const size = parseFloat(s.fontSize);
    const bold = parseInt(s.fontWeight, 10) >= 700;
    // WCAG large-text exemption: >=24px, or >=18.66px bold.
    const large = size >= 24 || (bold && size >= 18.66);
    samples.push({
      name, selector: sel,
      fg: s.color, bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(",") + ")",
      fontSize: size, large,
      ratio: Math.round(ratio(fgComposited, bg) * 100) / 100,
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
  let chrome;
  try {
    return await run(profile, (c) => (chrome = c));
  } finally {
    // EVERY exit path, not just the two success-shaped ones. Chrome is launched with an
    // unauthenticated DevTools socket on a loopback port; an orphan left by a mid-run failure keeps
    // that socket open for the life of the session, and any local process can attach to it. The
    // 20s endpoint timeout and any CDP error both used to unwind straight past the cleanup.
    try {
      chrome?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

async function run(profile, registerChrome) {
  const html = buildHarness();
  const file = join(profile, "contrast.html");
  writeFileSync(file, html, "utf8");

  if (!existsSync(CHROME)) {
    // Fail with a sentence rather than an unhandled ENOENT after a 20-second wait.
    throw new Error(`Chrome not found at "${CHROME}". Set CHROME_PATH to your browser binary.`);
  }

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ]);
  registerChrome(chrome);
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Chrome did not report a DevTools endpoint")), 20000);
    chrome.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    chrome.stderr.on("data", (d) => {
      const m = String(d).match(/ws:\/\/[^\s]+/);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    });
  });

  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  const page = { ws, nextId: 1, pending: new Map() };
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const p = page.pending.get(msg.id);
    if (!p) return;
    page.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
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

  // Imported, never hand-written: the selectors and the markup come from the SAME module, so a
  // harness that no longer matches the product fails loudly instead of measuring its own fiction.
  const targets = CONTRAST_TARGETS.map(([name, sel, min]) => [name, sel, min ?? null]);
  await send("Runtime.evaluate", { expression: `window.__TARGETS__ = ${JSON.stringify(targets)};` });
  const { result } = await send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
  const samples = result.value;

  let failed = 0;
  console.log("\nProject Control — loading / failure contrast (real Chrome, real admin CSS)\n");
  for (const s of samples) {
    if (s.error) {
      console.log(`  ✗ ${s.name}: ${s.error} (${s.selector})`);
      failed++;
      continue;
    }
    const ok = s.ratio >= s.required;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${s.name.padEnd(22)} ${String(s.ratio).padStart(6)}:1  (needs ${s.required}:1)  ${s.fg} on ${s.bg}  ${s.fontSize}px`
    );
  }
  console.log("");

  if (failed > 0) {
    console.error(`${failed} sample(s) below the WCAG AA threshold.\n`);
    process.exit(1);
  }
  console.log("All sampled text meets WCAG AA against its painted background.\n");
}

/**
 * The page under measurement.
 *
 * The body is produced by `renderHarnessBody()`, which server-renders the ACTUAL `Panel`,
 * `adminButtonClass` and `diagnoseLoadFailure` output — see render-contrast-harness.tsx for why
 * hand-typed markup was abandoned. `client/index.html`'s Tailwind directives are stripped along
 * with the rest of the @-rules; every colour, size and weight under test is expressed in the admin
 * token stylesheets, which are inlined whole.
 */
function buildHarness() {
  const css = ["client/src/index.css", "client/src/styles/admin-tokens.css", "client/src/styles/project-control.css"]
    .map((p) => readFileSync(join(ROOT, p), "utf8"))
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${css.replace(/@import[^;]+;/g, "").replace(/@tailwind[^;]+;/g, "")}
</style></head><body>
${renderHarnessBody()}
</body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
