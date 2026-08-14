"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const BRIDGE_VERSION = 3;

function rendererUrl(appDirectory) {
  return pathToFileURL(path.join(appDirectory, "renderer", "index.html")).href;
}

function isTrustedRendererEvent(event, window, expectedUrl) {
  if (!event || !window || window.isDestroyed?.()) return false;
  const contents = window.webContents;
  return Boolean(contents
    && event.sender === contents
    && event.senderFrame === contents.mainFrame
    && event.senderFrame?.url === expectedUrl);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boundedText(value, maximum = 500) {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

function copyRect(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ["x", "y", "width", "height", "left", "top", "right", "bottom"]) {
    const number = finiteNumber(value[key]);
    if (number !== undefined) result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
}

function copyPlacement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const placement = {
    ready: value.ready === true,
    proposedHardwareRectMm: copyRect(value.proposedHardwareRectMm),
    areaMm: copyRect(value.areaMm),
    originMm: copyRect(value.originMm),
    surroundingAvailableMm: copyRect(value.surroundingAvailableMm),
    minimumMoveInwardMm: copyRect(value.minimumMoveInwardMm),
  };
  for (const key of ["placementToleranceMm", "observedEvidenceMarginMm", "evidenceMarginRequiredMm"]) {
    const number = finiteNumber(value[key]);
    if (number !== undefined) placement[key] = number;
  }
  placement.evidenceMarginSatisfied = value.evidenceMarginSatisfied === true;
  return placement;
}

function rendererStateProjection(raw) {
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const active = state.activeCapture && typeof state.activeCapture === "object" ? state.activeCapture : null;
  const accepted = state.lastAcceptedCapture && typeof state.lastAcceptedCapture === "object" ? state.lastAcceptedCapture : null;
  const health = state.scannerHealth && typeof state.scannerHealth === "object" ? state.scannerHealth : {};
  const preview = state.positioningPreview && typeof state.positioningPreview === "object" ? state.positioningPreview : null;

  return Object.freeze({
    state: boundedText(state.state, 64) || "idle",
    lastError: boundedText(state.lastError, 500) || null,
    lastUploadedCert: /^MV\d+$/i.test(String(state.lastUploadedCert || "")) ? String(state.lastUploadedCert).toUpperCase() : null,
    autoOpenOnError: state.autoOpenOnError !== false,
    soundEnabled: state.soundEnabled !== false,
    scannerHealth: Object.freeze({
      status: boundedText(health.status, 64) || "checking",
      ...(boundedText(health.error, 240) ? { error: boundedText(health.error, 240) } : {}),
    }),
    activeCapture: active ? Object.freeze({
      certId: boundedText(active.certId, 64) || null,
      side: ["front", "back"].includes(active.side) ? active.side : null,
      stage: boundedText(active.stage, 64) || null,
      previewId: boundedText(active.previewId, 64) || null,
      cancelEligible: active.cancelEligible === true,
    }) : null,
    lastAcceptedCapture: accepted ? Object.freeze({
      certId: boundedText(accepted.certId, 64) || null,
      side: ["front", "back"].includes(accepted.side) ? accepted.side : null,
      cardRegistered: accepted.cardRegistered === true,
    }) : null,
    positioningPreview: preview ? Object.freeze({
      id: boundedText(preview.id, 64) || null,
      status: boundedText(preview.status, 64) || null,
      error: boundedText(preview.error, 500) || null,
      verificationStatus: boundedText(preview.verificationStatus, 64) || null,
      calibrationError: boundedText(preview.calibrationError, 500) || null,
      capture: preview.capture ? Object.freeze({ areaMm: copyRect(preview.capture.areaMm) }) : undefined,
      cardCandidate: preview.cardCandidate ? Object.freeze({ cardBoundsMm: copyRect(preview.cardCandidate.cardBoundsMm) }) : undefined,
      placement: copyPlacement(preview.placement),
      persisted: preview.persisted ? Object.freeze({
        originMm: copyRect(preview.persisted.originMm),
        areaMm: copyRect(preview.persisted.areaMm),
      }) : undefined,
    }) : null,
    recent: Object.freeze((Array.isArray(state.recent) ? state.recent : []).slice(0, 5).map((entry) => Object.freeze({
      certId: boundedText(entry?.certId, 64) || null,
      side: ["front", "back"].includes(entry?.side) ? entry.side : null,
      ts: boundedText(entry?.ts, 40) || null,
    }))),
  });
}

function safeUpdateStatus(value) {
  const status = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    status: boundedText(status.status, 64) || "unknown",
    ...(boundedText(status.version, 64) ? { version: boundedText(status.version, 64) } : {}),
    ...(boundedText(status.currentVersion, 64) ? { currentVersion: boundedText(status.currentVersion, 64) } : {}),
    ...(boundedText(status.error, 500) ? { error: boundedText(status.error, 500) } : {}),
    ...(finiteNumber(status.percent) !== undefined ? { percent: Math.max(0, Math.min(100, finiteNumber(status.percent))) } : {}),
  });
}

module.exports = {
  BRIDGE_VERSION,
  rendererUrl,
  isTrustedRendererEvent,
  rendererStateProjection,
  safeUpdateStatus,
};
