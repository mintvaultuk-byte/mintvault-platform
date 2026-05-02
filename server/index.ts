import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { cleanupStalePreGradeImages } from "./r2";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { sendVaultClubGraceExpiredEmail, sendTransferV2Completed } from "./email";
import { createServer } from "http";
import { WebhookHandlers } from "./webhookHandlers";
import { adminIpAllowlist } from "./auth";
import { getDatabaseUrl } from "./config";
import {
  expectedStripeKeyName,
  hasStripePublishableKey,
  hasStripeSecretKey,
} from "./stripeClient";
import pg from "pg";
import path from "path";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.set("trust proxy", 1);

// 301-redirect any *.fly.dev request to the canonical mintvaultuk.com.
// First in the chain so it short-circuits before session, body-parsing, etc.
// /health is excluded so Fly's HTTP-service health check (which may use
// `Host: mintvault.fly.dev`) always reaches the 200 handler below regardless
// of host. Path + query string preserved via req.originalUrl. Localhost,
// IP literals, and *.mintvaultuk.com are unaffected.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const host = (req.headers.host || "").toLowerCase();
  if (host === "mintvault.fly.dev" || host.endsWith(".fly.dev")) {
    return res.redirect(301, `https://mintvaultuk.com${req.originalUrl}`);
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/db-check", async (_req, res) => {
  const dbUrl = process.env.MINTVAULT_DATABASE_URL;
  if (!dbUrl) {
    return res.json({
      error: "MINTVAULT_DATABASE_URL is not set",
      database_url_present: !!process.env.DATABASE_URL,
      pghost_present: !!process.env.PGHOST,
    });
  }
  try {
    const parsed = new URL(dbUrl);
    const testPool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    const result = await testPool.query("SELECT to_regclass('public.cert_counter') AS cert_counter_exists, current_database() AS db_name");
    await testPool.end();
    res.json({
      env: process.env.NODE_ENV || "development",
      host: parsed.hostname,
      database: parsed.pathname.slice(1),
      source: "MINTVAULT_DATABASE_URL",
      cert_counter_exists: result.rows[0]?.cert_counter_exists,
      connected_db: result.rows[0]?.db_name,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "https://*.r2.cloudflarestorage.com", "https://i.ebayimg.com"],
        connectSrc: ["'self'", "https://api.stripe.com", "wss:"],
        frameSrc: ["https://js.stripe.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  })
);

const loginRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: "Too many login attempts, please try again later" },
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
      return first.trim();
    }
    return req.ip || req.socket.remoteAddress || "unknown";
  },
});

app.use("/api/admin/login", loginRateLimit);
app.use("/api/admin/session", loginRateLimit);
app.use("/api/admin/pin", loginRateLimit);

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: "Too many requests. Please try again in 15 minutes." },
  keyGenerator: (req) => {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
    return req.ip || req.socket.remoteAddress || "unknown";
  },
});
app.use("/api/auth/login", authRateLimit);
app.use("/api/auth/signup", authRateLimit);
app.use("/api/auth/forgot-password", authRateLimit);
app.use("/api/auth/magic-link", authRateLimit);
app.use("/api/admin", adminIpAllowlist);

if (!hasStripeSecretKey()) {
  console.warn(
    `[stripe] ${expectedStripeKeyName("secret")} not set — payments disabled`
  );
}
if (!hasStripePublishableKey()) {
  console.warn(
    `[stripe] ${expectedStripeKeyName("publishable")} not set — payments disabled`
  );
}

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature" });
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!Buffer.isBuffer(req.body)) {
        console.error("STRIPE WEBHOOK ERROR: req.body is not a Buffer");
        return res.status(500).json({ error: "Webhook processing error" });
      }

      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error("Webhook error:", error.message);
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.urlencoded({ extended: false }));

const PgStore = connectPgSimple(session);
const sessionPool = new pg.Pool({
  connectionString: getDatabaseUrl(),
  ssl: { rejectUnauthorized: false },
});
app.use(
  session({
    store: new PgStore({
      pool: sessionPool,
      createTableIfMissing: false,
    }),
    secret: process.env.SESSION_SECRET || "mintvault-session-secret-fallback",
    name: "mv.sid",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  })
);

const adminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: "Too many requests, please try again later" },
  skip: (req: any) => req.session?.isAdmin === true,
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
      return first.trim();
    }
    return req.ip || req.socket.remoteAddress || "unknown";
  },
});
app.use("/api/admin", adminRateLimit);

app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      let logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const safeBody = { ...capturedJsonResponse };
        delete safeBody.password;
        logLine += ` :: ${JSON.stringify(safeBody)}`;
      }

      log(logLine);
    }
  });

  next();
});

log(`ADMIN_PASSWORD env var: ${process.env.ADMIN_PASSWORD ? "SET" : "NOT SET"}`, "auth");
log(`ADMIN_PIN env var: ${process.env.ADMIN_PIN ? "SET" : "NOT SET"}`, "auth");
log(`SESSION_SECRET env var: ${process.env.SESSION_SECRET ? "SET" : "NOT SET (using fallback)"}`, "auth");

// Daily safety-net: purge any pre-grade-checker images older than 1 hour from R2.
// These should never exist (the estimate endpoint uses in-memory processing only),
// but this job catches any that might have leaked through a future code change.
async function runPreGradeCleanup() {
  try {
    const deleted = await cleanupStalePreGradeImages(60 * 60 * 1000);
    if (deleted > 0) {
      log(`[cleanup] Deleted ${deleted} stale pre-grade-checker image(s) from R2`, "cleanup");
    }
  } catch (err: any) {
    log(`[cleanup] Pre-grade image cleanup error: ${err.message}`, "cleanup");
  }
}

