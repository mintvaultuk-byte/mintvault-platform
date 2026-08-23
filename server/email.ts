import { Resend } from "resend";
import { APP_BASE_URL } from "./app-url";
import { COMPANY, formatPostalAddress } from "@shared/company";
import { trackUrl, serviceLabel, carrierLabel, carrierIdFromLegacyName } from "@shared/carriers";
import { recordApplicationOutcome } from "./growth-runtime-telemetry";

// Pre-formatted postal address as HTML <br />-joined block. Sourced from
// the canonical record on shared/company.ts so any address change updates
// every email template in lockstep.
const POSTAL_ADDRESS_HTML = formatPostalAddress(COMPANY.postalAddress, {
  multiline: true,
  includeDisplayName: true,
})
  .split("\n")
  .join("<br />");

const FROM_EMAIL = "MintVault UK <noreply@mintvaultuk.com>";
const FALLBACK_FROM = "MintVault UK <onboarding@resend.dev>";
const REPLY_TO = "mintvaultuk@gmail.com";

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

/**
 * Centralised Resend send wrapper. Checks the SDK error field that v3+ returns
 * on API failures (401, 422, etc.) instead of throwing. Throws on any failure
 * so callers know when an email was NOT sent.
 */
async function sendViaResend(
  resend: Resend,
  payload: {
    from: string;
    to: string | string[];
    replyTo?: string;
    subject: string;
    html: string;
    bcc?: string | string[];
    attachments?: Array<{ filename: string; content: Buffer | string }>;
  },
  options: { idempotencyKey?: string } = {}
): Promise<{ id: string }> {
  try {
    const result = await resend.emails.send(payload, options);
    if (result.error) {
      throw new Error(`Resend API error: ${result.error.message || JSON.stringify(result.error)}`);
    }
    if (!result.data?.id) {
      throw new Error("Resend returned no message id");
    }
    recordApplicationOutcome("email", "SUCCESS");
    return { id: result.data.id };
  } catch (error) {
    recordApplicationOutcome("email", "PLATFORM_FAILURE");
    throw error;
  }
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
  const base = APP_BASE_URL;
  return `${base}/track`;
}

/** HTML-escape a string for safe inclusion in email bodies. Preserves
 *  line breaks by converting \n → <br />. Used by sendContactInquiry to
 *  render free-form customer text without HTML injection risk. */
function escapeHtmlForEmail(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br />");
}

const CONTACT_TOPIC_LABELS: Record<string, string> = {
  submission: "Submission enquiry",
  grading: "Grading question",
  "cert-vault": "Certificate / Vault",
  ownership: "Ownership registry",
  "returns-shipping": "Returns & shipping",
  payment: "Payment",
  other: "Other",
};

/**
 * Send a customer contact-form submission to the configured inbox.
 *
 * To: CONTACT_INBOX_EMAIL env var, fallback hello@mintvaultuk.com.
 * From: getFromEmail() (verified Resend sender).
 * Reply-To: data.email so the inbox operator can reply directly.
 *
 * Throws on Resend failure so the calling route can record the error
 * against the contact_inquiries row.
 */
export async function sendContactInquiry(data: {
  name: string;
  email: string;
  topic: string;
  message: string;
  submittedAt: Date;
  inquiryId?: number;
}): Promise<{ id: string } | null> {
  const resend = getResend();
  if (!resend) return null;

  const inbox = process.env.CONTACT_INBOX_EMAIL || "hello@mintvaultuk.com";
  const topicLabel = CONTACT_TOPIC_LABELS[data.topic] || data.topic;
  const safeName = escapeHtmlForEmail(data.name);
  const safeEmail = escapeHtmlForEmail(data.email);
  const safeMessage = escapeHtmlForEmail(data.message);
  const submittedAtFmt = data.submittedAt.toISOString();

  const body = `
<p style="color:#ccc;font-size:13px;margin:0 0 16px 0;">New contact-form submission via mintvaultuk.com/help/contact.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:120px;">From</td><td style="padding:8px 0;color:#fff;">${safeName} &lt;${safeEmail}&gt;</td></tr>
<tr><td style="padding:8px 0;color:#999;">Topic</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${topicLabel}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Submitted</td><td style="padding:8px 0;color:#fff;font-family:Menlo,monospace;font-size:12px;">${submittedAtFmt}</td></tr>
${data.inquiryId != null ? `<tr><td style="padding:8px 0;color:#999;">Inquiry ID</td><td style="padding:8px 0;color:#fff;font-family:Menlo,monospace;font-size:12px;">#${data.inquiryId}</td></tr>` : ""}
</table>
<h3 style="color:#D4AF37;font-size:14px;margin:24px 0 8px 0;">MESSAGE</h3>
<div style="padding:16px;border:1px solid #333;border-radius:6px;background:rgba(255,255,255,0.03);color:#fff;font-size:13px;line-height:1.6;">
${safeMessage}
</div>
<p style="color:#666;font-size:11px;margin-top:24px;">Reply directly to this email — the Reply-To header is set to the customer's address.</p>`;

  return sendViaResend(resend, {
    from: getFromEmail(),
    replyTo: data.email,
    to: inbox,
    subject: `MintVault Contact: [${topicLabel}] — from ${data.name}`,
    html: baseHtml("Customer Contact", body),
  });
}

/**
 * Notify MintVault's configured business inbox about a newly persisted public
 * Partner application. This intentionally has no applicant acknowledgement:
 * the application receipt is shown on-page and no marketing/approval promise
 * is inferred from submitting the form.
 */
export async function sendPartnerApplicationNotification(data: {
  leadId: string;
  businessName: string;
  contactName: string;
  email: string;
  city: string;
  postcode: string;
  businessType: string;
  webPresence: string;
  interestReason: string;
  physicalRetail?: boolean;
  categories: string[];
  demandBand?: string;
  existingGradingSubmissions?: string;
}): Promise<{ id: string } | null> {
  const resend = getResend();
  if (!resend) return null;

  const inbox = process.env.CONTACT_INBOX_EMAIL || "hello@mintvaultuk.com";
  const safe = (value: string) => escapeHtmlForEmail(value);
  const optionalRows = [
    data.physicalRetail === undefined
      ? ""
      : `<tr><td style="padding:8px 0;color:#999;">Physical retail</td><td style="padding:8px 0;color:#fff;">${data.physicalRetail ? "Yes" : "No"}</td></tr>`,
    data.categories.length
      ? `<tr><td style="padding:8px 0;color:#999;">Categories</td><td style="padding:8px 0;color:#fff;">${safe(data.categories.join(", "))}</td></tr>`
      : "",
    data.demandBand
      ? `<tr><td style="padding:8px 0;color:#999;">Demand band</td><td style="padding:8px 0;color:#fff;">${safe(data.demandBand)}</td></tr>`
      : "",
    data.existingGradingSubmissions
      ? `<tr><td style="padding:8px 0;color:#999;">Existing grading service</td><td style="padding:8px 0;color:#fff;">${safe(data.existingGradingSubmissions)}</td></tr>`
      : "",
  ].join("");

  const body = `
<p style="color:#ccc;font-size:13px;margin:0 0 16px 0;">A public Founding Partner application has been received. Review does not create a Partner account or operational access.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:145px;">Application ID</td><td style="padding:8px 0;color:#D4AF37;font-family:Menlo,monospace;font-weight:bold;">${safe(data.leadId)}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Business</td><td style="padding:8px 0;color:#fff;">${safe(data.businessName)}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Contact</td><td style="padding:8px 0;color:#fff;">${safe(data.contactName)} &lt;${safe(data.email)}&gt;</td></tr>
<tr><td style="padding:8px 0;color:#999;">Location</td><td style="padding:8px 0;color:#fff;">${safe(data.city)}, ${safe(data.postcode)}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Business type</td><td style="padding:8px 0;color:#fff;">${safe(data.businessType)}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Website / social</td><td style="padding:8px 0;color:#fff;">${safe(data.webPresence)}</td></tr>
${optionalRows}
</table>
<h3 style="color:#D4AF37;font-size:14px;margin:24px 0 8px 0;">WHY THEY ARE INTERESTED</h3>
<div style="padding:16px;border:1px solid #333;border-radius:6px;background:rgba(255,255,255,0.03);color:#fff;font-size:13px;line-height:1.6;">${safe(data.interestReason)}</div>`;

  return sendViaResend(resend, {
    from: getFromEmail(),
    replyTo: data.email,
    to: inbox,
    // Fixed subject avoids putting untrusted names into email headers.
    subject: `MintVault Partner Application ${data.leadId}`,
    html: baseHtml("Founding Partner application", body),
  });
}

