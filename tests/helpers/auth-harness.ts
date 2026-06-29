/**
 * Isolated live-HTTP authorization harness (Phase 6).
 *
 * Boots a minimal Express app over a real ephemeral socket and mounts the
 * ACTUAL security middleware + auth guards from the app — nothing in the
 * authorization path is reimplemented or weakened:
 *   - csrfOriginCheck            (server/lib/csrf-origin.ts)
 *   - requireAdmin               (server/auth.ts)
 *   - requireAuth                (server/middleware/auth.ts)
 *   - requireCustomer            (server/customer-auth.ts)
 *   - requireGrader              (server/grader.ts)
 *   - requireStaff / requireCapability (server/staff.ts)
 *   - requireScannerOrAdmin      (server/lib/scanner-auth.ts)
 *   - authorizeSubmissionDownload (server/lib/customer-documents.ts)
 *   - errorEnvelope / safeErrorSummary (server/lib/error-sanitize.ts)
 *
 * It deliberately does NOT call registerRoutes() — that awaits DB migrations and
 * needs a session table. Instead the authenticated PRINCIPAL is injected per
 * request via an `x-test-session` header (a test double for a logged-in session;
 * the real guards still decide allow/deny). No database, scheduler, or external
 * provider is touched: every route here is in-memory.
 *
 * Representative middleware (rate-limit, upload limits) mirror the documented
 * production config — the exact instances live inline in server/index.ts and are
 * not exported; these cover the config/pattern, clearly labelled as such.
 */
import "./test-env"; // MUST be first: sets dummy DB/secret env before any server import loads
import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import rateLimit from "express-rate-limit";
import multer from "multer";

import { csrfOriginCheck } from "../../server/lib/csrf-origin";
import { requireAdmin } from "../../server/auth";
import { requireAuth } from "../../server/middleware/auth";
import { requireCustomer } from "../../server/customer-auth";
import { requireGrader } from "../../server/grader";
import { requireStaff, requireCapability } from "../../server/staff";
import { requireScannerOrAdmin } from "../../server/lib/scanner-auth";
import { authorizeSubmissionDownload } from "../../server/lib/customer-documents";
import {
  newRequestId,
  errorEnvelope,
  safeErrorSummary,
  errorDetailsAllowed,
  clientErrorMessage,
} from "../../server/lib/error-sanitize";

// Test double for authentication: drive a role over real HTTP by injecting the
// session principal (what a real login would have produced) — the REAL guards
// then enforce. Never reads identity from body/query/params.
function injectTestSession(req: Request, _res: Response, next: NextFunction) {
  (req as any).session = {};
  const raw = req.headers["x-test-session"];
  if (typeof raw === "string" && raw.length) {
    try {
      Object.assign((req as any).session, JSON.parse(raw));
    } catch {
      /* malformed → stay anonymous */
    }
  }
  next();
}

// Mirrors server/index.ts: correlation id + X-Request-ID on every request.
function assignRequestId(req: Request, res: Response, next: NextFunction) {
  (req as any).requestId = newRequestId();
  res.setHeader("X-Request-ID", (req as any).requestId);
  next();
}

const ok = (role: string) => (req: Request, res: Response) =>
  res.json({ ok: true, role, requestId: (req as any).requestId });

