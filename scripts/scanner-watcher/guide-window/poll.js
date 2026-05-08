/**
 * Renderer-side poller. setInterval 1000ms, reads watcher-state.json via
 * the IPC bridge from preload.js, and swaps the panel HTML to match.
 *
 * No framework — vanilla DOM. Element refs cached at startup; per-tick
 * cost is just a few innerText writes + a className swap.
 */

const POLL_MS = 1000;
const SUCCESS_FLASH_MS = 1500;

const els = {
  panel:    document.getElementById("panel"),
  icon:     document.getElementById("icon"),
  bigText:  document.getElementById("bigText"),
  subtext:  document.getElementById("subtext"),
  meta:     document.getElementById("meta"),
  buttons:  document.getElementById("buttons"),
  footer:   document.getElementById("footer"),
  updated:  document.getElementById("updated"),
  hideBtn:  document.getElementById("hideBtn"),
};

// × in the drag strip — hide the window. Process keeps running; show
// again from SwiftBar dropdown or by clicking the dock icon.
els.hideBtn.addEventListener("click", () => {
  window.guide.hide();
});

let busy = false;       // disable buttons while a control fetch is in flight

function setPanelClass(state) {
  els.panel.className = `panel state-${state || "loading"}`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleTimeString(); } catch { return "—"; }
}

function setButtons(buttonDefs) {
  els.buttons.innerHTML = "";
  for (const def of buttonDefs) {
    const b = document.createElement("button");
    b.textContent = def.label;
    if (def.variant === "danger") b.classList.add("danger");
    if (def.variant === "primary") b.classList.add("primary");
    if (busy) b.disabled = true;
    b.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      b.disabled = true;
      try {
        const r = await window.guide.control(def.action);
        if (!r.ok) {
          // Flash a footer warning for 3s; tick will overwrite shortly.
          els.footer.innerHTML = `<span class="warn">control failed: ${r.error || "HTTP " + r.status}</span>`;
        }
      } finally {
        busy = false;
      }
    });
    els.buttons.appendChild(b);
  }
}

async function tick() {
  const r = await window.guide.readState();
  if (!r.ok) {
    setPanelClass("loading");
    els.icon.textContent    = "⏳";
    els.bigText.textContent = "WATCHER OFFLINE";
    els.subtext.textContent = r.error === "no-state-file"
      ? "watcher-state.json not found — start the watcher"
      : `state read error: ${r.error}`;
    els.meta.textContent    = "";
    els.buttons.innerHTML   = "";
    els.footer.innerHTML    = `<span class="err">No connection to watcher</span>`;
    els.updated.textContent = "";
    return;
  }

  const s = r.state;
  els.updated.textContent = fmtTime(s.updated_at);

  // Footer is constant per tick — last cert + session count + ingest target.
  const targetLabel = s.ingest_url && s.ingest_url.includes("mintvault-v2")
    ? `<span class="warn">STAGING</span>`
    : `<span class="ok">prod</span>`;
  const lastCert = s.last_uploaded_cert || s.last_cert || "—";
  const session  = (typeof s.session_paired_count === "number" ? s.session_paired_count : 0);
  els.footer.innerHTML = `<span>✓ Last: ${lastCert}</span><span>${session} this session</span><span>${targetLabel}</span>`;

  switch (s.state) {
    case "idle": {
      setPanelClass("idle");
      els.icon.textContent    = "📷";
      els.bigText.textContent = "SCAN FRONT";
      const next = s.next_cert_guess || "—";
      els.subtext.textContent = `Cert ${next}`;
      els.meta.textContent    = "";
      setButtons([]);
      break;
    }

    case "front_buffered": {
      setPanelClass("front_buffered");
      els.icon.textContent    = "✅";
      els.bigText.textContent = "FRONT CAPTURED";
      els.subtext.textContent = "Now scan BACK";
      els.meta.textContent    = s.buffered_front_name ? `📄 ${s.buffered_front_name}` : "";
      setButtons([
        { label: "Reset card",        action: "reset",              variant: "danger" },
        { label: "Upload front-only", action: "upload-front-only" },
      ]);
      break;
    }

    case "uploading": {
      setPanelClass("uploading");
      els.icon.textContent    = "⬆";
      els.bigText.textContent = "UPLOADING";
      els.subtext.textContent = "Pairing front + back…";
      els.meta.textContent    = "";
      setButtons([]);
      break;
    }

    case "success": {
      setPanelClass("success");
      els.icon.textContent    = "✓";
      els.bigText.textContent = `${s.last_uploaded_cert || s.last_cert || "MV"} CREATED`;
      els.subtext.textContent = "Saved to vault — AI grading queued";
      els.meta.textContent    = "";
      setButtons([]);
      break;
    }

    case "error": {
      setPanelClass("error");
      els.icon.textContent    = "⚠";
      els.bigText.textContent = "UPLOAD FAILED";
      const errShort = (s.last_error || "").slice(0, 80);
      els.subtext.textContent = errShort || "see watcher.log";
      els.meta.textContent    = "";
      setButtons([
        { label: "Retry", action: "retry", variant: "primary" },
      ]);
      break;
    }

    default: {
      setPanelClass("loading");
      els.icon.textContent    = "❓";
      els.bigText.textContent = (s.state || "UNKNOWN").toUpperCase();
      els.subtext.textContent = "";
      els.meta.textContent    = "";
      setButtons([]);
    }
  }
}

// Kick immediately so the loading placeholder is replaced fast, then poll.
tick();
setInterval(tick, POLL_MS);
