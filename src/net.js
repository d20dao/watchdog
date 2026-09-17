// Outbound HTTP with one timeout covering headers and body. The timer is always cleared, so no timer
// is left pending in the Durable Object (pending timers can delay hibernation and add billed duration).

export class FetchTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

/**
 * POST/GET and return {status, ok, text}. `readBody: false` discards the body without reading it.
 * Throws FetchTimeoutError on timeout; other network errors are rethrown as-is.
 */
export async function fetchText(fetchImpl, url, init, timeoutMs, { readBody = true } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!readBody || !response.ok) {
      try {
        await response.body?.cancel();
      } catch {}
      return { status: response.status, ok: response.ok, text: null };
    }
    return { status: response.status, ok: true, text: await response.text() };
  } catch (err) {
    if (timedOut) throw new FetchTimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
