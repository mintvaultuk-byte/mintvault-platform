/**
 * Weekly-reel run notifications — email (Resend) + webhook (POST JSON).
 *
 * Both are best-effort: callers wrap in try/catch and only warn on failure.
 * Email uses the same Resend client wiring as server/email.ts (no separate
 * key, no separate SDK).
 */

import { Resend } from "resend";

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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(summary),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Webhook ${res.status}: ${body.slice(0, 200)}`);
  }
}
