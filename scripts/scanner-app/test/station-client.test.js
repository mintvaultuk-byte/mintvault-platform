const test = require("node:test");
const assert = require("node:assert/strict");
const { _private } = require("../lib/station-client");

test("station client extracts only the Partner session cookie", () => {
  const response = { headers: { get: () => "other=x; Path=/, mv.partner.sid=opaque-token_123; HttpOnly; Path=/" } };
  assert.equal(_private.cookieTokenFrom(response), "opaque-token_123");
  assert.equal(_private.cookieTokenFrom({ headers: { get: () => "other=x" } }), null);
});
