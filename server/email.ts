import { Resend } from "resend";

const FROM_EMAIL = "MintVault UK <mintvaultuk@gmail.com>";
const FALLBACK_FROM = "MintVault UK <onboarding@resend.dev>";

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY not set — emails disabled");
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

function getFromEmail(): string {
  if (process.env.RESEND_DOMAIN_VERIFIED === "true") {
    return FROM_EMAIL;
  }
  return FALLBACK_FROM;
}

function baseHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#111;border:1px solid #D4AF37;border-radius:8px;overflow:hidden;">
<tr><td style="background:#111;padding:24px 32px;text-align:center;border-bottom:1px solid rgba(212,175,55,0.3);">
<h1 style="margin:0;color:#D4AF37;font-size:24px;letter-spacing:4px;font-weight:bold;">MINTVAULT UK</h1>
</td></tr>
<tr><td style="padding:32px;color:#ccc;font-size:14px;line-height:1.6;">
<h2 style="color:#D4AF37;font-size:18px;margin:0 0 16px 0;letter-spacing:1px;">${title}</h2>
${body}
</td></tr>
<tr><td style="padding:16px 32px;text-align:center;border-top:1px solid rgba(212,175,55,0.15);color:#666;font-size:11px;">
<p style="margin:0;">MintVault UK Ltd &bull; Professional Card Grading</p>
<p style="margin:4px 0 0 0;">mintvaultuk@gmail.com</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function trackingUrl(submissionId: string): string {
  const base = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : process.env.REPLIT_DOMAINS
      ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
      : "https://mintvaultuk.com";
  return `${base}/track`;
}

const SERVICE_TYPE_LABELS: Record<string, string> = {
  grading: "Card Grading",
  reholder: "Reholder",
  crossover: "Crossover",
  authentication: "Authentication",
};

export async function sendSubmissionConfirmation(data: {
  email: string;
  firstName: string;
  submissionId: string;
  cardCount: number;
  tier: string;
  total: number;
  serviceType?: string;
  crossoverCompany?: string;
  crossoverOriginalGrade?: string;
  crossoverCertNumber?: string;
}) {
  const resend = getResend();
  if (!resend) return;

  const serviceLabel = SERVICE_TYPE_LABELS[data.serviceType || ""] || (data.serviceType?.toUpperCase() || "");
  const crossoverRows = data.serviceType === "crossover" && data.crossoverCompany ? `
<tr><td style="padding:8px 0;color:#999;width:140px;">Original Company</td><td style="padding:8px 0;color:#fff;">${data.crossoverCompany}</td></tr>
${data.crossoverOriginalGrade ? `<tr><td style="padding:8px 0;color:#999;">Original Grade</td><td style="padding:8px 0;color:#fff;">${data.crossoverOriginalGrade}</td></tr>` : ""}
${data.crossoverCertNumber ? `<tr><td style="padding:8px 0;color:#999;">Cert Number</td><td style="padding:8px 0;color:#fff;">${data.crossoverCertNumber}</td></tr>` : ""}
<tr><td colspan="2" style="padding:8px 0;color:#999;font-size:12px;">⚠️ Crossover is subject to review. Cards not meeting crossover standards will be returned.</td></tr>
` : "";

  const body = `
<p>Hi ${data.firstName},</p>
<p>Thank you for your submission. Your order has been confirmed and payment received.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Service Type</td><td style="padding:8px 0;color:#fff;">${serviceLabel}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Number of Cards</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Service Tier</td><td style="padding:8px 0;color:#fff;">${data.tier.toUpperCase()}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Total Paid</td><td style="padding:8px 0;color:#fff;">&pound;${(data.total / 100).toFixed(2)}</td></tr>
${crossoverRows}
</table>
<h3 style="color:#D4AF37;font-size:14px;margin:24px 0 8px 0;">NEXT STEPS</h3>
<ol style="margin:0;padding-left:20px;color:#ccc;">
<li style="margin-bottom:8px;">Pack your cards securely using rigid card savers or top loaders inside a padded envelope or box.</li>
<li style="margin-bottom:8px;">Include a note with your Submission ID: <strong style="color:#D4AF37;">${data.submissionId}</strong></li>
<li style="margin-bottom:8px;">Post via tracked and insured delivery to the address shown on your packing slip.</li>
<li style="margin-bottom:8px;">We will confirm receipt and begin grading.</li>
</ol>
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK YOUR SUBMISSION</a>
</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `MintVault — Submission Confirmed (${data.submissionId})`,
      html: baseHtml("Submission Confirmed", body),
    });
    console.log(`[email] Submission confirmation sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send confirmation to ${data.email}:`, err.message);
  }
}

export async function sendCardsReceived(data: {
  email: string;
  firstName: string;
  submissionId: string;
  cardCount: number;
}) {
  const resend = getResend();
  if (!resend) return;

  const body = `
<p>Hi ${data.firstName},</p>
<p>Great news — we have received your cards and they have been logged into our system.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Cards Received</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
</table>
<p>Your cards will now enter our grading queue. We will notify you when grading is complete.</p>
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK YOUR SUBMISSION</a>
</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `MintVault — Cards Received (${data.submissionId})`,
      html: baseHtml("Cards Received", body),
    });
    console.log(`[email] Cards received email sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send cards received to ${data.email}:`, err.message);
  }
}

