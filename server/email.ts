import { Resend } from "resend";

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
  const base = process.env.APP_URL || "https://mintvaultuk.com";
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
  labelToken?: string;
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
${data.labelToken ? `
<p style="margin-top:24px;">
<a href="https://mintvaultuk.com/api/submissions/${data.submissionId}/shipping-label?token=${data.labelToken}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;margin-right:12px;">DOWNLOAD SHIPPING LABEL</a>
<a href="https://mintvaultuk.com/api/submissions/${data.submissionId}/packing-slip?token=${data.labelToken}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.05);border:1px solid rgba(212,175,55,0.4);color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">DOWNLOAD PACKING SLIP</a>
</p>` : ""}
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK YOUR SUBMISSION</a>
</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      replyTo: REPLY_TO,
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
  photoUrls?: string[];
}) {
  const resend = getResend();
  if (!resend) return;

  const photosHtml = data.photoUrls && data.photoUrls.length > 0
    ? `<p style="margin-top:16px;color:#aaa;font-size:13px;">We photographed your cards when they arrived:</p>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 16px;">
${data.photoUrls.map(url => `<img src="${url}" alt="Receipt photo" style="width:120px;height:90px;object-fit:cover;border-radius:4px;border:1px solid #333;" />`).join("")}
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
    await resend.emails.send({
      from: getFromEmail(),
      replyTo: REPLY_TO,
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
      replyTo: REPLY_TO,
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

  const carrierRow = data.carrier
    ? `<tr><td style="padding:8px 0;color:#999;">Carrier</td><td style="padding:8px 0;color:#fff;">${data.carrier}</td></tr>`
    : "";
  const trackingRow = data.trackingNumber
    ? `<tr><td style="padding:8px 0;color:#999;">Tracking Number</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.trackingNumber}</td></tr>`
    : "";
  const rmTrackingBtn = (data.trackingNumber && (!data.carrier || data.carrier === "Royal Mail"))
    ? `<p style="margin-top:16px;">
<a href="https://www.royalmail.com/track-your-item#/tracking-results/${data.trackingNumber}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">TRACK WITH ROYAL MAIL →</a>
</p>`
    : "";

  const body = `
