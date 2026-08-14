"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readBoundedRegularFile, readBoundedJson } = require("../lib/bounded-file");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mintvault-bounded-file-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("sparse, oversized and symlink control files fail before allocation", (t) => {
  const directory = fixture(t);
  const sparse = path.join(directory, "sparse.json");
  const descriptor = fs.openSync(sparse, "w", 0o600);
  try { fs.ftruncateSync(descriptor, 1024 * 1024 * 1024); } finally { fs.closeSync(descriptor); }
  assert.throws(() => readBoundedJson(sparse, { maximumBytes: 1024, label: "control" }), /bounded regular/);
  const target = path.join(directory, "target.json");
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  const link = path.join(directory, "link.json");
  fs.symlinkSync(target, link);
  assert.throws(() => readBoundedJson(link, { maximumBytes: 1024, label: "control" }));
});

test("the same verified descriptor supplies bytes across a pathname swap", (t) => {
  const directory = fixture(t);
  const file = path.join(directory, "preview.jpg");
  const original = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);
  fs.writeFileSync(file, original, { mode: 0o600 });
  const bytes = readBoundedRegularFile(file, {
    minimumBytes: 4,
    maximumBytes: 1024,
    label: "preview",
    afterOpen: () => {
      fs.renameSync(file, `${file}.verified`);
      const replacement = fs.openSync(file, "w", 0o600);
      try { fs.ftruncateSync(replacement, 1024 * 1024 * 1024); } finally { fs.closeSync(replacement); }
    },
  });
  assert.deepEqual(bytes, original);
});