/**
 * Operational notification for a Partner supplies request that has ALREADY committed durably.
 *
 * This intentionally reuses the one Resend transport/escaping authority in this module. It has no
 * customer acknowledgement, payment link, credential, token or staff Gmail fallback: delivery goes
 * only to the configured operational inbox used by the existing Partner/contact notifications.
 * Retries must pass the same `idempotencyKey` for the canonical order, so a crash after Resend
 * accepts the message cannot duplicate operational mail on recovery.
 */
export async function sendPartnerSuppliesOrderNotification(data: {
  orderReference: string;
  partnerName: string;
  shopName: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  deliveryAddress: string;
  deliveryPostcode: string;
  deliveryCountry: string;
  submittedAt: string;
  items: Array<{ label: string; quantity: number }>;
  notes?: string | null;
  idempotencyKey: string;
}): Promise<{ id: string } | null> {
  const resend = getResend();
  if (!resend) return null;

  const inbox = process.env.CONTACT_INBOX_EMAIL || "hello@mintvaultuk.com";
  const safe = (value: string) => escapeHtmlForEmail(value);
  const itemRows = data.items
    .map(
      (item) =>
        `<tr><td style="padding:8px 0;color:#fff;">${safe(item.label)}</td><td style="padding:8px 0;color:#fff;text-align:right;font-family:Menlo,monospace;">${item.quantity}</td></tr>`
    )
    .join("");
  const contactPhone = data.contactPhone ? `<br />${safe(data.contactPhone)}` : "";
  const notes = data.notes
    ? `<h3 style="color:#D4AF37;font-size:14px;margin:24px 0 8px 0;">NOTES</h3><div style="padding:12px;border:1px solid #333;border-radius:6px;background:rgba(255,255,255,0.03);color:#fff;font-size:13px;line-height:1.6;">${safe(data.notes)}</div>`
    : "";
  const body = `
<p style="color:#ccc;font-size:13px;margin:0 0 16px 0;">A Partner supplies order has been received and is ready for operational processing. This is not a payment or stock-dispatch instruction.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:145px;">Order ID</td><td style="padding:8px 0;color:#D4AF37;font-family:Menlo,monospace;font-weight:bold;">${safe(data.orderReference)}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Submitted</td><td style="padding:8px 0;color:#fff;">${safe(data.submittedAt)}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Partner</td><td style="padding:8px 0;color:#fff;">${safe(data.partnerName)}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Shop</td><td style="padding:8px 0;color:#fff;">${safe(data.shopName)}</td></tr>
<tr><td style="padding:8px 0;color:#999;vertical-align:top;">Contact</td><td style="padding:8px 0;color:#fff;">${safe(data.contactName)}<br />${safe(data.contactEmail)}${contactPhone}</td></tr>
<tr><td style="padding:8px 0;color:#999;vertical-align:top;">Delivery address</td><td style="padding:8px 0;color:#fff;">${safe(data.deliveryAddress)}<br />${safe(data.deliveryPostcode)}<br />${safe(data.deliveryCountry)}</td></tr>
</table>
<h3 style="color:#D4AF37;font-size:14px;margin:24px 0 8px 0;">ITEMS</h3>
<table style="width:100%;border-collapse:collapse;border-top:1px solid #333;border-bottom:1px solid #333;">
<tr><th style="padding:8px 0;color:#999;text-align:left;font-size:11px;letter-spacing:1px;">PRODUCT</th><th style="padding:8px 0;color:#999;text-align:right;font-size:11px;letter-spacing:1px;">QUANTITY</th></tr>
${itemRows}
</table>
${notes}`;

  return sendViaResend(
    resend,
    {
      from: getFromEmail(),
      to: inbox,
      // A trusted canonical reference only: untrusted partner/contact names never enter headers.
      subject: `MintVault Partner Supplies ${data.orderReference}`,
      html: baseHtml("Partner supplies order", body),
    },
    { idempotencyKey: data.idempotencyKey }
  );
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
  labelToken?: string;
}) {
  const resend = getResend();
  if (!resend) return;

  const serviceLabel = SERVICE_TYPE_LABELS[data.serviceType || ""] || data.serviceType?.toUpperCase() || "";
  const crossoverRows =
    data.serviceType === "crossover" && data.crossoverCompany
      ? `
<tr><td style="padding:8px 0;color:#999;width:140px;">Original Company</td><td style="padding:8px 0;color:#fff;">${data.crossoverCompany}</td></tr>
${data.crossoverOriginalGrade ? `<tr><td style="padding:8px 0;color:#999;">Original Grade</td><td style="padding:8px 0;color:#fff;">${data.crossoverOriginalGrade}</td></tr>` : ""}
${data.crossoverCertNumber ? `<tr><td style="padding:8px 0;color:#999;">Cert Number</td><td style="padding:8px 0;color:#fff;">${data.crossoverCertNumber}</td></tr>` : ""}
<tr><td colspan="2" style="padding:8px 0;color:#999;font-size:12px;">⚠️ Crossover is subject to review. Cards not meeting crossover standards will be returned.</td></tr>
`
      : "";

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
<li style="margin-bottom:8px;">Post via tracked and insured delivery to:</li>
</ol>
<div style="margin:8px 0 16px 24px;padding:12px 16px;border:1px solid #333;border-radius:6px;background:rgba(255,255,255,0.03);color:#fff;font-family:Menlo,monospace;font-size:13px;line-height:1.6;">
${POSTAL_ADDRESS_HTML}
</div>
<p style="color:#999;font-size:12px;margin:0 0 16px 24px;">Also printed on your packing slip — please include the slip inside the parcel.</p>
<ol start="4" style="margin:0;padding-left:20px;color:#ccc;">
<li style="margin-bottom:8px;">We will confirm receipt and begin grading.</li>
</ol>
${
  data.labelToken
    ? `
<p style="margin-top:24px;">
<a href="${APP_BASE_URL}/api/submissions/${data.submissionId}/shipping-label?token=${data.labelToken}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;margin-right:12px;">DOWNLOAD SHIPPING LABEL</a>
<a href="${APP_BASE_URL}/api/submissions/${data.submissionId}/packing-slip?token=${data.labelToken}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.05);border:1px solid rgba(212,175,55,0.4);color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">DOWNLOAD PACKING SLIP</a>
</p>`
    : ""
}
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK YOUR SUBMISSION</a>
</p>`;

  try {
    const sent = await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Submission Confirmed (${data.submissionId})`,
      html: baseHtml("Submission Confirmed", body),
    });
    console.log(`[email] submission_confirmation_sent submissionId=${data.submissionId} providerMessageId=${sent.id}`);
  } catch (err: any) {
    console.error(`[email] submission_confirmation_failed submissionId=${data.submissionId}`);
    throw err;
  }
}

