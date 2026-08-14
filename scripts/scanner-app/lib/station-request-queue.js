/**
 * One process-wide critical section for station-signed HTTP requests.
 *
 * The identity helper persists a monotonic request nonce/sequence before it
 * returns a signature. Keeping signature creation and the corresponding
 * network exchange inside this queue prevents a later signature from reaching
 * the server before an earlier one. A rejected request does not poison later
 * work.
 */
function createQueue() {
  let tail = Promise.resolve();
  return Object.freeze({
    run(operation) {
      if (typeof operation !== "function") throw new TypeError("Station request operation must be a function");
      const result = tail.then(operation, operation);
      tail = result.catch(() => undefined);
      return result;
    },
  });
}

const sharedQueue = createQueue();
module.exports = Object.freeze({ run: sharedQueue.run, _private: { createQueue } });
