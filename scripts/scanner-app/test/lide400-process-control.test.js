"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lide = require("../lib/lide400-controller");
const integrity = require("../lib/helper-integrity");

const valid = JSON.stringify({
  ok: true,
  protocolVersion: integrity.HELPER_PROTOCOL_VERSION,
  helperVersion: integrity.HELPER_VERSION,
  status: "ready",
});

test("a SIGTERM-ignoring helper retains the global lease until confirmed SIGKILL close", async () => {
  const first = lide._private.run(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], 100, { killGraceMs: 250 });
  const firstRejected = assert.rejects(first, /timed out/);
  let secondSettled = false;
  const second = lide._private.run(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(valid)})`], 2_000)
    .finally(() => { secondSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 175));
  assert.equal(secondSettled, false, "a second helper must not spawn/settle while the first child is alive");
  await firstRejected;
  assert.equal((await second).status, "ready");
});

test("helper output is bounded and the process is reaped before the lease releases", async () => {
  await assert.rejects(
    lide._private.run(process.execPath, ["-e", `process.stdout.write(Buffer.alloc(${lide._private.MAX_HELPER_STDOUT_BYTES + 1}, 65))`], 2_000, { killGraceMs: 20 }),
    /stdout exceeded its size limit/,
  );
  assert.equal((await lide._private.run(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(valid)})`], 2_000)).status, "ready");
});

test("capture attestation consumes the opened file object across a pathname replacement", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-lide-attestation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capturedPath = path.join(root, "capture.tiff");
  const original = crypto.randomBytes(128 * 1024);
  fs.writeFileSync(capturedPath, original, { mode: 0o600 });
  const result = {
    fileSizeBytes: original.length,
    fileSha256: crypto.createHash("sha256").update(original).digest("hex"),
  };
  const opened = lide._private.openAttestedCapture(capturedPath, result, {
    afterOpen() {
      fs.renameSync(capturedPath, `${capturedPath}.original`);
      fs.writeFileSync(capturedPath, Buffer.alloc(original.length, 0x41), { mode: 0o600 });
    },
  });
  try {
    const recovered = Buffer.alloc(original.length);
    assert.equal(fs.readSync(opened.descriptor, recovered, 0, recovered.length, 0), recovered.length);
    assert.deepEqual(recovered, original);
  } finally {
    fs.closeSync(opened.descriptor);
  }
});

test("capture substitution before the stable open cannot satisfy helper attestation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-lide-attestation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capturedPath = path.join(root, "capture.tiff");
  const original = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(capturedPath, Buffer.alloc(original.length, 0x42), { mode: 0o600 });
  assert.throws(() => lide._private.openAttestedCapture(capturedPath, {
    fileSizeBytes: original.length,
    fileSha256: crypto.createHash("sha256").update(original).digest("hex"),
  }), /digest does not match/);
});
