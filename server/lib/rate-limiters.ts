import rateLimit from "express-rate-limit";

// The admin's email, exempt from certain public rate-limits via the
// x-mv-admin-email header. Relocated here from routes.ts so the reissue/estimate
// limiters' skip() can use it without a circular import; re-imported by routes.ts.
export const ADMIN_FREE_EMAIL = "neilsophieoliver@gmail.com";

// Shared rate-limiters (extracted from routes.ts registerRoutes closure so domain
// route modules can import them). Pure config — behaviour identical to before.

export const waitlistRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts from this device. Please try again later." },
  });

export const contactRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many contact-form submissions from this device. Please wait 15 minutes." },
  });

export const mvgsInterestRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many submissions from this device. Please wait an hour." },
  });

export const cookieAckRateLimit = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests." },
  });

export const paymentRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many payment attempts. Please wait a few minutes and try again." },
  });

export const stolenReportRateLimit = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Daily report limit reached. Contact support@mintvaultuk.com if you need to file more." },
  });

export const transferActionRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many transfer actions — please try again later." },
  });

export const reissueRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many reissue requests — please try again later." },
    skip: (req) => {
      const adminEmail = (req.header("x-mv-admin-email") || "").trim().toLowerCase();
      return adminEmail === ADMIN_FREE_EMAIL;
    },
  });

export const preGradeRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "AI pre-grade is limited to 3 requests per hour per IP. Try again later." },
  });

export const preGradePreviewRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many preview requests. Try again later." },
  });

export const lookupRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Limit: 60 per minute per IP." },
  });

export const verifyRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Limit: 100 per minute per IP." },
  });

export const showcaseRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Limit: 30 per minute per IP." },
  });

export const aiRateLimit = rateLimit({
    windowMs: 5 * 1000,
    max: 1,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => false,
    message: { error: "Please wait 5 seconds between AI analysis requests." },
  });

export const claimRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many claim attempts from this device. Please wait 15 minutes before trying again." },
  });

export const transferRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many transfer attempts from this device. Please wait 15 minutes before trying again." },
  });

export const transferV2RateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many transfer attempts. Please wait 15 minutes before trying again." },
  });

export const refNumberRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many verification attempts. Please wait before trying again." },
  });

export const magicLinkRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login requests. Please wait 15 minutes." },
  });

export const accountSwitchRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many switch attempts. Please wait 15 minutes." },
  });

export const pinLoginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts. Please wait 15 minutes." },
  });

export const toolsRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests — please wait a minute." },
  });

export const estimateRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many estimate requests — you can request up to 5 estimates per hour." },
    skip: (req) => {
      const headerEmail = ((req.headers["x-mv-admin-email"] as string) || "").trim().toLowerCase();
      return headerEmail === ADMIN_FREE_EMAIL;
    },
  });
