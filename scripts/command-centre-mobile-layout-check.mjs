import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { ADMIN_BROWSER_PROOF_CHECKS, stopOwnedChild } from "./ci/run-disposable-integration.mjs";

const runtimeProof = process.argv[2] === "--runtime-proof";
let runtimeUrl, reportPath;
if (runtimeProof) {
  runtimeUrl = new URL(process.argv[3]);
  reportPath = process.argv[4];
  if (
    process.argv.length !== 5 ||
    runtimeUrl.protocol !== "http:" ||
    runtimeUrl.hostname !== "127.0.0.1" ||
    !runtimeUrl.port ||
    runtimeUrl.username ||
    runtimeUrl.password ||
    runtimeUrl.pathname !== "/" ||
    runtimeUrl.search ||
    runtimeUrl.hash ||
    !reportPath ||
    !/^[a-f0-9-]{36}$/.test(process.env.MINTVAULT_BROWSER_PROOF_RUN_ID ?? "")
  )
    throw new Error("Runtime browser proof requires an owned loopback URL, report and run identity");
} else if (process.argv.length > 2) throw new Error("Unknown browser proof arguments");

const ROOT = new URL("../", import.meta.url);
const PAGE_SOURCE = readFileSync(new URL("client/src/pages/admin-command-centre.tsx", ROOT), "utf8");
const CSS_DIRECTORY = new URL("dist/public/assets/", ROOT);
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const classMatch = PAGE_SOURCE.match(/data-testid=\{`command-centre-kpi-\$\{id\}`\}[\s\S]{0,240}?className="([^"]+)"/);
if (!classMatch) throw new Error("Unable to resolve the shipped Command Centre KPI-card classes");

const candidateClass = classMatch[1];
if (!candidateClass.includes("min-w-0") || !candidateClass.includes("[overflow-wrap:anywhere]")) {
  throw new Error("KPI cards must retain both intrinsic-width containment rules");
}
const preFixClass = candidateClass.replace(" min-w-0", "").replace(" [overflow-wrap:anywhere]", "");

const cssFiles = readdirSync(CSS_DIRECTORY).filter((name) => /^index-.*\.css$/.test(name));
if (cssFiles.length !== 1) {
  throw new Error(`Expected one production index CSS asset; run npm run build first (found ${cssFiles.length})`);
}
const css = readFileSync(new URL(cssFiles[0], CSS_DIRECTORY), "utf8");
const chrome = CHROME_CANDIDATES.find((path) => {
  try {
    execFileSync("test", ["-x", path]);
    return true;
  } catch {
    return false;
  }
});
if (!chrome) throw new Error("A local Chrome/Chromium binary is required for the mobile layout gate");

const hostileToken = "SUBMISSION_STATUS_VOCABULARY_UNKNOWN_WITH_AN_UNBROKEN_CANONICAL_SOURCE_IDENTIFIER";
const tempDirectory = mkdtempSync(join(tmpdir(), "mintvault-command-centre-layout-"));
let browserClosureConfirmed = true;
const cancellation = new AbortController();
const onSignal = () => cancellation.abort(new Error("Browser proof cancelled"));
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

