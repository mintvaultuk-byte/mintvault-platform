"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const semanticOperations = require("../lib/semantic-operations");
const { _private } = require("../lib/fix-operation");
const { semanticAuthority } = require("./semantic-authority-fixture");

test("FIX authorisation survives response loss/restart with one exact V2 operation", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-fix-operation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "operations.json");
  const authority = semanticAuthority();
  const first = _private.createCoordinator(semanticOperations._private.createStore(file, authority));
  const operation = first.beginOrResume("card-job-123", ["back", "front"]);
  const restarted = _private.createCoordinator(semanticOperations._private.createStore(file, authority));
  const replay = restarted.beginOrResume("card-job-123", ["front", "back"]);
  assert.equal(replay.id, operation.id);
  assert.deepEqual(replay.payload, { cardJobId: "card-job-123", sides: ["back", "front"] });
  assert.throws(() => restarted.beginOrResume("card-job-456", ["front"]), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => restarted.beginOrResume("card-job-123", ["front"]), { code: "IDEMPOTENCY_CONFLICT" });
  restarted.complete(replay, "fix:card-job-123:MV123:back+front");
  assert.notEqual(restarted.beginOrResume("card-job-456", ["front"]).id, operation.id);
});