<p>Hi ${data.firstName},</p>
<p>Your graded slab has been handed to Royal Mail and is on its way to you!</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px 0;color:#999;width:140px;">Submission ID</td><td style="padding:8px 0;color:#D4AF37;font-weight:bold;">${data.submissionId}</td></tr>
<tr><td style="padding:8px 0;color:#999;">Cards</td><td style="padding:8px 0;color:#fff;">${data.cardCount}</td></tr>
${carrierRow}
${trackingRow}
</table>
${rmTrackingBtn}
<p>Please ensure someone is available to sign for the delivery.</p>
<p style="margin-top:24px;">
<a href="${trackingUrl(data.submissionId)}" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">VIEW IN DASHBOARD</a>
</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Your Cards Have Been Shipped (${data.submissionId})`,
      html: baseHtml("Your Cards Have Been Shipped", body),
    });
    console.log(`[email] Shipped email sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send shipped email to ${data.email}:`, err.message);
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
  const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";
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
    await resend.emails.send({
      from: getFromEmail(), replyTo: REPLY_TO, to: data.email,
      subject: `Your MintVault slab has arrived — ${data.submissionId}`,
      html: baseHtml("Slab Delivered", body),
    });
    console.log(`[email] Delivered email sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send delivered email to ${data.email}:`, err.message);
  }
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
          <a href="https://mintvaultuk.com" style="color:rgba(201,162,39,0.35);text-decoration:none;">mintvaultuk.com</a>
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
<p style="color:rgba(255,255,255,0.70);font-size:14px;line-height:1.7;margin:0 0 6px;">A first-time ownership registration has been requested for the certificate below. To complete the process, verify your email address using the button below.</p>
<p style="color:rgba(255,255,255,0.40);font-size:12px;line-height:1.6;margin:0 0 4px;">Once verified, this certificate will be permanently registered to your email address in the MintVault registry.</p>
${certBlock(data.certId)}
${ctaButton(data.verifyUrl, "Verify &amp; Register Ownership")}
<p style="color:rgba(255,255,255,0.28);font-size:11px;line-height:1.6;margin:16px 0 6px;">This verification link expires in <strong style="color:rgba(255,255,255,0.45);">24 hours</strong>. If you did not initiate this registration, no action is required — your certificate is unaffected.</p>
<p style="color:rgba(255,255,255,0.18);font-size:10px;line-height:1.5;margin:0;word-break:break-all;font-family:'Courier New',Courier,monospace;">LINK: ${data.verifyUrl}</p>`;

  try {
    await resend.emails.send({
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: `MintVault — Verify Ownership Registration for ${data.certId}`,
      html: ownershipBaseHtml("Ownership Registration — Email Verification", body),
    });
    console.log(`[email] Claim verification email sent to ${data.email} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send claim verification to ${data.email}:`, err.message);
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
    await resend.emails.send({
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.fromEmail,
      subject: `MintVault — Authorise Ownership Transfer for ${data.certId}`,
      html: ownershipBaseHtml("Ownership Transfer — Your Authorisation Required", body),
    });
    console.log(`[email] Transfer confirmation email sent to ${data.fromEmail} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send transfer confirmation to ${data.fromEmail}:`, err.message);
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
    await resend.emails.send({
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.toEmail,
      subject: `MintVault — Accept Ownership of ${data.certId}`,
      html: ownershipBaseHtml("Ownership Transfer — Acceptance Required", body),
    });
    console.log(`[email] New owner transfer email sent to ${data.toEmail} for ${data.certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send new owner transfer email to ${data.toEmail}:`, err.message);
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
    await resend.emails.send({
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: data.email,
      subject: "MintVault — Your Dashboard Login Link",
      html: ownershipBaseHtml("Dashboard Login Link", body),
    });
    console.log(`[email] Magic link sent to ${data.email}`);
  } catch (err: any) {
    console.error(`[email] Failed to send magic link to ${data.email}:`, err.message);
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
  <a href="https://mintvaultuk.com/cert/${data.certId}" style="color:#D4AF37;">
    mintvaultuk.com/cert/${data.certId}
  </a>
</p>
<p style="margin:0;color:#666;font-size:12px;">
  Keep this certificate safe. It serves as your official proof of registered ownership in the MintVault UK registry.
</p>`;

  try {
    await resend.emails.send({
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
  }
}

export async function sendStolenVerificationEmail(
  email: string,
  name: string,
  certId: string,
  cardName: string,
  verifyUrl: string,
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
    await resend.emails.send({
      from: getFromEmail(),
      replyTo: REPLY_TO,
      to: email,
      subject: `Confirm Your Stolen Card Report — ${certId}`,
      html: baseHtml(`Stolen Card Report — ${certId}`, body),
    });
    console.log(`[email] Stolen verification email sent to ${email} for ${certId}`);
  } catch (err: any) {
    console.error(`[email] Failed to send stolen verification to ${email}:`, err.message);
  }
}

// ── Account auth emails ───────────────────────────────────────────────────────

export async function sendWelcomeVerificationEmail(
  email: string,
  displayName: string | null,
  verifyUrl: string,
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
    await resend.emails.send({ from: getFromEmail(), replyTo: REPLY_TO, to: email, subject: "Verify your MintVault account", html: baseHtml("Verify Your Email", body) });
  } catch (err: any) { console.error(`[email] Welcome/verify failed for ${email}:`, err.message); }
}

export async function sendAccountMagicLinkEmail(
  email: string,
  loginUrl: string,
): Promise<void> {
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
    await resend.emails.send({ from: getFromEmail(), replyTo: REPLY_TO, to: email, subject: "Your MintVault login link", html: baseHtml("Your Login Link", body) });
  } catch (err: any) { console.error(`[email] Magic link failed for ${email}:`, err.message); }
}

export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string,
): Promise<void> {
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
    await resend.emails.send({ from: getFromEmail(), replyTo: REPLY_TO, to: email, subject: "Reset your MintVault password", html: baseHtml("Password Reset", body) });
  } catch (err: any) { console.error(`[email] Password reset failed for ${email}:`, err.message); }
}

export async function sendPasswordChangedEmail(email: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const body = `
<p style="margin:0 0 16px 0;">Your MintVault account password was successfully changed.</p>
<p style="margin:0 0 16px 0;">If you made this change, no action is needed.</p>
<p style="margin:0;color:#999;font-size:12px;">If you did not change your password, contact us immediately at mintvaultuk@gmail.com.</p>`;
  try {
    await resend.emails.send({ from: getFromEmail(), replyTo: REPLY_TO, to: email, subject: "Your MintVault password was changed", html: baseHtml("Password Changed", body) });
  } catch (err: any) { console.error(`[email] Password changed notice failed for ${email}:`, err.message); }
}

export async function sendEmailChangedNotification(
  oldEmail: string,
  newEmail: string,
): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const body = `
<p style="margin:0 0 16px 0;">The email address for your MintVault account has been changed.</p>
<p style="margin:0 0 8px 0;"><strong>Previous address:</strong> ${oldEmail}</p>
<p style="margin:0 0 24px 0;"><strong>New address:</strong> ${newEmail}</p>
<p style="margin:0;color:#999;font-size:12px;">If you did not make this change, contact us immediately at mintvaultuk@gmail.com.</p>`;
  try {
    await resend.emails.send({ from: getFromEmail(), replyTo: REPLY_TO, to: oldEmail, subject: "Your MintVault email address was changed", html: baseHtml("Email Address Changed", body) });
  } catch (err: any) { console.error(`[email] Email changed notice failed for ${oldEmail}:`, err.message); }
}

export async function sendAccountDeletedEmail(email: string): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const body = `
<p style="margin:0 0 16px 0;">Your MintVault account has been successfully deleted as requested.</p>
<p style="margin:0 0 16px 0;">Your submission history and certificate ownership records have been anonymised and retained for our records, as required for the certificate chain-of-custody.</p>
<p style="margin:0;color:#999;font-size:12px;">If you did not request account deletion, contact us immediately at mintvaultuk@gmail.com.</p>`;
  try {
    await resend.emails.send({ from: getFromEmail(), replyTo: REPLY_TO, to: email, subject: "Your MintVault account has been deleted", html: baseHtml("Account Deleted", body) });
  } catch (err: any) { console.error(`[email] Account deleted notice failed for ${email}:`, err.message); }
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
  const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";
  const body = `
<p>Hi ${name},</p>
<p>Welcome to <strong style="color:#D4AF37;">Vault Club ${tierLabel}</strong> — your exclusive membership is now active.</p>
<p>Here's what's unlocked for you:</p>
<ul style="color:#ccc;line-height:1.8;">
  ${data.tier === "bronze" ? "<li>10% discount on all grading submissions</li><li>30 AI Pre-Grade credits per month</li><li>Bronze Vault badge on your Showroom and certificates</li>" : ""}
  ${data.tier === "silver" ? "<li>20% discount on all grading submissions</li><li>100 AI Pre-Grade credits per month</li><li>Silver Vault badge + 8 Showroom themes + custom banner</li><li>1 free reholder credit per quarter</li><li>Members-only Vault report design</li>" : ""}
  ${data.tier === "gold" ? "<li>30% discount on all grading submissions</li><li>400 AI Pre-Grade credits per month</li><li>Gold Vault badge + all premium features</li><li>4 free reholder credits per quarter</li><li>Featured Collector rotation + free Express upgrade per submission</li>" : ""}
</ul>
<p style="margin-top:24px;">
<a href="${appUrl}/club" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">VIEW YOUR MEMBERSHIP</a>
</p>
<p style="color:#888;font-size:12px;margin-top:16px;">Questions? Reply to this email or contact us at mintvaultuk@gmail.com.</p>`;
  try {
    await resend.emails.send({
      from: getFromEmail(), replyTo: REPLY_TO, to: data.email,
      subject: `Welcome to Vault Club ${tierLabel} — MintVault`,
      html: baseHtml(`Welcome to Vault Club ${tierLabel}`, body),
    });
  } catch (err: any) { console.error(`[email] Vault Club welcome failed for ${data.email}:`, err.message); }
}

export async function sendVaultClubCancelledEmail(data: {
  email: string;
  displayName: string | null;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const name = data.displayName || "Collector";
  const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";
  const body = `
<p>Hi ${name},</p>
<p>Your Vault Club membership has been cancelled. We're sorry to see you go.</p>
<p>Your Showroom has been set to reserved until you rejoin. Your username and all your certificates remain safe.</p>
<p>If this was a mistake, you can rejoin anytime:</p>
<p style="margin-top:16px;">
<a href="${appUrl}/club" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">REJOIN VAULT CLUB</a>
</p>`;
  try {
    await resend.emails.send({
      from: getFromEmail(), replyTo: REPLY_TO, to: data.email,
      subject: "Your Vault Club membership has been cancelled — MintVault",
      html: baseHtml("Vault Club Cancelled", body),
    });
  } catch (err: any) { console.error(`[email] Vault Club cancelled notice failed for ${data.email}:`, err.message); }
}

export async function sendVaultClubPaymentFailedEmail(data: {
  email: string;
  displayName: string | null;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const name = data.displayName || "Collector";
  const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";
  const body = `
<p>Hi ${name},</p>
<p>We were unable to process your Vault Club subscription payment. This can happen if your card has expired or your bank declined the charge.</p>
<p>Please update your payment method to keep your membership active:</p>
<p style="margin-top:16px;">
<a href="${appUrl}/club" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">UPDATE PAYMENT METHOD</a>
</p>
<p style="color:#888;font-size:12px;">Your membership will remain active for 7 days while we retry the payment. After that your Showroom will be deactivated until you update your details.</p>`;
  try {
    await resend.emails.send({
      from: getFromEmail(), replyTo: REPLY_TO, to: data.email,
      subject: "Action required — Vault Club payment failed",
      html: baseHtml("Payment Failed", body),
    });
  } catch (err: any) { console.error(`[email] Vault Club payment failed notice for ${data.email}:`, err.message); }
}

export async function sendVaultClubGraceExpiredEmail(data: {
  email: string;
  displayName: string | null;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const name = data.displayName || "Collector";
  const appUrl = process.env.APP_URL || "https://mintvault.fly.dev";
  const body = `
<p>Hi ${name},</p>
<p>Your Vault Club membership has ended after repeated payment failures. Your Showroom has been set back to reserved.</p>
<p>We'd love to have you back. Rejoin anytime to reactivate all your perks immediately:</p>
<p style="margin-top:16px;">
<a href="${appUrl}/club" style="display:inline-block;padding:10px 24px;background:rgba(212,175,55,0.15);border:1px solid #D4AF37;color:#D4AF37;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">REJOIN VAULT CLUB</a>
</p>`;
  try {
    await resend.emails.send({
      from: getFromEmail(), replyTo: REPLY_TO, to: data.email,
      subject: "We miss you — Vault Club membership ended",
      html: baseHtml("Membership Ended", body),
    });
  } catch (err: any) { console.error(`[email] Vault Club grace expired notice for ${data.email}:`, err.message); }
}
