/**
 * MintVault Scanner Guide — Electron main process.
 *
 * One BrowserWindow, frameless, always-on-top, ~420×320, with a tiny
 * draggable header strip baked into the HTML. Position is persisted to
 * ~/.mintvault-scanner-tools/guide-window-position.json so the operator's
 * preferred corner sticks across launches.
 *
 * No menu, no devtools surface (pressing Cmd+Opt+I still works for debug
 * since we don't disable it explicitly — that's fine for an internal
 * tool). Single-window app: hide-on-close-button just hides; quit via
 * Cmd+Q or via launchctl bootout.
 */

const { app, BrowserWindow, screen, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const POSITION_DIR = path.join(os.homedir(), ".mintvault-scanner-tools");
const POSITION_FILE = path.join(POSITION_DIR, "guide-window-position.json");
const STATE_FILE = path.join(os.homedir(), "mintvault-scans", "watcher-state.json");
const CONTROL_PORT_DEFAULT = 54871;

// ── Position persistence ─────────────────────────────────────────────────
function loadPosition() {
  try {
    return JSON.parse(fs.readFileSync(POSITION_FILE, "utf8"));
  } catch {
    return null;
  }
}

function savePosition(pos) {
  try {
    fs.mkdirSync(POSITION_DIR, { recursive: true });
    fs.writeFileSync(POSITION_FILE, JSON.stringify(pos, null, 2));
  } catch (err) {
    console.warn("[guide] could not persist position:", err.message);
  }
}

// Default to top-right of the primary display, with a small margin.
function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - 420 - 24,
    y: workArea.y + 24,
    width: 420,
    height: 320,
  };
}

let mainWindow = null;

function createWindow() {
  const pos = loadPosition() || defaultPosition();
  mainWindow = new BrowserWindow({
    x: pos.x, y: pos.y,
    width: pos.width || 420,
    height: pos.height || 320,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: "MintVault Scanner Guide",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Pin above other floating panels too (notifications, native popovers).
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Persist position on move + size changes.
  let saveTimer = null;
  function debounceSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const [x, y] = mainWindow.getPosition();
      const [width, height] = mainWindow.getSize();
      savePosition({ x, y, width, height });
    }, 400);
  }
  mainWindow.on("move", debounceSave);
  mainWindow.on("resize", debounceSave);
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── IPC: state polling + control POSTs ───────────────────────────────────
// The renderer asks main for the current state every second. Main reads
// the state file directly (avoids exposing fs to the renderer) and
// proxies control POSTs to the watcher's loopback HTTP server.

ipcMain.handle("guide:read-state", async () => {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return { ok: true, state: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.code === "ENOENT" ? "no-state-file" : err.message };
  }
});

ipcMain.handle("guide:control", async (_evt, action) => {
  const allowed = ["reset", "upload-front-only", "retry"];
  if (!allowed.includes(action)) return { ok: false, error: `unknown action: ${action}` };

  // Pick up the watcher's actual port from state if available, else default.
  let port = CONTROL_PORT_DEFAULT;
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s.control_port) port = s.control_port;
  } catch {}

  return new Promise((resolve) => {
    const req = http.request({
      method: "POST",
      hostname: "127.0.0.1",
      port,
      path: `/control/${action}`,
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body: parsed });
      });
    });
    req.on("error", err => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
});

// ── App lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Keep running on macOS even with no window (so Cmd+W doesn't quit). The
// LaunchAgent restarts the process anyway, but this avoids a one-second
// flash if the operator clicks the (rare) close button.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
