/**
 * Stream-to-response lifecycle regression.
 *
 * The public slab-image proxy (GET /api/public/slab-image/:certNumber/:kind,
 * server/routes.ts) pipes an R2 GetObject body straight to the response. Node's
 * `readable.pipe(dest)` neither forwards source errors nor destroys the source when
 * the destination goes away, and server/** registers no `uncaughtException` handler —
 * so before the fix, an R2 socket reset mid-transfer terminated the whole process, and
 * a client disconnect left the R2 socket checked out of the shared S3Client agent pool.
 *
 * These tests pin the two guarantees the route now has to keep, using the same pattern
 * the handler uses. They deliberately exercise the STREAM WIRING rather than booting the
 * route (importing server/routes.ts starts pools, sessions and cron jobs), and the
 * "unguarded" cases assert the failure mode the fix exists to prevent — so this file
 * fails if either handler is removed.
 */
import express from "express";
import http from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

/** A slow readable standing in for an R2 GetObject body (an IncomingMessage). */
function slowSource(opts: { errorAfterChunks?: number } = {}): Readable {
  let pushed = 0;
  const stream = new Readable({
    read() {
      setTimeout(() => {
        if (stream.destroyed) return;
        pushed += 1;
        if (opts.errorAfterChunks != null && pushed >= opts.errorAfterChunks) {
          stream.emit("error", new Error("R2 connection reset mid-stream"));
          return;
        }
        stream.push(Buffer.alloc(512, "x"));
      }, 20);
    },
  });
  return stream;
}

interface Harness {
  port: number;
  sourceDestroyed: () => boolean;
  sourceErrorWasHandled: () => boolean;
  close: () => Promise<void>;
}

/**
 * Mount one route that pipes `slowSource()` to the response, with or without the
 * two handlers the real route applies.
 */
async function harness(opts: {
  guarded: boolean;
  errorAfterChunks?: number;
  contentLength?: number;
  /** Attach a no-op source error listener so the case isolates response
   *  behaviour instead of re-raising the unhandled-error crash. */
  swallowSourceError?: boolean;
}): Promise<Harness> {
  let destroyed = false;
  let errorHandled = false;

  const app = express();
  app.get("/img", (_req, res) => {
    const body = slowSource({ errorAfterChunks: opts.errorAfterChunks });
    body.on("close", () => {
      destroyed = true;
    });
    if (opts.swallowSourceError) body.on("error", () => {});
    res.setHeader("Content-Type", "image/png");
    if (opts.contentLength != null) res.setHeader("Content-Length", String(opts.contentLength));

    if (opts.guarded) {
      res.on("close", () => body.destroy());
      body.on("error", () => {
        errorHandled = true;
        if (!res.headersSent) {
          res.removeHeader("Content-Length");
          res.removeHeader("Content-Type");
          res.status(502).end();
        } else {
          res.destroy();
        }
      });
    }
    body.pipe(res);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as AddressInfo).port,
    sourceDestroyed: () => destroyed,
    sourceErrorWasHandled: () => errorHandled,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Request the route, then destroy the client socket as soon as bytes arrive. */
function requestThenDisconnect(port: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/img`, (res) => {
      res.on("data", () => req.destroy());
      res.on("error", () => {});
    });
    req.on("error", () => {});
    req.on("close", () => resolve());
  });
}

/** Request the route and wait for it to finish or fail. */
interface CompletionResult {
  statusCode?: number;
  failed: boolean;
  contentLength?: string;
  timedOut: boolean;
}

function requestToCompletion(port: number, timeoutMs = 3000): Promise<CompletionResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: CompletionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ failed: false, timedOut: true }), timeoutMs);
    const req = http.get(`http://127.0.0.1:${port}/img`, (res) => {
      res.resume();
      const contentLength = res.headers["content-length"];
      res.on("end", () => done({ statusCode: res.statusCode, contentLength, failed: false, timedOut: false }));
      res.on("error", () => done({ statusCode: res.statusCode, contentLength, failed: true, timedOut: false }));
    });
    req.on("error", () => done({ failed: true, timedOut: false }));
  });
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("stream-to-response lifecycle (public slab-image proxy pattern)", () => {
  it("destroys the source stream when the client disconnects mid-stream", async () => {
    const h = await harness({ guarded: true });
    try {
      await requestThenDisconnect(h.port);
      await settle();
      expect(h.sourceDestroyed()).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("without the disconnect handler the source stream is left open — the leak this guards", async () => {
    const h = await harness({ guarded: false });
    try {
      await requestThenDisconnect(h.port);
      await settle();
      expect(h.sourceDestroyed()).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("handles a mid-stream source error instead of raising an unhandled 'error' event", async () => {
    const h = await harness({ guarded: true, errorAfterChunks: 3 });
    try {
      const result = await requestToCompletion(h.port);
      await settle();
      expect(h.sourceErrorWasHandled()).toBe(true);
      // Headers are already flushed by then, so the response is destroyed rather
      // than answered — the client sees a truncated body, the server survives.
      expect(result.failed || result.statusCode === 200).toBe(true);
      expect(h.sourceDestroyed()).toBe(true);
    } finally {
      await h.close();
    }
  });


  it("clears the staged Content-Length when answering 502, so the client is not left waiting", async () => {
    // The route stages Content-Type + Content-Length for the image BEFORE piping.
    // Answering 502 without clearing Content-Length advertises bytes that never
    // arrive, and the client blocks until it gives up — trading a crash for a
    // held-open socket. This pins the clear.
    const h = await harness({ guarded: true, errorAfterChunks: 1, contentLength: 500_000 });
    try {
      const result = await requestToCompletion(h.port);
      expect(result.statusCode).toBe(502);
      expect(result.contentLength).toBeUndefined();
      expect(result.timedOut).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("leaving Content-Length in place on the error answer hangs the client — the regression this pins", async () => {
    const h = await harness({ guarded: false, errorAfterChunks: 1, contentLength: 500_000, swallowSourceError: true });
    try {
      // The source error is swallowed here so this case isolates the RESPONSE
      // behaviour: nothing completes the response, so the client waits on the
      // advertised Content-Length. (The crash itself is pinned separately.)
      const result = await requestToCompletion(h.port, 1200);
      expect(result.timedOut).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("an unguarded source error has no listener — the crash this guards against", async () => {
    const stream = slowSource({ errorAfterChunks: 1 });
    stream.resume();
    // No 'error' listener attached: Node would re-throw this as an uncaughtException
    // in the real handler, and server/** installs no uncaughtException handler.
    expect(stream.listenerCount("error")).toBe(0);
    await new Promise<void>((resolve) => {
      stream.once("error", () => resolve()); // attach only to keep the test process alive
    });
  });
});
