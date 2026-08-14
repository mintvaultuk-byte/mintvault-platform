/**
 * Scanner-station renderer. The normal path deliberately has no file picker,
 * mode selector, profile selector, or free-form certificate target: MintVault
 * arms the exact server-owned capture session before this app scans.
 */

const els = {
  hideBtn: document.getElementById("hideBtn"),
  appVersion: document.getElementById("appVersion"),
  updateBtn: document.getElementById("updateBtn"),
  reinstallBtn: document.getElementById("reinstallBtn"),
  updateStatus: document.getElementById("updateStatus"),
  scannerHealth: document.getElementById("scannerHealth"),
  stationIdentityRow: document.getElementById("stationIdentityRow"),
  stationOrganisation: document.getElementById("stationOrganisation"),
  stationIdentity: document.getElementById("stationIdentity"),
  stationUser: document.getElementById("stationUser"),
  targetCert: document.getElementById("targetCert"),
  targetSide: document.getElementById("targetSide"),
  targetHint: document.getElementById("targetHint"),
  workflowGuide: document.getElementById("workflowGuide"),
  placementVisual: document.getElementById("placementVisual"),
  workflowGuideStep: document.getElementById("workflowGuideStep"),
  workflowGuideTitle: document.getElementById("workflowGuideTitle"),
  workflowGuideHint: document.getElementById("workflowGuideHint"),
  dot: document.getElementById("dot"),
  statusText: document.getElementById("statusText"),
  statusSub: document.getElementById("statusSub"),
  recentList: document.getElementById("recentList"),
  orphansBtn: document.getElementById("orphansBtn"),
  orphanModal: document.getElementById("orphanModal"),
  orphanList: document.getElementById("orphanList"),
  orphanClose: document.getElementById("orphanClose"),
  lastCertBtn: document.getElementById("lastCertBtn"),
  logsBtn: document.getElementById("logsBtn"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsBody: document.getElementById("settingsBody"),
  diagnosticsRow: document.getElementById("diagnosticsRow"),
  autoOpenOnError: document.getElementById("autoOpenOnError"),
  soundEnabled: document.getElementById("soundEnabled"),
  restartServiceBtn: document.getElementById("clearBufferedBtn"),
  scanCardBtn: document.getElementById("scanCardBtn"),
  previewPanel: document.getElementById("previewPanel"),
  capturePreview: document.getElementById("capturePreview"),
  acceptPreviewBtn: document.getElementById("acceptPreviewBtn"),
  rescanPreviewBtn: document.getElementById("rescanPreviewBtn"),
  rescanErrorBtn: document.getElementById("rescanErrorBtn"),
  nextCardBtn: document.getElementById("nextCardBtn"),
  newCardBtn: document.getElementById("newCardBtn"),
  newCardError: document.getElementById("newCardError"),
  cardCompletePanel: document.getElementById("cardCompletePanel"),
  cardCompleteTitle: document.getElementById("cardCompleteTitle"),
  cardCompleteInstruction: document.getElementById("cardCompleteInstruction"),
  completeNextCardBtn: document.getElementById("completeNextCardBtn"),
  stationCredits: document.getElementById("stationCredits"),
  captureActionHint: document.getElementById("captureActionHint"),
  positioningPreviewBtn: document.getElementById("positioningPreviewBtn"),
  positioningHint: document.getElementById("positioningHint"),
  positioningPanel: document.getElementById("positioningPanel"),
  positioningCardPreviewViewport: document.getElementById("positioningCardPreviewViewport"),
  positioningCardPreview: document.getElementById("positioningCardPreview"),
  positioningFullPreview: document.getElementById("positioningFullPreview"),
  fullPlatenDiagnostics: document.getElementById("fullPlatenDiagnostics"),
  cardBoundaryOverlay: document.getElementById("cardBoundaryOverlay"),
  acquisitionBoundaryOverlay: document.getElementById("acquisitionBoundaryOverlay"),
  positioningResult: document.getElementById("positioningResult"),
  positioningGeometry: document.getElementById("positioningGeometry"),
  savePlacementBtn: document.getElementById("savePlacementBtn"),
  stationSetupModal: document.getElementById("stationSetupModal"),
  stationSetupTitle: document.getElementById("stationSetupTitle"),
  stationSetupText: document.getElementById("stationSetupText"),
  stationSetupError: document.getElementById("stationSetupError"),
  stationSignInForm: document.getElementById("stationSignInForm"),
  stationEmail: document.getElementById("stationEmail"),
  stationPassword: document.getElementById("stationPassword"),
  stationSignInBtn: document.getElementById("stationSignInBtn"),
  stationMfaForm: document.getElementById("stationMfaForm"),
  stationMfaCode: document.getElementById("stationMfaCode"),
  stationRecoveryCode: document.getElementById("stationRecoveryCode"),
  stationMfaBtn: document.getElementById("stationMfaBtn"),
  stationRegisterPanel: document.getElementById("stationRegisterPanel"),
  stationLocationField: document.getElementById("stationLocationField"),
  stationLocation: document.getElementById("stationLocation"),
  stationRegisterBtn: document.getElementById("stationRegisterBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  stationModalSignOutBtn: document.getElementById("stationModalSignOutBtn"),
  stationUpdatePanel: document.getElementById("stationUpdatePanel"),
  stationUpdateBtn: document.getElementById("stationUpdateBtn"),
  stationReinstallBtn: document.getElementById("stationReinstallBtn"),
  stationUpdateStatus: document.getElementById("stationUpdateStatus"),
};

const STATE_LABELS = {
  idle: "Ready — waiting for a server-owned capture",
  starting: "Starting scanner…",
  scanning_front: "Scanning front…",
  scanning_back: "Scanning back…",
  finalising: "Processing image…",
  uploading: "Uploading original TIFF…",
  validating: "Validating evidence…",
  retrying: "Retrying current side…",
  positioning_preview_scanning: "Scanning local placement preview…",
  positioning_preview_error: "Placement Preview needs attention",
  awaiting_scan: "Card positioned? Press Scan",
  processing_preview: "Generating scan preview…",
  preview_ready: "Preview ready — choose Accept or Rescan",
  preview_error: "Preview needs attention",
  expired: "Capture target expired",
  success: "Capture accepted",
  error: "Capture needs attention",
  storage_pressure: "Capture paused — free disk space is too low",
};

let lastState = null;
let renderedPreviewId = null;
let renderedPositioningPreviewId = null;
let actionInFlight = false;
let actionError = null;
let stationSetup = null;
let stationSetupBusy = false;
let stationSetupPoll = null;
let updateStatus = { status: "idle" };

function openModal(modal) {
  modal?.classList.add("visible");
}

function closeModal(modal) {
  modal?.classList.remove("visible");
}

function toTitle(value) {
  return String(value || "").replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderHealth(health) {
  const status = String(health?.status || "checking");
  if (status === "ready") return "Connected • 1200 DPI • Locked";
  if (status === "busy") return "Scanner busy • 1200 DPI • Locked";
  if (status === "profile_unprovisioned") return "Connected • setup required • 1200 DPI";
  if (status === "disconnected") return "Scanner disconnected";
  if (status === "checking") return "Checking device…";
  return `${toTitle(status)}${health?.error ? ` — ${health.error}` : ""}`.slice(0, 120);
}

function renderTarget(state) {
  const active = state.activeCapture;
  if (active?.certId) {
    els.targetCert.textContent = active.certId;
    els.targetSide.textContent = toTitle(active.side) || "—";
    const stage = String(active.stage || "");
    if (stage === "awaiting_scan") {
      els.targetHint.textContent = `Position the card, then press Scan ${toTitle(active.side)}. This station cannot retarget it.`;
    } else if (stage === "preview_ready") {
      els.targetHint.textContent = `Review this exact ${toTitle(active.side)} candidate before accepting or rescanning it.`;
    } else if (stage === "preview_error") {
      els.targetHint.textContent = `This ${toTitle(active.side)} candidate failed its safety check. Review it, reposition the card, then Rescan; it cannot be accepted.`;
    } else {
      els.targetHint.textContent = `This station is processing the server-owned ${toTitle(active.side)} target.`;
    }
    return;
  }

  if (state.lastAcceptedCapture?.cardRegistered && !state.activeCapture) {
    els.targetCert.textContent = state.lastAcceptedCapture.certId;
    els.targetSide.textContent = "CARD REGISTERED";
    els.targetHint.textContent = "Both server-owned sides are captured. Select Next Card only after the physical card has been cleared from this station.";
    return;
  }

  if (state.state === "success" && state.lastAcceptedCapture?.certId) {
    const accepted = state.lastAcceptedCapture;
    els.targetCert.textContent = accepted.certId;
    els.targetSide.textContent = `${toTitle(accepted.side)} SAVED`;
    els.targetHint.textContent = accepted.side === "front"
      ? "Front saved. MintVault will prepare Back when it is required."
      : "Card complete. MintVault will provide the next required card.";
    return;
  }

  els.targetCert.textContent = "No card ready";
  els.targetSide.textContent = "—";
  els.targetHint.textContent = state.state === "storage_pressure"
    ? "Free disk space on this Mac before starting another card. Existing encrypted evidence remains retained."
    : state.state === "error"
      ? "Retry this side from the MintVault card record. This app cannot retarget a capture."
      : "Arm a card side in MintVault. This station will only scan that server-owned target.";
}

function renderStationIdentity(setup) {
  const active = setup?.stage === "active";
  els.stationIdentityRow.hidden = !active;
  // Pending enrolment and every other post-MFA state must still support an
  // immediate shift change. The station identity remains visible only while
  // active, but the human can always leave once a sanitised summary proves a
  // current authenticated session.
  els.signOutBtn.hidden = !setup?.canSignOut;
  els.stationModalSignOutBtn.hidden = active || !setup?.canSignOut;
  if (!active) return;
  const organisation = [setup.summary?.organisationName, setup.summary?.locationName].filter(Boolean).join(" — ");
  els.stationOrganisation.textContent = organisation || "MintVault location";
  els.stationIdentity.textContent = setup.stationCode || "Station";
  els.stationUser.textContent = setup.summary?.displayName || "Authorised user";
  /*
   * Server-reported capacity, or an em dash. Never 0 as a stand-in for "not answered yet": the two
   * mean completely different things to a shop, and showing an unasked question as an empty wallet
   * would stop a station that is perfectly able to work.
   */
  const credits = setup.summary?.availableCredits;
  els.stationCredits.textContent = typeof credits === "number" ? String(credits) : "—";
}

function renderUpdateStatus(next) {
  updateStatus = next || { status: "idle" };
  const status = String(updateStatus.status || "idle");
  const version = updateStatus.version ? ` ${updateStatus.version}` : "";
  const messages = {
    idle: "Ready to check the approved MintVault release channel.",
    checking: "Checking the approved MintVault release set…",
    up_to_date: "This Mac already has the current approved MintVault Scanner release.",
    update_available: `Approved MintVault Scanner${version} is available.`,
    downloading: `Downloading approved MintVault Scanner${version}${Number.isFinite(updateStatus.percent) ? ` — ${updateStatus.percent}%` : ""}…`,
    downloading_dmg: `Downloading and verifying approved MintVault Scanner${version} DMG…`,
    dmg_ready: `Approved MintVault Scanner${version} DMG is verified and opening in macOS.`,
    ready_to_restart: `Approved MintVault Scanner${version} is verified and ready to restart.`,
    restart_deferred: updateStatus.error || "Finish the current physical capture before restarting.",
    installing: `Installing approved MintVault Scanner${version}…`,
    disabled: updateStatus.error || "Automatic update is available only in a signed MintVault release.",
    error: updateStatus.error || "MintVault could not verify the signed update set. Use DMG Reinstall or contact support.",
  };
  const message = messages[status] || "MintVault update status is unavailable.";
  els.updateStatus.textContent = message;
  els.stationUpdateStatus.textContent = message;
  const busy = ["checking", "downloading", "downloading_dmg", "installing"].includes(status);
  els.updateBtn.disabled = busy;
  els.stationUpdateBtn.disabled = busy;
  els.reinstallBtn.disabled = status === "installing";
  els.stationReinstallBtn.disabled = status === "installing";
}

function renderWorkflowGuide(state) {
  const active = state.activeCapture;
  const stage = String(active?.stage || "");
  const awaitingScan = stage === "awaiting_scan";
  const presentationPending = ["scanning", "retrying_scan", "processing_preview", "preview_ready", "preview_error", "upload"].includes(stage);
  els.workflowGuide.hidden = presentationPending;
  if (presentationPending) return;

  const accepted = state.lastAcceptedCapture;
  if (accepted?.certId) {
    if (accepted.cardRegistered && !active) {
      els.workflowGuide.dataset.guideState = "complete";
      els.placementVisual.classList.remove("flip-required");
      els.workflowGuideStep.textContent = "CARD REGISTERED";
      els.workflowGuideTitle.textContent = "Both sides are saved";
      els.workflowGuideHint.textContent = "Select Next Card only after clearing this card from the scanner.";
      return;
    }
    const frontAccepted = accepted.side === "front";
    els.workflowGuide.dataset.guideState = frontAccepted ? "back" : "complete";
    els.placementVisual.classList.toggle("flip-required", frontAccepted);
    els.workflowGuideStep.textContent = frontAccepted ? "FRONT SAVED" : "CARD COMPLETE";
    els.workflowGuideTitle.textContent = frontAccepted ? "Flip the card for Back" : "Both sides are saved";
    els.workflowGuideHint.textContent = frontAccepted
      ? "MintVault will prepare Back when it is required. Front remains saved."
      : "MintVault will provide the next required card.";
    return;
  }

  const isBack = awaitingScan && active?.side === "back";
  els.workflowGuide.dataset.guideState = isBack ? "back" : awaitingScan ? "front" : "setup";
  els.placementVisual.classList.toggle("flip-required", isBack);
  if (isBack) {
    els.workflowGuideStep.textContent = "STEP 2 — FLIP THE CARD";
    els.workflowGuideTitle.textContent = "Flip the card, then scan Back";
    els.workflowGuideHint.textContent = "Place the back face-down in the guide. Preview if needed, then press Scan Back.";
  } else if (awaitingScan) {
    els.workflowGuideStep.textContent = "STEP 1 — PLACE CARD";
    els.workflowGuideTitle.textContent = "Place the card face-down in the guide";
    els.workflowGuideHint.textContent = "Preview if needed, then press Scan Front. The scanner only captures this MintVault target.";
  } else {
    els.workflowGuideStep.textContent = "SETUP — CHECK PLACEMENT";
    els.workflowGuideTitle.textContent = "Place a card, then Preview";
    els.workflowGuideHint.textContent = "Preview checks that the complete card is visible. Open a card in MintVault to enable final scanning.";
  }
}

function renderStationSetup(next) {
  stationSetup = next || { stage: "sign_in" };
  const stage = String(stationSetup.stage || "sign_in");
  const active = stage === "active";
  renderStationIdentity(stationSetup);
  els.stationSetupModal.classList.toggle("visible", !active);
  els.stationSignInForm.hidden = stage !== "sign_in";
  els.stationMfaForm.hidden = stage !== "mfa";
  els.stationRegisterPanel.hidden = stage !== "register";
  els.stationUpdatePanel.hidden = stage !== "update_required";
  els.stationSetupError.textContent = stationSetup.error || "";
  els.stationSignInBtn.disabled = stationSetupBusy;
  els.stationMfaBtn.disabled = stationSetupBusy;
  els.stationRegisterBtn.disabled = stationSetupBusy;

  if (stage === "mfa") {
    els.stationSetupTitle.textContent = "Verify your MintVault sign-in";
    els.stationSetupText.textContent = "Enter your authenticator or recovery code. This Mac cannot scan until both you and the station are authorised.";
  } else if (stage === "register") {
    const locations = Array.isArray(stationSetup.locations) ? stationSetup.locations : [];
    els.stationSetupTitle.textContent = "Connect this station";
    els.stationSetupText.textContent = stationSetup.summary?.organisationName
      ? `${stationSetup.summary.organisationName}${stationSetup.summary.locationName ? ` — ${stationSetup.summary.locationName}` : ""}. Register this Mac for its authorised location.`
      : "Register this Mac for an authorised MintVault location.";
    els.stationLocation.replaceChildren();
    for (const location of locations) {
      const option = document.createElement("option");
      option.value = location.id;
      option.textContent = location.name;
      els.stationLocation.append(option);
    }
    els.stationLocationField.hidden = locations.length <= 1;
    if (locations.length === 0) {
      els.stationSetupError.textContent = "No active authorised location is available for this account.";
      els.stationRegisterBtn.disabled = true;
    }
  } else if (stage === "pending") {
    els.stationSetupTitle.textContent = "Waiting for MintVault approval";
    els.stationSetupText.textContent = `${stationSetup.stationCode || "This Mac"} is registered and awaiting Super Admin approval. Keep the app open; no card can be scanned yet.`;
  } else if (stage === "update_required") {
    els.stationSetupTitle.textContent = "UPDATE REQUIRED";
    els.stationSetupText.textContent = stationSetup.minimumSupportedVersion
      ? `This Mac must run MintVault Scanner ${stationSetup.minimumSupportedVersion} or later. Update now or reinstall the signed DMG.`
      : "Update now or reinstall the current signed MintVault Scanner DMG.";
  } else if (stage === "identity_recovery_required") {
    els.stationSetupTitle.textContent = "Station identity recovery required";
    els.stationSetupText.textContent = "MintVault cannot prove this Mac's enrolled identity. Scanning and re-registration are paused. Contact a MintVault Super Admin.";
  } else if (stage === "mfa_enrolment_required") {
    els.stationSetupTitle.textContent = "MFA setup required";
    els.stationSetupText.textContent = "Set up MFA in the MintVault Partner dashboard, then sign in to this Scanner again.";
  } else if (stage === "no_partner_access") {
    els.stationSetupTitle.textContent = "No Scanner access";
    els.stationSetupText.textContent = "This account is not authorised for this station action. Ask a Partner Owner or MintVault Super Admin to check the role.";
  } else if (stage === "no_location") {
    els.stationSetupTitle.textContent = "No authorised location";
    els.stationSetupText.textContent = "This account has no active shop location available for station enrolment.";
  } else if (stage === "offline") {
    els.stationSetupTitle.textContent = "MintVault offline";
    els.stationSetupText.textContent = "New physical work is paused. Existing queued evidence remains assigned to its original capture.";
  } else if (stage === "scanner_disconnected") {
    els.stationSetupTitle.textContent = "Scanner disconnected";
    els.stationSetupText.textContent = "Connect the Canon LiDE 400. New physical work remains paused until ImageCaptureCore reports it ready.";
  } else if (stage === "degraded" || stage === "replay_state_desync") {
    els.stationSetupTitle.textContent = stage === "replay_state_desync" ? "Station recovery required" : "MintVault temporarily unavailable";
    els.stationSetupText.textContent = stage === "replay_state_desync"
      ? "The station replay state must be securely resynchronised before physical work can continue."
      : "Station authority could not be verified. New physical work is paused.";
  } else if (["rejected", "cancelled", "expired", "suspended", "revoked", "station_unavailable"].includes(stage)) {
    els.stationSetupTitle.textContent = "Station unavailable";
    els.stationSetupText.textContent = "This station is not currently authorised for scanning. Contact a MintVault Super Admin.";
  } else if (active) {
    els.stationSetupTitle.textContent = "Station ready";
    els.stationSetupText.textContent = "This station is authorised. Complete placement setup before its first evidence scan.";
  } else {
    els.stationSetupTitle.textContent = "Sign in to MintVault";
    els.stationSetupText.textContent = "Use your authorised MintVault account to set up this Mac.";
  }

  if (stationSetupPoll) clearTimeout(stationSetupPoll);
  if (stage === "pending") {
    stationSetupPoll = setTimeout(() => void refreshStationSetup(), 15_000);
  }
}

async function refreshStationSetup() {
  if (stationSetupBusy) return;
  try {
    const result = await window.scanner.getStationSetup();
    renderStationSetup(result);
  } catch {
    renderStationSetup({ stage: "sign_in", error: "MintVault station status is unavailable" });
  }
}

async function runStationSetupAction(action) {
  if (stationSetupBusy) return;
  stationSetupBusy = true;
  renderStationSetup(stationSetup);
  try {
    const result = await action();
    if (!result?.ok) {
      renderStationSetup({ ...(stationSetup || {}), error: result?.error || "Station setup action was not accepted" });
    } else {
      renderStationSetup(result);
    }
  } catch (error) {
    renderStationSetup({ ...(stationSetup || {}), error: error?.message || "Station setup failed" });
  } finally {
    stationSetupBusy = false;
    renderStationSetup(stationSetup);
  }
}

function setActionButton(button, label, visible, disabled) {
  if (!button) return;
  button.hidden = !visible;
  button.disabled = Boolean(disabled);
  button.textContent = label;
}

function formatMm(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} mm` : "—";
}

/**
 * Map one physical ImageCaptureCore rectangle through the shared coordinate
 * contract and then through the actual object-fit:contain image rectangle.
 * This deliberately uses measured DOM geometry, never a guessed offset.
 */
function positionPreviewOverlay(element, physicalRect, entry, className) {
  const transform = window.MintVaultLidePreviewTransform;
  const area = entry?.capture?.areaMm;
  const image = els.positioningFullPreview;
  const viewport = image?.parentElement;
  if (!transform || !element || !physicalRect || !area || !image?.naturalWidth || !image?.naturalHeight || !viewport) {
    if (element) element.hidden = true;
    return;
  }
  const imageRect = image.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  if (imageRect.width <= 0 || imageRect.height <= 0 || viewportRect.width <= 0 || viewportRect.height <= 0) {
    element.hidden = true;
    return;
  }
  try {
    const mapped = transform.physicalRectToContainedViewportRect(
      physicalRect,
      area,
      { width: image.naturalWidth, height: image.naturalHeight },
      { width: imageRect.width, height: imageRect.height },
    );
    Object.assign(element.style, {
      left: `${imageRect.left - viewportRect.left + mapped.x}px`,
      top: `${imageRect.top - viewportRect.top + mapped.y}px`,
      width: `${mapped.width}px`,
      height: `${mapped.height}px`,
    });
    element.className = className;
    element.hidden = false;
  } catch {
    element.hidden = true;
  }
}

/**
 * The broad 300-DPI positioning capture remains the calibration source, but
 * the normal operator view is a display-only crop around the detected card.
 * It retains eight millimetres of visible scanner background on every
 * available side. No pixels are written, uploaded, or reused as evidence.
 */
function renderPositioningCardCrop(entry) {
  const transform = window.MintVaultLidePreviewTransform;
  const area = entry?.capture?.areaMm;
  const card = entry?.cardCandidate?.cardBoundsMm;
  const image = els.positioningCardPreview;
  const viewport = els.positioningCardPreviewViewport;
  if (!transform || !area || !card || !image?.naturalWidth || !image?.naturalHeight || !viewport) return;
  const marginMm = 8;
  const x = Math.max(area.x, card.x - marginMm);
  const y = Math.max(area.y, card.y - marginMm);
  const right = Math.min(area.x + area.width, card.x + card.width + marginMm);
  const bottom = Math.min(area.y + area.height, card.y + card.height + marginMm);
  if (right <= x || bottom <= y) return;
  try {
    const crop = transform.physicalRectToRasterRect(
      { x, y, width: right - x, height: bottom - y },
      area,
      { width: image.naturalWidth, height: image.naturalHeight },
    );
    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    if (viewportWidth <= 0 || viewportHeight <= 0 || crop.width <= 0 || crop.height <= 0) return;
    const scale = Math.min(viewportWidth / crop.width, viewportHeight / crop.height);
    Object.assign(image.style, {
      width: `${image.naturalWidth * scale}px`,
      height: `${image.naturalHeight * scale}px`,
      left: `${(viewportWidth - crop.width * scale) / 2 - crop.x * scale}px`,
      top: `${(viewportHeight - crop.height * scale) / 2 - crop.y * scale}px`,
    });
  } catch {
    // The original full preview remains available under diagnostics. Do not
    // invent a crop or affect capture safety when Preview geometry is invalid.
  }
}

function renderPositioningOverlays(entry) {
  const candidate = entry?.cardCandidate?.cardBoundsMm;
  positionPreviewOverlay(els.cardBoundaryOverlay, candidate, entry, "card-boundary-overlay");
  const proposal = entry?.placement?.proposedHardwareRectMm;
  const safe = Boolean(entry?.placement?.ready && ["detected", "saved"].includes(entry.status));
  positionPreviewOverlay(
    els.acquisitionBoundaryOverlay,
    proposal,
    entry,
    `acquisition-boundary-overlay ${safe ? "safe" : "unsafe"}`,
  );
}

function renderPositioningPreview(entry, scannerHealth, activeCapture) {
  const evidenceReviewActive = ["scanning", "retrying_scan", "processing_preview", "preview_ready", "preview_error", "upload"].includes(String(activeCapture?.stage || ""));
  const status = String(entry?.status || "");
  const canStart = ["ready", "profile_unprovisioned"].includes(String(scannerHealth?.status || ""));
  const scanning = status === "scanning";
  setActionButton(els.positioningPreviewBtn, scanning ? "PREVIEWING…" : "PREVIEW", true, actionInFlight || scanning || !canStart);

  if (!entry || evidenceReviewActive) {
    els.positioningPanel.hidden = true;
    els.fullPlatenDiagnostics.hidden = true;
    els.positioningHint.textContent = "Preview checks card placement only. It never becomes card evidence.";
    return;
  }
  if (scanning) {
    els.positioningPanel.hidden = true;
    els.fullPlatenDiagnostics.hidden = true;
    els.positioningHint.textContent = "Scanning a local placement Preview. No certificate, TIFF, or upload is involved.";
    return;
  }

  const showImage = ["detected", "reposition", "not_detected", "saved"].includes(status);
  els.positioningPanel.hidden = !showImage && status !== "error";
  els.fullPlatenDiagnostics.hidden = !showImage;
  if (showImage && entry.id !== renderedPositioningPreviewId) {
    renderedPositioningPreviewId = entry.id;
    els.positioningCardPreview.removeAttribute("src");
    els.positioningFullPreview.removeAttribute("src");
    window.scanner.getPositioningPreview(entry.id).then((result) => {
      if (lastState?.positioningPreview?.id !== entry.id || !result?.ok) return;
      els.positioningFullPreview.onload = () => {
        if (lastState?.positioningPreview?.id === entry.id) renderPositioningOverlays(lastState.positioningPreview);
      };
      els.positioningCardPreview.onload = () => {
        if (lastState?.positioningPreview?.id === entry.id) renderPositioningCardCrop(lastState.positioningPreview);
      };
      els.positioningCardPreview.src = result.dataUrl;
      els.positioningFullPreview.src = result.dataUrl;
    }).catch(() => {});
  }

  const candidate = entry.cardCandidate?.cardBoundsMm;
  const area = entry.capture?.areaMm;
  if (showImage && els.positioningFullPreview.complete) renderPositioningOverlays(entry);
  if (showImage && els.positioningCardPreview.complete) renderPositioningCardCrop(entry);

  if (status === "detected") {
    els.positioningResult.textContent = "CARD DETECTED — PLACEMENT IS READY";
    const placement = entry.placement;
    els.positioningGeometry.textContent = `Card ${formatMm(candidate.x)}, ${formatMm(candidate.y)} · ${formatMm(candidate.width)} × ${formatMm(candidate.height)}. Proposed hardware region ${formatMm(placement.areaMm.width)} × ${formatMm(placement.areaMm.height)} at ${formatMm(placement.originMm.x)}, ${formatMm(placement.originMm.y)}; usable placement tolerance ${formatMm(placement.placementToleranceMm)}.`;
    setActionButton(els.savePlacementBtn, "SAVE PLACEMENT ZONE", true, actionInFlight);
    els.positioningHint.textContent = "All four edges and corners are visible with scanner background. Saving only enables this local station’s final 1200-DPI capture profile.";
  } else if (status === "reposition") {
    els.positioningResult.textContent = "CARD DETECTED — MOVE SLIGHTLY INWARD, THEN PREVIEW";
    const proposal = entry.placement || {};
    const margins = proposal.surroundingAvailableMm || {};
    const movement = proposal.minimumMoveInwardMm || {};
    const moveRightMm = Math.ceil(Number(movement.x) || 0);
    const moveUpMm = Math.ceil(Number(movement.y) || 0);
    const evidenceStatus = proposal.evidenceMarginSatisfied
      ? `All four card edges are visible; observed minimum background is ${formatMm(proposal.observedEvidenceMarginMm)} (requirement ${formatMm(proposal.evidenceMarginRequiredMm)}).`
      : "At least one card edge does not have the required evidence background.";
    els.positioningGeometry.textContent = `Detected card ${formatMm(candidate?.x)}, ${formatMm(candidate?.y)} · ${formatMm(candidate?.width)} × ${formatMm(candidate?.height)}. Broad Preview background: left ${formatMm(margins.left)}, top ${formatMm(margins.top)}, right ${formatMm(margins.right)}, bottom ${formatMm(margins.bottom)}. ${evidenceStatus} The 100 × 130 mm area is clipped by the platen, so it is not saved. Measured inward movement: ${moveRightMm} mm right and ${moveUpMm} mm up.`;
    setActionButton(els.savePlacementBtn, "SAVE PLACEMENT ZONE", false, true);
    els.positioningHint.textContent = "The card is complete, but the placement zone needs a little more room at the glass edge for ordinary staff variation.";
  } else if (status === "not_detected") {
    els.positioningResult.textContent = "CARD NOT DETECTED — REPOSITION AND PREVIEW";
    els.positioningGeometry.textContent = area ? `Broad hardware preview area: ${formatMm(area.width)} × ${formatMm(area.height)} at ${formatMm(area.x)}, ${formatMm(area.y)}.` : "The scanner did not return usable positioning geometry.";
    setActionButton(els.savePlacementBtn, "SAVE PLACEMENT ZONE", false, true);
    els.positioningHint.textContent = "No placement was saved and no evidence was created. Reposition the card, then Preview again.";
  } else if (status === "saved") {
    els.positioningResult.textContent = "PLACEMENT ZONE SAVED";
    const placement = entry.persisted || entry.placement;
    els.positioningGeometry.textContent = `Local station origin ${formatMm(placement.originMm?.x)}, ${formatMm(placement.originMm?.y)} · hardware region ${formatMm(placement.areaMm?.width)} × ${formatMm(placement.areaMm?.height)}.`;
    setActionButton(els.savePlacementBtn, "PLACEMENT ZONE SAVED", true, true);
    els.positioningHint.textContent = "Normal SCAN FRONT / SCAN BACK remains target-bound and uses the locked 1200-DPI TIFF profile.";
  } else {
    els.positioningResult.textContent = "POSITIONING PREVIEW FAILED";
    els.positioningGeometry.textContent = entry.error || "No card position was saved.";
    setActionButton(els.savePlacementBtn, "SAVE PLACEMENT ZONE", false, true);
    els.positioningHint.textContent = "No certificate or evidence was changed. Check scanner readiness and Preview again.";
  }
}

function renderPreview(active) {
  const previewId = active?.previewId;
  if (!previewId || previewId === renderedPreviewId) return;
  renderedPreviewId = previewId;
  els.capturePreview.removeAttribute("src");
  window.scanner.getCapturePreview(previewId).then((result) => {
    if (lastState?.activeCapture?.previewId !== previewId) return;
    if (!result?.ok) {
      actionError = result?.error || "Preview is no longer available";
      renderState(lastState);
      return;
    }
    els.capturePreview.src = result.dataUrl;
  }).catch(() => {
    if (lastState?.activeCapture?.previewId === previewId) {
      actionError = "Preview could not be loaded";
      renderState(lastState);
    }
  });
}

function renderCaptureActions(state) {
  const active = state.activeCapture;
  const stage = String(active?.stage || "");
  const side = toTitle(active?.side || "card");
  const scanning = ["scanning", "retrying_scan", "processing_preview"].includes(stage);
  const previewReady = stage === "preview_ready" && Boolean(active?.previewId);
  const previewError = stage === "preview_error" && Boolean(active?.previewId);
  const previewVisible = previewReady || previewError;
  const awaitingScan = stage === "awaiting_scan";
  const hasTarget = Boolean(active?.certId && active?.side);
  const scanLabel = hasTarget ? `SCAN ${side}` : "SCAN CARD";
  const scanEnabled = awaitingScan && state.scannerHealth?.status === "ready" && !actionInFlight;
  const cardRegistered = state.lastAcceptedCapture?.cardRegistered === true && !active;

  /*
   * P6 completion screen: MVxxx COMPLETE / MARK CARD MVxxx / NEXT CARD.
   *
   * The MV shown is the server's certificate number, echoed back exactly as received. The station
   * never derives, increments or guesses it — "last cert + 1" is precisely the client-side identity
   * assignment the model forbids, because two stations would reach the same answer.
   *
   * MARK CARD is the physical instruction that keeps the paper trail honest: the operator writes
   * this number on the sleeve before the card leaves the station, so a card can always be matched
   * back to its certificate.
   */
  const completedCert = cardRegistered ? state.lastAcceptedCapture?.certId : null;
  els.cardCompletePanel.hidden = !completedCert;
  if (completedCert) {
    els.cardCompleteTitle.textContent = `${completedCert} COMPLETE`;
    els.cardCompleteInstruction.textContent = `MARK CARD ${completedCert}`;
  }
  // NEW CARD is only sensible when this station is not mid-card.
  els.newCardBtn.disabled = Boolean(active) || actionInFlight;

  // Keep the final evidence action visible in every state. A disabled,
  // explained SCAN CARD makes the target-bound rule clear without implying
  // Preview itself can become an authoritative capture.
  setActionButton(els.scanCardBtn, scanLabel, true, !scanEnabled);
  els.previewPanel.hidden = !previewVisible;
  setActionButton(els.acceptPreviewBtn, `ACCEPT ${side}`, previewReady, actionInFlight);
  setActionButton(els.rescanPreviewBtn, `RESCAN ${side}`, previewReady, actionInFlight);
  setActionButton(els.rescanErrorBtn, `RESCAN ${side}`, previewError, actionInFlight);
  setActionButton(els.nextCardBtn, "NEXT CARD", cardRegistered, actionInFlight);

  if (previewVisible) renderPreview(active);
  if (!previewVisible && renderedPreviewId) {
    renderedPreviewId = null;
    els.capturePreview.removeAttribute("src");
  }

  els.captureActionHint.textContent = !hasTarget
    ? "Open or arm a card in MintVault to enable final scanning."
    : awaitingScan && state.scannerHealth?.status !== "ready"
    ? "Finish this station’s placement setup before final scanning is enabled."
    : awaitingScan
    ? `Position the ${side.toLowerCase()}, then press Scan. No scan starts automatically.`
    : scanning
      ? "The locked 1200 DPI TIFF is being captured once; its derivative preview follows."
      : previewReady
        ? "Accept uploads this exact TIFF. Rescan archives it locally and keeps the same card-side target."
        : previewError
          ? "Safety check rejected this staged TIFF before upload. Review the preview, reposition the card, then Rescan; Accept is unavailable."
          : active
            ? "This target remains bound while the current operation finishes."
            : "Final scanning remains disabled until this server-owned card side is ready.";
}

function explainFailure(message) {
  const detail = String(message || "");
  const lower = detail.toLowerCase();
  if (lower.includes("expired")) return "Capture expired — retry this side in MintVault";
  if (lower.includes("disconnect") || lower.includes("not detected")) return "Scanner disconnected — check the USB connection";
  if (lower.includes("busy")) return "Scanner busy — wait briefly, then retry this side";
  if (lower.includes("timeout")) return "Scan timed out — retry this side";
  if (lower.includes("keeping this accepted side")) return "Upload pending — reconnecting";
  if (lower.includes("upload") || lower.includes("network") || lower.includes("http")) return "Upload interrupted — retrying may be required";
  if (lower.includes("dpi") || lower.includes("dimension") || lower.includes("profile") || lower.includes("tiff")) return "Image rejected — invalid locked capture";
  return detail || "Scanner service needs attention — see service logs";
}

function renderRecent(recent) {
  els.recentList.replaceChildren();
  if (!Array.isArray(recent) || recent.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No accepted captures yet";
    item.style.color = "var(--muted)";
    els.recentList.append(item);
    return;
  }

  for (const entry of recent.slice(0, 5)) {
    const item = document.createElement("li");
    const target = document.createElement("span");
    target.textContent = `${entry.certId || "—"} ${toTitle(entry.side)}`;
    const time = document.createElement("span");
    time.textContent = entry.ts
      ? new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    item.append(target, time);
    els.recentList.append(item);
  }
}

function renderState(state) {
  lastState = state || {};
  els.scannerHealth.textContent = renderHealth(lastState.scannerHealth);
  renderTarget(lastState);
  renderWorkflowGuide(lastState);
  renderPositioningPreview(lastState.positioningPreview, lastState.scannerHealth, lastState.activeCapture);

  if (els.autoOpenOnError) els.autoOpenOnError.checked = lastState.autoOpenOnError !== false;
  if (els.soundEnabled) els.soundEnabled.checked = lastState.soundEnabled !== false;

  const activeState = String(lastState.state || "idle");
  els.dot.className = `dot ${activeState}`;
  els.statusText.textContent = STATE_LABELS[activeState] || toTitle(activeState);
  els.statusSub.textContent = actionError || (["error", "storage_pressure"].includes(activeState)
    ? explainFailure(lastState.lastError)
    : activeState === "success"
      ? "The original TIFF was accepted for the selected card side."
      : lastState.activeCapture?.side
        ? `${toTitle(lastState.activeCapture.side)} • ${lastState.activeCapture.certId || "server target"}`
        : "");

  renderCaptureActions(lastState);

  renderRecent(lastState.recent);

  const lastCert = lastState.lastUploadedCert;
  els.lastCertBtn.disabled = !lastCert;
  els.lastCertBtn.title = lastCert
    ? `Open ${lastCert} in the MintVault logbook`
    : "No accepted capture on this station yet";
  els.lastCertBtn.textContent = lastCert ? `Open ${lastCert}` : "Open latest certificate";
}

async function runCaptureAction(action) {
  if (actionInFlight) return;
  const previewId = lastState?.activeCapture?.previewId;
  actionInFlight = true;
  actionError = null;
  renderState(lastState);
  try {
    const result = await action(previewId);
    if (!result?.ok) actionError = result?.error || "Scanner action was not accepted";
  } catch (error) {
    actionError = error?.message || "Scanner action failed";
  } finally {
    actionInFlight = false;
    renderState(lastState);
  }
}

function createText(className, value) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = value;
  return element;
}

/**
 * P7 — the FIX queue.
 *
 * The server sends entries already shaped as the operator reads them aloud:
 *   MV421 — FRONT MISSING
 * The list is derived from THIS partner's own Card Jobs, so there is no MV number to type and no
 * way to name a card belonging to anybody else. Selecting one asks the server to authorise exactly
 * the missing side(s); it costs no Grading Credits and works at a zero balance.
 */
function renderMissingImages(items) {
  els.orphanList.replaceChildren();
  if (!items || !items.length) {
    els.orphanList.textContent = "No cards are waiting for a replacement image.";
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "orphan-row";
    const info = document.createElement("div");
    info.className = "orphan-info";
    info.append(
      createText("orphan-id", `${item.mvNumber} — ${item.missingLabel}`),
      createText("orphan-meta", item.cardName || "(unnamed card)"),
    );
    const actions = document.createElement("div");
    actions.className = "orphan-actions";
    const fixBtn = document.createElement("button");
    fixBtn.className = "btn primary";
    fixBtn.textContent = "FIX THIS CARD";
    fixBtn.addEventListener("click", async () => {
      fixBtn.disabled = true;
      try {
        const result = await window.scanner.authoriseFix({
          cardJobId: item.cardJobId,
          sides: item.missingSides,
        });
        if (!result?.ok) {
          alert(result?.error || "Could not start the fix");
          return;
        }
        closeModal(els.orphanModal);
      } finally {
        fixBtn.disabled = false;
      }
    });
    actions.append(fixBtn);
    row.append(info, actions);
    els.orphanList.append(row);
  }
}

els.hideBtn.addEventListener("click", () => window.scanner.hidePopover());

els.stationSignInForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = els.stationEmail.value.trim();
  const password = els.stationPassword.value;
  els.stationPassword.value = "";
  void runStationSetupAction(() => window.scanner.stationSignIn({ email, password }));
});
els.stationMfaForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = els.stationMfaCode.value.trim();
  const recoveryCode = els.stationRecoveryCode.value.trim();
  els.stationMfaCode.value = "";
  els.stationRecoveryCode.value = "";
  void runStationSetupAction(() => window.scanner.stationCompleteMfa({ code, recoveryCode }));
});
els.stationRegisterBtn.addEventListener("click", () => {
  const locationId = els.stationLocation.value || undefined;
  void runStationSetupAction(() => window.scanner.registerStation({ locationId }));
});

async function shiftChange() {
  if (!confirm("Sign out the current scanner user?\n\nThis Mac remains registered as the same MintVault station.")) return;
  const result = await window.scanner.stationSignOut();
  if (!result?.ok) {
    alert(result?.error || "Unable to switch user safely");
    return;
  }
  renderStationSetup(result);
}
els.signOutBtn.addEventListener("click", () => void shiftChange());
els.stationModalSignOutBtn.addEventListener("click", () => void shiftChange());

if (els.appVersion) {
  window.scanner.getVersion?.().then((result) => {
    if (result?.ok) els.appVersion.textContent = `v${result.version}`;
  }).catch(() => {});
}

async function updateAndRestart() {
  if (!confirm("Download the newer approved MintVault Scanner release, verify it, then restart this app?\n\nAn active physical scan must finish first.")) return;
  try {
    const result = await window.scanner.updateApp({ action: "update_and_restart" });
    renderUpdateStatus(result);
  } catch {
    renderUpdateStatus({ status: "error", error: "MintVault could not start the approved update. Use DMG Reinstall or contact support." });
  }
}

async function openDmgReinstall() {
  if (!confirm("Open the pinned MintVault release channel to reinstall the signed, notarized DMG?\n\nYour station identity and queued evidence stay in Application Support and Keychain.")) return;
  try {
    const result = await window.scanner.openDmgReinstall();
    if (!result?.ok) renderUpdateStatus({ status: "error", error: result?.error || "MintVault could not open the approved DMG reinstall option." });
  } catch {
    renderUpdateStatus({ status: "error", error: "MintVault could not open the approved DMG reinstall option." });
  }
}

els.updateBtn.addEventListener("click", () => void updateAndRestart());
els.stationUpdateBtn.addEventListener("click", () => void updateAndRestart());
els.reinstallBtn.addEventListener("click", () => void openDmgReinstall());
els.stationReinstallBtn.addEventListener("click", () => void openDmgReinstall());

els.orphansBtn.addEventListener("click", async () => {
  els.orphanList.textContent = "Loading…";
  openModal(els.orphanModal);
  const result = await window.scanner.fetchOrphans();
  if (!result?.ok) {
    els.orphanList.textContent = `Could not load missing images: ${result?.body?.error || result?.status || "unknown error"}`;
    return;
  }
  renderMissingImages((result.body && result.body.items) || result.body?.orphans || []);
});

els.orphanClose.addEventListener("click", () => closeModal(els.orphanModal));

els.logsBtn.addEventListener("click", () => window.scanner.openLogs());
els.lastCertBtn.addEventListener("click", () => {
  if (!els.lastCertBtn.disabled) window.scanner.openLastCert();
});

els.diagnosticsRow.addEventListener("toggle", () => {
  els.settingsBody.toggleAttribute("hidden", !els.diagnosticsRow.open);
  if (els.diagnosticsRow.open && lastState?.positioningPreview) {
    requestAnimationFrame(() => renderPositioningOverlays(lastState.positioningPreview));
  }
});
els.autoOpenOnError.addEventListener("change", () => window.scanner.setSetting("autoOpenOnError", els.autoOpenOnError.checked));
els.soundEnabled.addEventListener("change", () => window.scanner.setSetting("soundEnabled", els.soundEnabled.checked));
els.scanCardBtn.addEventListener("click", () => void runCaptureAction(() => window.scanner.scanTarget()));
els.positioningPreviewBtn.addEventListener("click", () => void runCaptureAction(() => window.scanner.runPositioningPreview()));
els.savePlacementBtn.addEventListener("click", () => void runCaptureAction((previewId) => window.scanner.applyPositioningPreview(lastState?.positioningPreview?.id || previewId)));
els.acceptPreviewBtn.addEventListener("click", () => void runCaptureAction((previewId) => window.scanner.acceptCapturePreview(previewId)));
els.rescanPreviewBtn.addEventListener("click", () => void runCaptureAction((previewId) => window.scanner.rescanCapturePreview(previewId)));
els.rescanErrorBtn.addEventListener("click", () => void runCaptureAction((previewId) => window.scanner.rescanCapturePreview(previewId)));
els.nextCardBtn.addEventListener("click", () => void runCaptureAction(() => window.scanner.acknowledgeCardRegistered()));

/**
 * P6 — NEW CARD.
 *
 * The button is disabled for the duration of the request so one press is one request. The retry
 * token itself lives in the main process, so even if a press slipped through twice the server would
 * answer the second from its idempotency record rather than the wallet — this is the convenience
 * guard, not the correctness one.
 *
 * Nothing here decides whether the shop can afford a card. The server answers, and a refusal is
 * shown verbatim: at zero credits the operator is told to buy more, not shown a broken button.
 */
async function startNewCard() {
  if (els.newCardBtn.disabled) return;
  els.newCardBtn.disabled = true;
  els.newCardError.hidden = true;
  const previousLabel = els.newCardBtn.textContent;
  els.newCardBtn.textContent = "STARTING…";
  try {
    const result = await window.scanner.startNewCard({});
    if (!result?.ok) {
      els.newCardError.textContent = result?.error || "Could not start a new card";
      els.newCardError.hidden = false;
      return;
    }
    els.cardCompletePanel.hidden = true;
  } catch (err) {
    els.newCardError.textContent = err?.message || "Could not reach MintVault";
    els.newCardError.hidden = false;
  } finally {
    els.newCardBtn.textContent = previousLabel;
    els.newCardBtn.disabled = false;
  }
}

els.newCardBtn.addEventListener("click", () => void startNewCard());

// NEXT CARD on the completion panel does BOTH: clears the finished card, then starts the next one,
// so the operator's loop is a single press per card rather than two.
els.completeNextCardBtn.addEventListener("click", async () => {
  els.cardCompletePanel.hidden = true;
  await runCaptureAction(() => window.scanner.acknowledgeCardRegistered());
  await startNewCard();
});

els.restartServiceBtn.addEventListener("click", async () => {
  if (!confirm("Restart the scanner service?\n\nUse this only when the service is unresponsive. An active capture may be interrupted.")) return;
  const original = els.restartServiceBtn.textContent;
  els.restartServiceBtn.disabled = true;
  els.restartServiceBtn.textContent = "Restarting…";
  const result = await window.scanner.resetScanner();
  els.restartServiceBtn.textContent = result?.status || (result?.ok ? "Restarted" : "Manual fix needed");
  setTimeout(() => {
    els.restartServiceBtn.disabled = false;
    els.restartServiceBtn.textContent = original;
  }, result?.escalated ? 4_000 : 1_800);
});

window.scanner.onStateUpdate(renderState);
window.scanner.onStationSetupUpdate?.(renderStationSetup);
window.scanner.onUpdateStatus?.(renderUpdateStatus);
window.scanner.getState().then(renderState);
window.scanner.getUpdateStatus?.().then(renderUpdateStatus).catch(() => {});
void refreshStationSetup();
window.addEventListener("resize", () => {
  if (!lastState?.positioningPreview) return;
  renderPositioningCardCrop(lastState.positioningPreview);
  if (els.diagnosticsRow.open) renderPositioningOverlays(lastState.positioningPreview);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const modal of [els.orphanModal]) {
    if (modal.classList.contains("visible")) {
      closeModal(modal);
      return;
    }
  }
});
