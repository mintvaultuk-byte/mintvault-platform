/**
 * Renderer-side poller. setInterval 1000ms, reads watcher-state.json via
 * the IPC bridge from preload.js, and swaps the panel HTML to match.
 *
 * No framework — vanilla DOM. Element refs cached at startup; per-tick
 * cost is just a few innerText writes + a className swap.
 */

const POLL_MS = 1000;
const PREVIEW_DEBOUNCE_MS = 300;

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
  // Modal
  modal:        document.getElementById("manualModal"),
  modalCert:    document.getElementById("manualCert"),
  modalPreview: document.getElementById("manualPreview"),
  modalReplace: document.getElementById("manualReplace"),
  modalReplaceWrap: document.getElementById("manualReplaceWrap"),
  modalSubmit:  document.getElementById("manualSubmit"),
  modalCancel:  document.getElementById("manualCancel"),
  modalClose:   document.getElementById("manualClose"),
};

// × in the drag strip — hide the window. Process keeps running; show
// again from SwiftBar dropdown or by clicking the dock icon.
els.hideBtn.addEventListener("click", () => {
  window.guide.hide();
});

let busy = false;       // disable buttons while a control fetch is in flight
let lastPreview = null; // last successful preview payload (for submit validation)

// ── Modal state + behaviour ─────────────────────────────────────────────

function openModal() {
  els.modal.classList.add("visible");
  els.modalCert.value = "";
  els.modalPreview.textContent = "";
  els.modalPreview.className = "preview";
  els.modalReplace.checked = false;
  els.modalReplaceWrap.classList.remove("warn");
  els.modalSubmit.disabled = true;
  // Default side back (most common gap), HTML radio already checked
  document.querySelectorAll('input[name="manualSide"]').forEach(r => {
    r.checked = r.value === "back";
  });
  lastPreview = null;
  setTimeout(() => els.modalCert.focus(), 50);
}

function closeModal() {
  els.modal.classList.remove("visible");
}

let previewTimer = null;
async function updatePreview() {
  const raw = els.modalCert.value.trim().toUpperCase();
  if (!/^MV\d+$/.test(raw)) {
    els.modalPreview.textContent = raw ? "Format: MV###" : "";
    els.modalPreview.className = "preview";
    els.modalSubmit.disabled = true;
    lastPreview = null;
    return;
  }

  els.modalPreview.textContent = "Looking up…";
  els.modalPreview.className = "preview";

  const r = await window.guide.certPreview(raw);
  if (!r.ok) {
    els.modalPreview.textContent = r.body?.error || `Lookup failed (HTTP ${r.status})`;
    els.modalPreview.className = "preview error";
    els.modalSubmit.disabled = true;
    lastPreview = null;
    return;
  }

  const p = r.body;
  lastPreview = p;
  const side = (document.querySelector('input[name="manualSide"]:checked') || {}).value || "back";
  const sideHas = side === "front" ? p.has_front : p.has_back;
  const otherHas = side === "front" ? p.has_back : p.has_front;

  // Surface "Replace existing" warning when the targeted side is occupied.
  if (sideHas) {
    els.modalReplaceWrap.classList.add("warn");
  } else {
    els.modalReplaceWrap.classList.remove("warn");
    els.modalReplace.checked = false;
  }

  const fronty = p.has_front ? "✓" : "✗ missing";
  const backy  = p.has_back  ? "✓" : "✗ missing";
  const card   = p.card_name || "(unidentified)";
  els.modalPreview.innerHTML =
    `<strong>${p.cert_id}</strong> — ${card}` +
    `<br>front: ${fronty} · back: ${backy}` +
    (p.deleted ? "<br><strong>SOFT-DELETED</strong>" : "");
  els.modalPreview.className = "preview ok";

  // Submit allowed when target side is empty OR replace_existing is checked.
  els.modalSubmit.disabled = sideHas && !els.modalReplace.checked;
  void otherHas; // referenced for clarity; submit gating cares only about target side
}

els.modalCert.addEventListener("input", () => {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, PREVIEW_DEBOUNCE_MS);
});
document.querySelectorAll('input[name="manualSide"]').forEach(r => {
  r.addEventListener("change", updatePreview);
});
els.modalReplace.addEventListener("change", updatePreview);
els.modalCancel.addEventListener("click", closeModal);
els.modalClose.addEventListener("click", closeModal);
els.modal.addEventListener("click", (e) => { if (e.target === els.modal) closeModal(); });

els.modalSubmit.addEventListener("click", async () => {
  if (els.modalSubmit.disabled || !lastPreview) return;
  const certId = lastPreview.cert_id;
  const side = (document.querySelector('input[name="manualSide"]:checked') || {}).value || "back";
  const replaceExisting = !!els.modalReplace.checked;
  els.modalSubmit.disabled = true;
  els.modalSubmit.textContent = "Arming…";
  const r = await window.guide.manualMode({ certId, side, replaceExisting });
  els.modalSubmit.textContent = "Wait for next scan";
  if (!r.ok) {
    els.modalPreview.textContent = `Arm failed: ${r.body?.error || r.error || "unknown"}`;
    els.modalPreview.className = "preview error";
    els.modalSubmit.disabled = false;
    return;
  }
  closeModal();
});