/** V2 order confirmation — includes legal page links, inspection window, and terms acceptance record. Used when LEGAL_PAGES_LIVE=true. */
export async function sendSubmissionConfirmationV2(data: {
  email: string;
  firstName: string;
  submissionId: string;
  cardCount: number;
  tier: string;
  total: number;
  serviceType?: string;
  labelToken?: string;
  termsVersion?: string;
  termsAcceptedAt?: string;
}) {
  const resend = getResend();
  if (!resend) return;

  const serviceLabel = SERVICE_TYPE_LABELS[data.serviceType || ""] || data.serviceType?.toUpperCase() || "";
  const body = `
<p>Hi ${data.firstName},</p>
<p>Thank you for your submission. Your order has been confirmed and payment received.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Service</td><td style="padding:8px 0;color:#fff;">${serviceLabel}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Cards</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Tier</td><td style="padding:8px 0;color:#fff;">${data.tier.toUpperCase()}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Total Paid</td><td style="padding:8px 0;color:#fff;">&pound;${(data.total / 100).toFixed(2)}</td></tr>
</table>

<div style="border:1px solid rgba(212,175,55,0.3);border-radius:8px;padding:16px;margin:20px 0;background:rgba(212,175,55,0.05);">
<h4 style="color:#D4AF37;margin:0 0 8px 0;font-size:13px;">14-Day Inspection Window</h4>
<p style="color:#ccc;font-size:12px;margin:0;">Please inspect your returned Card on arrival and report any issues to support@mintvaultuk.com within 14 days of delivery.</p>
</div>

<div style="border:1px solid #333;border-radius:8px;padding:16px;margin:20px 0;">
<h4 style="color:#D4AF37;margin:0 0 8px 0;font-size:13px;">About Grading</h4>
<p style="color:#999;font-size:12px;margin:0 0 8px 0;">Grading is a professional opinion, not a guaranteed outcome. Grades may change on re-examination or differ from other grading companies.</p>
<p style="color:#999;font-size:12px;margin:0;">Your Declared Value and selected Value Protection tier determine the liability cap for loss or damage. Under-declaring limits cover.</p>
</div>

<h3 style="color:#D4AF37;font-size:14px;margin:24px 0 8px 0;">NEXT STEPS</h3>
<ol style="margin:0;padding-left:20px;color:#ccc;">
<li style="margin-bottom:8px;">Pack your cards securely using rigid card savers or top loaders.</li>
<li style="margin-bottom:8px;">Include your Submission ID: <strong style="color:#D4AF37;">${data.submissionId}</strong></li>
<li style="margin-bottom:8px;">Post via tracked and insured delivery to:</li>
</ol>
<div style="margin:8px 0 16px 24px;padding:12px 16px;border:1px solid #333;border-radius:6px;background:rgba(255,255,255,0.03);color:#fff;font-family:Menlo,monospace;font-size:13px;line-height:1.6;">
${POSTAL_ADDRESS_HTML}
</div>
<p style="color:#999;font-size:12px;margin:0 0 16px 24px;">Also printed on your packing slip — please include the slip inside the parcel.</p>
${
  data.labelToken
    ? `
<p style="margin-top:24px;">
<a href="${APP_BASE_URL}/api/submissions/${data.submissionId}/shipping-label?token=${data.labelToken}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;margin-right:12px;">DOWNLOAD SHIPPING LABEL</a>
<a href="${APP_BASE_URL}/api/submissions/${data.submissionId}/packing-slip?token=${data.labelToken}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.05);border:1px solid rgba(212,175,55,0.4);color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">DOWNLOAD PACKING SLIP</a>
</p>`
    : ""
}

<div style="margin-top:24px;padding-top:16px;border-top:1px solid #333;">
<p style="color:#666;font-size:11px;margin:0 0 4px 0;">Legal Documents:</p>
<p style="color:#999;font-size:11px;margin:0;">
<a href="${APP_BASE_URL}/legal/website-terms" style="color:#D4AF37;">Website Terms</a> ·
<a href="${APP_BASE_URL}/legal/submission-agreement" style="color:#D4AF37;">Submission Agreement</a> ·
<a href="${APP_BASE_URL}/legal/guarantee" style="color:#D4AF37;">Guarantee Policy</a> ·
<a href="${APP_BASE_URL}/legal/privacy-policy" style="color:#D4AF37;">Privacy Policy</a> ·
<a href="${APP_BASE_URL}/legal/shipping-requirements" style="color:#D4AF37;">Shipping Requirements</a>
</p>
${data.termsVersion ? `<p style="color:#666;font-size:10px;margin:8px 0 0 0;">You accepted the Submission Agreement (version ${data.termsVersion}) on ${data.termsAcceptedAt || "submission"} UTC.</p>` : ""}
</div>`;

  try {
    const sent = await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Submission Confirmed (${data.submissionId})`,
      html: baseHtml("Submission Confirmed", body),
    });
    console.log(
      `[email] submission_confirmation_v2_sent submissionId=${data.submissionId} providerMessageId=${sent.id}`
    );
  } catch (err: any) {
    console.error(`[email] submission_confirmation_v2_failed submissionId=${data.submissionId}`);
    throw err;
  }
}

export async function sendCardsReceived(data: {
  email: string;
  firstName: string;
  submissionId: string;
  cardCount: number;
  photoUrls?: string[];
}) {
  const resend = getResend();
  if (!resend) return;

  const photosHtml =
    data.photoUrls && data.photoUrls.length > 0
      ? `<p style="margin-top:16px;color:#aaa;font-size:13px;">We photographed your cards when they arrived:</p>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 16px;">
${data.photoUrls.map((url) => `<img src="${url}" alt="Receipt photo" style="width:120px;height:90px;object-fit:cover;border-radius:4px;border:1px solid #333;" />`).join("")}
</div>`
      : "";

  const body = `
<p>Hi ${data.firstName},</p>
<p>Great news — we have received your cards and they have been logged into our system.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Cards Received</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
</table>
${photosHtml}
<p>Your cards will now enter our grading queue. We will notify you when grading is complete.</p>
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK YOUR SUBMISSION</a>
</p>`;

  try {
    const sent = await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Cards Received (${data.submissionId})`,
      html: baseHtml("Cards Received", body),
    });
    console.log(`[email] cards_received_sent submissionId=${data.submissionId} providerMessageId=${sent.id}`);
  } catch (err: any) {
    console.error(`[email] cards_received_failed submissionId=${data.submissionId}`);
    throw err;
  }
}

// Transactional — fires on FORWARD transition into in_grading. Must NEVER
// fire on the step-back path (backward → in_grading from ready_to_return);
// the routes/admin-submissions.ts in_grading branch handles that gating,
// and the dedicated /step-back endpoint never calls sendX functions.
// Not gated on marketing_feature_consent — order-status updates are
// transactional, same as the other sendX siblings.
export async function sendGradingStarted(data: {
  email: string;
  firstName: string;
  submissionId: string;
  cardCount: number;
  turnaroundDays: number | null;
}) {
  const resend = getResend();
  if (!resend) return;

  const turnaroundLine = data.turnaroundDays
    ? `<tr><td style="padding:8px 0;color:#999;">Expected Turnaround</td><td style="padding:8px 0;color:#fff;">${data.turnaroundDays} working days</td></tr>`
    : "";

  const body = `
<p>Hi ${data.firstName},</p>
<p>We've started grading your cards.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Cards</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
${turnaroundLine}
</table>
<p>You'll get another update once grading is complete and your cards are being prepared for return shipping.</p>
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK YOUR SUBMISSION</a>
</p>`;

  try {
    const sent = await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Grading Started (${data.submissionId})`,
      html: baseHtml("Grading Started", body),
    });
    console.log(`[email] grading_started_sent submissionId=${data.submissionId} providerMessageId=${sent.id}`);
  } catch (err: any) {
    console.error(`[email] grading_started_failed submissionId=${data.submissionId}`);
    throw err;
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
    const sent = await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Grading Complete (${data.submissionId})`,
      html: baseHtml("Grading Complete", body),
    });
    console.log(`[email] grading_complete_sent submissionId=${data.submissionId} providerMessageId=${sent.id}`);
  } catch (err: any) {
    console.error(`[email] grading_complete_failed submissionId=${data.submissionId}`);
    throw err;
  }
}

