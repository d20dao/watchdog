// HTTP routing for the Worker. Kept free of runtime-specific imports so it can be unit tested.

import { LIMITS, NETWORKS } from "./config.js";
import { ICONS } from "./icons.js";
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
 * @param deps.stub   Durable Object stub exposing ingestReport(record), ingestBackupReport(record) and getStatus()
 * @param deps.cache  optional Cache (caches.default) for the public read endpoints
 */
export async function handleFetch(request, env, ctx, deps) {
  const url = new URL(request.url);
  const health = /^\/v1\/health\/([^/]+)(\/backup)?$/.exec(url.pathname);
  if (health) {
    const net = Object.hasOwn(NETWORKS, health[1]) ? NETWORKS[health[1]] : null;
    const backup = health[2] !== undefined;
    if (!net || (backup && !net.backupHealthKeySecret)) return text(404, "unknown network\n");
    // The backup (follower) stream has its own key and storage, so it can never touch the primary's state.
    return handleHealthPost(request, env, net, {
      ingest: backup ? (record) => deps.stub().ingestBackupReport(record) : (record) => deps.stub().ingestReport(record),
      now: deps.now,
      subtle: deps.subtle,
      keySecret: backup ? net.backupHealthKeySecret : net.healthKeySecret,
      stream: backup ? "backup" : "primary",
    });
  }

  const icon = Object.hasOwn(ICONS, url.pathname) ? ICONS[url.pathname] : null;
  if (!icon && url.pathname !== "/" && url.pathname !== "/status.json") return text(404, "not found\n");
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "method not allowed\n", { allow: "GET, HEAD" });
  if (icon) {
    // Static bytes, linked from the page with a content hash, so browsers may keep them for a year.
    return new Response(request.method === "HEAD" ? null : icon.body, {
      headers: {
        "content-type": icon.type,
        "cache-control": "public, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'",
        ...COMMON_HEADERS,
      },
    });
  }

  // Query strings are ignored so they cannot be used to bypass the short edge cache.
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  const cacheControl = `public, max-age=${LIMITS.statusCacheSeconds}`;
  let response = deps.cache ? await deps.cache.match(cacheKey) : undefined;
  if (!response) {
    const status = await deps.stub().getStatus();
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
            // img-src for the page's own icons: some browsers apply it to favicon loads.
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ...COMMON_HEADERS,
          },
        });
    if (deps.cache) ctx.waitUntil(deps.cache.put(cacheKey, response.clone()));
  }
  // The stored copy's max-age is the edge TTL. A hit comes back with Cache-Control raised to the zone's Browser Cache
  // TTL (hours), which Cloudflare applies to any lower max-age; the Worker's own response is not rewritten, so
  // browsers get the 15 s set here again, less the hit's Age.
  const headers = new Headers(response.headers);
  headers.set("cache-control", cacheControl);
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}
