/**
 * Renderer logic for the popover. Vanilla JS — no framework. State comes
 * in via IPC pushes; user actions go out via the same channel. Modals are
 * plain divs toggled with .visible.
 */

const els = {
  // Header
  hideBtn:    document.getElementById("hideBtn"),
  restartBtn: document.getElementById("restartBtn"),

  // Mode segmented control
  modeBtns:   Array.from(document.querySelectorAll(".seg-btn")),

  // Stats
  nextCert:   document.getElementById("nextCert"),
  lastScan:   document.getElementById("lastScan"),
  session:    document.getElementById("session"),

  // Status
  dot:        document.getElementById("dot"),
  statusText: document.getElementById("statusText"),
  statusSub:  document.getElementById("statusSub"),

  // Recent
  recentList: document.getElementById("recentList"),

  // Actions
  orphansBtn:  document.getElementById("orphansBtn"),
  forwardBtn:  document.getElementById("forwardBtn"),
  inboxBtn:    document.getElementById("inboxBtn"),
  lastCertBtn: document.getElementById("lastCertBtn"),
  logsBtn:     document.getElementById("logsBtn"),

  // SilverFast export path
  sfPathVal:     document.getElementById("sfPathVal"),
  sfPathCopyBtn: document.getElementById("sfPathCopyBtn"),

  // Manual scan modal
  manualModal:  document.getElementById("manualModal"),
  manualMeta:   document.getElementById("manualMeta"),
  manualCert:   document.getElementById("manualCert"),
  manualReplace:document.getElementById("manualReplace"),
  manualSubmit: document.getElementById("manualSubmit"),
  manualCancel: document.getElementById("manualCancel"),

  // Orphan picker
  orphanModal: document.getElementById("orphanModal"),
  orphanList:  document.getElementById("orphanList"),
  orphanClose: document.getElementById("orphanClose"),

  // Forward-to-cert
  forwardModal:      document.getElementById("forwardModal"),
  forwardServerNext: document.getElementById("forwardServerNext"),
  forwardCert:       document.getElementById("forwardCert"),
  forwardCancel:     document.getElementById("forwardCancel"),
  forwardApply:      document.getElementById("forwardApply"),

  // Scan confirmation (blocking)
  confirmModal: document.getElementById("confirmModal"),
  confirmImg:   document.getElementById("confirmImg"),
  confirmImgPlaceholder: document.getElementById("confirmImgPlaceholder"),
  confirmLabel: document.getElementById("confirmLabel"),
  confirmCert:  document.getElementById("confirmCert"),
  confirmNote:  document.getElementById("confirmNote"),
  confirmOk:    document.getElementById("confirmOk"),

  // Soft-delete confirm
  deleteModal:   document.getElementById("deleteModal"),
  deleteCertId:  document.getElementById("deleteCertId"),
  deleteReason:  document.getElementById("deleteReason"),
  deleteCancel:  document.getElementById("deleteCancel"),
  deleteConfirm: document.getElementById("deleteConfirm"),

  // Pause + Settings + Test scan (toggles QoL pack)
  pauseBtn:        document.getElementById("pauseBtn"),
  settingsToggle:  document.getElementById("settingsToggle"),
  settingsBody:    document.getElementById("settingsBody"),
  autoOpenOnError: document.getElementById("autoOpenOnError"),
  soundEnabled:    document.getElementById("soundEnabled"),
  testScanBtn:     document.getElementById("testScanBtn"),
  clearBufferedBtn:document.getElementById("clearBufferedBtn"),
};

// ── Modal helpers ────────────────────────────────────────────────────────

function openModal(m) { m.classList.add("visible"); }
function closeModal(m) { m.classList.remove("visible"); }

// ── State rendering ──────────────────────────────────────────────────────

const STATE_LABELS = {
  idle:           "Idle — waiting for scan",
  front_buffered: "Front captured — scan back",
  uploading:      "Uploading…",
  success:        "Upload succeeded",
  error:          "Upload failed",
  manual_pending: "Manual mode — waiting for scan",
};