export function buildAuthHarness() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(assignRequestId);

  // ── Stripe webhook: raw body, BEFORE express.json + the session/CSRF stack —
  //    mirrors the real ordering (signature-authenticated, CSRF-exempt by path).
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req: Request, res: Response) => {
    res.json({ rawBody: Buffer.isBuffer(req.body), len: Buffer.isBuffer(req.body) ? req.body.length : -1 });
  });

  app.use(express.json());
  app.use(injectTestSession);

  // 5xx response interceptor — reconstructs server/index.ts's FIRST layer using
  // the SAME exported primitives: ANY 5xx res.json/res.send body collapses to the
  // strict { error: "Internal Server Error", requestId } envelope. (The exact
  // inline middleware in index.ts is not exported; this mirrors its logic so the
  // two-layer wiring — not just the primitive — is exercised over HTTP.)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const allowDetails = errorDetailsAllowed(process.env.NODE_ENV, process.env.DEBUG_ERROR_DETAILS);
    let enveloped = false;
    const originalJson = res.json.bind(res);
    res.json = function (bodyJson?: any) {
      const env = errorEnvelope(res.statusCode, bodyJson, { allowDetails, requestId: (req as any).requestId });
      if (env.scrubbed) enveloped = true;
      return originalJson(env.body);
    } as any;
    const originalSend = res.send.bind(res);
    res.send = function (body?: any) {
      if (!enveloped && !allowDetails && res.statusCode >= 500) {
        enveloped = true;
        const env = errorEnvelope(res.statusCode, body, { allowDetails, requestId: (req as any).requestId });
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return originalJson(env.body);
      }
      return originalSend(body);
    } as any;
    next();
  });

  app.use(csrfOriginCheck);

  // ── Auth-guard routes (GET so CSRF doesn't mask the guard decision) ──────────
  app.get("/api/admin/ping", requireAdmin, ok("admin"));
  app.get("/api/auth/me", requireAuth, ok("user"));
  app.get("/api/customer/ping", requireCustomer, ok("customer"));
  app.get("/api/grader/ping", requireGrader, ok("grader"));
  app.get("/api/staff/ping", requireStaff, ok("staff"));
  app.get("/api/staff/grade", requireCapability("grade"), ok("staff:grade"));
  app.get("/api/staff/scan", requireCapability("scan"), ok("staff:scan"));
  app.get("/api/staff/print", requireCapability("print"), ok("staff:print"));

  // Admin reprint — guard only (the real handler needs the DB; this verifies the
  // authorization boundary on the reprint path).
  app.post("/api/admin/print-batch/reprint", requireAdmin, ok("admin"));

  // Scanner-or-admin (POST — also exercises the scanner CSRF exemption).
  app.post("/api/scan-ingest/ping", requireScannerOrAdmin, ok("scanner"));

  // ── BOLA/IDOR: real authorizeSubmissionDownload against an INJECTED submission
  //    (the "storage" double is the x-fixture-submission header). Identity comes
  //    ONLY from the session, never from params/body.
  app.post("/api/customer/submissions/:id/doc", requireCustomer, (req: Request, res: Response) => {
    const raw = req.headers["x-fixture-submission"];
    let submission: any = null;
    if (typeof raw === "string" && raw.length) {
      try {
        submission = JSON.parse(raw);
      } catch {
        submission = null;
      }
    }
    const result = authorizeSubmissionDownload(submission, {
      customerEmail: (req as any).session.customerEmail,
      userId: (req as any).session.userId,
    });
    if (!result.ok) return res.status(result.status).json({ error: "denied" });
    res.json({ ok: true, doc: "packing-slip" });
  });

  // ── grader→admin __graderProxy escalation (server/auth.ts:133). The flag is
  //    request-local, set ONLY by the in-app grader proxy AFTER cert ownership is
  //    verified; it has no client (header/body/query) path. Positive path: once
  //    the flag is set in-process, requireAdmin lets the (grader) request through.
  app.get(
    "/api/_harness/grader-proxy",
    (req: Request, _res: Response, next: NextFunction) => {
      (req as any).__graderProxy = true; // simulates the verified in-app proxy
      next();
    },
    requireAdmin,
    ok("admin-via-grader-proxy")
  );

  // ── grader per-object ownership — REPRESENTATIVE of authorizeGraderCert
  //    (server/routes/grader.ts:69), which is module-private + DB-bound
  //    (getCertAssignment) so it cannot run in a DB-less harness. Mirrors its
  //    rule exactly: the cert must be assigned to THIS grader AND not yet
  //    approved. Identity comes ONLY from the session; the assignment is the
  //    injected "DB" double (x-fixture-assignment).
  app.post("/api/grader/cert/:certId/act", requireGrader, (req: Request, res: Response) => {
    const raw = req.headers["x-fixture-assignment"];
    let assignment: any = null;
    if (typeof raw === "string" && raw.length) {
      try {
        assignment = JSON.parse(raw);
      } catch {
        assignment = null;
      }
    }
    const graderId = (req as any).session.graderId;
    if (!assignment) return res.status(404).json({ error: "Not found" });
    if (assignment.assignedGraderId !== graderId || assignment.gradingStatus === "approved") {
      return res.status(403).json({ error: "This card is not assigned to you" });
    }
    res.json({ ok: true });
  });

  // ── raw 5xx (no thrown error) — exercises the response interceptor's scrub
  //    directly: a handler that leaks secrets in a 500 body must be collapsed.
  app.get("/api/raw5xx", (_req: Request, res: Response) =>
    res.status(500).json({ secret: "postgres://u:pw@db/prod token=sk_live_DEADBEEF a@b.com" })
  );

  // ── CSRF probe (POST, no guard) ──────────────────────────────────────────────
  app.post("/api/test/csrf", (_req: Request, res: Response) => res.json({ ok: true }));

  // ── Generic correlated 5xx + safe logging: the handler below mirrors the real
  //    central handler (errorEnvelope + safeErrorSummary). The thrown message
  //    embeds secrets that must NEVER reach the client or the log line.
  app.get("/api/boom", (_req: Request, _res: Response) => {
    throw new Error("connect postgres://user:pw@db-host/prod failed; token=sk_live_DEADBEEF; a@b.com");
  });

  // ── Representative trusted-proxy rate limiter (mirrors index.ts: max 5 /
  //    window, keyed on the first X-Forwarded-For hop, trust proxy = 1). ────────
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.toString().split(",")[0].trim();
      return first || req.ip || "unknown";
    },
    handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
  });
  app.get("/api/rl/ping", limiter, (_req: Request, res: Response) => res.json({ ok: true }));

  // ── Representative upload limits (mirrors the cert upload: 50MB cap, only
  //    jpg/jpeg/png/webp by extension). ──────────────────────────────────────
  const upload = multer({
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (/\.(jpe?g|png|webp)$/i.test(file.originalname)) return cb(null, true);
      cb(new Error("unsupported file type"));
    },
  });
  app.post(
    "/api/upload/ping",
    (req: Request, res: Response, next: NextFunction) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) return res.status(400).json({ error: "upload rejected" });
        next();
      });
    },
    (req: Request, res: Response) => res.json({ ok: true, hasFile: !!(req as any).file })
  );

  // Tiny size cap (1KB) so the size-limit rejection can be exercised without a
  // 50MB body — mirrors the production size-limit mechanism, not its exact value.
  const tinyUpload = multer({ limits: { fileSize: 1024 } });
  app.post(
    "/api/upload/tiny",
    (req: Request, res: Response, next: NextFunction) => {
      tinyUpload.single("file")(req, res, (err: unknown) => {
        if (err) return res.status(400).json({ error: "upload too large" });
        next();
      });
    },
    (_req: Request, res: Response) => res.json({ ok: true })
  );

  // Central error handler — mirrors server/index.ts's SECOND layer: it emits
  // { message: clientErrorMessage(...), requestId }; the 5xx interceptor above
  // then collapses that to { error: "Internal Server Error", requestId }.
  // Together they reproduce production's two-layer 5xx handling — a regression in
  // EITHER layer (final handler leaking, or interceptor failing to scrub) shows.
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    const requestId = (req as any).requestId ?? newRequestId();
    console.error("[unhandled-error]", safeErrorSummary(err, { requestId, operation: `${req.method} ${req.path}` }));
    if (res.headersSent) return next(err);
    const isProd = process.env.NODE_ENV === "production";
    const body: Record<string, unknown> = { message: clientErrorMessage(status, message, isProd) };
    if (status >= 500) body.requestId = requestId;
    res.status(status).json(body);
  });

  return app;
}

// ── live-HTTP plumbing (node http only — full header control, no new deps) ─────
export interface HarnessServer {
  port: number;
  close: () => Promise<void>;
}

export function startHarness(app: express.Express): Promise<HarnessServer> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

export function httpRequest(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any = undefined;
        try {
          json = JSON.parse(text);
        } catch {
          /* non-JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
