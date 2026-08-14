"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { directFetch, boundedResponseText } = require("../lib/http-safety");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("login, signed JSON and staged PUT never follow a cross-origin 307", async (t) => {
  let secondHopRequests = 0;
  const attacker = http.createServer((_request, response) => {
    secondHopRequests += 1;
    response.writeHead(204).end();
  });
  const attackerPort = await listen(attacker);
  const pinned = http.createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${attackerPort}/collect` }).end();
  });
  const pinnedPort = await listen(pinned);
  t.after(() => { pinned.close(); attacker.close(); });
  const fetch = (await import("node-fetch")).default;

  for (const init of [
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "operator@example.com", password: "secret" }) },
    { method: "POST", headers: { "x-mintvault-station-signature": "secret" }, body: "{}" },
    { method: "PUT", headers: { "x-upload-grant": "secret" }, body: Buffer.from("tiff") },
  ]) {
    await assert.rejects(directFetch(fetch, `http://127.0.0.1:${pinnedPort}/pinned`, init), /redirect/i);
  }
  assert.equal(secondHopRequests, 0);
});

test("API response bodies are bounded even when content-length is absent", async () => {
  const body = {
    headers: { get: () => null },
    body: (async function* () { yield Buffer.alloc(8); yield Buffer.alloc(8); })(),
  };
  await assert.rejects(boundedResponseText(body, 12), /size limit/);
});

test("all Scanner credential/evidence fetch sites use direct no-redirect transport", () => {
  for (const name of ["station-client.js", "server-client.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", name), "utf8");
    assert.equal(/await fetch(?:Impl)?\(/.test(source), false, `${name} bypassed directFetch`);
    assert.match(source, /directFetch\(/);
  }
});