function renderState(s) {
  // Mode segmented control
  for (const b of els.modeBtns) {
    b.classList.toggle("active", b.dataset.mode === s.mode);
  }

  // Pause button + status dot precedence: pause masks all other states.
  const paused = s.pausedUntil != null && s.pausedUntil > Date.now();
  els.pauseBtn.textContent = paused ? "Resume" : "Pause";
  els.pauseBtn.classList.toggle("active", paused);

  // Settings checkbox state — fall back to default true if absent.
  if (els.autoOpenOnError) {
    els.autoOpenOnError.checked = s.autoOpenOnError !== false;
  }
  if (els.soundEnabled) {
    els.soundEnabled.checked = s.soundEnabled !== false;
  }

  // Stats — display server prediction unless operator has set an override.
  els.nextCert.textContent = s.nextCertOverride || s.predictedNextCert || "—";
  if (s.recent && s.recent.length > 0) {
    const r = s.recent[0];
    const t = r.ts ? new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    els.lastScan.textContent = `${r.certId} ${r.side.toUpperCase()} · ${t}`;
  } else {
    els.lastScan.textContent = "—";
  }
  els.session.textContent = `${s.sessionPaired || 0} scan${s.sessionPaired === 1 ? "" : "s"}`;

  // Status — paused wins over the underlying state.
  if (paused) {
    els.dot.className = "dot paused";
    els.statusText.textContent = "Paused — clicking will resume";
    const minsLeft = Math.max(0, Math.ceil((s.pausedUntil - Date.now()) / 60_000));
    els.statusSub.textContent = `auto-resume in ${minsLeft} min`;
  } else {
    els.dot.className = `dot ${s.state}`;
    els.statusText.textContent = STATE_LABELS[s.state] || s.state;
    els.statusSub.textContent = (() => {
      if (s.state === "manual_pending" && s.manualPending) {
        return `→ ${s.manualPending.certId} ${s.manualPending.side.toUpperCase()}${s.manualPending.replaceExisting ? " (replace)" : ""}`;
      }
      if (s.state === "error" && s.lastError) return s.lastError.slice(0, 80);
      if (s.state === "front_buffered" && s.bufferedFront) {
        return `${s.bufferedFront.split("/").pop()} buffered — no timer, take your time`;
      }
      return "";
    })();
  }

  // Recent — last 5
  if (s.recent && s.recent.length > 0) {
    els.recentList.innerHTML = s.recent.map(r => {
      const t = r.ts ? new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const tag = r.source && r.source !== "auto" ? `<span class="src">${r.source}</span>` : "";
      return `<li><span>${r.certId} ${r.side}</span><span>${tag} ${t}</span></li>`;
    }).join("");
  } else {
    els.recentList.innerHTML = `<li><span style="color:var(--muted)">No scans yet</span></li>`;
  }

  // Server-next display in forward modal stays fresh while it's open
  els.forwardServerNext.textContent = `Server says next is: ${s.predictedNextCert || "—"}`;

  // Quick-action button: only enabled once a cert has been uploaded.
  // Tooltip surfaces the target cert so the operator knows what they'll open.
  if (els.lastCertBtn) {
    const lastCert = s.lastUploadedCert;
    els.lastCertBtn.disabled = !lastCert;
    els.lastCertBtn.title = lastCert
      ? `Open ${lastCert} logbook page in browser`
      : "No cert uploaded yet this session";
    els.lastCertBtn.textContent = lastCert ? `Open ${lastCert}` : "Open last cert";
  }

  // Scan-confirmation popup — BLOCKING. Shows THIS Mac's ASSIGNED cert number
  // (s.confirmCard.certId, from this Mac's own ingest response), NEVER the
  // global predictedNextCert forecast. Dismissed only by OK (ack-confirm-card).
  if (els.confirmModal) {
    const c = s.confirmCard;
    if (c) {
      if (c.thumb) {
        els.confirmImg.src = c.thumb;
        els.confirmImg.style.display = "";
        if (els.confirmImgPlaceholder) els.confirmImgPlaceholder.style.display = "none";
      } else {
        els.confirmImg.removeAttribute("src");
        els.confirmImg.style.display = "none";
        if (els.confirmImgPlaceholder) els.confirmImgPlaceholder.style.display = "";
      }
      const incomplete = c.status === "incomplete" || !c.certId;
      els.confirmLabel.textContent = incomplete ? "" : "This card is";
      els.confirmCert.textContent = incomplete ? "SCAN INCOMPLETE" : c.certId;
      els.confirmCert.classList.toggle("warn", incomplete);
      els.confirmCert.classList.toggle("pending", !incomplete && c.status === "raw_pending");
      els.confirmNote.textContent = c.note || "";
      // Red note for an incomplete scan OR an unconfirmed front/back (c.warn).
      // The big number stays gold for c.warn — the NUMBER is correct; only the
      // front/back image labelling needs a human glance.
      els.confirmNote.classList.toggle("warn", incomplete || !!c.warn);
      els.confirmOk.textContent = incomplete ? "OK — rescan this card" : "OK — number written, next card";
      openModal(els.confirmModal);
    } else {
      closeModal(els.confirmModal);
    }
  }
}

// ── Header buttons ───────────────────────────────────────────────────────