export async function sendShipped(data: {
  email: string;
  firstName: string;
  submissionId: string;
  cardCount: number;
  trackingNumber?: string;
  carrier?: string;
  service?: string;
}) {
  const resend = getResend();
  if (!resend) return;

  // Carrier values may be either the stable id ("royal_mail") or a legacy
  // free-text label ("Royal Mail") on historical rows. Normalise via the
  // shared mapper, then look up the canonical label + track URL.
  const carrierId = data.carrier ? carrierIdFromLegacyName(data.carrier) : null;
  const carrierDisplay = carrierId ? carrierLabel(carrierId) : data.carrier || "";
  const serviceText = carrierId && data.service ? serviceLabel(carrierId, data.service) : null;
  const carrierLine = carrierDisplay ? `${carrierDisplay}${serviceText ? ` — ${serviceText}` : ""}` : "";
  const trackHref = carrierId ? trackUrl(carrierId, data.trackingNumber ?? null) : null;

  const carrierRow = carrierLine
    ? `<tr><td style="padding:8px 0;color:#999;">Carrier</td><td style="padding:8px 0;color:#fff;">${carrierLine}</td></tr>`
    : "";
  const trackingRow = data.trackingNumber
    ? `<tr><td style="padding:8px 0;color:#999;">Tracking Number</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.trackingNumber}</td></tr>`
    : "";
  const trackingBtn = trackHref
    ? `<p style="margin-top:16px;">
<a href="${trackHref}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK WITH ${carrierDisplay.toUpperCase()} →</a>
</p>`
    : "";

  const dispatchLine = carrierDisplay
    ? `Your graded slab has been handed to ${carrierDisplay} and is on its way to you!`
    : `Your graded slab is on its way to you!`;

  const body = `
<p>Hi ${data.firstName},</p>
<p>${dispatchLine}</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Cards</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
${carrierRow}
${trackingRow}
</table>
${trackingBtn}
<p>Please ensure someone is available to sign for the delivery.</p>
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">VIEW IN DASHBOARD</a>
</p>`;

  try {
    const sent = await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Your Cards Have Been Shipped (${data.submissionId})`,
      html: baseHtml("Your Cards Have Been Shipped", body),
    });
    console.log(`[email] shipped_sent submissionId=${data.submissionId} providerMessageId=${sent.id}`);
  } catch (err: any) {
    console.error(`[email] shipped_failed submissionId=${data.submissionId}`);
    throw err;
  }
}

export async function sendSubmissionDelivered(data: {
  email: string;
  firstName: string;
  submissionId: string;
  certId?: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const appUrl = process.env.APP_URL || "https://mintvaultuk.com";
  const vaultLink = data.certId ? `${appUrl}/vault/${data.certId}` : `${appUrl}/cert`;
  const body = `
<p>Hi ${data.firstName},</p>
<p>Royal Mail has confirmed delivery of your MintVault slab. We hope it arrived safely!</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
</table>
<p>If you haven't claimed ownership yet, you can do that in your dashboard. Once claimed, your card will appear in the Vault report with your verified ownership badge.</p>
<p>Tag us <strong>@mintvaultuk</strong> if you share it on socials — we'd love to see it!</p>
<p style="margin-top:24px;">
<a href="${vaultLink}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">VIEW VAULT REPORT</a>
</p>`;
  try {
    const sent = await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `Your MintVault slab has arrived — ${data.submissionId}`,
      html: baseHtml("Slab Delivered", body),
    });
    console.log(`[email] delivered_sent submissionId=${data.submissionId} providerMessageId=${sent.id}`);
  } catch (err: any) {
    console.error(`[email] delivered_failed submissionId=${data.submissionId}`);
    throw err;
  }
}

/** Neutral, non-incentivised request sent only by the durable GB-05 worker. */
export async function sendReviewRequestEmail(data: {
  email: string;
  firstName: string;
  submissionId: string;
  reviewUrl: string;
  preferencesUrl: string;
  idempotencyKey: string;
}): Promise<{ id: string } | null> {
  const resend = getResend();
  if (!resend) return null;
  const safeName = escapeHtmlForEmail(data.firstName);
  const safeSubmission = escapeHtmlForEmail(data.submissionId);
  const safeReviewUrl = escapeHtmlForEmail(data.reviewUrl);
  const safePreferencesUrl = escapeHtmlForEmail(data.preferencesUrl);
  const body = `
<p>Hi ${safeName},</p>
<p>Your MintVault return has been delivered. If you would like to share an honest review of your experience, you can use the link below.</p>
<p>Positive, neutral and critical feedback are all welcome. There is no incentive, and your response does not affect your order or support.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${safeSubmission}</td></tr>
</table>
<p style="margin-top:24px;">
<a href="${safeReviewUrl}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">SHARE AN HONEST REVIEW</a>
</p>
<p style="color:#777;font-size:11px;margin-top:24px;">Prefer not to receive this request for this submission? <a href="${safePreferencesUrl}" style="color:#D4AF37;">Update this review preference</a>.</p>`;
  return sendViaResend(
    resend,
    {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `Share your honest MintVault experience — ${safeSubmission}`,
      html: baseHtml("How was your MintVault experience?", body),
    },
    { idempotencyKey: data.idempotencyKey }
  );
}

// ── Premium ownership email wrapper ────────────────────────────────────────
// Used exclusively for ownership/transfer emails. Distinct from the
// submission baseHtml — stronger gold, vault branding, registry feel.
function ownershipBaseHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — MintVault</title>
</head>
<body style="margin:0;padding:0;background:#080808;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#080808;padding:36px 16px 48px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- Top gold bar -->
  <tr><td style="height:3px;background:linear-gradient(90deg,transparent 0%,#A07820 10%,#D4AF37 40%,#F0CC50 50%,#D4AF37 60%,#A07820 90%,transparent 100%);border-radius:3px 3px 0 0;"></td></tr>

  <!-- Main panel -->
  <tr><td style="background:#0f0f0f;border:1px solid rgba(201,162,39,0.22);border-top:none;border-radius:0 0 10px 10px;overflow:hidden;">

    <!-- Header -->
    <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:28px 36px 22px;border-bottom:1px solid rgba(201,162,39,0.10);background:linear-gradient(180deg,#141414 0%,#0f0f0f 100%);">
      <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td valign="middle">
          <span style="color:#D4AF37;font-size:17px;font-weight:900;letter-spacing:3px;text-transform:uppercase;">MINTVAULT</span>
          <span style="display:block;color:rgba(201,162,39,0.45);font-size:7.5px;font-weight:700;letter-spacing:4px;text-transform:uppercase;margin-top:3px;font-family:'Courier New',Courier,monospace;">OFFICIAL REGISTRY &nbsp;&bull;&nbsp; UNITED KINGDOM</span>
        </td>
        <td align="right" valign="middle">
          <span style="color:rgba(201,162,39,0.30);font-size:7px;font-weight:700;letter-spacing:2px;text-transform:uppercase;font-family:'Courier New',Courier,monospace;">AUTHENTICATED<br>COMMUNICATION</span>
        </td>
      </tr>
      </table>
    </td></tr>

    <!-- Title row -->
    <tr><td style="padding:28px 36px 0;">
      <h2 style="margin:0;color:#ffffff;font-size:20px;font-weight:800;letter-spacing:0.5px;line-height:1.2;">${title}</h2>
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:20px 36px 32px;">
      ${body}
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:18px 36px 22px;border-top:1px solid rgba(201,162,39,0.08);background:#0a0a0a;">
      <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="color:rgba(255,255,255,0.20);font-size:10px;line-height:1.7;font-family:'Courier New',Courier,monospace;">
          <span style="color:rgba(201,162,39,0.45);font-weight:700;letter-spacing:1px;">MINTVAULT UK LTD</span><br>
          Professional Card Grading &amp; Certification<br>
          <a href="${APP_BASE_URL}" style="color:rgba(201,162,39,0.35);text-decoration:none;">mintvaultuk.com</a>
        </td>
        <td align="right" valign="bottom">
          <span style="color:rgba(201,162,39,0.20);font-size:8px;font-weight:700;letter-spacing:2px;text-transform:uppercase;font-family:'Courier New',Courier,monospace;line-height:1.8;">VAULT<br>SECURED</span>
        </td>
      </tr>
      </table>
    </td></tr>

  </td></tr>

  <!-- Bottom tag -->
  <tr><td align="center" style="padding:14px 0 0;">
    <span style="color:rgba(255,255,255,0.10);font-size:8.5px;font-family:'Courier New',Courier,monospace;letter-spacing:2px;">SECURE &nbsp;&bull;&nbsp; VERIFIED &nbsp;&bull;&nbsp; MINTVAULT REGISTRY</span>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// Cert reference block — used inside ownership email bodies
function certBlock(certId: string, extraRows: string = ""): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;">
<tr><td style="background:#070707;border:1px solid rgba(201,162,39,0.18);border-left:3px solid #C9A227;border-radius:0 6px 6px 0;padding:14px 18px;">
  <span style="display:block;color:rgba(201,162,39,0.45);font-size:8px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:7px;font-family:'Courier New',Courier,monospace;">CERTIFICATE ON RECORD</span>
  <span style="display:block;color:#D4AF37;font-size:24px;font-weight:700;letter-spacing:2px;font-family:'Courier New',Courier,monospace;">${certId}</span>
  ${extraRows}
</td></tr>
</table>`;
}

// Premium CTA button for ownership emails
function ctaButton(href: string, label: string): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 20px;">
<tr><td align="center">
  <a href="${href}" style="display:inline-block;background:linear-gradient(135deg,#D4AF37 0%,#A07820 100%);color:#1A1400;padding:15px 44px;text-decoration:none;font-weight:900;border-radius:6px;font-size:12px;letter-spacing:2.5px;text-transform:uppercase;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">${label}</a>
</td></tr>
</table>`;
}

export async function sendClaimVerification(data: { email: string; certId: string; verifyUrl: string }): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED claim verification email to ${data.email} (no Resend client)`);
    return;
  }

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">A first-time ownership registration has been requested for the certificate below. To complete the process, verify your email address using the button below.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">Once verified, this certificate will be permanently registered to your email address in the MintVault registry.</p>
${certBlock(data.certId)}
${ctaButton(data.verifyUrl, "Verify &amp; Register Ownership")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">This verification link expires in <strong style="color:rgba(255,255,255,0.45);">24 hours</strong>. If you did not initiate this registration, no action is required — your certificate is unaffected.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:0;word-break:break-all;font-family:'Courier New',Courier,monospace;">LINK: ${data.verifyUrl}</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Verify Ownership Registration for ${data.certId}`,
      html: ownershipBaseHtml("Ownership Registration — Email Verification", body),
    });
    console.log(`[email] Claim verification email sent to ${data.email} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send claim verification to ${data.email}:`, err.message);
    throw err;
  }
}

export async function sendTransferOwnerConfirmation(data: {
  fromEmail: string;
  toEmail: string;
  certId: string;
  confirmUrl: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED transfer confirmation email to ${data.fromEmail} (no Resend client)`);
    return;
  }

  const extraRows = `
<span style="display:block;color:rgba(255,255,255,0.35);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-top:10px;font-family:'Courier New',Courier,monospace;">Transfer Recipient</span>
<span style="display:block;color:rgba(255,255,255,0.65);font-size:13px;margin-top:3px;">${data.toEmail}</span>`;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">A transfer of registered ownership has been initiated for the certificate below. You are the current registered owner.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">To authorise this transfer, confirm below. The recipient will then be required to accept via a separate confirmation before the registry is updated.</p>
${certBlock(data.certId, extraRows)}
${ctaButton(data.confirmUrl, "Authorise Transfer")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">This authorisation link expires in <strong style="color:rgba(255,255,255,0.45);">24 hours</strong>. If you did not initiate this transfer, take no action — your ownership record remains unchanged.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:0;word-break:break-all;font-family:'Courier New',Courier,monospace;">LINK: ${data.confirmUrl}</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.fromEmail,
      subject: `MintVault — Authorise Ownership Transfer for ${data.certId}`,
      html: ownershipBaseHtml("Ownership Transfer — Your Authorisation Required", body),
    });
    console.log(`[email] Transfer confirmation email sent to ${data.fromEmail} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send transfer confirmation to ${data.fromEmail}:`, err.message);
    throw err;
  }
}

