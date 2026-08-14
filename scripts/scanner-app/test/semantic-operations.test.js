const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const operations = require("../lib/semantic-operations");

function storeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-semantic-operations-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "store.json");
  return { file, store: operations._private.createStore(file) };
}

test("begin durably binds one UUID to semantic scope before returning", (t) => {
  const { file, store } = storeFixture(t);
  const first = store.begin({ key: "enrol:device-a", type: "STATION_ENROLMENT", payload: { b: 2, a: 1 } });
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.payload, { a: 1, b: 2 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).operations[0].id, first.id);

  const replay = store.begin({ key: "enrol:device-a", type: "STATION_ENROLMENT", payload: { a: 1, b: 2 } });
  assert.equal(replay.id, first.id);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.payload, first.payload);
  assert.throws(() => store.begin({ key: "enrol:device-a", type: "STATION_ENROLMENT", payload: { a: 9, b: 2 } }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.throws(() => store.begin({ key: "enrol:device-a", type: "CARD_JOB", payload: { a: 1, b: 2 } }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
});

test("completion is immutable and corrupt stores fail closed", (t) => {
  const { file, store } = storeFixture(t);
  const pending = store.begin({ key: "new-card:press-1", type: "CARD_JOB", payload: { cardName: "Example" } });
  assert.equal(store.pending("CARD_JOB").id, pending.id);
  const completed = store.complete(pending.id, "job-123");
  assert.equal(completed.state, "COMPLETED");
  assert.equal(store.pending("CARD_JOB"), null);
  assert.equal(store.complete(pending.id, "job-123").resultReference, "job-123");
  assert.throws(() => store.complete(pending.id, "job-456"), { code: "IDEMPOTENCY_CONFLICT" });
  fs.writeFileSync(file, "not-json");
  assert.throws(() => store.read(), /corrupt; mutations are paused/);
});

test("stored payload tampering fails closed", (t) => {
  const { file, store } = storeFixture(t);
  store.begin({ key: "enrol:one", type: "STATION_ENROLMENT", payload: { locationId: "location-a" } });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.operations[0].payload.locationId = "location-b";
  fs.writeFileSync(file, JSON.stringify(parsed));
  assert.throws(() => store.read(), /payload does not match/);
});

test("completed history compacts without deleting any unresolved operation", (t) => {
  const { file, store } = storeFixture(t);
  const records = Array.from({ length: operations._private.MAX_OPERATIONS }, (_, index) => {
    const payload = { index };
    return {
      id: crypto.randomUUID(), key: `completed:${index}`, type: "CARD_JOB_NEW",
      payloadFingerprint: operations._private.fingerprint(payload), payload,
      state: "COMPLETED", resultReference: `job-${index}`,
      createdAt: new Date(index * 1000).toISOString(), completedAt: new Date(index * 1000 + 1).toISOString(),
    };
  });
  records[0] = { ...records[0], state: "PENDING", resultReference: null, completedAt: null };
  operations._private.durableWrite(file, { schemaVersion: 1, operations: records });
  store.begin({ key: "next-card", type: "CARD_JOB_NEW", payload: { index: "next" } });
  const retained = store.read().operations;
  assert.equal(retained.filter((operation) => operation.state === "PENDING").length, 2);
  assert.equal(retained.some((operation) => operation.id === records[0].id), true);
  assert.ok(retained.length <= operations._private.RETAIN_COMPLETED + 2);
});
