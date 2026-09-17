// Worker entry: receives keeper health reports, serves status, and runs the per-minute check.

import { DURABLE_OBJECT_NAME } from "./config.js";
import { handleFetch } from "./http.js";

export { Watchdog } from "./watchdog.js";

// Error text only (never request data); Telegram and RPC failures are already reduced to codes.
const errorText = (err) => String(err?.message ?? err).slice(0, 200);

const stubFor = (env) => env.WATCHDOG.get(env.WATCHDOG.idFromName(DURABLE_OBJECT_NAME));

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx, {
        stub: () => stubFor(env),
        cache: typeof caches !== "undefined" ? caches.default : undefined,
      });
    } catch (err) {
      console.error("watchdog fetch failed:", errorText(err));
      return new Response("internal error\n", { status: 500, headers: { "cache-control": "no-store" } });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      stubFor(env)
        .runCron()
        .then((summary) => console.log(JSON.stringify({ watchdogRun: summary })))
        .catch((err) => console.error("watchdog run failed:", errorText(err))),
    );
  },
};
