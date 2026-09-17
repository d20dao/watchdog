// HTTP routing for the Worker. Kept free of runtime-specific imports so it can be unit tested.

import { LIMITS, NETWORKS } from "./config.js";
import { handleHealthPost } from "./report.js";
import { renderHtml } from "./status.js";

const COMMON_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function text(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...COMMON_HEADERS, ...extra },
  });
}

/**
 * @param deps.stub   Durable Object stub exposing ingestReport(record) and getStatus()
 * @param deps.cache  optional Cache (caches.default) for the public read endpoints
 */
export async function handleFetch(request, env, ctx, deps) {
  const url = new URL(request.url);
  const health = /^\/v1\/health\/([^/]+)$/.exec(url.pathname);
  if (health) {
    const net = Object.hasOwn(NETWORKS, health[1]) ? NETWORKS[health[1]] : null;
    if (!net) return text(404, "unknown network\n");
    return handleHealthPost(request, env, net, {
      ingest: (record) => deps.stub().ingestReport(record),
      now: deps.now,
      subtle: deps.subtle,
    });
  }

  if (url.pathname !== "/" && url.pathname !== "/status.json") return text(404, "not found\n");
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "method not allowed\n", { allow: "GET, HEAD" });

  // Query strings are ignored so they cannot be used to bypass the short edge cache.
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  let response = deps.cache ? await deps.cache.match(cacheKey) : undefined;
  if (!response) {
    const status = await deps.stub().getStatus();
    const cacheControl = `public, max-age=${LIMITS.statusCacheSeconds}`;
    response = url.pathname === "/status.json"
      ? new Response(JSON.stringify(status, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": cacheControl,
            "access-control-allow-origin": "*",
            ...COMMON_HEADERS,
          },
        })
      : new Response(renderHtml(status), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": cacheControl,
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ...COMMON_HEADERS,
          },
        });
    if (deps.cache) ctx.waitUntil(deps.cache.put(cacheKey, response.clone()));
  }
  if (request.method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
  return response;
}
