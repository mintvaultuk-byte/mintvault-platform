(() => {
  const query = new URL(window.location.href).searchParams;
  const stage = query.get("stage") || "profile_setup_required";
  const canServiceStation = query.get("service") === "1";
  const preview = query.get("preview") !== "0";
  const previewId = "ui-proof-preview";
  const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="820" viewBox="0 0 600 820"><rect width="600" height="820" fill="#202326"/><rect x="72" y="82" width="456" height="656" rx="18" fill="#33383c" stroke="#697077" stroke-width="5"/><rect x="186" y="220" width="228" height="320" rx="12" fill="#b86adc" stroke="#f2d5ff" stroke-width="5"/><path d="M164 196h272v368H164z" fill="none" stroke="#4ade80" stroke-width="8" stroke-dasharray="14 10"/><text x="300" y="620" text-anchor="middle" fill="#4ade80" font-family="system-ui" font-size="23" font-weight="700">FULL CARD + SAFE MARGIN</text></svg>`;
  const dataUrl = `data:image/svg+xml;base64,${btoa(previewSvg)}`;
  const setup = {
    ok: true,
    stage,
    canSignOut: true,
    canServiceStation,
    stationCode: "MV-STN-ABCDEFGHJK",
    calibrationStatus: stage === "active" ? "VALID" : "UNPROVISIONED",
    summary: { organisationName: "MintVault Partner", locationName: "Pilot Shop 0", displayName: "Alex Morgan", availableCredits: 14 },
  };
  const positioningPreview = preview ? {
    id: previewId,
    status: "detected",
    verificationStatus: "idle",
    capture: { areaMm: { x: 0, y: 0, width: 216, height: 297 } },
    cardCandidate: { cardBoundsMm: { x: 41, y: 61, width: 63, height: 88 } },
    placement: { ready: true, originMm: { x: 22, y: 39 }, areaMm: { width: 100, height: 130 }, placementToleranceMm: 14 },
  } : null;
  const state = {
    state: "idle",
    scannerHealth: { status: stage === "active" ? "ready" : "profile_unprovisioned", model: "CanoScan LiDE 400", deviceId: "ica:lide400:pilot" },
    positioningPreview,
    activeCapture: null,
    recent: [],
  };
  const noOp = async () => ({ ok: true });
  window.scanner = {
    getState: async () => state,
    getStationSetup: async () => setup,
    getVersion: async () => ({ ok: true, version: "1.2.1" }),
    getUpdateStatus: async () => ({ status: "up_to_date" }),
    getPositioningPreview: async (id) => id === previewId ? { ok: true, dataUrl } : { ok: false },
    onStateUpdate: () => () => {},
    onStationSetupUpdate: () => () => {},
    onUpdateStatus: () => () => {},
    runPositioningPreview: noOp,
    applyPositioningPreview: async () => ({ ...setup, stage: "active", calibrationStatus: "VALID" }),
    hidePopover: noOp,
    stationSignIn: noOp,
    stationCompleteMfa: noOp,
    registerStation: noOp,
    stationSignOut: async () => ({ ok: true, stage: "sign_in" }),
    updateApp: noOp,
    openDmgReinstall: noOp,
    fetchOrphans: async () => ({ ok: true, body: { items: [] } }),
    authoriseFix: noOp,
    openLogs: noOp,
    openLastCert: noOp,
    setSetting: noOp,
    scanTarget: noOp,
    getCapturePreview: noOp,
    acceptCapturePreview: noOp,
    rescanCapturePreview: noOp,
    startNewCard: noOp,
    acknowledgeCardRegistered: noOp,
    resetScanner: noOp,
  };
})();
