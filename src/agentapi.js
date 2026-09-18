// x402 agent API: one GET of the API's public /health per run and network, and the stored poll state.
// A reply is reduced here to a fixed set of figures (states, counts, ages and the relayer's balance). Nothing else
// from it is stored, logged or shown, so a field added to /health later (a payer, a payment id) never gets further.

import { LIMITS } from "./config.js";
import { FetchTimeoutError, ResponseTooLargeError, fetchText } from "./net.js";

const USER_AGENT = "d20dao-watchdog (+https://watchdog.d20dao.org)";
const DECIMAL = /^[0-9]{1,30}(\.[0-9]{1,18})?$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const flag = (v) => (typeof v === "boolean" ? v : null);
const breakerState = (v) => (v === "open" || v === "closed" ? v : null);
const sameAddress = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : null);

const COUNT_KEYS = ["settling", "paid", "sent", "requested", "expiring", "done", "rejected", "refundDue", "refundHandled"];

function breaker(b, extra) {
  const src = isObject(b) ? b : {};
  const out = { state: breakerState(src.state), openForSeconds: count(src.openForSeconds) };
  for (const key of extra) out[key] = count(src[key]);
  return out;
}

/**
 * The figures kept from a /health body, or null when it is not a health reply (no boolean `ok`).
 * Unknown or malformed fields become null. `relayerMatches` compares the reported relayer with the watched wallet.
 */
export function sanitizeHealth(body, api) {
  if (!isObject(body) || typeof body.ok !== "boolean") return null;
  const relayer = isObject(body.relayer) ? body.relayer : {};
  const counts = isObject(body.counts) ? body.counts : {};
  const inDoubt = isObject(body.inDoubt) ? body.inDoubt : {};
  return {
    ok: body.ok,
    relayerMatches: sameAddress(relayer.address, api.relayer),
    relayerBalance: typeof relayer.balance === "string" && DECIMAL.test(relayer.balance) ? relayer.balance : null,
    relayerFunded: flag(relayer.funded),
    relayerMinCalls: count(relayer.minCalls),
    stuck: flag(body.stuck),
    settlementBreaker: breaker(body.breaker, ["failures", "attempts"]),
    deliveryBreaker: breaker(body.delivery, ["expiries", "failures"]),
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, count(counts[key])])),
    pending: count(body.pending),
    inDoubt: { count: count(inDoubt.count), overdue: count(inDoubt.overdue), oldestSeconds: count(inDoubt.oldestSeconds) },
    lastAlarmSecondsAgo: body.lastAlarmSecondsAgo === null ? null : count(body.lastAlarmSecondsAgo),
  };
}

/** Calls the relayer holds, in every state: its alarm keeps running while this is above zero. Null when unknown. */
export function storedCalls(health) {
  const values = COUNT_KEYS.map((key) => health?.counts?.[key]);
  return values.every((v) => Number.isSafeInteger(v)) ? values.reduce((a, b) => a + b, 0) : null;
}

const transportReason = (err) =>
  err instanceof FetchTimeoutError ? "timeout" : err instanceof ResponseTooLargeError ? "reply too large" : "network error";

/**
 * GET <url>/health. /health answers 200 when ok and 503 with the same JSON when not, so both are health replies.
 * Returns {ok: true, httpStatus, latencyMs, health} or {ok: false, httpStatus, latencyMs, reason}. Never throws.
 */
export async function readAgentApi(net, { fetch, clock = () => Date.now(), timeoutMs = LIMITS.agentApiTimeoutMs }) {
  const api = net.agentApi;
  const started = clock();
  const elapsed = () => Math.max(0, Math.round(clock() - started));
  const failure = (reason, httpStatus = null) => ({ ok: false, httpStatus, latencyMs: elapsed(), reason });
  let response;
  try {
    response = await fetchText(
      fetch,
      `${api.url}/health`,
      { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT } },
      timeoutMs,
      { readErrorBody: true, maxBytes: LIMITS.agentApiMaxResponseBytes },
    );
  } catch (err) {
    return failure(transportReason(err));
  }
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    return failure(response.ok ? "invalid json" : `http ${response.status}`, response.status);
  }
  const health = sanitizeHealth(body, api);
  if (!health) return failure(response.ok ? "not a health reply" : `http ${response.status}`, response.status);
  if (body.network !== net.name) return failure("health reply for another network", response.status);
  return { ok: true, httpStatus: response.status, latencyMs: elapsed(), health };
}

/**
 * The stored poll state after one poll. A failed poll counts toward `failures` and keeps the last good figures,
 * which the checks then treat as unknown rather than current.
 */
export function applyAgentApiPoll(prev, poll, now) {
  const base = { checkedAt: now, httpStatus: poll.httpStatus ?? null, latencyMs: poll.latencyMs ?? null };
  if (poll.ok) return { ...base, reachable: true, reason: null, failures: 0, lastOkAt: now, health: poll.health };
  return {
    ...base,
    reachable: false,
    reason: poll.reason ?? "unknown",
    failures: (prev?.failures ?? 0) + 1,
    lastOkAt: prev?.lastOkAt ?? null,
    health: prev?.health ?? null,
  };
}
