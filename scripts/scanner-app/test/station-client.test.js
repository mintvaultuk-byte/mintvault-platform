const test = require("node:test");
const assert = require("node:assert/strict");
const { _private } = require("../lib/station-client");

test("station client extracts only the Partner session cookie", () => {
  const response = { headers: { get: () => "other=x; Path=/, mv.partner.sid=opaque-token_123; HttpOnly; Path=/" } };
  assert.equal(_private.cookieTokenFrom(response), "opaque-token_123");
  assert.equal(_private.cookieTokenFrom({ headers: { get: () => "other=x" } }), null);
});

test("calibration mutations require the V2 semantic-operation signature", async () => {
  await assert.rejects(
    _private.signedJsonV2("POST", "/api/partner/stations/calibrations", {}, "not-an-operation"),
    /valid semantic operation ID/,
  );
  const source = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "..", "lib", "station-client.js"), "utf8");
  assert.match(source, /saveCalibration[\s\S]*signedJsonV2\([\s\S]*payload\?\.semanticOperationId/);
  assert.match(source, /signStoredRequestV2\([\s\S]*semanticOperationId/);
});