export async function sendTransferNewOwnerConfirmation(data: {
  toEmail: string;
  fromEmail: string;
  certId: string;
  confirmUrl: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED new owner transfer email to ${data.toEmail} (no Resend client)`);
    return;
  }

  const extraRows = `
<span style="display:block;color:rgba(255,255,255,0.35);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-top:10px;font-family:'Courier New',Courier,monospace;">Transferred From</span>
<span style="display:block;color:rgba(255,255,255,0.65);font-size:13px;margin-top:3px;">${data.fromEmail}</span>`;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">The current registered owner of the certificate below has authorised a transfer of ownership to you.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">To complete the transfer, accept ownership below. Once confirmed, this certificate will be registered to your email address in the MintVault registry and a new ownership reference will be issued.</p>
${certBlock(data.certId, extraRows)}
${ctaButton(data.confirmUrl, "Accept Ownership")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">This acceptance link expires in <strong style="color:rgba(255,255,255,0.45);">48 hours</strong>. If you did not expect this transfer, no action is required — the current ownership record remains unchanged.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:0;word-break:break-all;font-family:'Courier New',Courier,monospace;">LINK: ${data.confirmUrl}</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.toEmail,
      subject: `MintVault — Accept Ownership of ${data.certId}`,
      html: ownershipBaseHtml("Ownership Transfer — Acceptance Required", body),
    });
    console.log(`[email] New owner transfer email sent to ${data.toEmail} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send new owner transfer email to ${data.toEmail}:`, err.message);
    throw err;
  }
}

// ── v2 Transfer emails (DVLA-style with ref number + dispute window) ─────────

export async function sendTransferV2OutgoingConfirmation(data: {
  fromEmail: string;
  toEmail: string;
  certId: string;
  confirmUrl: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED v2 transfer outgoing email to ${data.fromEmail} (no Resend client)`);
    return;
  }

  const extraRows = `
<span style="display:block;color:rgba(255,255,255,0.35);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-top:10px;font-family:'Courier New',Courier,monospace;">Transfer Recipient</span>
<span style="display:block;color:rgba(255,255,255,0.65);font-size:13px;margin-top:3px;">${data.toEmail}</span>`;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">A transfer of registered keepership has been initiated for the certificate below. You are the current Registered Keeper.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">To authorise this transfer, confirm below. The recipient will then need to verify the Document Reference Number from the Logbook and accept the transfer. A 14-day dispute window applies after both parties confirm.</p>
${certBlock(data.certId, extraRows)}
${ctaButton(data.confirmUrl, "Authorise Transfer")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">This authorisation link expires in <strong style="color:rgba(255,255,255,0.45);">24 hours</strong>. If you did not initiate this transfer, take no action — your keepership record remains unchanged.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:0;word-break:break-all;font-family:'Courier New',Courier,monospace;">LINK: ${data.confirmUrl}</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.fromEmail,
      subject: `MintVault — Authorise Keepership Transfer for ${data.certId}`,
      html: ownershipBaseHtml("Keepership Transfer — Your Authorisation Required", body),
    });
    console.log(`[email] v2 transfer outgoing email sent to ${data.fromEmail} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed v2 transfer outgoing to ${data.fromEmail}:`, err.message);
    throw err;
  }
}

/**
 * v435 — Buyer-initiated transfer: notifies the current owner that a new
 * claimant has used the printed claim code to start a transfer. Owner has
 * 14 days to dispute or confirm. Default psychological framing favours
 * DISPUTE (safer action) — the confirm link is secondary.
 *
 * If the owner takes no action within 14 days the transfer expires and
 * the original ownership is preserved (silence ≠ consent for buyer-init,
 * unlike the seller-init dispute window).
 */
export async function sendTransferV2OwnerInvitedByBuyer(data: {
  ownerEmail: string;
  certId: string;
  maskedClaimantEmail: string; // e.g. "n***@example.com"
  ownerExpiresAt: Date; // 14-day deadline
  disputeUrl: string;
  confirmUrl: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED v2 buyer-init owner email to ${data.ownerEmail} (no Resend client)`);
    return;
  }

  const deadlineIso = data.ownerExpiresAt.toISOString();
  const deadlineHuman = data.ownerExpiresAt.toUTCString();

  const extraRows = `
<span style="display:block;color:rgba(255,255,255,0.35);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-top:10px;font-family:'Courier New',Courier,monospace;">New Claimant</span>
<span style="display:block;color:rgba(255,255,255,0.65);font-size:13px;margin-top:3px;">${data.maskedClaimantEmail}</span>
<span style="display:block;color:rgba(255,255,255,0.35);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-top:10px;font-family:'Courier New',Courier,monospace;">Respond By</span>
<span style="display:block;color:rgba(255,255,255,0.65);font-size:13px;margin-top:3px;">${deadlineHuman} (${deadlineIso})</span>`;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">Someone has requested to transfer keepership of the certificate below to themselves, using the claim code from your physical claim insert.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;"><strong style="color:rgba(255,255,255,0.65);">If you did NOT sell or give away this card, dispute this transfer immediately.</strong> If in doubt — dispute. You can always start a fresh transfer later if you change your mind.</p>
${certBlock(data.certId, extraRows)}
${ctaButton(data.disputeUrl, "Dispute this transfer")}
<p style="color:rgba(255,255,255,0.55);font-size:12px;line-height:1.6;margin:14px 0 6px;text-align:center;">Only if you DID sell or give this card to the new claimant:</p>
<p style="text-align:center;margin:0 0 18px;"><a href="${data.confirmUrl}" style="color:rgba(255,255,255,0.55);font-size:12px;text-decoration:underline;">Confirm transfer</a></p>
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">If you take no action by <strong style="color:rgba(255,255,255,0.45);">${deadlineHuman}</strong>, this transfer will <strong style="color:rgba(255,255,255,0.45);">expire</strong> and you will remain the Registered Keeper. Silence does not transfer the certificate.</p>
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:0 0 6px;">If your claim insert was lost or stolen, dispute this transfer and contact <strong style="color:rgba(255,255,255,0.45);">support@mintvaultuk.com</strong>.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:8px 0 0;word-break:break-all;font-family:'Courier New',Courier,monospace;">DISPUTE: ${data.disputeUrl}<br/>CONFIRM: ${data.confirmUrl}</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.ownerEmail,
      subject: `Transfer requested for your MintVault certificate ${data.certId}`,
      html: ownershipBaseHtml("Transfer Requested — Action Required", body),
    });
    console.log(`[email] v2 buyer-init owner email sent to ${data.ownerEmail} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed v2 buyer-init owner email to ${data.ownerEmail}:`, err.message);
    throw err;
  }
}

/**
 * v435 — Notifies the new claimant that the owner has confirmed their
 * buyer-initiated transfer. Transfer now enters the standard 14-day
 * dispute window before auto-finalising.
 */
export async function sendTransferV2BuyerInitOwnerConfirmed(data: {
  claimantEmail: string;
  certId: string;
  disputeDeadline: Date;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const deadlineHuman = data.disputeDeadline.toUTCString();
  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">The current Registered Keeper has confirmed the transfer of the certificate below to you.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">A 14-day dispute window is now active. If neither party disputes, the transfer will finalise automatically on <strong style="color:rgba(255,255,255,0.55);">${deadlineHuman}</strong>.</p>
${certBlock(data.certId)}`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.claimantEmail,
      subject: `MintVault — Transfer of ${data.certId} confirmed by previous keeper`,
      html: ownershipBaseHtml("Owner confirmed your transfer — dispute window started", body),
    });
  } catch (err: any) {
    console.error(`[email] Failed v2 buyer-init owner-confirmed email to ${data.claimantEmail}:`, err.message);
    throw err;
  }
}

