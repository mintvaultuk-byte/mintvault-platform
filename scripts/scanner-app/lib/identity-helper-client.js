const { spawnSync } = require("node:child_process");
const helperIntegrity = require("./helper-integrity");

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

class IdentityHelperError extends Error {
  constructor(code, message) {
    super(message || "Station identity operation failed");
    this.name = "IdentityHelperError";
    this.code = code || "IDENTITY_HELPER_FAILED";
  }
}

function call(command, payload = {}) {
  if (typeof command !== "string" || !/^[a-z0-9-]{1,40}$/.test(command)) {
    throw new IdentityHelperError("INVALID_COMMAND", "Identity helper command is invalid");
  }
  const request = Buffer.from(JSON.stringify({ command, ...payload }));
  if (request.length > MAX_REQUEST_BYTES) throw new IdentityHelperError("INVALID_REQUEST", "Identity helper request is too large");
  const helper = helperIntegrity.verifiedIdentityHelper();
  const child = spawnSync(helper.path, [], {
    input: request,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: MAX_RESPONSE_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.error) throw new IdentityHelperError("IDENTITY_HELPER_UNAVAILABLE", "Station identity helper is unavailable");
  let result;
  try {
    result = helperIntegrity.assertCompatibleIdentityResult(JSON.parse(String(child.stdout || "")));
  } catch {
    throw new IdentityHelperError("IDENTITY_HELPER_PROTOCOL", "Station identity helper returned an invalid response");
  }
  if (child.status !== 0 || result.ok !== true) {
    throw new IdentityHelperError(result.error?.code, result.error?.message);
  }
  return result;
}

module.exports = {
  IdentityHelperError,
  status: () => call("status"),
  create: () => call("create"),
  migrateV1: (payload) => call("migrate-v1", payload),
  bindStation: (payload) => call("bind-station", payload),
  setStatus: (stationStatus) => call("set-status", { stationStatus }),
  signRequestV1: (payload) => call("sign-request-v1", payload),
  signRequestV2: (payload) => call("sign-request-v2", payload),
  signResyncChallenge: (payload) => call("sign-resync-challenge", payload),
  applyReplayState: (payload) => call("apply-replay-state", payload),
  wrapQueueKey: (payload) => call("wrap-queue-key", payload),
  unwrapQueueKey: (payload) => call("unwrap-queue-key", payload),
  semanticLedgerStatus: () => call("semantic-ledger-status"),
  semanticLedgerPrepare: (payload) => call("semantic-ledger-prepare", payload),
  semanticLedgerCommit: (payload) => call("semantic-ledger-commit", payload),
  semanticLedgerAbort: (payload) => call("semantic-ledger-abort", payload),
  retire: (expectedFingerprint) => call("retire", { expectedFingerprint }),
  _private: { call, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES },
};
