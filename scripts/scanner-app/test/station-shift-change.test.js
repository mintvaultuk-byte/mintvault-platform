const test = require("node:test");
const assert = require("node:assert/strict");
const { _private } = require("../lib/station-client");

test("SHIFT CHANGE clears the local person before waiting for remote revocation", async () => {
  const events = [];
  let release;
  const pending = _private.signOutWith({
    token: "operator-session-token-value",
    clearSession: () => events.push("cleared"),
    origin: "https://mintvault.test",
    fetchImpl: async (_url, init) => {
      events.push("network-started");
      assert.match(init.headers.cookie, /^mv\.partner\.sid=/);
      await new Promise((resolve) => { release = resolve; });
      return { ok: true };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["cleared", "network-started"]);
  release();
  assert.deepEqual(await pending, { ok: true, remoteRevoked: true });
});

test("SHIFT CHANGE remains locally complete when MintVault is offline", async () => {
  let cleared = false;
  const result = await _private.signOutWith({
    token: "operator-session-token-value",
    clearSession: () => { cleared = true; },
    origin: "https://mintvault.test",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(cleared, true);
  assert.deepEqual(result, { ok: true, remoteRevoked: false });
});
