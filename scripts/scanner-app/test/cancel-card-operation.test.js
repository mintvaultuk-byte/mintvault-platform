"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const semanticOperations = require("../lib/semantic-operations");
const cancellation = require("../lib/cancel-card-operation");
const { semanticAuthority } = require("./semantic-authority-fixture");

function target(overrides = {}) {
  return {
    cardJobId: "card-job-123",
    captureSessionId: "capture-session-123",
    captureAuthorisationId: "capture-authorisation-123",
    ...overrides,
  };
}

test("CANCEL persists one exact operation across response loss, restart and double click", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-cancel-operation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "operations.json");
  const authority = semanticAuthority();
  const first = cancellation._private.createCoordinator(semanticOperations._private.createStore(file, authority));
  const operation = first.beginOrResume(target());
  assert.equal(first.beginOrResume(target()).id, operation.id, "double click reuses the same durable operation");

  const restarted = cancellation._private.createCoordinator(semanticOperations._private.createStore(file, authority));
  assert.equal(restarted.beginOrResume(target()).id, operation.id, "response loss/restart reuses the same operation");
  assert.throws(() => restarted.beginOrResume(target({ captureSessionId: "capture-session-999" })), { code: "IDEMPOTENCY_CONFLICT" });
  restarted.complete(operation, "cancelled:card-job-123:capture-session-123:credit-released");
  const completedReplay = restarted.beginOrResume(target());
  assert.equal(completedReplay.id, operation.id);
  assert.equal(completedReplay.state, "COMPLETED");
  assert.equal(cancellation.completedOutcome(completedReplay).status, "CANCELLED");

  const refusedTarget = target({ cardJobId: "card-job-456", captureSessionId: "capture-session-456", captureAuthorisationId: "capture-authorisation-456" });
  const refused = restarted.beginOrResume(refusedTarget);
  restarted.complete(refused, "refused:card-job-456:accepted-evidence");
  const refusedReplay = restarted.beginOrResume(refusedTarget);
  assert.equal(refusedReplay.id, refused.id);
  assert.equal(cancellation.completedOutcome(refusedReplay).status, "REFUSED_ACCEPTED_EVIDENCE");
});

test("only exact zero-evidence release authority completes CANCEL", () => {
  const operation = { id: "9d1b2553-8874-42c4-9ec6-40a37ccce9f5", payload: target() };
  const exact = {
    ok: true,
    body: { cancellation: {
      clientOpId: operation.id,
      cardJobId: operation.payload.cardJobId,
      captureSessionId: operation.payload.captureSessionId,
      status: "CANCELLED",
      acceptedEvidenceCount: 0,
      creditSpent: false,
      reservationReleased: true,
    } },
  };
  assert.ok(cancellation.validateCancellation(operation, exact));
  for (const changed of [
    { ...exact, body: {} },
    { ...exact, body: { cancellation: { ...exact.body.cancellation, cardJobId: "card-job-other" } } },
    { ...exact, body: { cancellation: { ...exact.body.cancellation, acceptedEvidenceCount: 1 } } },
    { ...exact, body: { cancellation: { ...exact.body.cancellation, creditSpent: true } } },
    { ...exact, body: { cancellation: { ...exact.body.cancellation, reservationReleased: false } } },
  ]) assert.equal(cancellation.validateCancellation(operation, changed), null);

  assert.equal(cancellation.definitiveEvidenceRefusal(operation, {
    ok: false,
    status: 409,
    body: { error: { code: "CARD_JOB_HAS_ACCEPTED_EVIDENCE", cardJobId: operation.payload.cardJobId } },
  }), true);
  assert.equal(cancellation.completedOutcome({
    ...operation,
    state: "COMPLETED",
    resultReference: "refused:card-job-123:accepted-evidence",
  }).status, "REFUSED_ACCEPTED_EVIDENCE");
  assert.throws(() => cancellation.completedOutcome({ ...operation, state: "COMPLETED", resultReference: "unknown" }), /invalid durable outcome/);
});
