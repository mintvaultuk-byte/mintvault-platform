const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const operations = require("../lib/semantic-operations");
const { semanticAuthority } = require("./semantic-authority-fixture");

function storeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-semantic-operations-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "store.json");
  const authority = semanticAuthority();
  return { file, authority, store: operations._private.createStore(file, authority) };
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
  assert.throws(() => store.read(), /authentication failed/);
});

test("recomputed payload digests, lifecycle flips and deletion after pending fail closed", (t) => {
  const { file, store } = storeFixture(t);
  store.begin({ key: "new-card:one", type: "CARD_JOB_NEW", payload: { cardName: "one" } });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.operations[0].payload.cardName = "attacker";
  parsed.operations[0].payloadFingerprint = operations._private.fingerprint(parsed.operations[0].payload);
  parsed.operations[0].state = "COMPLETED";
  fs.writeFileSync(file, JSON.stringify(parsed));
  assert.throws(() => store.read(), /authentication failed/);
  fs.unlinkSync(file);
  assert.throws(() => store.read(), /missing after initialization/);
});

test("a prior valid MACed ledger and wrapped-key snapshot cannot roll back device high-water", (t) => {
  const { file, store } = storeFixture(t);
  const first = store.begin({ key: "new-card:first", type: "CARD_JOB_NEW", payload: { cardName: "first" } });
  const oldLedger = fs.readFileSync(file);
  const oldKey = fs.readFileSync(store.keyPath);
  store.complete(first.id, "card-job:first");
  store.begin({ key: "new-card:second", type: "CARD_JOB_NEW", payload: { cardName: "second" } });
  fs.writeFileSync(file, oldLedger);
  fs.writeFileSync(store.keyPath, oldKey);
  assert.throws(() => store.read(), /device high-water/);
});

test("completed history compacts without deleting any unresolved operation", (t) => {
  const { store } = storeFixture(t);
  const pending = store.begin({ key: "pending:0", type: "CARD_JOB_NEW", payload: { index: 0 } });
  for (let index = 1; index < operations._private.MAX_OPERATIONS; index += 1) {
    const record = store.begin({ key: `completed:${index}`, type: "CARD_JOB_NEW", payload: { index } });
    store.complete(record.id, `job-${index}`);
  }
  store.begin({ key: "next-card", type: "CARD_JOB_NEW", payload: { index: "next" } });
  const retained = store.read().operations;
  assert.equal(retained.filter((operation) => operation.state === "PENDING").length, 2);
  assert.equal(retained.some((operation) => operation.id === pending.id), true);
  assert.ok(retained.length <= operations._private.RETAIN_COMPLETED + 2);
});

test("identity retirement zeroes the cached MAC key and creates a restart-readable fresh namespace", (t) => {
  const { file, authority, store } = storeFixture(t);
  const old = store.begin({ key: "old-identity:card", type: "CARD_JOB_NEW", payload: { cardName: "old" } });
  store.complete(old.id, "card-job:old");
  const retirementFiles = store.retirementFiles();
  assert.equal(authority.wrappedKeys.length, 1);
  const oldKey = Buffer.from(authority.wrappedKeys[0]);

  store.completeIdentityRetirement();
  for (const candidate of retirementFiles) fs.unlinkSync(candidate);
  authority.resetForNewIdentity();

  store.begin({ key: "new-identity:card", type: "CARD_JOB_NEW", payload: { cardName: "new" } });
  assert.equal(authority.wrappedKeys.length, 2);
  assert.equal(authority.wrappedKeys[1].equals(oldKey), false);
  assert.equal(fs.existsSync(store.keyPath), true);

  const restarted = operations._private.createStore(file, authority);
  assert.equal(restarted.read().operations.some((operation) => operation.key === "new-identity:card"), true);
});
