"use strict";

const crypto = require("node:crypto");
const semanticOperations = require("./semantic-operations");

function normalizedPayload(cardJobId, sides) {
  if (typeof cardJobId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(cardJobId)) throw new Error("FIX card job is invalid");
  if (!Array.isArray(sides) || sides.length < 1 || sides.length > 2 || sides.some((side) => !["front", "back"].includes(side))) {
    throw new Error("FIX sides are invalid");
  }
  return Object.freeze({ cardJobId, sides: [...new Set(sides)].sort() });
}

function createCoordinator(store = semanticOperations) {
  return Object.freeze({
    beginOrResume(cardJobId, sides) {
      const payload = normalizedPayload(cardJobId, sides);
      const pending = store.pending("FIX_AUTHORISE");
      if (pending) {
        if (JSON.stringify(pending.payload) !== JSON.stringify(payload)) {
          const error = new Error("A different FIX authorisation is awaiting recovery");
          error.code = "IDEMPOTENCY_CONFLICT";
          throw error;
        }
        return pending;
      }
      return store.begin({ key: `fix-authorise:${crypto.randomUUID()}`, type: "FIX_AUTHORISE", payload });
    },
    complete(operation, resultReference) { return store.complete(operation.id, resultReference); },
  });
}

const shared = createCoordinator();
module.exports = Object.freeze({
  beginOrResume: shared.beginOrResume,
  complete: shared.complete,
  _private: { normalizedPayload, createCoordinator },
});