/**
 * v435 — Notifies the new claimant that the owner has rejected their
 * buyer-initiated transfer. Cert ownership reverts to original keeper.
 */
export async function sendTransferV2BuyerInitOwnerRejected(data: {
  claimantEmail: string;
  certId: string;
  reason?: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">The current Registered Keeper has disputed the transfer of the certificate below.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">No transfer of ownership has occurred. The original keeper remains on record.</p>
${certBlock(data.certId)}
${data.reason ? `<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:8px 0 4px;">Reason: ${data.reason}</p>` : ""}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">If you believe you are the rightful owner, contact <strong style="color:rgba(255,255,255,0.45);">support@mintvaultuk.com</strong>.</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.claimantEmail,
      subject: `MintVault — Transfer of ${data.certId} disputed`,
      html: ownershipBaseHtml("Transfer disputed by current keeper", body),
    });
  } catch (err: any) {
    console.error(`[email] Failed v2 buyer-init owner-rejected email to ${data.claimantEmail}:`, err.message);
    throw err;
  }
}

export async function sendTransferV2IncomingConfirmation(data: {
  toEmail: string;
  fromEmail: string;
  certId: string;
  confirmUrl: string;
  previousOwnersCount: number;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED v2 transfer incoming email to ${data.toEmail} (no Resend client)`);
    return;
  }

  const extraRows = `
<span style="display:block;color:rgba(255,255,255,0.35);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-top:10px;font-family:'Courier New',Courier,monospace;">Transferred From</span>
<span style="display:block;color:rgba(255,255,255,0.65);font-size:13px;margin-top:3px;">${data.fromEmail}</span>
<span style="display:block;color:rgba(255,255,255,0.35);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-top:10px;font-family:'Courier New',Courier,monospace;">Former Keepers</span>
<span style="display:block;color:rgba(255,255,255,0.65);font-size:13px;margin-top:3px;">${data.previousOwnersCount}</span>`;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">The current Registered Keeper of the certificate below has authorised a transfer of keepership to you.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">To accept this transfer, click below and enter the <strong style="color:rgba(255,255,255,0.55);">Document Reference Number</strong> from the Logbook. The previous keeper should have provided this to you with the physical card. A 14-day dispute window begins after you confirm.</p>
${certBlock(data.certId, extraRows)}
${ctaButton(data.confirmUrl, "Accept &amp; Verify")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">You have <strong style="color:rgba(255,255,255,0.45);">14 days</strong> to complete this step. If you did not expect this transfer, no action is required.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:0;word-break:break-all;font-family:'Courier New',Courier,monospace;">LINK: ${data.confirmUrl}</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.toEmail,
      subject: `MintVault — Accept Keepership of ${data.certId}`,
      html: ownershipBaseHtml("Keepership Transfer — Verification Required", body),
    });
    console.log(`[email] v2 transfer incoming email sent to ${data.toEmail} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed v2 transfer incoming to ${data.toEmail}:`, err.message);
    throw err;
  }
}

export async function sendTransferV2DisputeWindowStarted(data: {
  email: string;
  certId: string;
  role: "outgoing" | "incoming";
  disputeDeadline: Date;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED v2 dispute-window email to ${data.email} (no Resend client)`);
    return;
  }

  const deadlineStr = data.disputeDeadline.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const roleLabel =
    data.role === "outgoing" ? "outgoing (current) Registered Keeper" : "incoming (new) Registered Keeper";

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">Both parties have confirmed the keepership transfer for the certificate below. A 14-day dispute window is now active.</p>
${certBlock(data.certId)}
<p style="color:rgba(255,255,255,0.50);font-size:13px;line-height:1.7;margin:12px 0 6px;">You are the <strong style="color:rgba(255,255,255,0.65);">${roleLabel}</strong>.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">If neither party raises a dispute before <strong style="color:rgba(255,255,255,0.55);">${deadlineStr}</strong>, the transfer will be finalised automatically and the registry will be updated.</p>
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">To raise a dispute, contact <strong style="color:rgba(255,255,255,0.45);">support@mintvaultuk.com</strong> with the Certificate ID and your concern.</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Transfer Dispute Window Open for ${data.certId}`,
      html: ownershipBaseHtml("Keepership Transfer — Dispute Window", body),
    });
    console.log(`[email] v2 dispute-window email sent to ${data.email} (${data.role}) for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed v2 dispute-window email to ${data.email}:`, err.message);
    throw err;
  }
}

export async function sendTransferV2Completed(data: {
  email: string;
  certId: string;
  role: "outgoing" | "incoming";
  newKeeperName?: string | null;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED v2 transfer complete email to ${data.email} (no Resend client)`);
    return;
  }

  const isIncoming = data.role === "incoming";
  const title = isIncoming
    ? "Keepership Transfer Complete — You Are the New Registered Keeper"
    : "Keepership Transfer Complete — Registry Updated";
  const mainText = isIncoming
    ? `The keepership transfer for the certificate below has been finalised. You are now the Registered Keeper in the MintVault registry.${data.newKeeperName ? ` Registered as: ${data.newKeeperName}.` : ""}`
    : "The keepership transfer for the certificate below has been finalised. The registry has been updated and you are no longer the Registered Keeper for this certificate.";

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">${mainText}</p>
${certBlock(data.certId)}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">If you believe this transfer was made in error, contact <strong style="color:rgba(255,255,255,0.45);">support@mintvaultuk.com</strong> immediately.</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Keepership Transfer Complete for ${data.certId}`,
      html: ownershipBaseHtml(title, body),
    });
    console.log(`[email] v2 transfer complete email sent to ${data.email} (${data.role}) for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed v2 transfer complete to ${data.email}:`, err.message);
    throw err;
  }
}

export async function sendTransferV2Cancelled(data: { email: string; certId: string; reason: string }): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">The keepership transfer for the certificate below has been cancelled.</p>
${certBlock(data.certId)}
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:8px 0 4px;">Reason: ${data.reason}</p>
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">The existing ownership record remains unchanged. If you have questions, contact <strong style="color:rgba(255,255,255,0.45);">support@mintvaultuk.com</strong>.</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Transfer Cancelled for ${data.certId}`,
      html: ownershipBaseHtml("Keepership Transfer Cancelled", body),
    });
  } catch (err: any) {
    console.error(`[email] Failed v2 transfer cancelled to ${data.email}:`, err.message);
    throw err;
  }
}

export async function sendTransferV2Disputed(data: {
  email: string;
  certId: string;
  disputedBy: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">A dispute has been raised on the keepership transfer for the certificate below.</p>
${certBlock(data.certId)}
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:8px 0 4px;">The dispute was raised by the <strong style="color:rgba(255,255,255,0.55);">${data.disputedBy} keeper</strong>. The transfer has been paused and MintVault will review.</p>
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">MintVault will contact both parties with next steps. If you have additional information, email <strong style="color:rgba(255,255,255,0.45);">support@mintvaultuk.com</strong>.</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Transfer Disputed for ${data.certId}`,
      html: ownershipBaseHtml("Keepership Transfer — Dispute Raised", body),
    });
  } catch (err: any) {
    console.error(`[email] Failed v2 transfer disputed to ${data.email}:`, err.message);
    throw err;
  }
}

export async function sendTransferV2Expired(data: { email: string; certId: string; reason: string }): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">The keepership transfer for the certificate below has expired because a required confirmation was not completed in time.</p>
${certBlock(data.certId)}
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:8px 0 4px;">${data.reason}</p>
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">You can initiate a new transfer at any time from the <strong style="color:rgba(255,255,255,0.45);">Transfer Keepership</strong> page.</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Transfer Expired for ${data.certId}`,
      html: ownershipBaseHtml("Keepership Transfer Expired", body),
    });
  } catch (err: any) {
    console.error(`[email] Failed v2 transfer expired to ${data.email}:`, err.message);
    throw err;
  }
}

export async function sendTransferV2IncomingReminder(data: {
  email: string;
  certId: string;
  daysRemaining: number;
  confirmUrl: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">A keepership transfer is pending your confirmation for the certificate below. You have <strong style="color:rgba(255,255,255,0.55);">${data.daysRemaining} day${data.daysRemaining === 1 ? "" : "s"}</strong> remaining to verify the Document Reference Number.</p>
${certBlock(data.certId)}
${ctaButton(data.confirmUrl, "Verify & Accept")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">If you do not complete verification before the deadline, the transfer will expire automatically.</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Reminder: Accept Keepership of ${data.certId} (${data.daysRemaining} days left)`,
      html: ownershipBaseHtml("Keepership Transfer — Reminder", body),
    });
  } catch (err: any) {
    console.error(`[email] Failed v2 transfer reminder to ${data.email}:`, err.message);
    throw err;
  }
}

