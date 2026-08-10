const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

test("scanner client uploads original TIFF bytes as image/tiff for pair and manual attach", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await listen(server);
  t.after(() => close(server));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-tiff-upload-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  // Valid little-endian classic TIFF header followed by byte values that make
  // accidental JPEG re-encoding immediately detectable in the request body.
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0xff, 0x00, 0x93, 0x7e]);
  const source = path.join(tempDir, "v850-master.tif");
  fs.writeFileSync(source, tiff);

  const priorBase = process.env.MINTVAULT_API_BASE;
  process.env.MINTVAULT_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const clientPath = require.resolve("../lib/server-client");
  delete require.cache[clientPath];
  const client = require("../lib/server-client");
  t.after(() => {
    if (priorBase === undefined) delete process.env.MINTVAULT_API_BASE;
    else process.env.MINTVAULT_API_BASE = priorBase;
    delete require.cache[clientPath];
  });

  await client.uploadPair(source, source, "test-key");
  await client.attachImage("MV58A", "front", source, false);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.equal(request.body.includes(tiff), true, "original TIFF bytes must be sent unchanged");
    assert.match(request.body.toString("latin1"), /Content-Type: image\/tiff/);
    assert.doesNotMatch(request.body.toString("latin1"), /Content-Type: image\/jpeg/);
  }
  assert.equal(requests[0].url, "/api/admin/scan-ingest");
  assert.equal(requests[1].url, "/api/admin/certs/MV58A/image");
});

test("scanner client rejects a non-TIFF before attempting authoritative upload", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-not-tiff-"));
  try {
    const source = path.join(tempDir, "not-a-tiff.tif");
    fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client = require("../lib/server-client");
    assert.throws(() => client._private.assertTiffMaster(source), /not TIFF-signature data/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
