/** Process-wide fail-closed projection of signed-station protocol failures. */
let latched = null;

function errorCode(result) {
  return typeof result?.body?.error?.code === "string" ? result.body.error.code : null;
}

function observe(result) {
  const code = errorCode(result);
  if (result?.status === 409 && code === "station_replay") {
    latched = Object.freeze({
      ok: true,
      stage: "replay_state_desync",
      error: "Station replay state is out of sync. Secure recovery is required before physical work can continue.",
    });
  }
  return result;
}

function current() {
  return latched;
}

// The normal request path must never clear this. Only the authenticated P14
// resync completion may call clearAfterResync after installing a newer epoch.
function clearAfterResync() {
  latched = null;
}

// Exact device retirement destroys the credential whose replay state was
// latched. A later fresh identity must not inherit that credential's denial.
function clearAfterIdentityRetirement() {
  latched = null;
}

module.exports = Object.freeze({ observe, current, clearAfterResync, clearAfterIdentityRetirement, _private: { errorCode } });