async function proveRuntime(send, sessionId) {
  const checks = [];
  const passed = (name) => checks.push({ name, status: "passed" });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error("Browser evaluation failed (values intentionally not logged)");
    return result.result.value;
  };
  const until = async (expression, label) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Browser did not reach ${label}`);
  };
  const fill = async (testId, value) => {
    if (!value || value.length < 8) throw new Error("Synthetic browser credential fixture is missing");
    await evaluate(`(() => { const input = document.querySelector('[data-testid="${testId}"]');
      if (!input) throw new Error('missing input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  const click = async (testId) => {
    await until(
      `(() => {const b=document.querySelector('[data-testid="${testId}"]'); return b && !b.disabled;})()`,
      testId
    );
    await evaluate(`document.querySelector('[data-testid="${testId}"]').click()`);
  };
  await send("Page.navigate", { url: `${runtimeUrl}admin/login?next=%2Fadmin%2Fcommand` }, sessionId);
  await until("!!document.querySelector('[data-testid=\"input-admin-password\"]')", "rendered login");
  passed("rendered-login");
  await fill("input-admin-password", process.env.MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PASSWORD);
  await click("button-admin-login");
  await until("!!document.querySelector('[data-testid=\"input-admin-pin\"]')", "rendered PIN");
  passed("rendered-pin");
  await fill("input-admin-pin", process.env.MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PIN);
  await click("button-admin-pin-submit");
  await until(
    "location.pathname === '/admin/command' && !!document.querySelector('[data-testid=\"command-centre-page\"]') && !!document.querySelector('[data-testid^=\"command-centre-kpi-\"]')",
    "rendered Command Centre with data"
  );
  passed("rendered-command-centre");
  const dashboard = await evaluate(
    "fetch('/api/admin/command/dashboard', { credentials: 'include' }).then(async r => ({status:r.status, body:await r.json()}))"
  );
  if (
    dashboard.body?.kpis?.["non-terminal-submissions"]?.status !== "VALUE" ||
    dashboard.body.kpis["non-terminal-submissions"].value !== 1
  )
    throw new Error("Browser dashboard did not report the seeded non-terminal submission");
  if (
    dashboard.status !== 200 ||
    !dashboard.body ||
    !Array.isArray(dashboard.body.registry) ||
    !dashboard.body.registry.length
  )
    throw new Error("Authenticated browser dashboard response is missing authoritative data");
  passed("authenticated-dashboard");
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: 320, height: 700, deviceScaleFactor: 1, mobile: false },
    sessionId
  );
  await until("innerWidth === 320", "320px viewport");
  const geometry =
    await evaluate(`(() => { const cards = [...document.querySelectorAll('[data-testid^="command-centre-kpi-"]')];
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      cards: cards.filter(x => x.tagName === 'A').map(x => ({width:x.getBoundingClientRect().width,
        parentWidth:x.parentElement.getBoundingClientRect().width, minWidth:getComputedStyle(x).minWidth, wrap:getComputedStyle(x).overflowWrap})) }; })()`);
  if (
    !geometry.cards.length ||
    geometry.scrollWidth > geometry.width ||
    geometry.cards.some((c) => c.width > c.parentWidth + 1 || c.minWidth !== "0px" || c.wrap !== "anywhere")
  )
    throw new Error(`Rendered mobile containment failed: ${JSON.stringify(geometry)}`);
  passed("mobile-containment");
  await click("button-logout");
  await until(
    "location.pathname === '/admin/login' && !!document.querySelector('[data-testid=\"input-admin-password\"]')",
    "rendered logout"
  );
  passed("rendered-logout");
  const status = await evaluate("fetch('/api/admin/command/dashboard', { credentials:'include' }).then(r => r.status)");
  if (status !== 401) throw new Error(`Logged-out browser retained dashboard access (${status})`);
  passed("post-logout-refusal");
  if (!ADMIN_BROWSER_PROOF_CHECKS.every((name, index) => checks[index]?.name === name))
    throw new Error("Incomplete browser proof");
  const version = await send("Browser.getVersion");
  return {
    schemaVersion: 1,
    runId: process.env.MINTVAULT_BROWSER_PROOF_RUN_ID,
    url: runtimeUrl.href,
    browser: version.product,
    passed: checks.length,
    failed: 0,
    skipped: 0,
    checks,
  };
}