export async function sendGradingComplete(data: {
  email: string;
  firstName: string;
  submissionId: string;
  cardCount: number;
}) {
  const resend = getResend();
  if (!resend) return;

  const body = `
<p>Hi ${data.firstName},</p>
<p>Your cards have been graded and are now being prepared for return shipping.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Cards Graded</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
</table>
<p>Once your cards have been dispatched, you will receive a shipping confirmation with tracking details.</p>
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK YOUR SUBMISSION</a>
</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `MintVault — Grading Complete (${data.submissionId})`,
      html: baseHtml("Grading Complete", body),
    });
    console.log(`[email] Grading complete email sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send grading complete to ${data.email}:`, err.message);
  }
}

export async function sendShipped(data: {
  email: string;
  firstName: string;
  submissionId: string;
  cardCount: number;
  trackingNumber?: string;
  carrier?: string;
}) {
  const resend = getResend();
  if (!resend) return;

  const trackingRow = data.trackingNumber
    ? `<tr><td style="padding:8px 0;color:#999;">Tracking Number</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.trackingNumber}</td></tr>`
    : "";
  const carrierRow = data.carrier
    ? `<tr><td style="padding:8px 0;color:#999;">Carrier</td><td style="padding:8px 0;color:#fff;">${data.carrier}</td></tr>`
    : "";

  const body = `
<p>Hi ${data.firstName},</p>
<p>Your graded cards have been dispatched and are on their way to you!</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Cards</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
${carrierRow}
${trackingRow}
</table>
<p>Please ensure someone is available to sign for the delivery. If you have any issues with your delivery, please contact the courier directly using the tracking number above.</p>
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK YOUR SUBMISSION</a>
</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `MintVault — Your Cards Have Been Shipped (${data.submissionId})`,
      html: baseHtml("Your Cards Have Been Shipped", body),
    });
    console.log(`[email] Shipped email sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send shipped email to ${data.email}:`, err.message);
  }
}

export async function sendClaimVerification(data: {
  email: string;
  certId: string;
  verifyUrl: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED claim verification email to ${data.email} (no Resend client)`);
    return;
  }

  const body = `
<p style="color:#ccc;">You have requested to claim ownership of certificate <strong style="color:#D4AF37;">${data.certId}</strong>.</p>
<p style="color:#ccc;">Click the button below to verify your email and complete the claim:</p>
<div style="text-align:center;margin:24px 0;">
  <a href="${data.verifyUrl}" style="display:inline-block;background:#D4AF37;color:#000;padding:12px 32px;text-decoration:none;font-weight:bold;border-radius:4px;font-size:16px;letter-spacing:1px;">VERIFY &amp; CLAIM</a>
</div>
<p style="color:#999;font-size:12px;">This link expires in 24 hours. If you did not request this, you can safely ignore this email.</p>
<p style="color:#666;font-size:11px;word-break:break-all;">Or copy this link: ${data.verifyUrl}</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: `MintVault — Verify Ownership Claim for ${data.certId}`,
      html: baseHtml("Verify Your Ownership Claim", body),
    });
    console.log(`[email] Claim verification email sent to ${data.email} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send claim verification to ${data.email}:`, err.message);
  }
}
