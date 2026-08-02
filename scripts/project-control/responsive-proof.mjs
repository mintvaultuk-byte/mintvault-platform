/**
 * Project Control — REAL browser responsive proof.
 *
 * WHY THIS EXISTS
 *
 * The previous responsive proof asserted `document.documentElement.scrollWidth <= window.innerWidth`
 * inside happy-dom. happy-dom has no layout engine: `scrollWidth` is a field initialised to 0 and
 * never written, and `getBoundingClientRect()` returns a bare DOMRect. So the assertion read
 * `0 <= 390` and passed for any content at any viewport — a 99,999px element passed it. On top of
 * that, vitest runs with `css: false` by default here, so the media queries under test were never
 * even parsed. The test could not fail, which means it was not a test.
 *
 * This drives real Chrome over the DevTools Protocol and measures real layout, with real CSS.
 *
 * NO NEW DEPENDENCY. Chrome is already installed on this machine and `ws` is already a dependency.
 * Adding Playwright or Puppeteer would pull 170-500MB of browser binaries for a measurement the
 * machine can already make.
 *
 * THE 500px CLAMP — the trap this harness exists to avoid
 *
 * Chrome on macOS refuses to size a window below ~500px wide. `--window-size=390,844` yields a
 * 500px LAYOUT VIEWPORT while still writing a 390x844 PNG, so a screenshot can look like mobile
 * proof while the layout behind it was computed at 500px. Every viewport here therefore goes
 * through `Emulation.setDeviceMetricsOverride`, and every measurement asserts the width it
 * actually got rather than the width it asked for.
 *
 * Usage:  node scripts/project-control/responsive-proof.mjs <base-url> [outDir]
 * Exit code 0 = every viewport clean. Non-zero = a real overflow, printed with the offending
 * selectors rather than a bare number.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The viewports the parity report claims proof for. */
export const VIEWPORTS = [
  { label: "1440x900", width: 1440, height: 900, mobile: false },
  { label: "1280x800", width: 1280, height: 800, mobile: false },
  { label: "1024x768", width: 1024, height: 768, mobile: false },
  { label: "768x1024", width: 768, height: 1024, mobile: false },
  { label: "390x844", width: 390, height: 844, mobile: true },
];

/**
 * The in-page probe.
 *
 * Returns measurements AND the offending selectors. A responsive failure that reports only
 * "1402 > 390" tells you there is a problem; this tells you which element to fix.
 *
 * `position: fixed` elements are excluded deliberately — an overlay pinned to the viewport does
 * not create document overflow, and including them produces false positives on every page with a
 * modal or a toast.
 */
const PROBE = `(async () => {
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const de = document.documentElement;
  const vw = window.innerWidth;
  /**
   * Screen-reader-only text is deliberately parked outside the viewport — the canonical .sr-only
   * recipe is a 1px clipped box at a negative offset. It is not visual overflow, and counting it
   * would make every accessible page fail. Excluded by its signature (sub-2px and clipped), not by
   * class name, so a hand-rolled equivalent is excluded too.
   *
   * position:fixed is excluded for the same reason: an overlay pinned to the viewport does not
   * widen the document.
   */
  const hidden = (el, r) => {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") return true;
    const clipped = cs.clip !== "auto" || (cs.clipPath && cs.clipPath !== "none");
    return clipped && r.width <= 2 && r.height <= 2;
  };
  const offenders = [...document.querySelectorAll("*")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5) && !hidden(el, r))
    .map(({ el, r }) => ({
      sel:
        el.tagName.toLowerCase() +
        (el.id ? "#" + el.id : "") +
        (typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\\s+/).join(".")
          : ""),
      left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
    }))
    .slice(0, 25);
  return {
    innerWidth: vw,
    devicePixelRatio: window.devicePixelRatio,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    docClientWidth: de.clientWidth,
    horizontallyScrollable: de.scrollWidth > de.clientWidth,
    offenders,
  };
})()`;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function rpc(ws, state, method, params = {}) {
  const id = ++state.id;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function withChrome(fn) {
  const profile = mkdtempSync(join(tmpdir(), "pc-responsive-"));
  const port = 9200 + Math.floor((process.pid % 300));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  try {
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        target = list.find((t) => t.type === "page");
      } catch {
        /* not up yet */
      }
    }
    if (!target) throw new Error("Chrome did not expose a debugging target");
    return await fn(target.webSocketDebuggerUrl);
  } finally {
    chrome.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  }
}

