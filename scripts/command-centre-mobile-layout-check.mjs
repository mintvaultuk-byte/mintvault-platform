import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

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

const classMatch = PAGE_SOURCE.match(
  /data-testid=\{`command-centre-kpi-\$\{id\}`\}[\s\S]{0,240}?className="([^"]+)"/
);
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

async function render(className, label) {
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
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let socket;
  try {
    const debuggerUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Chrome did not expose CDP for ${label}`)), 10_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        const match = chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
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
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    let nextId = 0;
    const pending = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) return;
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
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
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }
}

try {
  const control = await render(preFixClass, "pre-fix-control");
  const candidate = await render(candidateClass, "candidate");
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
} finally {
  rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
