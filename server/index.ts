import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripeClient";
import { WebhookHandlers } from "./webhookHandlers";
import { adminIpAllowlist } from "./auth";
import { getDatabaseUrl } from "./config";
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
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "https://api.stripe.com", "wss:"],
        frameSrc: ["https://js.stripe.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
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
app.use("/api/admin", adminIpAllowlist);

async function initStripe() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    console.warn("MINTVAULT_DATABASE_URL not set, skipping Stripe initialization");
    return;
  }

  try {
    log("Initializing Stripe schema...", "stripe");
    await runMigrations({ databaseUrl, schema: "stripe" });
    log("Stripe schema ready", "stripe");

    const stripeSync = await getStripeSync();

    try {
      const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
      if (domain) {
        const webhookUrl = `https://${domain}/api/stripe/webhook`;
        const result = await stripeSync.findOrCreateManagedWebhook(webhookUrl);
        log(`Webhook configured: ${result?.webhook?.url || webhookUrl}`, "stripe");
      } else {
        log("REPLIT_DOMAINS not set, skipping webhook registration", "stripe");
      }
    } catch (webhookErr: any) {
      log(`Webhook setup warning: ${webhookErr.message}`, "stripe");
    }

    stripeSync
      .syncBackfill()
      .then(() => log("Stripe data synced", "stripe"))
      .catch((err: any) => console.error("Error syncing Stripe data:", err));
  } catch (error) {
    console.error("Failed to initialize Stripe:", error);
  }
}

initStripe().catch(err => console.error("Stripe init failed:", err));

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
      maxAge: 12 * 60 * 60 * 1000,
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

(async () => {
  await registerRoutes(httpServer, app);

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
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    }
  );
})();
