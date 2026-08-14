"use strict";

const semanticOperations = require("./semantic-operations");

function requiredIdentifier(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function normalizedPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Card cancellation target is invalid");
  return Object.freeze({
    cardJobId: requiredIdentifier(input.cardJobId, "Cancellation Card Job"),
    captureSessionId: requiredIdentifier(input.captureSessionId, "Cancellation capture session"),
    captureAuthorisationId: requiredIdentifier(input.captureAuthorisationId, "Cancellation capture authorisation"),
  });
}

function samePayload(left, right) {
  return ["cardJobId", "captureSessionId", "captureAuthorisationId"].every((field) => left?.[field] === right?.[field]);
}

function createCoordinator(store = semanticOperations) {
  return Object.freeze({
    beginOrResume(input) {
      const payload = normalizedPayload(input);
      const pending = store.pending("CARD_JOB_CANCEL");
      if (pending) {
        if (!samePayload(pending.payload, payload)) {
          const error = new Error("A different Card Job cancellation is awaiting recovery");
          error.code = "IDEMPOTENCY_CONFLICT";
          throw error;
        }
        return pending;
      }
      return store.begin({
        key: `card-job-cancel:${payload.cardJobId}`,
        type: "CARD_JOB_CANCEL",
        payload,
      });
    },
    complete(operation, resultReference) { return store.complete(operation.id, resultReference); },
  });
}

function validateCancellation(operation, result) {
  const expected = normalizedPayload(operation?.payload);
  const cancellation = result?.body?.cancellation;
  if (result?.ok !== true || !cancellation || typeof cancellation !== "object" || Array.isArray(cancellation)
      || cancellation.clientOpId !== operation.id
      || cancellation.cardJobId !== expected.cardJobId
      || cancellation.captureSessionId !== expected.captureSessionId
      || cancellation.status !== "CANCELLED"
      || cancellation.acceptedEvidenceCount !== 0
      || cancellation.creditSpent !== false
      || cancellation.reservationReleased !== true) {
    return null;
  }
  return Object.freeze({
    cardJobId: expected.cardJobId,
    captureSessionId: expected.captureSessionId,
    resultReference: `cancelled:${expected.cardJobId}:${expected.captureSessionId}:credit-released`,
  });
}

function definitiveEvidenceRefusal(operation, result) {
  const error = result?.body?.error;
  return result?.ok === false && result?.status === 409
    && error?.code === "CARD_JOB_HAS_ACCEPTED_EVIDENCE"
    && error?.cardJobId === operation?.payload?.cardJobId;
}

function completedOutcome(operation) {
  if (operation?.state !== "COMPLETED") return null;
  const payload = normalizedPayload(operation.payload);
  const success = `cancelled:${payload.cardJobId}:${payload.captureSessionId}:credit-released`;
  const refused = `refused:${payload.cardJobId}:accepted-evidence`;
  if (operation.resultReference === success) return Object.freeze({ status: "CANCELLED", payload });
  if (operation.resultReference === refused) return Object.freeze({ status: "REFUSED_ACCEPTED_EVIDENCE", payload });
  throw new Error("Completed Card Job cancellation has an invalid durable outcome");
}

function recover(operationId, target) {
  const expected = normalizedPayload(target);
  const operation = semanticOperations.find(operationId);
  if (!operation || operation.type !== "CARD_JOB_CANCEL" || !samePayload(operation.payload, expected)) {
    throw new Error("Local Card Job cancellation marker does not match its authenticated semantic operation");
  }
  return operation;
}

const shared = createCoordinator();
module.exports = Object.freeze({
  beginOrResume: shared.beginOrResume,
  complete: shared.complete,
  pending: () => semanticOperations.pending("CARD_JOB_CANCEL"),
  recover,
  validateCancellation,
  definitiveEvidenceRefusal,
  completedOutcome,
  _private: { normalizedPayload, samePayload, createCoordinator },
});