async function render(className, label) {
  if (!browserClosureConfirmed) throw new Error("Previous browser closure unknown");
  cancellation.signal.throwIfAborted();
  const path = join(tempDirectory, `${label}.html`);
  const profileDirectory = join(tempDirectory, `${label}-chrome-profile`);
  writeFileSync(
    path,
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body class="m-0"><main class="w-screen px-4"><section class="p-4"><div id="grid" class="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><a id="card" class="${className}"><h4>Non-terminal submissions</h4><p>${hostileToken}</p><p>Source: ${hostileToken}</p></a></div></section></main><pre id="result"></pre>
<script>requestAnimationFrame(()=>{const card=document.querySelector('#card').getBoundingClientRect();const grid=document.querySelector('#grid').getBoundingClientRect();document.querySelector('#result').textContent=JSON.stringify({innerWidth,documentScrollWidth:document.documentElement.scrollWidth,gridRight:grid.right,cardRight:card.right,cardWidth:card.width,minWidth:getComputedStyle(document.querySelector('#card')).minWidth,overflowWrap:getComputedStyle(document.querySelector('#card')).overflowWrap})})</script></body></html>`
  );
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  browserClosureConfirmed = false;
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  if (runtimeProof) console.log(`COMMAND_CENTRE_BROWSER_CHILD_PID=${child.pid}`);
  let socket;
  const pending = new Map();
  const cancelPending = () => {
    for (const handler of pending.values()) {
      clearTimeout(handler.timeout);
      handler.reject(new Error("Browser proof interrupted"));
    }
    pending.clear();
    if (socket) socket.terminate();
  };
  cancellation.signal.addEventListener("abort", cancelPending);
  try {
    const debuggerUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Chrome did not expose CDP for ${label}`)), 10_000);
      const abort = () => {
        clearTimeout(timeout);
        reject(new Error("Browser startup cancelled"));
      };
      cancellation.signal.addEventListener("abort", abort, { once: true });
      if (cancellation.signal.aborted) abort();
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        const match = chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          cancellation.signal.removeEventListener("abort", abort);
          resolve(match[1]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited before ${label} layout capture (code ${code})`));
      });
    });
    socket = new WebSocket(debuggerUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("CDP connection timed out"));
      }, 10_000);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP connection failed"));
      });
    });
    let nextId = 0;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) return;
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      clearTimeout(handler.timeout);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        cancellation.signal.throwIfAborted();
        const id = ++nextId;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 15_000);
        pending.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    if (runtimeProof) {
      // The test browser may only reach its own app. Do not load remote fonts,
      // analytics or any provider URL discovered in the rendered application.
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.method !== "Fetch.requestPaused" || event.sessionId !== sessionId) return;
        const allowed = new URL(event.params.request.url).origin === runtimeUrl.origin;
        void send(
          allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
          {
            requestId: event.params.requestId,
            ...(!allowed ? { errorReason: "BlockedByClient" } : {}),
          },
          sessionId
        ).catch(() => {});
      });
      await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
      return await proveRuntime(send, sessionId);
    }
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: 320, height: 700, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    await send("Page.navigate", { url: pathToFileURL(path).href }, sessionId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const evaluation = await send(
        "Runtime.evaluate",
        { expression: "document.querySelector('#result')?.textContent || ''", returnByValue: true },
        sessionId
      );
      if (evaluation.result.value) return JSON.parse(evaluation.result.value);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Chrome did not emit ${label} geometry`);
  } finally {
    cancellation.signal.removeEventListener("abort", cancelPending);
    cancelPending();
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    browserClosureConfirmed = await stopOwnedChild(child, { closed });
  }
}

try {
  if (runtimeProof) {
    const report = await render(candidateClass, "runtime-proof");
    if (!browserClosureConfirmed) throw new Error("Browser closure unknown; retain owned runtime resources");
    cancellation.signal.throwIfAborted();
    writeFileSync(reportPath, JSON.stringify(report));
  } else {
    const control = await render(preFixClass, "pre-fix-control");
    const candidate = await render(candidateClass, "candidate");
    if (!browserClosureConfirmed) throw new Error("Browser closure unknown; retain owned runtime resources");
    if (!(control.cardRight > control.gridRight && control.documentScrollWidth > control.innerWidth)) {
      throw new Error(`Pre-fix control did not reproduce the overflow: ${JSON.stringify(control)}`);
    }
    if (candidate.cardRight > candidate.gridRight || candidate.documentScrollWidth > candidate.innerWidth) {
      throw new Error(`Candidate overflows at 320px: ${JSON.stringify(candidate)}`);
    }
    if (candidate.minWidth !== "0px" || candidate.overflowWrap !== "anywhere") {
      throw new Error(`Candidate containment CSS is not active: ${JSON.stringify(candidate)}`);
    }
    process.stdout.write(`${JSON.stringify({ viewport: 320, control, candidate })}\n`);
  }
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  if (browserClosureConfirmed) rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  else {
    console.error(`Retained browser profile: ${tempDirectory}`);
    process.exit(75);
  }
}
