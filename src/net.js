// Outbound HTTP with one timeout covering headers and body. The timer is always cleared, so no timer
// is left pending in the Durable Object (pending timers can delay hibernation and add billed duration).

export class FetchTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super("response too large");
    this.name = "ResponseTooLargeError";
  }
}

/** Read a response body as text, stopping as soon as it exceeds `maxBytes`. */
async function readTextLimited(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new ResponseTooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new ResponseTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * POST/GET and return {status, ok, text}. `readBody: false` discards the body without reading it.
 * With `maxBytes`, a longer body throws ResponseTooLargeError as soon as the limit is passed.
 * Throws FetchTimeoutError on timeout; other network errors are rethrown as-is.
 */
export async function fetchText(fetchImpl, url, init, timeoutMs, { readBody = true, maxBytes } = {}) {
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
    const text = maxBytes === undefined ? await response.text() : await readTextLimited(response, maxBytes);
    return { status: response.status, ok: true, text };
  } catch (err) {
    if (timedOut) throw new FetchTimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