els.hideBtn.addEventListener("click", () => window.scanner.hidePopover());
els.restartBtn.addEventListener("click", async () => {
  els.restartBtn.disabled = true;
  await window.scanner.getState().then(renderState);
  els.restartBtn.disabled = false;
});

// Scan-confirmation OK — acknowledge, clear the popup, and let the main process
// drain any scans the gate held while it was up (scan-one-write-one).
els.confirmOk.addEventListener("click", async () => {
  // No explicit closeModal here: the state-driven render hides the modal when
  // confirmCard becomes null, and re-opens it if drainInbox surfaces the next
  // held card. An explicit close would race with — and wrongly dismiss — that
  // next confirmation.
  els.confirmOk.disabled = true;
  try {
    await window.scanner.ackConfirmCard();
  } finally {
    els.confirmOk.disabled = false;
  }
});

// ── Mode toggle ──────────────────────────────────────────────────────────

for (const b of els.modeBtns) {
  b.addEventListener("click", async () => {
    const mode = b.dataset.mode;
    await window.scanner.setMode(mode);
  });
}

// ── Manual scan modal — auto-opens when main emits scan-detected ─────────

let pendingScanFile = null;

window.scanner.onScanDetected((evt) => {
  pendingScanFile = evt.filePath;
  const sizeKb = (evt.sizeBytes / 1024).toFixed(0);
  els.manualMeta.textContent = `${evt.filename} (${sizeKb} KB, ${new Date().toLocaleTimeString()})`;
  els.manualCert.value = "";
  els.manualReplace.checked = false;
  // Default to "back" — most common gap when the operator forgot a side
  document.querySelector('input[name="manualSide"][value="back"]').checked = true;
  openModal(els.manualModal);
  setTimeout(() => els.manualCert.focus(), 50);
});

els.manualSubmit.addEventListener("click", async () => {
  // Backward-compatible parse: input is digits-only by design (the static
  // MV prefix lives in HTML), but operators occasionally paste a full
  // "MV58" / "mv 58" / "  MV 58  " from elsewhere. Strip everything
  // that isn't a digit, then re-prefix MV — same result either way.
  const digits = (els.manualCert.value || "").replace(/[^0-9]/g, "");
  if (!digits) {
    els.manualCert.style.borderColor = "var(--red)";
    return;
  }
  const certId = `MV${digits}`;
  const side = (document.querySelector('input[name="manualSide"]:checked') || {}).value || "front";
  const replaceExisting = !!els.manualReplace.checked;
  els.manualSubmit.disabled = true;
  els.manualSubmit.textContent = "Attaching…";
  const r = await window.scanner.attachManualScan({ certId, side, replaceExisting });
  els.manualSubmit.disabled = false;
  els.manualSubmit.textContent = "Attach";
  if (!r?.ok) {
    els.manualMeta.textContent = `Failed: ${r?.error || "unknown"}`;
    return;
  }
  pendingScanFile = null;
  closeModal(els.manualModal);
});

els.manualCancel.addEventListener("click", async () => {
  await window.scanner.attachManualScan({ cancel: true });
  pendingScanFile = null;
  closeModal(els.manualModal);
});

// Live-strip non-digits as the operator types — handles paste of "MV58"
// without the operator having to backspace the prefix.
els.manualCert.addEventListener("input", () => {
  const cleaned = els.manualCert.value.replace(/[^0-9]/g, "");
  if (cleaned !== els.manualCert.value) els.manualCert.value = cleaned;
  els.manualCert.style.borderColor = "";
});

// ── Orphan picker ────────────────────────────────────────────────────────

