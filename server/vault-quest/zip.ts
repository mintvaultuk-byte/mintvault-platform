// Minimal, dependency-free ZIP writer (Node zlib). Produces a standard .zip
// (deflate or stored, per-entry, whichever is smaller) so the Export Centre can
// bundle a card pack without adding an npm dependency or relying on a system
// `zip` binary (which isn't guaranteed in a container).
import zlib from "zlib";
import { promisify } from "util";
import type { Writable } from "stream";

const deflateRawAsync = promisify(zlib.deflateRaw);

/**
 * Strip any zip-slip / control chars from an entry name. Splits on "/" and drops
 * empty, "." and ".." segments so there's no single-pass-regex bypass (e.g.
 * "....//" or nested traversal) — the archive we hand a print house can never
 * carry a path-traversal entry.
 */
function sanitizeEntryName(name: string): string {
  return name
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/")
    .replace(/[\x00-\x1f]/g, "");
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function makeZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    // sanitize entry name — no zip-slip in the archive we hand a print house
    const safe = sanitizeEntryName(e.name);
    const nameBuf = Buffer.from(safe, "utf8");
    const crc = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data);
    const useDeflate = deflated.length < e.data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : e.data;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    local.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, eocd]);
}

/**
 * Streaming ZIP writer — writes each entry to a Writable (typically a temp-file
 * stream) as it is added, using ASYNC deflate (runs on libuv's threadpool, never
 * blocks the event loop) and holding only one entry in memory at a time. This is
 * the production-safe path for large export packs: peak memory is one card's
 * buffers, not the whole 150-card set, and the request thread is never stalled by
 * a synchronous multi-hundred-MB deflate.
 *
 * Usage:
 *   const zip = new ZipStream(fs.createWriteStream(tmp));
 *   for (…) await zip.add(name, buf);
 *   await zip.finalize();
 */
export class ZipStream {
  private central: Buffer[] = [];
  private offset = 0;
  private count = 0;
  private done = false;
  private streamErr: Error | null = null;

  constructor(private readonly out: Writable) {
    // CRITICAL: a Writable emits an 'error' EVENT on a write failure (ENOSPC/EIO/
    // EPIPE) in addition to the per-write callback. An 'error' event with no
    // listener is re-thrown as an uncaughtException and would take the whole
    // shared server process down. Latch it here and surface it through the
    // awaited add()/finalize() chain so the export job just fails instead.
    this.out.on("error", (e: Error) => {
      this.streamErr = this.streamErr ?? e;
    });
  }

  private write(buf: Buffer): Promise<void> {
    if (this.streamErr) return Promise.reject(this.streamErr);
    return new Promise<void>((resolve, reject) => {
      this.out.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }

  async add(name: string, data: Buffer): Promise<void> {
    if (this.streamErr) throw this.streamErr;
    if (this.done) throw new Error("ZipStream already finalized");
    const nameBuf = Buffer.from(sanitizeEntryName(name), "utf8");
    const crc = crc32(data);
    const deflated = await deflateRawAsync(data);
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : data;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    await this.write(Buffer.concat([lfh, nameBuf, body]));

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(this.offset, 42);
    this.central.push(cdh, nameBuf);

    this.offset += lfh.length + nameBuf.length + body.length;
    this.count++;
  }

  async finalize(): Promise<void> {
    if (this.streamErr) throw this.streamErr;
    if (this.done) return;
    this.done = true;
    const centralBuf = Buffer.concat(this.central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.count, 8);
    eocd.writeUInt16LE(this.count, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(this.offset, 16);
    await this.write(Buffer.concat([centralBuf, eocd]));
    await new Promise<void>((resolve, reject) => {
      this.out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
