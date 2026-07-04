/**
 * Weekly-reel run notifications — email (Resend) + webhook (POST JSON).
 *
 * Both are best-effort: callers wrap in try/catch and only warn on failure.
 * Email uses the same Resend client wiring as server/email.ts (no separate
 * key, no separate SDK).
 */

import { Resend } from "resend";
import { assertPublicHttpsUrl } from "./ssrf-guard";

export interface ReelSummary {
  date: string;
  status: "ok" | "partial" | "failed";
  cardCount: number;
  successCount: number;
  failCount: number;
  manifestKey: string;
}

const FROM_EMAIL = "MintVault UK <noreply@mintvaultuk.com>";
const FALLBACK_FROM = "MintVault UK <onboarding@resend.dev>";

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}
function getFromEmail(): string {
  return process.env.RESEND_DOMAIN_VERIFIED === "true" ? FROM_EMAIL : FALLBACK_FROM;
}

function statusLabel(s: ReelSummary["status"]): string {
  return s === "ok" ? "OK" : s === "partial" ? "PARTIAL" : "FAILED";
}

export async function sendReelSummaryEmail(to: string, summary: ReelSummary): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[reel-notify] RESEND_API_KEY missing — skipping email");
    return;
  }
  const subject = `MintVault Weekly Reel — ${summary.date} — ${statusLabel(summary.status)}`;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#222;">
  <h2 style="color:#D4AF37;">Weekly Reel — ${summary.date}</h2>
  <p>Status: <strong>${statusLabel(summary.status)}</strong></p>
  <ul>
    <li>Cards processed: ${summary.cardCount}</li>
    <li>Succeeded: ${summary.successCount}</li>
    <li>Failed: ${summary.failCount}</li>
    <li>Manifest: <code>${summary.manifestKey}</code></li>
  </ul>
  </body></html>`;
  const result = await resend.emails.send({ from: getFromEmail(), to, subject, html });
  if ((result as any).error) {
    throw new Error(`Resend error: ${JSON.stringify((result as any).error)}`);
  }
}

export async function postReelWebhook(url: string, summary: ReelSummary): Promise<void> {
  // SSRF guard at the sink (covers every caller — scheduled job + test endpoint):
  // an admin-set webhook URL must not be pointable at cloud metadata / internal
  // hosts (169.254.169.254, localhost, the Fly 6PN, etc.).
  const safe = await assertPublicHttpsUrl(url);
  const res = await fetch(safe.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(summary),
    // redirect:"error" closes the SSRF-via-redirect hole — otherwise an
    // attacker-controlled public host could 302 the (already-validated) request
    // on to http://169.254.169.254 and we'd follow it. A webhook receiver
    // should return 2xx, never a redirect, so erroring here is correct.
    redirect: "error",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Webhook ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * "Your card was featured" notification — sent to the cert owner after a
 * successful reel run, gated on (a) the notify_card_owners pipeline setting
 * and (b) the submission's marketing_feature_consent flag.
 *
 * Best-effort: caller wraps in try/catch and only warns on failure.
 */
export interface FeaturedCardNotification {
  toEmail: string;
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  appBaseUrl: string;        // e.g. "https://mintvaultuk.com"
}

export async function sendCardFeaturedEmail(n: FeaturedCardNotification): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[reel-notify] RESEND_API_KEY missing — skipping owner email");
    return;
  }
  const subject = "Your card was featured in MintVault's weekly highlights!";
  const gradeLine = n.grade != null ? `Grade <strong>${n.grade}</strong>` : "";
  const cardLine = n.cardName ? `<p><strong>${escapeHtml(n.cardName)}</strong></p>` : "";
  const certUrl = `${n.appBaseUrl.replace(/\/+$/, "")}/cert/${encodeURIComponent(n.certNumber)}`;
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#0a0a0a;color:#ccc;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#111;border:1px solid #D4AF37;border-radius:8px;padding:32px;">
    <h1 style="color:#D4AF37;margin:0 0 16px 0;letter-spacing:2px;">YOUR CARD WAS FEATURED</h1>
    <p>Your card appeared in our weekly grade highlights reel.</p>
    ${cardLine}
    <p>Certificate <code style="color:#D4AF37;">${escapeHtml(n.certNumber)}</code>${gradeLine ? ` · ${gradeLine}` : ""}</p>
    <p style="margin-top:24px;">
      <a href="${certUrl}" style="display:inline-block;background:linear-gradient(135deg,#D4AF37,#B8960C);color:#1A1400;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:6px;">View Certificate</a>
    </p>
    <p style="color:#666;font-size:11px;margin-top:32px;">MintVault UK · mintvaultuk@gmail.com</p>
  </div>
  </body></html>`;
  const result = await resend.emails.send({ from: getFromEmail(), to: n.toEmail, subject, html });
  if ((result as any).error) {
    throw new Error(`Resend error: ${JSON.stringify((result as any).error)}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