els.orphansBtn.addEventListener("click", async () => {
  els.orphanList.textContent = "Loading…";
  openModal(els.orphanModal);
  const r = await window.scanner.fetchOrphans();
  if (!r.ok) {
    els.orphanList.innerHTML = `<div style="color:var(--red)">Fetch failed: ${r.body?.error || r.status}</div>`;
    return;
  }
  const orphans = r.body?.orphans || [];
  if (orphans.length === 0) {
    els.orphanList.innerHTML = `<div style="color:var(--muted)">No orphans — every cert has both sides.</div>`;
    return;
  }
  els.orphanList.innerHTML = orphans.map(o => {
    const missing = o.missingFront && o.missingBack ? "no images" :
                    o.missingFront ? "missing front" :
                    o.missingBack  ? "missing back"  : "complete";
    const card = o.cardName || "(empty)";
    const setLine = o.set ? ` · ${o.set}` : "";
    const armSide = o.missingFront ? "front" : "back";
    return `
      <div class="orphan-row" data-cert="${o.certId}" data-side="${armSide}">
        <div class="orphan-info">
          <span class="orphan-id">${o.certId}</span>
          <span class="orphan-meta">${card}${setLine} — ${missing}</span>
        </div>
        <div class="orphan-actions">
          ${o.missingFront || o.missingBack ? `<button class="btn primary" data-action="attach">Attach ${armSide}</button>` : ""}
          <button class="btn danger" data-action="delete">Soft-delete</button>
        </div>
      </div>
    `;
  }).join("");

  els.orphanList.querySelectorAll('[data-action="attach"]').forEach(btn => {
    btn.addEventListener("click", async () => {
      const row    = btn.closest(".orphan-row");
      const certId = row.dataset.cert;
      const side   = row.dataset.side;
      // Orphan-attach defaults replaceExisting=true: the operator has
      // explicitly chosen "Attach back to MVxx" from a list filtered to
      // orphan certs — if the targeted side is somehow already present,
      // they want to overwrite it, not get a 409.
      const r = await window.scanner.armOneShot({ certId, side, replaceExisting: true, fromOrphanPicker: true });
      if (r.ok) {
        closeModal(els.orphanModal);
      } else {
        alert(`Arm failed: ${r.error || "unknown"}`);
      }
    });
  });
  els.orphanList.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const row    = btn.closest(".orphan-row");
      const certId = row.dataset.cert;
      els.deleteCertId.textContent = certId;
      els.deleteReason.value = "";
      openModal(els.deleteModal);
      els.deleteConfirm.dataset.cert = certId;
      setTimeout(() => els.deleteReason.focus(), 50);
    });
  });
});

els.orphanClose.addEventListener("click", () => closeModal(els.orphanModal));

els.deleteCancel.addEventListener("click", () => closeModal(els.deleteModal));
els.deleteConfirm.addEventListener("click", async () => {
  const certId = els.deleteConfirm.dataset.cert;
  const reason = (els.deleteReason.value || "").trim();
  if (reason.length < 10) {
    els.deleteReason.style.borderColor = "var(--red)";
    return;
  }
  els.deleteConfirm.disabled = true;
  const r = await window.scanner.deleteCert({ certId, reason });
  els.deleteConfirm.disabled = false;
  if (!r.ok) {
    alert(`Delete failed: ${r.body?.error || r.error || "unknown"}`);
    return;
  }
  closeModal(els.deleteModal);
  // Refresh orphan list — it'll drop the deleted row
  els.orphansBtn.click();
});

// ── Forward to cert ──────────────────────────────────────────────────────

els.forwardBtn.addEventListener("click", () => {
  els.forwardCert.value = "";
  openModal(els.forwardModal);
  setTimeout(() => els.forwardCert.focus(), 50);
});
els.forwardCancel.addEventListener("click", () => closeModal(els.forwardModal));
els.forwardApply.addEventListener("click", async () => {
  // Backward-compatible parse: input is digits-only by design (the static
  // MV prefix lives in HTML), but operators occasionally paste a full
  // "MV57" / "mv 57" / "  MV 57  " from elsewhere. Strip everything
  // that isn't a digit, then re-prefix MV — same result either way.
  const digits = (els.forwardCert.value || "").replace(/[^0-9]/g, "");
  if (!digits) {
    els.forwardCert.style.borderColor = "var(--red)";
    return;
  }
  const certId = `MV${digits}`;
  const r = await window.scanner.forwardToCert(certId);
  if (!r.ok) {
    alert(`Failed: ${r.error || "unknown"}`);
    return;
  }
  closeModal(els.forwardModal);
});

// Live-strip non-digits as the operator types — handles paste of "MV57"
// without the operator having to backspace the prefix.
els.forwardCert.addEventListener("input", () => {
  const cleaned = els.forwardCert.value.replace(/[^0-9]/g, "");
  if (cleaned !== els.forwardCert.value) els.forwardCert.value = cleaned;
  els.forwardCert.style.borderColor = "";
});

// ── Logs / quick actions ─────────────────────────────────────────────────

els.logsBtn.addEventListener("click", () => window.scanner.openLogs());
els.inboxBtn.addEventListener("click", () => window.scanner.openInbox());
els.lastCertBtn.addEventListener("click", async () => {
  if (els.lastCertBtn.disabled) return;
  await window.scanner.openLastCert();
});

