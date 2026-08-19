import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { csrfOriginCheck } from "./lib/csrf-origin";
import { withAdvisoryLock } from "./lib/advisory-lock";
import { trackInterval, trackTimeout, beginJob, endJob, isShuttingDown, runGracefulShutdown } from "./lib/lifecycle";
import { serveStatic } from "./static";
import { cleanupStalePreGradeImages } from "./r2";
import { createRequestLogger } from "./lib/request-logger";
import { db, pool } from "./db";
import { sql } from "drizzle-orm";
import { sendVaultClubGraceExpiredEmail, sendTransferV2Completed } from "./email";
import { createServer } from "http";
import { WebhookHandlers } from "./webhookHandlers";
import { adminIpAllowlist } from "./auth";
import { getDatabaseUrl } from "./config";
import { FEATURE_FLAGS } from "./config/feature-flags";
import { startConnectorRuntime, stopConnectorRuntime } from "./partner/connector-runtime";
import { validatePartnerRbacAtBoot } from "./partner/permissions";
import pg from "pg";
import path from "path";
import { partnerAccountingTopologyReadiness } from "./partner/db";

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
//
// API endpoints must NOT 301 — non-browser clients (scanner-watcher, future
// webhooks) lose the POST body when node-fetch follows a 301 (RFC 7231
// legacy: 301 follow downgrades POST→GET). Bypassing /api/* here keeps
// canonical-domain redirect for browser traffic while letting machine
// clients reach the real route handler.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.path.startsWith("/api/")) return next();
  const host = (req.headers.host || "").toLowerCase();
  // Skip redirect on staging — APP_URL identifies which fly app is canonical for itself.
  const appUrlHost = (() => {
    try {
      return new URL(process.env.APP_URL || "").host.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (appUrlHost && host === appUrlHost) return next();
  if (host === "mintvault.fly.dev" || host.endsWith(".fly.dev")) {
    console.log(`[canonical-redirect] ${req.method} ${req.originalUrl} from host=${host}`);
    return res.redirect(301, `https://mintvaultuk.com${req.originalUrl}`);
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Readiness probe (Phase 5): unlike /health (pure liveness), /ready also verifies
// the DB is reachable AND the schema is migrated — the core `certificates` table
// exists — so a rolling deploy only routes traffic to a machine that can actually
// serve. Returns a generic status only (no host/schema/error detail).
// NOT rate-limited by design: it is the platform (Fly) readiness probe with one
// cheap catalog lookup; a limiter here could cause false 429s that make Fly route
// traffic away from healthy machines — i.e. it would BREAK health checks. Intentional.
// codeql[js/missing-rate-limiting]
app.get("/ready", async (_req, res) => {
  try {
    const result = await pool.query("SELECT to_regclass('public.certificates') AS t");
    const schemaReady = result.rows[0]?.t != null;
    if (!schemaReady) return res.status(503).json({ status: "not-ready" });
    return res.status(200).json({ status: "ready" });
  } catch {
    return res.status(503).json({ status: "not-ready" });
  }
});

// H-c — /api/db-check removed: it was an unauthenticated debug probe that leaked
// DB host, database name, current_database(), schema/table existence, NODE_ENV,
// env-var presence, and raw DB error messages to any caller. Nothing depended on
// it (Fly health probes hit /health; see fly.toml). Liveness/readiness remain at
// /health and /api/healthz.

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:
          process.env.NODE_ENV === "production"
            ? ["'self'", "https://js.stripe.com"]
            : ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
        // H-e — styleSrc keeps 'unsafe-inline': the React SPA relies on inline
        // style attributes (style={{…}}) and runtime-injected <style> tags
        // (Vite/Tailwind) that can't carry a per-request nonce without a build-
        // pipeline change; removing it white-screens dynamic styling. scriptSrc
        // is ALREADY nonce-free and unsafe-inline-free in production (above).
        // Residual unsafe-inline is style-only — tracked for a future nonce/hash step.
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "https://*.r2.cloudflarestorage.com", "https://i.ebayimg.com"],
        connectSrc: ["'self'", "https://api.stripe.com", "wss:"],
        frameSrc: ["https://js.stripe.com"],
        frameAncestors: ["'none'"], // H-e — clickjacking defence (CSP equivalent of X-Frame-Options: DENY)
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
/**
 * `/api/super-admin/*` inherits the SAME allowlist (hostile-review F5).
 *
 * The four super-admin routers — grading-partners, connector-ops, partner-management and the
 * Partner Master Dashboard — are strictly MORE privileged than `/api/admin`: they read across
 * every tenant and return bulk partner PII. Leaving them outside the allowlist inverted the
 * security gradient, protecting the narrower surface and exposing the wider one.
 *
 * WHY THIS CANNOT LOCK ANYONE OUT: a super-admin session can only be created through
 * `POST /api/admin/login` + `POST /api/admin/pin` (server/routes/auth.ts), both of which are
 * already behind this exact middleware. Anyone able to authenticate has therefore already
 * passed the allowlist from the same address, so no caller that could previously reach a
 * super-admin route loses access.
 *
 * CONFIGURATION COMPATIBILITY: `adminIpAllowlist` returns `next()` immediately when
 * ADMIN_IP_ALLOWLIST is unset or empty, so on any deployment not using the allowlist this is
 * a no-op. It reuses the same variable and the same middleware — no new configuration, no new
 * failure mode. It also adds defence against a stolen session cookie being replayed from an
 * address the operator never uses.
 */
app.use("/api/super-admin", adminIpAllowlist);

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("[stripe] STRIPE_SECRET_KEY not set — payments disabled");
}
if (!process.env.STRIPE_PUBLISHABLE_KEY) {
  console.warn("[stripe] STRIPE_PUBLISHABLE_KEY not set — payments disabled");
}

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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
});

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
  max: 8,
  // 30s tolerates Neon autosuspend cold-start (see server/db.ts for the
  // same rationale). Session reads/writes happen on nearly every request,
  // so this pool is the most likely to surface a cold-start otherwise.
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});
sessionPool.on("error", (err) => {
  console.error("[session-pool] idle client error (evicted):", err.message);
});
app.use(
  session({
    store: new PgStore({
      pool: sessionPool,
      createTableIfMissing: false,
    }),
    secret: (() => {
      const s = process.env.SESSION_SECRET;
      if (!s && process.env.NODE_ENV === "production") {
        throw new Error("SESSION_SECRET is required in production");
      }
      return s || "mintvault-dev-only-secret";
    })(),
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

/**
 * API request/response logging. The middleware and the body-suppression prefix list now live in
 * server/lib/request-logger.ts so they can be driven by a real test; `log` is passed in so the
 * emitted lines are identical to the previous inline implementation.
 */
app.use(createRequestLogger(log));

log(`ADMIN_PASSWORD env var: ${process.env.ADMIN_PASSWORD ? "SET" : "NOT SET"}`, "auth");
// ADMIN_PIN env-var log removed 2026-05-04 — PIN is now per-user bcrypt on users.pin_hash.
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
        try {
          await sendTransferV2Expired({ email: row.fromEmail, certId: row.certId, reason: row.reason });
        } catch (e: any) {
          log(`[transfer-v2] Expired email to fromEmail failed: ${e.message}`, "transfer-v2");
        }
        try {
          await sendTransferV2Expired({ email: row.toEmail, certId: row.certId, reason: row.reason });
        } catch (e: any) {
          log(`[transfer-v2] Expired email to toEmail failed: ${e.message}`, "transfer-v2");
        }
        try {
          await storageForAudit.writeAuditLog("transfer", String(row.transferId), "transfer_v2.expired", null, {
            certId: row.certId,
            reason: row.reason,
            fromEmail: row.fromEmail,
            toEmail: row.toEmail,
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
            await sendTransferV2Completed({
              email: result.toEmail!,
              certId: result.certId!,
              role: "incoming",
              newKeeperName: result.ownerName,
            });
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
  // G6D is transactional only when the MintVault and Partner role URLs address the same database.
  // Keep the main server available: individual G6D lifecycle calls fail closed until an operator
  // reconciles a split topology, rather than turning a Partner URL configuration error into an
  // application-wide outage.
  if (!partnerAccountingTopologyReadiness().ready) {
    log("[partner-credit] G6D settlement unavailable: database topology requires reconciliation.", "partner-credit");
  }

  // Phase 2 (forward-port from remediation-release) — same-origin CSRF defense for
  // cookie-authenticated, state-changing requests. Registered after the module-level
  // middleware (raw-body Stripe webhook, express.json, session) and before the route
  // handlers. Exempts the signature-authed webhook + custom-header scanner-token
  // requests; requests with no Origin/Referer (non-browser clients) pass. Layered on
  // top of the SameSite=lax session cookie.
  app.use(csrfOriginCheck);

  await registerRoutes(httpServer, app);

  // Phase 5: wrap each recurring job that mutates state or sends email/publishes
  // in a Postgres advisory lock so only ONE machine runs a given tick (prod runs
  // 2 machines). Non-blocking + fail-closed; on a single machine the lock is
  // always free, so behaviour is unchanged. Also (graceful shutdown): a guarded
  // tick never starts once shutdown begins, and counts as an active job while it
  // runs so shutdown drains it before the DB pools are closed. Timers use
  // trackInterval/trackTimeout so shutdown can cancel them (no new tick starts).
  const guard = (name: string, fn: () => Promise<void>) => () => {
    if (isShuttingDown()) return Promise.resolve();
    beginJob();
    return withAdvisoryLock(pool, name, fn)
      .then(
        (r) => {
          if (!r.ran) log("skipped — lock held by another instance", name);
        },
        (e: any) => log(`error: ${e?.message ?? e}`, name)
      )
      .finally(() => endJob());
  };

  // Run cleanup once on startup, then every 24 hours
  const guardedPreGradeCleanup = guard("pre-grade-cleanup", runPreGradeCleanup);
  guardedPreGradeCleanup();
  trackInterval(guardedPreGradeCleanup, 24 * 60 * 60 * 1000);

  // Run Vault Club grace sweep once on startup, then every 24 hours (sends email)
  const guardedVaultClubGraceSweep = guard("vault-club-grace-sweep", runVaultClubGraceSweep);
  guardedVaultClubGraceSweep();
  trackInterval(guardedVaultClubGraceSweep, 24 * 60 * 60 * 1000);

  // Run transfer v2 sweep after 30s delay (let migrations finish), then every hour (sends email)
  const guardedTransferV2Sweep = guard("transfer-v2-sweep", runTransferV2Sweep);
  trackTimeout(guardedTransferV2Sweep, 30_000);
  trackInterval(guardedTransferV2Sweep, 60 * 60 * 1000);

  // GB-05 neutral review outbox. The service remains a no-op while its
  // destination/allowlist/token/email authority is not configured. Advisory
  // locking plus SKIP LOCKED claims and Resend idempotency prevent duplicates
  // across the two-machine fleet and crash retries.
  const guardedReviewRequests = guard("growth-review-requests", async () => {
    const { processReviewRequestBatch } = await import("./review-request-service");
    const result = await processReviewRequestBatch();
    if (result.processed > 0) log(`processed=${result.processed}`, "growth-review-requests");
  });
  trackTimeout(guardedReviewRequests, 45_000);
  trackInterval(guardedReviewRequests, 15 * 60 * 1000);

  // Partner credit reservations are a temporary hold, never a manual-maintenance obligation. The
  // domain service treats a pre-0017 database as a no-op for application-first rollout; once G6B
  // exists this hourly, advisory-locked tick expires every due reservation automatically.
  const guardedPartnerCreditReservationExpiry = guard("partner-credit-reservation-expiry", async () => {
    const { runPartnerCreditReservationExpiry } = await import("./jobs/partner-credit-reservation-expiry");
    const result = await runPartnerCreditReservationExpiry();
    if (result.processed > 0) {
      log(`processed=${result.processed} expired=${result.expired.length}`, "partner-credit-reservation-expiry");
    }
  });
  guardedPartnerCreditReservationExpiry();
  trackInterval(guardedPartnerCreditReservationExpiry, 60 * 60 * 1000);

  // Grading Credit reconciliation — hourly, advisory-locked, STRICTLY READ-ONLY.
  //
  // reconcileCreditReservations() has existed and been tested for some time but was never wired to
  // anything, so wallet-vs-ledger drift could occur in production with nobody informed. Drift in the
  // credit ledger is a money-correctness fault: it must raise an alert, and must NEVER be silently
  // repaired, because an automatic correction destroys the evidence needed to explain what happened.
  // Remediation is an audited Super Admin adjustment.
  //
  // An `error`-severity issue means an invariant is already broken (balance mismatch, negative
  // balance, missing consume evidence, duplicate terminal transition, cross-tenant reference), so it
  // is logged at error level with a bounded sample. Expected steady state is exactly zero.
  const guardedPartnerCreditReconciliation = guard("partner-credit-reconciliation", async () => {
    const { runPartnerCreditReconciliation } = await import("./jobs/partner-credit-reconciliation");
    const result = await runPartnerCreditReconciliation();
    if (!result.ran) {
      log(`skipped: ${result.skippedReason}`, "partner-credit-reconciliation");
      return;
    }
    if (result.errors === 0 && result.warnings === 0) return; // silent when clean — zero is the norm
    const summary = Object.entries(result.byCode)
      .map(([code, n]) => `${code}=${n}`)
      .join(" ");
    // eslint-disable-next-line no-console
    console.error(
      `[partner-credit-reconciliation] LEDGER DRIFT DETECTED errors=${result.errors} ` +
        `warnings=${result.warnings} ${summary}\n  ${result.sample.join("\n  ")}`
    );
  });
  guardedPartnerCreditReconciliation();
  trackInterval(guardedPartnerCreditReconciliation, 60 * 60 * 1000);

  /*
   * Partner Card Job reconciliation — every 15 minutes, advisory-locked.
   *
   * THE ONE DOCUMENTED MEDIUM IN THE PARTNER PILOT. QA approval publishes the certificate on the HQ
   * pool and then transitions the Card Job on the partner-admin pool; a crash or deploy between them
   * leaves an approved grade whose Card Job never left QA_REVIEW. Output is fail-closed in that
   * state, so nothing publishes early — but the card is stuck for ever and nobody is told.
   *
   * Fifteen minutes rather than hourly BECAUSE it is fail-closed: the cost of the drift is a real
   * shop waiting on a card it has already paid for and had approved, so the window in which that can
   * go unnoticed should be a coffee break, not a working session.
   *
   * Unlike the credit reconciliation above, this one REPAIRS — the cause is known exactly and the
   * fix is a single legal transition the approval should have made. It settles nothing, mints
   * nothing, touches no grade, re-proves every invariant on a locked row, and audits the repair as a
   * repair. A REFUSED item means the premise did not hold and a human is needed; that is logged at
   * error level, because a card that cannot be repaired automatically is the one that matters.
   */
  const guardedPartnerCardJobReconciliation = guard("partner-card-job-reconciliation", async () => {
    const { runPartnerCardJobReconciliation } = await import("./jobs/partner-card-job-reconciliation");
    const result = await runPartnerCardJobReconciliation();
    if (!result.ran) {
      log(`skipped: ${result.skippedReason}`, "partner-card-job-reconciliation");
      return;
    }
    if (result.drift.repaired > 0 || result.drift.alreadyAdvanced > 0) {
      log(
        `qa drift repaired=${result.drift.repaired} already_advanced=${result.drift.alreadyAdvanced}`,
        "partner-card-job-reconciliation"
      );
    }
    if (result.drift.refused > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[partner-card-job-reconciliation] DRIFT COULD NOT BE REPAIRED refused=${result.drift.refused}\n  ` +
          result.sample.filter((s) => s.startsWith("REFUSED")).join("\n  ")
      );
    }
    if (result.stuckCardJobs > 0 || result.staleLeases > 0) {
      log(
        `stuck_card_jobs=${result.stuckCardJobs} stale_leases=${result.staleLeases}`,
        "partner-card-job-reconciliation"
      );
    }
  });
  guardedPartnerCardJobReconciliation();
  trackInterval(guardedPartnerCardJobReconciliation, 15 * 60 * 1000);

  // RAG Phase 0 — hourly embed-corpus tick. First run after 60s so the
  // server is fully serving before we touch OpenAI; thereafter every
  // hour. Job fail-softs if the migration hasn't run yet, so it's safe
  // to ship the code before approving the migration.
  trackTimeout(async () => {
    try {
      const { runEmbedCorpusJob } = await import("./jobs/embed-corpus");
      const guardedEmbedCorpus = guard("embed-corpus", async () => {
        await runEmbedCorpusJob();
      });
      await guardedEmbedCorpus();
      trackInterval(guardedEmbedCorpus, 60 * 60 * 1000);
    } catch (err: any) {
      log(`[embed-corpus] startup error: ${err?.message || err}`, "embed-corpus");
    }
  }, 60_000);

  // Instagram daily-post cron. Self-paced via setInterval inside
  // startIgDailyPostScheduler() — fires once per UK day inside the
  // 10:00-11:00 London window. Soft-fails if ig_post_queue is missing
  // (migration not yet applied on this branch). Never publishes unless
  // IG_POST_ENABLED=true AND the ig_settings.post_enabled toggle is on.
  trackTimeout(async () => {
    try {
      const { startIgDailyPostScheduler } = await import("./jobs/ig-daily-post");
      startIgDailyPostScheduler();
      log("scheduler armed", "ig-cron");
    } catch (err: any) {
      log(`startup error: ${err?.message || err}`, "ig-cron");
    }
  }, 60_000);

  // startWeeklyReelScheduler() — fires on Fridays at 18:00 UTC. Builds the
  // weekly grade-highlight manifest from consenting submissions; per-card
  // failures are non-fatal. Soft-fails gracefully if SEGMIND_API_KEY is
  // missing in env.
  trackTimeout(async () => {
    try {
      const { startWeeklyReelScheduler } = await import("./jobs/weekly-reel");
      startWeeklyReelScheduler();
      log("scheduler armed (Friday 18:00 UTC)", "weekly-reel");
    } catch (err: any) {
      log(`startup error: ${err?.message || err}`, "weekly-reel");
    }
  }, 60_000);

  // R2 → B2 cold-archive sweep. First run after 60s (let migrations finish
  // + B2 client lazy-init on first use), then daily. Idempotent at the
  // object level via existsInB2 — safe across both Fly machines without
  // a distributed lock. dryRun=false here; admin endpoint allows manual
  // dry-runs separately. Defaults: ageDays=90 (Compliance retention),
  // batchSize=50 (~~5 minutes per tick at realistic per-cert bytes).
  async function runArchivalSweep() {
    try {
      const { archiveStaleImages } = await import("./workers/r2-to-b2-archival");
      const summary = await archiveStaleImages({ dryRun: false, batchSize: 50, ageDays: 90 });
      log(
        `summary: certs=${summary.certsProcessed} copied=${summary.objectsCopied} ` +
          `skipped=${summary.objectsSkipped} bytes=${(summary.bytesCopied / 1024 / 1024).toFixed(2)}MB ` +
          `errors=${summary.errors}`,
        "archival-b2"
      );
    } catch (err: any) {
      log(`sweep error: ${err?.message || err}`, "archival-b2");
    }
  }
  const guardedArchivalSweep = guard("archival-sweep", runArchivalSweep);
  trackTimeout(guardedArchivalSweep, 60_000);
  trackInterval(guardedArchivalSweep, 24 * 60 * 60 * 1000);

  // Scan reconciler — re-drive failed pipelines from retained R2 raw + surface
  // never-confirmed ingests for scanner re-supply. First run 90s after boot,
  // then every 5 min. Idempotent + soft-fails if the durability columns are
  // missing (pre-migration). Safe across both Fly machines (idempotent keys).
  async function runScanReconciler() {
    try {
      const { reconcileStuckScans } = await import("./scan-ingest-service");
      // 30 min (was 10): with 3-4 scanners the per-machine queue legitimately
      // holds cards >10 min at peak; 10 min re-drove QUEUED certs and doubled
      // the backlog (re-drive storm). The job-start heartbeat in
      // processScanInBackground means genuinely dead pipelines still surface;
      // restart-stranded certs recover within ~30-35 min instead of ~10-15.
      await reconcileStuckScans({ staleMinutes: 30 });
    } catch (err: any) {
      log(`reconcile error: ${err?.message || err}`, "scan-reconciler");
    }
  }
  const guardedScanReconciler = guard("scan-reconciler", runScanReconciler);
  trackTimeout(guardedScanReconciler, 90_000);
  trackInterval(guardedScanReconciler, 5 * 60 * 1000);

  // Durable scanner derivative worker. Unlike the legacy in-process FIFO, the
  // PostgreSQL job row survives a Fly restart and is claimed with SKIP LOCKED,
  // so each replica can safely run one bounded worker without sharing Node
  // memory or starting a herd. A short compatibility backoff avoids log churn
  // during a rolling release that has not applied migration 0046 yet.
  let durableScannerWorkerInFlight = false;
  let durableScannerQueueUnavailableUntil = 0;
  const durableScannerWorkerId = `${process.env.FLY_ALLOC_ID || process.env.HOSTNAME || "server"}:${process.pid}`;
  const runDurableScannerWorker = async () => {
    if (isShuttingDown() || durableScannerWorkerInFlight || Date.now() < durableScannerQueueUnavailableUntil) return;
    durableScannerWorkerInFlight = true;
    beginJob();
    try {
      const { runOneScannerProcessingJob } = await import("./scanner-processing-queue");
      await runOneScannerProcessingJob(durableScannerWorkerId);
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === "42P01") {
        durableScannerQueueUnavailableUntil = Date.now() + 60_000;
        log("migration 0046 is not yet available; retrying worker in 60s", "scanner-processing-worker");
      } else {
        log(`worker error: ${err?.message || err}`, "scanner-processing-worker");
      }
    } finally {
      durableScannerWorkerInFlight = false;
      endJob();
    }
  };
  void runDurableScannerWorker();
  trackInterval(() => {
    void runDurableScannerWorker();
  }, 2_000);

  // Direct scanner uploads use an opaque, non-authoritative R2 staging key.
  // Keep staging retention bounded without ever touching immutable masters: a
  // small SKIP LOCKED batch deletes only rows the finaliser marked accepted or
  // whose unused upload grant has expired.
  let stagingCleanupUnavailableUntil = 0;
  const runScannerStagingCleanup = async () => {
    if (isShuttingDown() || Date.now() < stagingCleanupUnavailableUntil) return;
    try {
      const { claimScannerEvidenceStagingCleanup, markScannerEvidenceStagingDeleted } =
        await import("./scanner-evidence-staging-service");
      const { deleteFromR2 } = await import("./r2");
      const candidates = await claimScannerEvidenceStagingCleanup(20);
      for (const candidate of candidates) {
        await deleteFromR2(candidate.objectKey);
        await markScannerEvidenceStagingDeleted(candidate.id);
      }
      if (candidates.length)
        log(`removed ${candidates.length} non-authoritative staging object(s)`, "scanner-staging-cleanup");
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === "42P01") {
        stagingCleanupUnavailableUntil = Date.now() + 60_000;
        log("migration 0047 is not yet available; retrying cleanup in 60s", "scanner-staging-cleanup");
      } else {
        log(`cleanup error: ${err?.message || err}`, "scanner-staging-cleanup");
      }
    }
  };
  trackTimeout(() => {
    void runScannerStagingCleanup();
  }, 2 * 60_000);
  trackInterval(() => {
    void runScannerStagingCleanup();
  }, 5 * 60_000);

  // Session expiry is batch-owned by the service, not by each 3–35 second
  // station poll. The query has a partial expiry index and SKIP LOCKED, so two
  // replicas can make bounded cleanup progress without a global UPDATE storm.
  let scannerExpiryUnavailableUntil = 0;
  const sweepExpiredScannerCaptures = async () => {
    if (isShuttingDown() || Date.now() < scannerExpiryUnavailableUntil) return;
    try {
      const { expireScannerCaptureSessions } = await import("./scanner-capture-service");
      const expired = await expireScannerCaptureSessions(100);
      if (expired) log(`expired ${expired} scanner capture session(s)`, "scanner-capture-expiry");
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === "42P01") {
        scannerExpiryUnavailableUntil = Date.now() + 60_000;
        log("scanner capture schema is not yet available; retrying expiry sweep in 60s", "scanner-capture-expiry");
      } else {
        log(`expiry sweep error: ${err?.message || err}`, "scanner-capture-expiry");
      }
    }
  };
  trackTimeout(() => {
    void sweepExpiredScannerCaptures();
  }, 60_000);
  trackInterval(() => {
    void sweepExpiredScannerCaptures();
  }, 60_000);

  // A05 — unmatched /api/* returns a clean 404 JSON instead of falling through
  // to the SPA index.html. Sits AFTER all real API routes (registerRoutes above)
  // and BEFORE the SPA catch-all (serveStatic/setupVite below), so no real
  // endpoint 404s and client-side routing for non-/api paths is unaffected.
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // H-d — single generic error response path. Log the FULL error (message +
  // stack) server-side; NEVER leak internal exception detail to clients.
  // Intentional client errors created via http-errors (status < 500 with
  // expose=true) keep their safe, user-facing message; everything else returns a
  // generic body. Inline route validation (res.status(4xx).json(...)) responds
  // before reaching here, so helpful 4xx messages are untouched.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    if (status < 500 && err.expose === true && typeof err.message === "string") {
      return res.status(status).json({ error: err.message });
    }
    return res.status(status).json({ error: "Internal server error" });
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
      // Resolved AI feature-flag state at boot — surfaces in Fly logs so we can
      // confirm which AI features are live without exec'ing into the machine.
      const FF = FEATURE_FLAGS;
      console.log(
        "[ai-flags]",
        JSON.stringify({
          identify: FF.AI_IDENTIFY_ENABLED,
          defect_suggest: FF.AI_DEFECT_SUGGEST_ENABLED,
          haiku_quick_grade: FF.AI_HAIKU_QUICK_GRADE_ENABLED,
          full_grade: FF.AI_FULL_GRADE_ENABLED,
          centering: FF.AI_CENTERING_ENABLED,
          standalone_detect: FF.AI_STANDALONE_DETECT_ENABLED,
          standalone_grade: FF.AI_STANDALONE_GRADE_ENABLED,
          description_gen: FF.AI_DESCRIPTION_GEN_ENABLED,
          gpt_second_opinion: FF.AI_GPT_SECOND_OPINION_ENABLED,
          public_estimate: FF.AI_PUBLIC_ESTIMATE_ENABLED,
        })
      );

      // Neon-compute keep-warm. Fly's health probe (/health) doesn't touch the
      // DB, so a long quiet period lets Neon autosuspend the compute, which
      // surfaces as a 1–5s cold-start on the next real request. A SELECT 1
      // every ~4 minutes keeps the compute hot without coupling Fly liveness
      // to DB availability (a Neon blip there would cycle machines).
      //
      // - Runs on the same Drizzle pool the app uses, so warmth applies to the
      //   actual connection path.
      // - .unref() so this timer never holds the event loop open during a
      //   graceful shutdown (Fly SIGTERM should still drain cleanly).
      // - Errors are logged and swallowed; this is a best-effort warm-up and
      //   must NEVER take the process down.
      const KEEP_WARM_INTERVAL_MS = 4 * 60 * 1000;
      trackInterval(
        () => {
          pool
            .query("SELECT 1")
            .catch((err: any) => console.warn("[db-keepwarm] SELECT 1 failed:", err?.message ?? err));
        },
        KEEP_WARM_INTERVAL_MS,
        { unref: true }
      );
      console.log(`[db-keepwarm] interval armed (${KEEP_WARM_INTERVAL_MS / 1000}s)`);

      // Partner Trusted Intake Connector driver. Started only AFTER the server is
      // listening, and deliberately fire-and-forget: startConnectorRuntime never
      // throws, never awaits, and parks itself in a visible "stopped" state on any
      // failure — a connector problem can never crash or delay the main app. With
      // no PARTNER_CONNECTOR_DATABASE_URL it logs one line and does nothing at all.
      startConnectorRuntime();

      // Partner RBAC reference data (roles/permissions/mappings) — READ-ONLY validation.
      //
      // The catalogue itself is seeded by migration 0034_partner_rbac_seed.sql, NOT here: a runtime
      // application identity must not mutate the Partner security catalogue (owner decision,
      // 2026-07-31). This call only reads, and publishes what it finds to the partner readiness
      // endpoint so an incomplete catalogue is visible rather than silent. Fail-soft: it never
      // throws and never delays the listen path.
      validatePartnerRbacAtBoot();
    }
  );
})();

// Graceful shutdown (Phase 5): on SIGTERM/SIGINT — mark shutting-down + cancel
// every scheduled timer (so no NEW cron tick starts), stop accepting traffic and
// drain in-flight requests, wait for any active guarded job to finish, THEN close
// the DB pools (never under a live job), and exit. A hard 10s deadline always
// forces exit. fly.toml kill_timeout is set to 15s so Fly waits for the drain
// instead of SIGKILLing early (Fly default is ~5s).
function gracefulShutdown(signal: string) {
  log(`${signal} received — draining and shutting down`, "shutdown");
  void runGracefulShutdown({
    deadlineMs: 10_000,
    closeServer: async () => {
      // Drain the connector runtime alongside the HTTP server: it stops taking NEW
      // claims and waits for the in-flight cycle, so no lease is leaked. Never
      // allowed to block or fail the shutdown path.
      await Promise.all([
        new Promise<void>((resolve) => {
          httpServer.close(() => {
            log("http server closed to new connections", "shutdown");
            resolve();
          });
        }),
        stopConnectorRuntime().catch(() => undefined),
      ]);
    },
    closePools: async () => {
      await Promise.allSettled([pool.end(), sessionPool.end()]);
      log("db pools closed — exiting cleanly", "shutdown");
    },
    exit: (code) => process.exit(code),
  });
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