// ── Panel rendering ─────────────────────────────────────────────────────

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
      // Confirm dialog for destructive secondary actions
      if (def.confirm && !window.confirm(def.confirm)) return;
      busy = true;
      b.disabled = true;
      try {
        const r = await window.guide.control(def.action);
        if (!r.ok) {
          els.footer.innerHTML = `<span class="warn">control failed: ${r.body?.error || r.error || "HTTP " + r.status}</span>`;
        }
      } finally {
        busy = false;
      }
    });
    els.buttons.appendChild(b);
  }
}

// "..." overflow menu — used to demote Upload-Front-Only behind a confirm
// step. Operator already misclicked the primary button once → orphan MV59.
function appendMoreMenu(items) {
  const wrap = document.createElement("div");
  wrap.className = "more-wrap";
  const btn = document.createElement("button");
  btn.className = "more-btn";
  btn.textContent = "…";
  btn.title = "More options";
  const pop = document.createElement("div");
  pop.className = "more-popover";
  for (const it of items) {
    const b = document.createElement("button");
    b.textContent = it.label;
    b.addEventListener("click", async () => {
      pop.classList.remove("open");
      if (it.confirm && !window.confirm(it.confirm)) return;
      busy = true;
      try {
        const r = await window.guide.control(it.action);
        if (!r.ok) {
          els.footer.innerHTML = `<span class="warn">control failed: ${r.body?.error || r.error || "HTTP " + r.status}</span>`;
        }
      } finally {
        busy = false;
      }
    });
    pop.appendChild(b);
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.classList.toggle("open");
  });
  document.addEventListener("click", () => pop.classList.remove("open"), { once: true });
  wrap.appendChild(btn);
  wrap.appendChild(pop);
  els.buttons.appendChild(wrap);
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

  // Footer is constant per tick — last cert + session count + ingest target
  // + Manual Mode link (small, secondary).
  const targetLabel = s.ingest_url && s.ingest_url.includes("mintvault-v2")
    ? `<span class="warn">STAGING</span>`
    : `<span class="ok">prod</span>`;
  const lastCert = s.last_uploaded_cert || s.last_cert || "—";
  const session  = (typeof s.session_paired_count === "number" ? s.session_paired_count : 0);
  els.footer.innerHTML =
    `<span>✓ Last: ${lastCert}</span>` +
    `<span>${session} this session</span>` +
    `<span>${targetLabel}</span>` +
    `<button class="footer-link" id="manualLink" title="Attach a missing scan to a specific cert">manual mode</button>`;
  const ml = document.getElementById("manualLink");
  if (ml) ml.addEventListener("click", openModal);

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
      // Reassurance under the subtext — there's no timer, the operator
      // doesn't need to rush. Counters the "I have to upload-front-only
      // before time runs out" misread that produced MV59.
      els.meta.innerHTML = (s.buffered_front_name ? `📄 ${s.buffered_front_name}` : "") +
        `<div class="reassurance">No timer — take your time</div>`;
      // Primary: only Reset card. Upload-front-only demoted to "..." menu
      // with a confirm prompt to defuse the misclick footgun.
      setButtons([
        { label: "Reset card", action: "reset", variant: "danger" },
      ]);
      appendMoreMenu([
        {
          label: "Upload front-only (no back)",
          action: "upload-front-only",
          confirm: "Upload this card with NO back scan? The cert will be created front-only and you'll need to attach the back later via Manual Mode.",
        },
      ]);
      break;
    }

    case "uploading": {
      setPanelClass("uploading");
      els.icon.textContent    = "⬆";
      els.bigText.textContent = "UPLOADING";
      els.subtext.textContent = s.manual_pending
        ? `Attaching to ${s.manual_pending.certId} ${s.manual_pending.side.toUpperCase()}…`
        : "Pairing front + back…";
      els.meta.textContent    = "";
      setButtons([]);
      break;
    }

    case "manual_pending": {
      setPanelClass("manual_pending");
      els.icon.textContent    = "⏸";
      const mp = s.manual_pending || {};
      els.bigText.textContent = "WAITING FOR SCAN";
      els.subtext.textContent = mp.certId
        ? `Will attach to ${mp.certId} ${(mp.side || "").toUpperCase()}${mp.replaceExisting ? " (replace)" : ""}`
        : "Manual mode armed";
      els.meta.textContent    = "";
      setButtons([
        { label: "Cancel manual mode", action: "cancel-manual", variant: "danger" },
      ]);
      break;
    }

    case "success": {
      setPanelClass("success");
      els.icon.textContent    = "✓";
      const cert = s.last_uploaded_cert || s.last_cert || "MV";
      els.bigText.textContent = `${cert} READY`;
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