export async function measure(baseUrl, outDir) {
  return withChrome(async (wsUrl) => {
    const state = { id: 0, pending: new Map() };
    const ws = await connect(wsUrl);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && state.pending.has(msg.id)) {
        const { resolve, reject } = state.pending.get(msg.id);
        state.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });

    await rpc(ws, state, "Page.enable");
    await rpc(ws, state, "Runtime.enable");
    const results = [];

    for (const vp of VIEWPORTS) {
      // The clamp-proof path. --window-size cannot go below ~500px on macOS; this can.
      await rpc(ws, state, "Emulation.setDeviceMetricsOverride", {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.mobile ? 2 : 1,
        mobile: vp.mobile,
        screenWidth: vp.width,
        screenHeight: vp.height,
      });
      await rpc(ws, state, "Page.navigate", { url: baseUrl });
      await new Promise((r) => setTimeout(r, 1200));

      const evalOnce = async (expr) => {
        const r = await rpc(ws, state, "Runtime.evaluate", {
          expression: expr,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      };

      const m = await evalOnce(PROBE);

      /**
       * POSITIVE CONTROL — the assertion that this harness is not the last one.
       *
       * Inject an element far wider than the viewport and require the probe to NOTICE. If it does
       * not, the measurement is vacuous and the run fails, regardless of how clean the real page
       * looked. This is exactly the check the happy-dom version lacked.
       */
      await evalOnce(
        `(() => { const d = document.createElement("div");
           d.id = "__overflow_canary__"; d.style.cssText = "width:5000px;height:1px";
           document.body.appendChild(d); return true; })()`
      );
      const canary = await evalOnce(PROBE);
      await evalOnce(`(() => { document.getElementById("__overflow_canary__")?.remove(); return true; })()`);

      const canaryDetected = canary.docScrollWidth > canary.innerWidth || canary.offenders.length > 0;

      if (outDir) {
        /**
         * Full page, but captured through an explicit clip at the EMULATED width.
         *
         * `captureBeyondViewport: true` alone re-lays-out to Chrome's own bounds and produced
         * 5000px-wide images for a 390px viewport — a picture that does not depict the layout that
         * was just measured. Clipping to the emulated width and the measured document height keeps
         * the artefact and the measurement describing the same thing. `scale: 1` keeps the pixel
         * grid honest rather than multiplying by dpr.
         */
        const fullHeight = await evalOnce(
          `Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`
        );
        const shot = await rpc(ws, state, "Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: vp.width, height: Math.min(fullHeight, 20000), scale: 1 },
        });
        writeFileSync(join(outDir, `${vp.label}-project-control.png`), Buffer.from(shot.data, "base64"));
      }

      results.push({
        viewport: vp.label,
        requestedWidth: vp.width,
        ...m,
        canaryDetected,
        // A viewport is only clean if the measurement was real (canary caught) AND nothing overflowed.
        clean: canaryDetected && !m.horizontallyScrollable && m.offenders.length === 0 && m.innerWidth === vp.width,
      });
    }

    ws.close();
    return results;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.argv[2];
  const outDir = process.argv[3];
  if (!baseUrl) {
    console.error("usage: node scripts/project-control/responsive-proof.mjs <base-url> [outDir]");
    process.exit(2);
  }
  if (outDir) mkdirSync(outDir, { recursive: true });
  measure(baseUrl, outDir)
    .then((rows) => {
      let failed = 0;
      for (const r of rows) {
        const status = r.clean ? "PASS" : "FAIL";
        if (!r.clean) failed++;
        console.log(
          `${status} ${r.viewport}: innerWidth=${r.innerWidth} (requested ${r.requestedWidth}) ` +
            `docScrollWidth=${r.docScrollWidth} bodyScrollWidth=${r.bodyScrollWidth} ` +
            `dpr=${r.devicePixelRatio} scrollable=${r.horizontallyScrollable} ` +
            `canaryDetected=${r.canaryDetected} offenders=${r.offenders.length}`
        );
        for (const o of r.offenders) console.log(`      overflow: ${o.sel} left=${o.left} right=${o.right} w=${o.width}`);
        if (!r.canaryDetected) console.log("      !! positive control did NOT fire — this measurement is vacuous");
        if (r.innerWidth !== r.requestedWidth)
          console.log(`      !! viewport clamped: asked ${r.requestedWidth}, got ${r.innerWidth}`);
      }
      console.log(failed === 0 ? "\nAll viewports clean." : `\n${failed} viewport(s) failed.`);
      process.exit(failed === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error("responsive proof failed to run:", e.message);
      process.exit(2);
    });
}
