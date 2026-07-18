/**
 * Turn a card lookup / identify failure into a structured, actionable error —
 * never the browser's raw "Failed to fetch". `fetch()` rejects with a TypeError
 * ONLY when the request never reaches the server (server down, offline, DNS) —
 * that transport case is the one graders most need a clear message for. Non-2xx
 * responses are classified by status. Pure + dependency-free so it's unit-tested
 * directly.
 */
export type LookupErrorKind = "network" | "auth" | "provider" | "invalid" | "not_found" | "server" | "unknown";

export interface LookupError {
  kind: LookupErrorKind;
  title: string;
  message: string;
}

export function classifyLookupError(input: { thrown?: unknown; status?: number; body?: { error?: string } | null }): LookupError {
  const { thrown, status, body } = input;
  const msg = String((thrown as { message?: string } | undefined)?.message ?? thrown ?? "");

  // Transport failure: fetch() rejects with a TypeError ("Failed to fetch",
  // "NetworkError when attempting to fetch", "Load failed") when the connection
  // is refused / unreachable — i.e. the request never reached Express.
  if (thrown instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return {
      kind: "network",
      title: "Can’t reach the server",
      message:
        "The request didn’t reach MintVault — check the server is running and your connection, then try again. You can still enter card details manually.",
    };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", title: "Session expired", message: "Your admin session ended. Sign in again, then retry — your entries are kept." };
  }
  if (status === 503) {
    return {
      kind: "provider",
      title: "Lookup unavailable",
      message: body?.error || "Card lookup is temporarily unavailable. Enter the card details manually for now.",
    };
  }
  if (status === 400) {
    return {
      kind: "invalid",
      title: "Invalid search",
      message: body?.error || "That search wasn’t valid — check the card number (e.g. TG12/TG30) and try again.",
    };
  }
  if (status === 404) {
    return { kind: "not_found", title: "No match found", message: "No matching card was found. Check the details or enter them manually." };
  }
  if (typeof status === "number" && status >= 500) {
    return { kind: "server", title: "Lookup error", message: "The lookup service hit an error. Try again shortly, or enter details manually." };
  }
  return { kind: "unknown", title: "Something went wrong", message: msg || body?.error || "Unexpected error — you can enter details manually." };
}
