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

const TOOLS_DIR = path.join(os.homedir(), ".mintvault-scanner-tools");
const POSITION_FILE  = path.join(TOOLS_DIR, "guide-window-position.json");
const VISIBLE_FILE   = path.join(TOOLS_DIR, "guide-visible.json");
const STATE_FILE = path.join(os.homedir(), "mintvault-scans", "watcher-state.json");
const CONTROL_PORT_DEFAULT = 54871;
const VISIBILITY_PORT = 54872;

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
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    fs.writeFileSync(POSITION_FILE, JSON.stringify(pos, null, 2));
  } catch (err) {
    console.warn("[guide] could not persist position:", err.message);
  }
}

// ── Visibility persistence ───────────────────────────────────────────────
// Single source of truth for whether the window is currently shown. Read
// by the SwiftBar plugin (cheap stat call) so it can flip "Show / Hide"
// labels. Default = visible; missing file = first run = visible.
function loadVisible() {
  try {
    const v = JSON.parse(fs.readFileSync(VISIBLE_FILE, "utf8"));
    return v.visible !== false;
  } catch {
    return true;
  }
}
function saveVisible(visible) {
  try {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    fs.writeFileSync(VISIBLE_FILE, JSON.stringify({
      visible,
      updated_at: new Date().toISOString(),
      visibility_port: VISIBILITY_PORT,
    }, null, 2));
  } catch (err) {
    console.warn("[guide] could not persist visibility:", err.message);
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

  // If last session ended hidden, respect that and start hidden. We still
  // create the window (so .show() works instantly later); we just don't
  // map it on screen until something asks.
  if (!loadVisible()) {
    mainWindow.hide();
  } else {
    saveVisible(true);
  }

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
  mainWindow.on("show", () => saveVisible(true));
  mainWindow.on("hide", () => saveVisible(false));
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── Show / hide helpers ─────────────────────────────────────────────────
// Always pin alwaysOnTop after show — macOS sometimes drops the flag
// when re-showing a hidden window into a different space.
function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true, "floating");
}
function hideWindow() {
  if (!mainWindow) return;
  mainWindow.hide();
}
function isWindowVisible() {
  return !!mainWindow && mainWindow.isVisible();
}

// ── IPC: state polling + control POSTs ───────────────────────────────────
// The renderer asks main for the current state every second. Main reads
// the state file directly (avoids exposing fs to the renderer) and
// proxies control POSTs to the watcher's loopback HTTP server.

ipcMain.handle("guide:hide", async () => {
  hideWindow();
  return { ok: true };
});

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

// ── Visibility HTTP server (loopback only) ───────────────────────────────
// SwiftBar plugin and any other local tooling can flip the window via:
//   POST 127.0.0.1:54872/show
//   POST 127.0.0.1:54872/hide
//   POST 127.0.0.1:54872/toggle
//   GET  127.0.0.1:54872/visible    → { visible: true|false }
// No auth — loopback bind only, single-user machine.

function startVisibilityServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/visible") {
        res.statusCode = 200;
        res.end(JSON.stringify({ visible: isWindowVisible() }));
        return;
      }
      if (req.method !== "POST") {
        res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: "POST only" })); return;
      }
      switch (url.pathname) {
        case "/show":   showWindow(); res.statusCode = 200; res.end(JSON.stringify({ ok: true, visible: true  })); return;
        case "/hide":   hideWindow(); res.statusCode = 200; res.end(JSON.stringify({ ok: true, visible: false })); return;
        case "/toggle":
          if (isWindowVisible()) hideWindow(); else showWindow();
          res.statusCode = 200; res.end(JSON.stringify({ ok: true, visible: isWindowVisible() })); return;
        default:
          res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: "not found" })); return;
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }
  });
  server.on("error", err => console.warn("[guide] visibility server error:", err.message));
  server.listen(VISIBILITY_PORT, "127.0.0.1", () => {
    console.log(`[guide] visibility server listening on 127.0.0.1:${VISIBILITY_PORT}`);
  });
  return server;
}

// ── App lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  startVisibilityServer();
  // Dock-icon click on macOS: if no windows are open OR the window is
  // hidden, bring it back. This makes the dock icon a free toggle —
  // operator who hid the window can click the dock to restore.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isVisible()) {
      showWindow();
    }
  });
});

// Keep running on macOS even with no window (so Cmd+W doesn't quit). The
// LaunchAgent restarts the process anyway, but this avoids a one-second
// flash if the operator clicks the (rare) close button.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
