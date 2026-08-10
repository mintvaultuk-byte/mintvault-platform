/**
 * Trusted Intake Connector — Phase G2: deterministic source fingerprint.
 *
 * See .claude/controlled-code-lead/tasks/partner-network-connector-g2-g5/SOURCE-FINGERPRINT.md for
 * the full design rationale (field selection, ordering, null/numeric/text handling, algorithm
 * choice). This module is pure — no database access, no I/O — so it is unit-testable without a
 * disposable Postgres instance, and its determinism can be proven by calling it twice with the
 * same input and comparing output.
 */
import { createHash } from "node:crypto";

export const SOURCE_FINGERPRINT_VERSION = 1;

export interface FingerprintCard {
  sequenceNumber: number;
  cardName: string | null;
  game: string | null;
  cardSet: string | null;
  cardNumber: string | null;
  year: number | null;
  variant: string | null;
  language: string | null;
  declaredValuePence: number | null;
  quantity: number;
  frontImageKey: string | null;
  backImageKey: string | null;
}

export interface FingerprintSource {
  submission: {
    locationId: string;
    customerId: string | null;
    serviceTierCode: string | null;
    estimatedPricePence: number | null;
    cardCount: number;
    status: string;
  };
  customer: { fullName: string; email: string | null; phone: string | null } | null;
  serviceTier: { tierCode: string; pricePerCardPence: number; isActive: boolean } | null;
  cards: FingerprintCard[];
}

const NULL_TOKEN = " NULL ";

function normaliseText(v: string | null): string {
  if (v == null) return NULL_TOKEN;
  return v.normalize("NFC").trim();
}

function normaliseNumber(v: number | null): string {
  if (v == null) return NULL_TOKEN;
  return String(v);
}

function normaliseBool(v: boolean): string {
  return v ? "true" : "false";
}

/** Deterministic, ordered, `|`-delimited serialisation — never JSON (JSON's own key-ordering and escaping rules are a second source of non-determinism this avoids). */
function serialise(source: FingerprintSource): string {
  const parts: string[] = [];

  // Submission — fixed field order, never Object.keys() insertion order.
  parts.push("submission");
  parts.push(normaliseText(source.submission.locationId));
  parts.push(normaliseText(source.submission.customerId));
  parts.push(normaliseText(source.submission.serviceTierCode));
  parts.push(normaliseNumber(source.submission.estimatedPricePence));
  parts.push(normaliseNumber(source.submission.cardCount));
  parts.push(normaliseText(source.submission.status));

  // Customer — fixed field order.
  parts.push("customer");
  if (source.customer) {
    parts.push(normaliseText(source.customer.fullName));
    parts.push(normaliseText(source.customer.email));
    parts.push(normaliseText(source.customer.phone));
  } else {
    parts.push(NULL_TOKEN, NULL_TOKEN, NULL_TOKEN);
  }

  // Service tier — fixed field order.
  parts.push("serviceTier");
  if (source.serviceTier) {
    parts.push(normaliseText(source.serviceTier.tierCode));
    parts.push(normaliseNumber(source.serviceTier.pricePerCardPence));
    parts.push(normaliseBool(source.serviceTier.isActive));
  } else {
    parts.push(NULL_TOKEN, NULL_TOKEN, NULL_TOKEN);
  }

  // Cards — ordered by sequenceNumber ASC (never insertion order), fixed per-card field order.
  const orderedCards = [...source.cards].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  parts.push("cards");
  parts.push(String(orderedCards.length));
  for (const card of orderedCards) {
    parts.push(normaliseNumber(card.sequenceNumber));
    parts.push(normaliseText(card.cardName));
    parts.push(normaliseText(card.game));
    parts.push(normaliseText(card.cardSet));
    parts.push(normaliseText(card.cardNumber));
    parts.push(normaliseNumber(card.year));
    parts.push(normaliseText(card.variant));
    parts.push(normaliseText(card.language));
    parts.push(normaliseNumber(card.declaredValuePence));
    parts.push(normaliseNumber(card.quantity));
    parts.push(normaliseText(card.frontImageKey));
    parts.push(normaliseText(card.backImageKey));
  }

  return parts.join("|");
}

/** SHA-256 hex digest of the canonical serialisation. Pure and deterministic — same input, same output, always. */
export function calculateSourceFingerprint(source: FingerprintSource): string {
  return createHash("sha256").update(serialise(source), "utf8").digest("hex");
}
