/**
 * Phone-QR upload (POST /api/upload/:certId/:imageType) resource + auth gating.
 *
 * The route buffers the raw camera file with multer.memoryStorage (30 MB cap,
 * server/lib/multer-configs.ts). The token check used to live INSIDE the handler,
 * i.e. after the whole body had been read. Measured on the real server before the
 * fix: 12 concurrent UNAUTHENTICATED requests (all answered 401) allocated
 * 771.8 MB and pushed RSS from 433.8 MB to 648.9 MB — roughly 30 concurrent
 * connections would exhaust the 2 GB Fly machine, with no auth, rate limit or
 * concurrency cap in front of it.
 *
 * These tests compose the REAL components the route uses — the real multer config,
 * the real stateless HMAC verifier, and the real admission factory — in the same
 * order the route wires them, and assert on observable behaviour (was the body
 * buffered? did the client finish sending before it was rejected?) rather than on
 * source text. A separate wiring test guards the ORDER in server/routes.ts, because
 * the whole defence is the ordering.
 */
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUploadToken, verifyUploadToken } from "../server/lib/upload-token";
import { createPhoneUploadAdmission } from "../server/lib/phone-upload-admission";
import { phoneUpload } from "../server/lib/multer-configs";

const ORIGINAL_SECRET = process.env.SIGNED_URL_SECRET;
beforeAll(() => {
  process.env.SIGNED_URL_SECRET = "phone-upload-test-secret";
});
afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.SIGNED_URL_SECRET;
  else process.env.SIGNED_URL_SECRET = ORIGINAL_SECRET;
});

/** Counts how many request bodies multer actually buffered. */
let filesBuffered = 0;
let bytesBuffered = 0;

interface App {
  port: number;
  admission: ReturnType<typeof createPhoneUploadAdmission>;
  close: () => Promise<void>;
}

