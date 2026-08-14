const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const semanticOperations = require("../lib/semantic-operations");
const newCard = require("../lib/new-card-operation");
const { _private } = newCard;
const { semanticAuthority } = require("./semantic-authority-fixture");

test("NEW survives restart with the same op ID and exact original payload", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-new-operation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "operations.json");
  const authority = semanticAuthority();
  const firstProcess = _private.createCoordinator(semanticOperations._private.createStore(file, authority));
  const first = firstProcess.beginOrResume("  Original card  ");
  assert.deepEqual(first.payload, { cardName: "Original card" });

  const restartedProcess = _private.createCoordinator(semanticOperations._private.createStore(file, authority));
  const replay = restartedProcess.beginOrResume("Changed after response loss");
  assert.equal(replay.id, first.id);
  assert.deepEqual(replay.payload, { cardName: "Original card" });
  restartedProcess.complete(replay, "card-job:job-123");

  const next = restartedProcess.beginOrResume("Second card");
  assert.notEqual(next.id, first.id);
  assert.deepEqual(next.payload, { cardName: "Second card" });
});

test("only a validated job or explicit no-credit refusal can close NEW", () => {
  assert.equal(newCard.validatedCardJobId({ ok: true, body: { cardJob: { cardJobId: "job-12345678" } } }), "job-12345678");
  for (const ambiguous of [
    { ok: true, body: {} },
    { ok: false, status: 502, body: { error: { code: "gateway" } } },
    { ok: false, status: 503, body: { error: { code: "unavailable" } } },
    { ok: false, status: 504, body: { error: { code: "timeout" } } },
  ]) {
    assert.equal(newCard.validatedCardJobId(ambiguous), null);
    assert.equal(newCard.isDefinitivelyUnspent(ambiguous), false);
  }
  assert.equal(newCard.isDefinitivelyUnspent({
    ok: false, status: 402, body: { error: { code: "INSUFFICIENT_CREDITS" } },
  }), true);
});
