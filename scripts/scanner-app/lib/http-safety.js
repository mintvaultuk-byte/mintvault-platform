"use strict";

const DEFAULT_JSON_MAX_BYTES = 1024 * 1024;

function directFetch(fetchImpl, url, init = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("HTTP transport is unavailable");
  return fetchImpl(url, { ...init, redirect: "error" });
}

async function boundedResponseText(response, maximumBytes = DEFAULT_JSON_MAX_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("HTTP response limit is invalid");
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("MintVault response exceeds its size limit");
  if (response?.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maximumBytes) {
        response.body.destroy?.();
        throw new Error("MintVault response exceeds its size limit");
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) throw new Error("MintVault response exceeds its size limit");
  return text;
}

module.exports = { DEFAULT_JSON_MAX_BYTES, directFetch, boundedResponseText };