/** The route's middleware chain, built from the real components. */
async function makeApp(maxConcurrent = 4): Promise<App> {
  const admission = createPhoneUploadAdmission(maxConcurrent);
  const app = express();

  const requirePhoneUploadToken = (req: any, res: any, next: any) => {
    const token = req.query.token;
    if (typeof token !== "string" || token.length === 0) {
      return res.status(401).json({ error: "Token required" });
    }
    if (!verifyUploadToken(String(req.params.certId), String(req.params.imageType), token)) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    next();
  };

  const phoneUploadWithLimits = (req: any, res: any, next: any) => {
    phoneUpload.single("image")(req, res, (err: any) => {
      if (!err) return next();
      if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Image is too large (30 MB maximum)" });
      if (err instanceof Error && err.message === "Images only") return res.status(400).json({ error: "Images only" });
      return next(err);
    });
  };

  app.post(
    "/api/upload/:certId/:imageType",
    requirePhoneUploadToken,
    admission.middleware,
    phoneUploadWithLimits,
    (req: any, res: any) => {
      if (req.file) {
        filesBuffered += 1;
        bytesBuffered += req.file.buffer.length;
      }
      // Stand-in for the real handler's autoCrop/R2/DB work.
      res.json({ ok: true, received: req.file ? req.file.buffer.length : 0, certId: req.params.certId });
    }
  );

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    admission,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface UploadResult {
  status?: number;
  body?: any;
  bytesSentBeforeResponse: number;
  totalBytes: number;
  aborted?: boolean;
}

/**
 * Send a multipart upload, recording how many body bytes were actually written
 * before the server's response arrived — the measure of "was it rejected early".
 */
function upload(
  port: number,
  opts: {
    certId?: string;
    imageType?: string;
    token?: string | null;
    sizeBytes?: number;
    abortAfterBytes?: number;
    fieldName?: string;
    filename?: string;
    timeoutMs?: number;
  }
): Promise<UploadResult> {
  const {
    certId = "MV1",
    imageType = "front",
    token,
    sizeBytes = 2 * 1024 * 1024,
    abortAfterBytes,
    fieldName = "image",
    filename = "photo.jpg",
    timeoutMs = 8000,
  } = opts;

  return new Promise((resolve) => {
    const boundary = "----mvtest" + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const total = head.length + sizeBytes + tail.length;
    const qs = token === undefined ? "" : `?token=${encodeURIComponent(String(token))}`;

    let sent = 0;
    let responded = false;
    let bytesAtResponse = 0;
    let settled = false;

    const finish = (r: Partial<UploadResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
      resolve({ bytesSentBeforeResponse: bytesAtResponse, totalBytes: total, ...r } as UploadResult);
    };

    const timer = setTimeout(() => finish({ aborted: true }), timeoutMs);

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/upload/${certId}/${imageType}${qs}`,
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(total) },
      },
      (res) => {
        responded = true;
        bytesAtResponse = sent;
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let body: any;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          finish({ status: res.statusCode, body });
        });
        res.on("error", () => finish({ status: res.statusCode }));
      }
    );
    req.on("error", () => finish({ aborted: true }));

    req.write(head);
    // JPEG magic bytes so nothing is rejected on content sniffing.
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(chunk, 0);

    const pump = () => {
      if (settled) return;
      while (sent < sizeBytes) {
        if (responded) return; // server already answered; stop uploading
        if (abortAfterBytes != null && sent >= abortAfterBytes) return req.destroy();
        const n = Math.min(chunk.length, sizeBytes - sent);
        const ok = req.write(n === chunk.length ? chunk : chunk.subarray(0, n));
        sent += n;
        if (!ok) return req.once("drain", () => setImmediate(pump));
      }
      req.write(tail);
      req.end();
    };
    setImmediate(pump);
  });
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe("phone upload — authentication before buffering", () => {
  it("a valid token uploads successfully (the real mobile journey)", async () => {
    const app = await makeApp();
    try {
      const { token } = generateUploadToken("MV1", "front");
      // Exactly what client/src/pages/mobile-upload.tsx sends: FormData field
      // "image", token in the query string.
      const r = await upload(app.port, { certId: "MV1", imageType: "front", token, sizeBytes: 1024 * 1024 });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.received).toBe(1024 * 1024);
    } finally {
      await app.close();
    }
  });

  it("a missing token is rejected before the body is buffered", async () => {
    const app = await makeApp();
    const before = filesBuffered;
    try {
      const r = await upload(app.port, { token: undefined, sizeBytes: 8 * 1024 * 1024 });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("Token required");
      expect(filesBuffered).toBe(before); // multer never ran
      expect(r.bytesSentBeforeResponse).toBeLessThan(r.totalBytes); // rejected mid-send
    } finally {
      await app.close();
    }
  });

  it("an invalid token is rejected before the body is buffered", async () => {
    const app = await makeApp();
    const before = filesBuffered;
    try {
      const r = await upload(app.port, { token: "1799999999.deadbeef", sizeBytes: 8 * 1024 * 1024 });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("Invalid or expired token");
      expect(filesBuffered).toBe(before);
      expect(r.bytesSentBeforeResponse).toBeLessThan(r.totalBytes);
    } finally {
      await app.close();
    }
  });

  it("an expired token is rejected", async () => {
    const app = await makeApp();
    try {
      const { token } = generateUploadToken("MV1", "front", -1000); // already past
      expect(verifyUploadToken("MV1", "front", token)).toBe(false);
      const r = await upload(app.port, { token, sizeBytes: 512 * 1024 });
      expect(r.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("a token cannot be replayed against another certificate or the other side", async () => {
    const app = await makeApp();
    try {
      const { token } = generateUploadToken("MV1", "front");
      const otherCert = await upload(app.port, { certId: "MV2", imageType: "front", token, sizeBytes: 256 * 1024 });
      expect(otherCert.status).toBe(401);
      const otherSide = await upload(app.port, { certId: "MV1", imageType: "back", token, sizeBytes: 256 * 1024 });
      expect(otherSide.status).toBe(401);
      const correct = await upload(app.port, { certId: "MV1", imageType: "front", token, sizeBytes: 256 * 1024 });
      expect(correct.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("phone upload — bounded memory", () => {
  it("concurrent unauthenticated uploads buffer nothing at all", async () => {
    const app = await makeApp();
    const before = filesBuffered;
    const bytesBefore = bytesBuffered;
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => upload(app.port, { token: undefined, sizeBytes: 8 * 1024 * 1024 }))
      );
      expect(results.every((r) => r.status === 401)).toBe(true);
      expect(filesBuffered).toBe(before); // zero bodies buffered
      expect(bytesBuffered).toBe(bytesBefore); // zero bytes retained
    } finally {
      await app.close();
    }
  });

  it("caps concurrent authenticated uploads and sheds the excess with 503 + Retry-After", async () => {
    const app = await makeApp(2); // deliberately small so the cap is observable
    try {
      const { token } = generateUploadToken("MV1", "front");
      const results = await Promise.all(
        Array.from({ length: 8 }, () => upload(app.port, { token, sizeBytes: 3 * 1024 * 1024 }))
      );
      const ok = results.filter((r) => r.status === 200);
      const shed = results.filter((r) => r.status === 503);
      expect(ok.length + shed.length).toBe(8);
      expect(shed.length).toBeGreaterThan(0); // the cap engaged
      expect(app.admission.stats().max).toBe(2);
      await settle();
      expect(app.admission.stats().active).toBe(0); // fully released
    } finally {
      await app.close();
    }
  });

  it("concurrent valid uploads within the cap all succeed", async () => {
    const app = await makeApp(4);
    try {
      const { token } = generateUploadToken("MV1", "front");
      const results = await Promise.all(
        Array.from({ length: 4 }, () => upload(app.port, { token, sizeBytes: 1024 * 1024 }))
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      await settle();
      expect(app.admission.stats().active).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("an aborted upload releases its admission slot", async () => {
    const app = await makeApp(2);
    try {
      const { token } = generateUploadToken("MV1", "front");
      await Promise.all([
        upload(app.port, { token, sizeBytes: 6 * 1024 * 1024, abortAfterBytes: 256 * 1024 }),
        upload(app.port, { token, sizeBytes: 6 * 1024 * 1024, abortAfterBytes: 256 * 1024 }),
      ]);
      await settle(300);
      expect(app.admission.stats().active).toBe(0);
      // Capacity is genuinely reusable afterwards.
      const after = await upload(app.port, { token, sizeBytes: 512 * 1024 });
      expect(after.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("an oversized image is rejected as 413, not a generic 500", async () => {
    const app = await makeApp();
    try {
      const { token } = generateUploadToken("MV1", "front");
      const r = await upload(app.port, { token, sizeBytes: 30 * 1024 * 1024 + 1024 });
      expect(r.status).toBe(413);
      expect(r.body.error).toMatch(/too large/i);
      await settle();
      expect(app.admission.stats().active).toBe(0); // slot released on rejection
    } finally {
      await app.close();
    }
  });
});

describe("phone upload — wiring", () => {
  it("server/routes.ts gates the token and admission BEFORE multer", async () => {
    // The defence IS the ordering, so pin it. Behaviour is covered above; this
    // guards the one thing behaviour tests on a rebuilt chain cannot see.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const chain = src.slice(src.indexOf('"/api/upload/:certId/:imageType"'));
    const tokenAt = chain.indexOf("requirePhoneUploadToken");
    const admissionAt = chain.indexOf("phoneUploadAdmission.middleware");
    const multerAt = chain.indexOf("phoneUploadWithLimits");
    expect(tokenAt).toBeGreaterThan(-1);
    expect(admissionAt).toBeGreaterThan(-1);
    expect(multerAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeLessThan(admissionAt);
    expect(admissionAt).toBeLessThan(multerAt);
  });
});