// ── SilverFast export path ───────────────────────────────────────────────
// Show the absolute inbox the watcher is actually watching (respects
// MINTVAULT_SCANS_DIR — comes straight from main's INBOX), with one-click
// copy so the operator can paste it into SilverFast's Path field. This is the
// fix for scans being exported to the wrong folder after a setup/reset.
// Pure display + clipboard — no writes, no behaviour change.
if (els.sfPathVal) {
  window.scanner.getInboxPath().then((p) => {
    els.sfPathVal.textContent = p || "—";
    els.sfPathVal.title = p || "";
  });
}
if (els.sfPathCopyBtn) {
  els.sfPathCopyBtn.addEventListener("click", async () => {
    const r = await window.scanner.copyInboxPath();
    if (!r || !r.ok) return;
    const original = els.sfPathCopyBtn.textContent;
    els.sfPathCopyBtn.textContent = "Copied";
    els.sfPathCopyBtn.classList.add("copied");
    setTimeout(() => {
      els.sfPathCopyBtn.textContent = original;
      els.sfPathCopyBtn.classList.remove("copied");
    }, 1500);
  });
}

// ── Pause toggle ─────────────────────────────────────────────────────────

els.pauseBtn.addEventListener("click", async () => {
  const cur = await window.scanner.getState();
  const isPaused = cur.pausedUntil != null && cur.pausedUntil > Date.now();
  els.pauseBtn.disabled = true;
  await window.scanner.setPaused(!isPaused);
  els.pauseBtn.disabled = false;
});

// ── Settings collapsible ─────────────────────────────────────────────────

els.settingsToggle.addEventListener("click", () => {
  const open = !els.settingsBody.hasAttribute("hidden");
  if (open) {
    els.settingsBody.setAttribute("hidden", "");
    els.settingsToggle.textContent = "Settings ⌄";
  } else {
    els.settingsBody.removeAttribute("hidden");
    els.settingsToggle.textContent = "Settings ⌃";
  }
});

els.autoOpenOnError.addEventListener("change", async () => {
  await window.scanner.setSetting("autoOpenOnError", !!els.autoOpenOnError.checked);
});

els.soundEnabled.addEventListener("change", async () => {
  await window.scanner.setSetting("soundEnabled", !!els.soundEnabled.checked);
});

// ── Test scan ────────────────────────────────────────────────────────────

els.testScanBtn.addEventListener("click", async () => {
  els.testScanBtn.disabled = true;
  const original = els.testScanBtn.textContent;
  els.testScanBtn.textContent = "Triggering…";
  const r = await window.scanner.testScan();
  if (r.ok) {
    els.testScanBtn.textContent = "Triggered — watch tray";
    setTimeout(() => {
      els.testScanBtn.textContent = original;
      els.testScanBtn.disabled = false;
    }, 3000);
  } else {
    els.testScanBtn.textContent = `Failed: ${(r.error || "unknown").slice(0, 30)}`;
    setTimeout(() => {
      els.testScanBtn.textContent = original;
      els.testScanBtn.disabled = false;
    }, 4000);
  }
});

// Reset the scanner — escalates Soft (in-process restart) → Reload → Repair
// against the live com.mintvault.scanner agent. Shows a plain-English status.
// If it escalates, the agent restarts and surfaces the final outcome
// ("Reloaded agent" / "Repaired + reinstalled agent" / "Manual fix needed")
// via a notification on relaunch.
els.clearBufferedBtn.addEventListener("click", async () => {
  if (!window.confirm("Reset the scanner?\n\nRestarts the watcher; if needed, reloads or repairs the scanner agent. Safe to run anytime.")) return;
  els.clearBufferedBtn.disabled = true;
  const original = els.clearBufferedBtn.textContent;
  els.clearBufferedBtn.textContent = "Resetting…";
  const r = await window.scanner.resetScanner();
  setTimeout(async () => {
    const cur = await window.scanner.getState();
    if (cur) renderState(cur);
    els.clearBufferedBtn.disabled = false;
    // Plain-English status — never a raw exit code.
    els.clearBufferedBtn.textContent = (r && r.status) ? r.status : (r && r.ok ? "Done" : "Manual fix needed");
    setTimeout(() => { els.clearBufferedBtn.textContent = original; }, (r && r.escalated) ? 4000 : 1800);
  }, (r && r.escalated) ? 300 : 1500);
});

// ── Boot ─────────────────────────────────────────────────────────────────

window.scanner.onStateUpdate(renderState);
window.scanner.getState().then(renderState);

// Close modals with Escape
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const m of [els.manualModal, els.orphanModal, els.forwardModal, els.deleteModal]) {
    if (m.classList.contains("visible")) {
      // Manual modal needs the cancel side-effect (releases pending scan)
      if (m === els.manualModal && pendingScanFile) {
        window.scanner.attachManualScan({ cancel: true });
        pendingScanFile = null;
      }
      closeModal(m);
      return;
    }
  }
});
