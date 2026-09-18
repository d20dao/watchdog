import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAgentApiPoll, readAgentApi, sanitizeHealth, storedCalls } from "../src/agentapi.js";
import { AGENT_API_CHECK_NAMES, evaluateAgentApiChecks } from "../src/checks.js";
import { MAINNET, TESTNET, agentApiBody, agentApiPoll, healthyRead } from "./helpers.js";

const USDC = 10n ** 18n;
const severity = (c) => (c === undefined ? "unknown" : c === null ? "clear" : c.severity);
const LIVE_MAINNET = { ...MAINNET, agentApi: { ...MAINNET.agentApi, enabled: true } };

/** The stored poll state after one successful poll of `overrides`. */
const polled = (overrides = {}) => applyAgentApiPoll(null, agentApiPoll(overrides), 1000);

/** A fetch answering every request with `body` (an object is sent as JSON) and `status`, recording each call. */
function answering(body, status = 200, headers = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

test("sanitizeHealth keeps a fixed set of figures and drops everything else", () => {
  const body = agentApiBody({
    // Fields a later /health could carry: none of them may survive.
    refunds: [{ payer: "0x1234567890abcdef1234567890abcdef12345678", paymentId: "0x" + "ab".repeat(32) }],
    payer: "0x1234567890abcdef1234567890abcdef12345678",
    lastSettleError: { class: "payment 0x" + "cd".repeat(32) + " failed", secondsAgo: 5 },
    delivery: { state: "closed", expiries: 0, failures: 0, openForSeconds: 0, lastReason: { kind: "failure", reason: "tx 0x" + "ef".repeat(32), secondsAgo: 9 } },
    inflight: { nonce: 7, hash: "0x" + "12".repeat(32) },
  });
  const h = sanitizeHealth(body, TESTNET.agentApi);
  assert.deepEqual(h, {
    ok: true,
    relayerMatches: true,
    relayerBalance: "0.38899523334875",
    relayerFunded: true,
    relayerMinCalls: 3,
    stuck: false,
    settlementBreaker: { state: "closed", openForSeconds: 0, failures: 0, attempts: 0 },
    deliveryBreaker: { state: "closed", openForSeconds: 0, expiries: 0, failures: 0 },
    counts: { settling: 0, paid: 0, sent: 0, requested: 0, expiring: 0, done: 71, rejected: 42, refundDue: 0, refundHandled: 0 },
    pending: 0,
    inDoubt: { count: 0, overdue: 0, oldestSeconds: 0 },
    lastAlarmSecondsAgo: 119,
  });
  const text = JSON.stringify(h);
  for (const secret of ["0x1234", "abab", "cdcd", "efef", "1212", "0xF6b4", "0xAbDF"]) assert.ok(!text.includes(secret), secret);
  assert.equal(storedCalls(h), 113);
});

test("sanitizeHealth: malformed figures become unknown; a body without a boolean ok is not a health reply", () => {
  const h = sanitizeHealth(
    agentApiBody({
      relayer: { address: "0x0000000000000000000000000000000000000001", balance: "<b>1</b>", funded: "yes", minCalls: -1 },
      stuck: 1,
      breaker: { state: "half-open", failures: 1.5 },
      delivery: null,
      counts: { done: "71", refundDue: 2 },
      inDoubt: { count: 3, overdue: 1e20, oldestSeconds: 700 },
      lastAlarmSecondsAgo: null,
    }),
    TESTNET.agentApi,
  );
  assert.equal(h.relayerMatches, false);
  assert.equal(h.relayerBalance, null);
  assert.equal(h.relayerFunded, null);
  assert.equal(h.relayerMinCalls, null);
  assert.equal(h.stuck, null);
  assert.deepEqual(h.settlementBreaker, { state: null, openForSeconds: null, failures: null, attempts: null });
  assert.deepEqual(h.deliveryBreaker, { state: null, openForSeconds: null, expiries: null, failures: null });
  assert.equal(h.counts.done, null);
  assert.equal(h.counts.refundDue, 2);
  assert.deepEqual(h.inDoubt, { count: 3, overdue: null, oldestSeconds: 700 });
  assert.equal(h.lastAlarmSecondsAgo, null);
  assert.equal(storedCalls(h), null);
  for (const body of [null, [], "ok", { ok: "true" }, { error: "rate_limited" }]) assert.equal(sanitizeHealth(body, TESTNET.agentApi), null);
});

test("readAgentApi: a plain GET of /health, 200 and 503 are both health replies", async () => {
  const up = answering(agentApiBody());
  const ok = await readAgentApi(TESTNET, { fetch: up.fetch });
  assert.equal(ok.ok, true);
  assert.equal(ok.httpStatus, 200);
  assert.equal(ok.health.ok, true);
  assert.equal(up.calls.length, 1);
  assert.equal(up.calls[0].url, "https://api-testnet.d20dao.org/health");
  assert.equal(up.calls[0].init.method, "GET");
  assert.ok(!Object.keys(up.calls[0].init.headers).some((h) => h.toLowerCase() === "authorization"), "no ops token");

  const red = await readAgentApi(TESTNET, { fetch: answering(agentApiBody({ ok: false, counts: { ...agentApiBody().counts, refundDue: 1 } }), 503).fetch });
  assert.equal(red.ok, true, "a 503 carrying the health JSON is a reply, not an outage");
  assert.equal(red.httpStatus, 503);
  assert.equal(red.health.ok, false);
  assert.equal(red.health.counts.refundDue, 1);
});

test("readAgentApi: outages and replies that are not this network's health are failed polls", async () => {
  const reason = async (fetch) => {
    const poll = await readAgentApi(TESTNET, { fetch, timeoutMs: 20 });
    assert.equal(poll.ok, false);
    return poll.reason;
  };
  assert.equal(await reason(answering("<html>bad gateway</html>", 502).fetch), "http 502");
  assert.equal(await reason(answering({ error: "rate_limited" }, 429).fetch), "http 429");
  assert.equal(await reason(answering("<html>hello</html>").fetch), "invalid json");
  assert.equal(await reason(answering({ status: "fine" }).fetch), "not a health reply");
  assert.equal(await reason(answering(agentApiBody({ network: "arc-mainnet" })).fetch), "health reply for another network");
  assert.equal(await reason(answering("x".repeat(20 * 1024)).fetch), "reply too large");
  assert.equal(await reason(async () => { throw new TypeError("connection refused"); }), "network error");
  const hanging = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  assert.equal(await reason(hanging), "timeout");
});

test("poll state: failures count up and reset; the last good figures are kept for display", () => {
  const good = applyAgentApiPoll(null, agentApiPoll(), 100);
  assert.deepEqual({ ...good, health: undefined }, { checkedAt: 100, httpStatus: 200, latencyMs: 80, reachable: true, reason: null, failures: 0, lastOkAt: 100, health: undefined });
  const down1 = applyAgentApiPoll(good, { ok: false, httpStatus: 502, latencyMs: 30, reason: "http 502" }, 160);
  const down2 = applyAgentApiPoll(down1, { ok: false, httpStatus: null, latencyMs: 10000, reason: "timeout" }, 220);
  assert.equal(down2.failures, 2);
  assert.equal(down2.reachable, false);
  assert.equal(down2.reason, "timeout");
  assert.equal(down2.lastOkAt, 100);
  assert.deepEqual(down2.health, good.health);
  assert.equal(applyAgentApiPoll(down2, agentApiPoll(), 280).failures, 0);
});

test("a healthy agent API and a funded relayer raise nothing", () => {
  const r = evaluateAgentApiChecks(TESTNET, polled(), healthyRead(TESTNET));
  assert.deepEqual(Object.keys(r), [...AGENT_API_CHECK_NAMES]);
  assert.ok(Object.values(r).every((c) => c === null));
});

test("an agent API that is not watched clears every check and is never read", () => {
  assert.equal(MAINNET.agentApi.enabled, false, "mainnet stays off until its API is live");
  const r = evaluateAgentApiChecks(MAINNET, polled({ ok: false, stuck: true }), healthyRead(MAINNET, { agentRelayerBalanceWei: 0n }));
  assert.ok(Object.values(r).every((c) => c === null));
});

test("relayer balance on chain: testnet < 1 USDC warning, < 0.36 alarm; mainnet < 4 warning, < 1 alarm", () => {
  const at = (net, wei) => evaluateAgentApiChecks(net, polled(), healthyRead(net, { agentRelayerBalanceWei: wei })).agent_api_relayer_balance;
  assert.equal(severity(at(TESTNET, 1n * USDC)), "clear");
  assert.equal(severity(at(TESTNET, 1n * USDC - 1n)), "warning");
  assert.equal(severity(at(TESTNET, 36n * USDC / 100n)), "warning");
  assert.equal(severity(at(TESTNET, 36n * USDC / 100n - 1n)), "alarm");
  assert.equal(severity(at(LIVE_MAINNET, 4n * USDC)), "clear");
  assert.equal(severity(at(LIVE_MAINNET, 4n * USDC - 1n)), "warning");
  assert.equal(severity(at(LIVE_MAINNET, 1n * USDC)), "warning");
  assert.equal(severity(at(LIVE_MAINNET, 1n * USDC - 1n)), "alarm");
  const c = at(TESTNET, 388995233348750000n);
  assert.equal(c.title, "agent API relayer balance low");
  assert.equal(
    c.detail,
    "relayer 0xF6b446dC2F30e6A802DFB7bD4c222d84F6cd05C3 holds 0.388995 USDC (warning below 1, alarm below 0.36); top it up before sales stop at 3 calls' cost",
  );
  // Read by the watchdog itself: known while the API is down, unknown when the chain read failed.
  const down = applyAgentApiPoll(null, { ok: false, reason: "timeout" }, 1);
  assert.equal(severity(evaluateAgentApiChecks(TESTNET, down, healthyRead(TESTNET, { agentRelayerBalanceWei: 0n })).agent_api_relayer_balance), "alarm");
  assert.equal(severity(evaluateAgentApiChecks(TESTNET, polled(), { ok: false }).agent_api_relayer_balance), "unknown");
  assert.equal(severity(evaluateAgentApiChecks(TESTNET, polled(), healthyRead(TESTNET, { agentRelayerBalanceWei: null })).agent_api_relayer_balance), "unknown");
});

test("unreachable: nothing on the first failed poll, warning after 2, alarm after 5; health figures unknown meanwhile", () => {
  let state = polled({ ok: false, stuck: true });
  const runs = [];
  for (let i = 1; i <= 5; i++) {
    state = applyAgentApiPoll(state, { ok: false, httpStatus: 522, reason: "http 522" }, 1000 + i * 60);
    runs.push(evaluateAgentApiChecks(TESTNET, state, healthyRead(TESTNET)));
  }
  assert.deepEqual(runs.map((r) => severity(r.agent_api)), ["unknown", "warning", "warning", "warning", "alarm"]);
  assert.equal(runs[1].agent_api.title, "agent API unreachable");
  assert.equal(runs[1].agent_api.detail, "https://api-testnet.d20dao.org/health failed 2 polls in a row (last: http 522)");
  for (const check of ["agent_api_funded", "agent_api_stuck", "agent_api_breaker", "agent_api_refund_due", "agent_api_in_doubt", "agent_api_alarm_loop"]) {
    assert.ok(runs.every((r) => r[check] === undefined), check);
  }
  assert.equal(severity(evaluateAgentApiChecks(TESTNET, applyAgentApiPoll(state, agentApiPoll(), 2000), healthyRead(TESTNET)).agent_api), "clear");
});

test("health fields: funded, stuck, breakers, refunds owed, payments in doubt", () => {
  const check = (overrides, name) => evaluateAgentApiChecks(TESTNET, polled({ ok: false, ...overrides }), healthyRead(TESTNET))[name];

  const unfunded = check({ relayer: { address: TESTNET.agentApi.relayer, balance: "0.2", funded: false, minCalls: 3 } }, "agent_api_funded");
  assert.equal(unfunded.severity, "alarm");
  assert.equal(unfunded.detail, "the API reports its relayer holds 0.2 USDC, under 3 calls' cost: it has stopped selling");
  assert.equal(check({ relayer: { funded: null } }, "agent_api_funded"), undefined, "the API could not read its balance");

  assert.equal(check({ stuck: true }, "agent_api_stuck").severity, "alarm");

  const settle = check({ breaker: { state: "open", failures: 3, attempts: 4, openForSeconds: 40 } }, "agent_api_breaker");
  assert.equal(settle.severity, "warning");
  assert.equal(settle.detail, "settlement breaker open (3 of 4 recent settle calls failed): the API refuses new calls until it closes");
  const delivery = check({ delivery: { state: "open", expiries: 2, failures: 0, openForSeconds: 280 } }, "agent_api_breaker");
  assert.equal(delivery.severity, "alarm");
  assert.equal(delivery.detail, "delivery breaker open (2 requests expired unserved, 0 failed to open): the API refuses new calls until it closes");

  const counts = agentApiBody().counts;
  const one = check({ counts: { ...counts, refundDue: 1 } }, "agent_api_refund_due");
  assert.equal(one.severity, "alarm");
  assert.equal(one.title, "agent API refund owed");
  assert.equal(
    one.detail,
    "1 paid call could not be served and its payer is owed a refund. Refund each payer by hand, then mark it handled in the agent API's operator refund list; this clears when none is left",
  );
  assert.match(check({ counts: { ...counts, refundDue: 3 } }, "agent_api_refund_due").detail, /^3 paid calls could not be served and their payers are owed a refund\./);
  assert.equal(check({ counts: { ...counts, refundHandled: 4 } }, "agent_api_refund_due"), null, "handled refunds do not count");

  const doubt = check({ inDoubt: { count: 2, overdue: 1, oldestSeconds: 725 } }, "agent_api_in_doubt");
  assert.equal(doubt.severity, "alarm");
  assert.equal(doubt.detail, "1 settlement unconfirmed past the API's limit (oldest 12m 5s): Gateway has confirmed neither way whether the payer was charged");
  assert.equal(check({ inDoubt: { count: 2, overdue: 0, oldestSeconds: 120 } }, "agent_api_in_doubt"), null, "in doubt but not yet overdue");
});

test("relayer alarm loop: alarm at 30 min since its last run while calls are stored; idle is fine", () => {
  const at = (lastAlarmSecondsAgo, counts = agentApiBody().counts) =>
    severity(evaluateAgentApiChecks(TESTNET, polled({ lastAlarmSecondsAgo, counts }), healthyRead(TESTNET)).agent_api_alarm_loop);
  assert.equal(at(1799), "clear");
  assert.equal(at(1800), "alarm");
  const empty = Object.fromEntries(Object.keys(agentApiBody().counts).map((key) => [key, 0]));
  assert.equal(at(86_400, empty), "clear", "nothing stored: the alarm rightly stops");
  assert.equal(at(null), "unknown", "never ran");
  const c = evaluateAgentApiChecks(TESTNET, polled({ lastAlarmSecondsAgo: 2400 }), healthyRead(TESTNET)).agent_api_alarm_loop;
  assert.equal(c.detail, "its last alarm ran 40m ago with 113 calls stored; it runs at least every 10 min while any are");
});

test("ok false alarms on its own only when no other check explains it; a different relayer alarms", () => {
  const generic = (overrides) => evaluateAgentApiChecks(TESTNET, polled(overrides), healthyRead(TESTNET)).agent_api;
  assert.equal(generic({ ok: false }).title, "agent API not ok");
  assert.equal(generic({ ok: false, stuck: true }), null, "explained by the stuck sender");
  assert.equal(generic({ ok: false, counts: { ...agentApiBody().counts, refundDue: 1 } }), null, "explained by the refund owed");
  const other = generic({ relayer: { address: "0x0000000000000000000000000000000000000001", balance: "5", funded: true, minCalls: 3 } });
  assert.equal(other.severity, "alarm");
  assert.equal(other.detail, "/health names a relayer other than 0xF6b446dC2F30e6A802DFB7bD4c222d84F6cd05C3, the wallet the watchdog checks");
});