// ── Customer dashboard magic link email ───────────────────────────────────────
export async function sendMagicLink(data: { email: string; loginUrl: string }): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED magic link email to ${data.email} (no Resend client)`);
    return;
  }

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 16px;">Click the button below to log in to your MintVault customer dashboard. This link is valid for <strong style="color:#fff;">24 hours</strong> and can only be used once.</p>
${ctaButton(data.loginUrl, "Log In to Dashboard")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">If you did not request this link, you can ignore this email — no account or password has been created.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:0;word-break:break-all;font-family:'Courier New',Courier,monospace;">LINK: ${data.loginUrl}</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: "MintVault — Your Dashboard Login Link",
      html: ownershipBaseHtml("Dashboard Login Link", body),
    });
    console.log(`[email] Magic link sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send magic link to ${data.email}:`, err.message);
    throw err;
  }
}

// ── PIN reset link email ──────────────────────────────────────────────────────
// Distinct from sendMagicLink so the subject + body unambiguously signal
// "reset your PIN" rather than "log in". 15-min single-use link.
export async function sendPinResetLink(data: { email: string; resetUrl: string }): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(`[email] SKIPPED PIN reset email to ${data.email} (no Resend client)`);
    return;
  }

  const body = `
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 16px;">You asked to reset your 6-digit MintVault PIN. Click the button below to choose a new one. This link is valid for <strong style="color:#fff;">15 minutes</strong> and can only be used once.</p>
${ctaButton(data.resetUrl, "Reset Your PIN")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">If you did not request a PIN reset, you can ignore this email — your existing PIN remains unchanged.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:0;word-break:break-all;font-family:'Courier New',Courier,monospace;">LINK: ${data.resetUrl}</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: "MintVault — Reset Your PIN",
      html: ownershipBaseHtml("Reset Your PIN", body),
    });
    console.log(`[email] PIN reset link sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send PIN reset link to ${data.email}:`, err.message);
    throw err;
  }
}

// ── Certificate PDF email ──────────────────────────────────────────────────
export async function sendCertificatePdf(data: {
  email: string;
  ownerName?: string | null;
  certId: string;
  cardName?: string | null;
  pdfBuffer: Buffer;
}) {
  const resend = getResend();
  if (!resend) return;

  const displayName = data.ownerName ? data.ownerName : "Card Owner";
  const cardLabel = data.cardName ? ` — ${data.cardName}` : "";

  const body = `
<p style="margin:0 0 16px 0;">Dear ${displayName},</p>
<p style="margin:0 0 16px 0;">
  Your MintVault Certificate of Authenticity for <strong style="color:#fff;">${data.certId}${cardLabel}</strong>
  is attached to this email as a PDF document.
</p>
<p style="margin:0 0 16px 0;">
  This certificate confirms your registered ownership and the authenticated grade of your card.
  You can also verify this certificate at any time by visiting:
</p>
<p style="margin:0 0 24px 0;">
  <a href="${APP_BASE_URL}/cert/${data.certId}" style="color:#D4AF37;">
    mintvaultuk.com/cert/${data.certId}
  </a>
</p>
<p style="margin:0 0 24px 0;">
  Your card is now in your MintVault collection. Sign in with your email at
  <a href="${APP_BASE_URL}/customer-login" style="color:#D4AF37;">mintvaultuk.com/customer-login</a>
  to view it any time — no password needed the first time.
</p>
<p style="margin:0;color:#666;font-size:12px;">
  Keep this certificate safe. It serves as your official proof of registered ownership in the MintVault UK registry.
</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `Your MintVault Certificate — ${data.certId}`,
      html: baseHtml(`Certificate of Authenticity — ${data.certId}`, body),
      attachments: [
        {
          filename: `MintVault-Certificate-${data.certId}.pdf`,
          content: data.pdfBuffer.toString("base64"),
        },
      ],
    });
    console.log(`[email] Certificate PDF sent to ${data.email} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send certificate PDF to ${data.email}:`, err.message);
    throw err;
  }
}

export async function sendStolenVerificationEmail(
  email: string,
  name: string,
  certId: string,
  cardName: string,
  verifyUrl: string
): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const body = `
<p style="margin:0 0 16px 0;">Hi ${name},</p>
<p style="margin:0 0 16px 0;">
  You've submitted a stolen card report for certificate <strong style="color:#D4AF37;">${certId}</strong>
  (<em>${cardName}</em>).
</p>
<p style="margin:0 0 24px 0;">
  To confirm this report and flag the certificate in our registry, please click the button below.
  This link expires after 24 hours.
</p>
<p style="margin:0 0 32px 0;text-align:center;">
  <a href="${verifyUrl}"
     style="display:inline-block;background:#D4AF37;color:#1A1400;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;letter-spacing:0.5px;">
    Confirm Stolen Report
  </a>
</p>
<p style="margin:0 0 12px 0;color:#999;font-size:12px;">
  If you did not submit this report, you can safely ignore this email. No action will be taken unless you click the link above.
</p>
<p style="margin:0;color:#999;font-size:12px;">
  Once confirmed, the certificate will display a stolen warning on its public Vault page. To clear the flag, contact us at mintvaultuk@gmail.com.
</p>`;

  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: email,
      subject: `Confirm Your Stolen Card Report — ${certId}`,
      html: baseHtml(`Stolen Card Report — ${certId}`, body),
    });
    console.log(`[email] Stolen verification email sent to ${email} for ${certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send stolen verification to ${email}:`, err.message);
    throw err;
  }
}

// ── Account auth emails ───────────────────────────────────────────────────────

export async function sendWelcomeVerificationEmail(
  email: string,
  displayName: string | null,
  verifyUrl: string
): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const name = displayName || email.split("@")[0];
  const body = `
<p style="margin:0 0 16px 0;">Hi ${name},</p>
<p style="margin:0 0 16px 0;">Welcome to MintVault UK — the professional grading service for trading cards.</p>
<p style="margin:0 0 24px 0;">Please verify your email address to activate your account:</p>
<p style="margin:0 0 32px 0;text-align:center;">
  <a href="${verifyUrl}" style="display:inline-block;background:#D4AF37;color:#1A1400;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;letter-spacing:0.5px;">
    Verify My Email
  </a>
</p>
<p style="margin:0;color:#999;font-size:12px;">This link expires in 24 hours. If you did not create a MintVault account, ignore this email.</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: email,
      subject: "Verify your MintVault account",
      html: baseHtml("Verify Your Email", body),
    });
  } catch (err: any) {
    console.error(`[email] Welcome/verify failed for ${email}:`, err.message);
  }
}

export async function sendAccountMagicLinkEmail(email: string, loginUrl: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const body = `
<p style="margin:0 0 16px 0;">You requested a magic login link for your MintVault account.</p>
<p style="margin:0 0 24px 0;">Click the button below to sign in instantly. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
<p style="margin:0 0 32px 0;text-align:center;">
  <a href="${loginUrl}" style="display:inline-block;background:#D4AF37;color:#1A1400;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;letter-spacing:0.5px;">
    Sign In to MintVault
  </a>
</p>
<p style="margin:0;color:#999;font-size:12px;">If you did not request this, you can safely ignore it. Your account is secure.</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: email,
      subject: "Your MintVault login link",
      html: baseHtml("Your Login Link", body),
    });
  } catch (err: any) {
    console.error(`[email] Magic link failed for ${email}:`, err.message);
  }
}

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const body = `
<p style="margin:0 0 16px 0;">We received a request to reset the password for your MintVault account.</p>
<p style="margin:0 0 24px 0;">Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.</p>
<p style="margin:0 0 32px 0;text-align:center;">
  <a href="${resetUrl}" style="display:inline-block;background:#D4AF37;color:#1A1400;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;letter-spacing:0.5px;">
    Reset My Password
  </a>
</p>
<p style="margin:0;color:#999;font-size:12px;">If you did not request a password reset, ignore this email. Your password has not been changed.</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: email,
      subject: "Reset your MintVault password",
      html: baseHtml("Password Reset", body),
    });
  } catch (err: any) {
    console.error(`[email] Password reset failed for ${email}:`, err.message);
  }
}

