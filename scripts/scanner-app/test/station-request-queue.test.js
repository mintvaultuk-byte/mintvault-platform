const test = require("node:test");
const assert = require("node:assert/strict");
const { _private } = require("../lib/station-request-queue");

test("station-signed exchanges cannot overtake one another", async () => {
  const queue = _private.createQueue();
  const events = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.run(async () => {
    events.push("first:sign");
    await firstBlocked;
    events.push("first:response");
    return 1;
  });
  const second = queue.run(async () => {
    events.push("second:sign");
    events.push("second:response");
    return 2;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:sign"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first:sign", "first:response", "second:sign", "second:response"]);
});

test("a rejected exchange does not poison the queue", async () => {
  const queue = _private.createQueue();
  await assert.rejects(queue.run(async () => { throw new Error("network failed"); }), /network failed/);
  assert.equal(await queue.run(async () => "recovered"), "recovered");
  assert.throws(() => queue.run(null), /must be a function/);
});