// Daily job: expire Vault Club grace periods
async function runVaultClubGraceSweep() {
  try {
    const expired = await db.execute(sql`
      SELECT id, email, display_name FROM users
      WHERE vault_club_status = 'grace'
        AND vault_club_grace_until IS NOT NULL
        AND vault_club_grace_until < NOW()
        AND deleted_at IS NULL
    `);
    for (const row of expired.rows as any[]) {
      await db.execute(sql`
        UPDATE users SET
          vault_club_tier      = NULL,
          vault_club_status    = 'canceled',
          vault_club_grace_until = NULL,
          showroom_active      = false,
          updated_at           = NOW()
        WHERE id = ${row.id}
      `);
      if (row.email) {
        sendVaultClubGraceExpiredEmail({
          email: row.email,
          displayName: row.display_name || null,
        }).catch(() => {});
      }
      log(`[vault-club] Grace expired for user ${row.id}`, "vault-club");
    }
    if (expired.rows.length > 0) {
      log(`[vault-club] Grace sweep: expired ${expired.rows.length} membership(s)`, "vault-club");
    }
  } catch (err: any) {
    log(`[vault-club] Grace sweep error: ${err.message}`, "vault-club");
  }
}

// ── Transfer v2 auto-finalise cron ──────────────────────────────────────────
async function runTransferV2Sweep() {
  try {
    // 1. Expire stale transfers — seller-init (outgoing 24h, incoming 14d)
    //    AND v435 buyer-init (owner 14d, silence = REJECTION not consent).
    const { storage } = await import("./storage");
    const expired = await storage.expireStaleTransfersV2();
    if (expired.length > 0) {
      log(`[transfer-v2] Expired ${expired.length} stale transfer(s)`, "transfer-v2");

      // v435 — wire the previously-orphaned sendTransferV2Expired email so
      // both parties learn the transfer didn't go through. Inline try/catch
      // per recipient so one failed send doesn't skip the rest.
      const { sendTransferV2Expired } = await import("./email");
      const { storage: storageForAudit } = await import("./storage");
      for (const row of expired) {
        try { await sendTransferV2Expired({ email: row.fromEmail, certId: row.certId, reason: row.reason }); } catch (e: any) {
          log(`[transfer-v2] Expired email to fromEmail failed: ${e.message}`, "transfer-v2");
        }
        try { await sendTransferV2Expired({ email: row.toEmail, certId: row.certId, reason: row.reason }); } catch (e: any) {
          log(`[transfer-v2] Expired email to toEmail failed: ${e.message}`, "transfer-v2");
        }
        try {
          await storageForAudit.writeAuditLog("transfer", String(row.transferId), "transfer_v2.expired", null, {
            certId: row.certId, reason: row.reason, fromEmail: row.fromEmail, toEmail: row.toEmail,
          });
        } catch {}
      }
    }

    // 2. Auto-finalise transfers past dispute deadline.
    //    NOTE: this only finalises status='pending_dispute'. Buyer-init
    //    transfers in 'pending_owner_invited_by_buyer' are NOT auto-completed
    //    here — they expire instead (handled in step 1).
    const ready = await storage.getTransfersReadyToFinalise();
    for (const transfer of ready) {
      try {
        const result = await storage.finaliseTransferV2(transfer.id);
        if (result.success) {
          log(`[transfer-v2] Auto-finalised transfer ${transfer.id} for cert ${result.certId}`, "transfer-v2");

          // Email both parties
          try {
            await sendTransferV2Completed({ email: transfer.fromEmail, certId: result.certId!, role: "outgoing" });
            await sendTransferV2Completed({ email: result.toEmail!, certId: result.certId!, role: "incoming", newKeeperName: result.ownerName });
          } catch (emailErr: any) {
            log(`[transfer-v2] Completion emails failed (non-fatal): ${emailErr.message}`, "transfer-v2");
          }
        }
      } catch (fErr: any) {
        log(`[transfer-v2] Failed to finalise transfer ${transfer.id}: ${fErr.message}`, "transfer-v2");
      }
    }
  } catch (err: any) {
    log(`[transfer-v2] Sweep error: ${err.message}`, "transfer-v2");
  }
}

(async () => {
  await registerRoutes(httpServer, app);

  // Run cleanup once on startup, then every 24 hours
  runPreGradeCleanup();
  setInterval(runPreGradeCleanup, 24 * 60 * 60 * 1000);

  // Run Vault Club grace sweep once on startup, then every 24 hours
  runVaultClubGraceSweep();
  setInterval(runVaultClubGraceSweep, 24 * 60 * 60 * 1000);

  // DMCC reminder dispatcher — picks up rows from subscription_reminders
  // whose scheduled_for is past and sends them. Runs every 5 minutes; also
  // invoked once 60s after boot (lets the migration chain finish first)
  // so a deploy doesn't delay reminders by up to 5 minutes.
  setTimeout(() => {
    import("./vault-club-reminders-dispatcher").then(({ runReminderDispatcher }) => {
      runReminderDispatcher().catch((e: any) =>
        console.error("[reminders] startup dispatch error:", e.message)
      );
      setInterval(() => {
        runReminderDispatcher().catch((e: any) =>
          console.error("[reminders] interval dispatch error:", e.message)
        );
      }, 5 * 60 * 1000);
    });
  }, 60_000);

  // Run transfer v2 sweep after 30s delay (let migrations finish), then every hour
  setTimeout(runTransferV2Sweep, 30_000);
  setInterval(runTransferV2Sweep, 60 * 60 * 1000);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
    },
    () => {
      log(`serving on port ${port}`);
    }
  );
})();