export async function sendPasswordChangedEmail(email: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const body = `
<p style="margin:0 0 16px 0;">Your MintVault account password was successfully changed.</p>
<p style="margin:0 0 16px 0;">If you made this change, no action is needed.</p>
<p style="margin:0;color:#999;font-size:12px;">If you did not change your password, contact us immediately at mintvaultuk@gmail.com.</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: email,
      subject: "Your MintVault password was changed",
      html: baseHtml("Password Changed", body),
    });
  } catch (err: any) {
    console.error(`[email] Password changed notice failed for ${email}:`, err.message);
  }
}

export async function sendEmailChangedNotification(oldEmail: string, newEmail: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const body = `
<p style="margin:0 0 16px 0;">The email address for your MintVault account has been changed.</p>
<p style="margin:0 0 8px 0;"><strong>Previous address:</strong> ${oldEmail}</p>
<p style="margin:0 0 24px 0;"><strong>New address:</strong> ${newEmail}</p>
<p style="margin:0;color:#999;font-size:12px;">If you did not make this change, contact us immediately at mintvaultuk@gmail.com.</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: oldEmail,
      subject: "Your MintVault email address was changed",
      html: baseHtml("Email Address Changed", body),
    });
  } catch (err: any) {
    console.error(`[email] Email changed notice failed for ${oldEmail}:`, err.message);
  }
}

export async function sendAccountDeletedEmail(email: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const body = `
<p style="margin:0 0 16px 0;">Your MintVault account has been successfully deleted as requested.</p>
<p style="margin:0 0 16px 0;">Your submission history and certificate ownership records have been anonymised and retained for our records, as required for the certificate chain-of-custody.</p>
<p style="margin:0;color:#999;font-size:12px;">If you did not request account deletion, contact us immediately at mintvaultuk@gmail.com.</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: email,
      subject: "Your MintVault account has been deleted",
      html: baseHtml("Account Deleted", body),
    });
  } catch (err: any) {
    console.error(`[email] Account deleted notice failed for ${email}:`, err.message);
  }
}

// ── Vault Club emails ─────────────────────────────────────────────────────────

export async function sendVaultClubWelcomeEmail(data: {
  email: string;
  displayName: string | null;
  tier: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const name = data.displayName || "Collector";
  const tierLabel = data.tier.charAt(0).toUpperCase() + data.tier.slice(1);
  const appUrl = process.env.APP_URL || "https://mintvaultuk.com";
  const body = `
<p>Hi ${name},</p>
<p>Welcome to <strong style="color:#D4AF37;">Vault Club ${tierLabel}</strong> — your exclusive membership is now active.</p>
<p>Here's what's unlocked for you:</p>
<ul style="color:#ccc;line-height:1.8;">
  ${data.tier === "silver" ? "<li>10% off all grading submissions</li><li>50 AI Pre-Grade credits every month</li><li>Your own public Showroom at mintvaultuk.com/showroom/[your-name]</li><li>Silver Vault badge on every cert</li>" : ""}
</ul>
<p style="margin-top:24px;">
<a href="${appUrl}/club" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">VIEW YOUR MEMBERSHIP</a>
</p>
<p style="color:#888;font-size:12px;margin-top:16px;">Questions? Reply to this email or contact us at mintvaultuk@gmail.com.</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `Welcome to Vault Club ${tierLabel} — MintVault`,
      html: baseHtml(`Welcome to Vault Club ${tierLabel}`, body),
    });
  } catch (err: any) {
    console.error(`[email] Vault Club welcome failed for ${data.email}:`, err.message);
  }
}

export async function sendVaultClubCancelledEmail(data: { email: string; displayName: string | null }): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const name = data.displayName || "Collector";
  const appUrl = process.env.APP_URL || "https://mintvaultuk.com";
  const body = `
<p>Hi ${name},</p>
<p>Your Vault Club membership has been cancelled. We're sorry to see you go.</p>
<p>Your Showroom has been set to reserved until you rejoin. Your username and all your certificates remain safe.</p>
<p>If this was a mistake, you can rejoin anytime:</p>
<p style="margin-top:16px;">
<a href="${appUrl}/club" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">REJOIN VAULT CLUB</a>
</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: "Your Vault Club membership has been cancelled — MintVault",
      html: baseHtml("Vault Club Cancelled", body),
    });
  } catch (err: any) {
    console.error(`[email] Vault Club cancelled notice failed for ${data.email}:`, err.message);
  }
}

export async function sendVaultClubPaymentFailedEmail(data: {
  email: string;
  displayName: string | null;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const name = data.displayName || "Collector";
  const appUrl = process.env.APP_URL || "https://mintvaultuk.com";
  const body = `
<p>Hi ${name},</p>
<p>We were unable to process your Vault Club subscription payment. This can happen if your card has expired or your bank declined the charge.</p>
<p>Please update your payment method to keep your membership active:</p>
<p style="margin-top:16px;">
<a href="${appUrl}/club" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">UPDATE PAYMENT METHOD</a>
</p>
<p style="color:#888;font-size:12px;">Your membership will remain active for 7 days while we retry the payment. After that your Showroom will be deactivated until you update your details.</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: "Action required — Vault Club payment failed",
      html: baseHtml("Payment Failed", body),
    });
  } catch (err: any) {
    console.error(`[email] Vault Club payment failed notice for ${data.email}:`, err.message);
  }
}

export async function sendVaultClubGraceExpiredEmail(data: {
  email: string;
  displayName: string | null;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const name = data.displayName || "Collector";
  const appUrl = process.env.APP_URL || "https://mintvaultuk.com";
  const body = `
<p>Hi ${name},</p>
<p>Your Vault Club membership has ended after repeated payment failures. Your Showroom has been set back to reserved.</p>
<p>We'd love to have you back. Rejoin anytime to reactivate all your perks immediately:</p>
<p style="margin-top:16px;">
<a href="${appUrl}/club" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">REJOIN VAULT CLUB</a>
</p>`;
  try {
    await sendViaResend(resend, {
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: "We miss you — Vault Club membership ended",
      html: baseHtml("Membership Ended", body),
    });
  } catch (err: any) {
    console.error(`[email] Vault Club grace expired notice for ${data.email}:`, err.message);
  }
}

/**
 * Partner Portal password-reset email.
 *
 * SECRECY: the reset URL embeds a single-use token. Nothing in this function logs, returns, or
 * embeds the URL in an error message — sendViaResend surfaces only the provider's own error text.
 */
export async function sendPartnerResetEmail(data: {
  email: string;
  resetUrl: string;
  expiresMinutes: number;
}): Promise<{ id: string } | null> {
  const resend = getResend();
  if (!resend) return null;
  const safeUrl = escapeHtmlForEmail(data.resetUrl);
  const safeMinutes = escapeHtmlForEmail(String(data.expiresMinutes));
  const body = `
<p style="margin:0 0 16px 0;">A password reset was requested for your MintVault Partner Portal account.</p>
<p style="margin:0 0 20px 0;">This secure link can be used <strong style="color:#fff;">once</strong> and expires in <strong style="color:#fff;">${safeMinutes} minutes</strong>.</p>
<p style="margin:20px 0;">
<a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:#D4AF37;color:#111;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">RESET PARTNER PASSWORD</a>
</p>
<p style="color:#888;font-size:12px;line-height:1.6;margin:18px 0 0;">If you did not request this, ignore this email. Your password has not been changed.</p>`;
  return sendViaResend(resend, {
    from: getFromEmail(),
    replyTo: REPLY_TO,
    to: data.email,
    subject: "MintVault Partner — password reset",
    html: baseHtml("Partner Portal Password Reset", body),
  });
}

export async function sendPartnerInvitationEmail(data: {
  email: string;
  partnerName: string;
  roleCode: string;
  invitationUrl: string;
  expiresAt: Date;
}): Promise<{ id: string } | null> {
  const resend = getResend();
  if (!resend) return null;
  const safePartner = escapeHtmlForEmail(data.partnerName);
  const safeRole = escapeHtmlForEmail(data.roleCode.replace(/^PARTNER_/, "").replace(/_/g, " "));
  const safeUrl = escapeHtmlForEmail(data.invitationUrl);
  const safeExpiry = escapeHtmlForEmail(data.expiresAt.toISOString());
  const body = `
<p style="margin:0 0 16px 0;">You have been invited to access the MintVault Partner Portal for <strong style="color:#fff;">${safePartner}</strong>.</p>
<p style="margin:0 0 16px 0;">Invited role: <strong style="color:#D4AF37;">${safeRole}</strong></p>
<p style="margin:0 0 20px 0;">This secure invitation expires at <strong style="color:#fff;">${safeExpiry}</strong>.</p>
<p style="margin:20px 0;">
<a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:#D4AF37;color:#111;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">SET UP PARTNER ACCESS</a>
</p>
<p style="color:#888;font-size:12px;line-height:1.6;margin:18px 0 0;">If you were not expecting this invitation, ignore this email. No password has been created.</p>`;
  return sendViaResend(resend, {
    from: getFromEmail(),
    replyTo: REPLY_TO,
    to: data.email,
    subject: `MintVault Partner invitation — ${data.partnerName}`,
    html: baseHtml("Partner Portal Invitation", body),
  });
}
