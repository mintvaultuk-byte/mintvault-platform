const crypto = require("node:crypto");
const semanticOperations = require("./semantic-operations");

function normaliseCardName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim();
  if (name.length > 240) throw new Error("Card name is too long");
  return name;
}

function validatedCardJobId(result) {
  const value = result?.body?.cardJob?.cardJobId;
  return result?.ok === true && typeof value === "string" && value.length >= 8 ? value : null;
}

function isDefinitivelyUnspent(result) {
  return result?.status === 402 && result?.body?.error?.code === "INSUFFICIENT_CREDITS";
}

function createCoordinator(store = semanticOperations) {
  return Object.freeze({
    beginOrResume(cardName) {
      const existing = store.pending("CARD_JOB_NEW");
      if (existing) return existing;
      const canonicalName = normaliseCardName(cardName);
      return store.begin({
        key: `card-job-new:${crypto.randomUUID()}`,
        type: "CARD_JOB_NEW",
        payload: { cardName: canonicalName },
      });
    },
    complete(operation, resultReference) {
      return store.complete(operation.id, resultReference);
    },
  });
}

const sharedCoordinator = createCoordinator();
module.exports = Object.freeze({
  beginOrResume: sharedCoordinator.beginOrResume,
  complete: sharedCoordinator.complete,
  validatedCardJobId,
  isDefinitivelyUnspent,
  _private: { createCoordinator, normaliseCardName },
});
