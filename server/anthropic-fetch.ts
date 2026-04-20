/**
 * Wrapped fetch for the Anthropic Messages API with AbortController timeout.
 * Default 30s — prevents upstream latency from hanging Express workers.
 *
 * Throws a standard DOMException with name="AbortError" if the timeout fires.
 * Callers are expected to inspect err.name and translate to HTTP 504.
 */
export async function anthropicFetch(
  body: unknown,
  opts: { apiKey: string; timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
