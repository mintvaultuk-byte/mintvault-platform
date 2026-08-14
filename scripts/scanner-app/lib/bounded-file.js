"use strict";

const fs = require("node:fs");

function readBoundedRegularFile(filePath, { maximumBytes, minimumBytes = 1, encoding = null, label = "File", afterOpen = null } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(minimumBytes)
      || minimumBytes < 0 || minimumBytes > maximumBytes) throw new TypeError("Bounded file limits are invalid");
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < minimumBytes || stat.size > maximumBytes) {
      throw new Error(`${label} is not a bounded regular single-link file`);
    }
    if (typeof afterOpen === "function") afterOpen({ descriptor, stat });
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.nlink !== 1) {
      throw new Error(`${label} changed while being read`);
    }
    return encoding ? bytes.toString(encoding) : bytes;
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readBoundedJson(filePath, options) {
  return JSON.parse(readBoundedRegularFile(filePath, { ...options, encoding: "utf8" }));
}

module.exports = { readBoundedRegularFile, readBoundedJson };
