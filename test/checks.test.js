import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateChainChecks, evaluateReportChecks, evaluateRpcCheck } from "../src/checks.js";
import { MAINNET, TESTNET, healthyRead } from "./helpers.js";

const NOW = 1789420300;
const GWEI = 10n ** 9n;
const USDC = 10n ** 18n;

function reportState(overrides = {}) {
  return {
    firstReceivedAt: NOW - 3600,
    lastReceivedAt: NOW - 10,
    reportObservedAt: NOW - 11,
    healthObservedAt: NOW - 15,
    healthy: true,
    sendEnabled: true,
    faults: [],
    droppedTotal: 0,
    droppedAlertedTotal: 0,
    unhealthySince: null,
    ...overrides,
  };
}

const severity = (c) => (c === undefined ? "unknown" : c === null ? "clear" : c.severity);

test("never-reported networks raise no report alerts", () => {
  const r = evaluateReportChecks(TESTNET, null, NOW);
  assert.deepEqual(Object.values(r).map(severity), ["clear", "clear", "clear", "clear"]);
});

test("heartbeat thresholds (150 s warning, 240 s alarm)", () => {
  const at = (silence) => severity(evaluateReportChecks(TESTNET, reportState({ lastReceivedAt: NOW - silence }), NOW).heartbeat);
  assert.equal(at(149), "clear");
  assert.equal(at(150), "warning");
  assert.equal(at(239), "warning");
  assert.equal(at(240), "alarm");
  const c = evaluateReportChecks(TESTNET, reportState({ lastReceivedAt: NOW - 302 }), NOW).heartbeat;
  assert.equal(c.title, "heartbeat missing");
  assert.equal(c.detail, "last report 5m 2s ago");
});

test("health observation age in the latest report (120 s warning, 240 s alarm)", () => {
  const at = (lag) =>
    severity(evaluateReportChecks(TESTNET, reportState({ reportObservedAt: NOW - 5, healthObservedAt: NOW - 5 - lag }), NOW).health_age);
  assert.equal(at(119), "clear");
  assert.equal(at(120), "warning");
  assert.equal(at(240), "alarm");
  // Bootstrap shape has no health observation: handled by the unhealthy check instead.
  assert.equal(severity(evaluateReportChecks(TESTNET, reportState({ healthObservedAt: null }), NOW).health_age), "clear");
  // A delivery gap alone does not age the observation (heartbeat covers it).
  const late = reportState({ lastReceivedAt: NOW - 600, reportObservedAt: NOW - 600, healthObservedAt: NOW - 610 });
  assert.equal(severity(evaluateReportChecks(TESTNET, late, NOW).health_age), "clear");
});

test("unhealthy: warning immediately, alarm after 5 minutes continuously", () => {
  const fresh = evaluateReportChecks(
    TESTNET,
    reportState({ healthy: false, faults: ["settlement_stalled", "nonce_stalled"], unhealthySince: NOW - 11 }),
    NOW,
  ).unhealthy;
  assert.equal(fresh.severity, "warning");
  assert.equal(fresh.detail, "faults: settlement_stalled, nonce_stalled");

  const at = (duration) =>
    evaluateReportChecks(
      TESTNET,
      reportState({ healthy: false, faults: ["tick_failed"], reportObservedAt: NOW - 5, unhealthySince: NOW - 5 - duration }),
      NOW,
    ).unhealthy;
  assert.equal(at(299).severity, "warning");
  assert.equal(at(300).severity, "alarm");
  assert.equal(at(300).detail, "faults: tick_failed (for 5m)");
  assert.equal(severity(evaluateReportChecks(TESTNET, reportState(), NOW).unhealthy), "clear");
});

test("dropped audit events raise a one-shot notice on increase", () => {
  const c = evaluateReportChecks(TESTNET, reportState({ droppedTotal: 7, droppedAlertedTotal: 4 }), NOW).dropped_events;
  assert.equal(c.severity, "warning");
  assert.equal(c.event, true);
  assert.match(c.detail, /rose by 3 to 7/);
  assert.equal(severity(evaluateReportChecks(TESTNET, reportState({ droppedTotal: 7, droppedAlertedTotal: 7 }), NOW).dropped_events), "clear");
});

test("chain checks are unknown when the read failed", () => {
  const r = evaluateChainChecks(TESTNET, { ok: false });
  assert.ok(Object.values(r).every((c) => c === undefined));
});

test("pending request age (25 s warning, 45 s alarm)", () => {
  const at = (age) =>
    evaluateChainChecks(TESTNET, healthyRead(TESTNET, { pending: { count: 2, ids: [7n, 8n], oldest: { id: 7n, ageSeconds: age } } })).pending;
  assert.equal(severity(at(24)), "clear");
  assert.equal(severity(at(25)), "warning");
  assert.equal(severity(at(45)), "alarm");
  assert.equal(
    at(50).detail,
    `request 7 pending for 50s (2 pending) https://arc-testnet.d20dao.org/request/${TESTNET.coordinator}/7`,
  );
  assert.equal(severity(evaluateChainChecks(TESTNET, healthyRead()).pending), "clear");
  assert.equal(severity(evaluateChainChecks(TESTNET, healthyRead(TESTNET, { pending: null })).pending), "unknown");
});

test("keeper balance (< 5 USDC warning, < 2 USDC alarm)", () => {
  const at = (wei) => evaluateChainChecks(MAINNET, healthyRead(MAINNET, { balanceWei: wei })).balance;
  assert.equal(severity(at(5n * USDC)), "clear");
  assert.equal(severity(at(5n * USDC - 1n)), "warning");
  assert.equal(severity(at(2n * USDC)), "warning");
  assert.equal(severity(at(2n * USDC - 1n)), "alarm");
  assert.match(at(3434567890123456789n).detail, /holds 3\.434567 USDC$/);
});

test("2 x base fee + 1 gwei against the fee cap (> 25 % warning, > 50 % alarm)", () => {
  const at = (net, baseGwei) =>
    evaluateChainChecks(net, healthyRead(net, { block: { number: 1, timestamp: NOW, baseFeeWei: baseGwei * GWEI } })).base_fee;
  // Testnet cap 100 gwei: 12 gwei -> 25 gwei = exactly 25 % (not above).
  assert.equal(severity(at(TESTNET, 12n)), "clear");
  // Live value on both networks today: 20 gwei -> 41 gwei = 41 % of the testnet cap.
  const live = at(TESTNET, 20n);
  assert.equal(live.severity, "warning");
  assert.equal(live.detail, "2 x base fee + 1 gwei = 41 gwei is 41% of the 100 gwei fee cap");
  assert.equal(severity(at(TESTNET, 25n)), "alarm"); // 51 %
  assert.equal(severity(at(MAINNET, 20n)), "clear"); // 41 of 2000 gwei
  assert.equal(severity(at(MAINNET, 500n)), "alarm"); // 1001 of 2000 gwei
});

test("committer and implementation slots", () => {
  assert.equal(severity(evaluateChainChecks(MAINNET, healthyRead(MAINNET)).committer), "clear");
  const wrong = evaluateChainChecks(
    MAINNET,
    healthyRead(MAINNET, {
      committer: "0x0000000000000000000000000000000000000001",
      coordinatorImpl: "0x0000000000000000000000000000000000000002",
      registryImpl: "0xD20Da0cf7Ddc6123f9A87c0C210F8ECB934CA7D5",
    }),
  );
  assert.equal(wrong.committer.severity, "alarm");
  assert.equal(wrong.coordinator_impl.severity, "alarm");
  assert.equal(severity(wrong.registry_impl), "clear", "checksum case is ignored");
});

test("refund logs raise an alarm event with request ids", () => {
  const refunds = [812n, 813n].map((requestId) => ({
    requestId,
    refundAddress: "0x3333333333333333333333333333333333333333",
    amountWei: 5n * 10n ** 17n,
    paid: requestId === 812n,
  }));
  const c = evaluateChainChecks(
    TESTNET,
    healthyRead(TESTNET, { logs: { fromBlock: 1, toBlock: 2, refunds, foreignFulfillments: [] } }),
  );
  assert.equal(c.refund.severity, "alarm");
  assert.equal(c.refund.event, true);
  assert.equal(c.refund.title, "refund issued, investigate");
  assert.match(c.refund.detail, /request 812 \(0\.5 USDC paid to 0x3333/);
  assert.match(c.refund.detail, /request 813 \(0\.5 USDC credited/);
  assert.match(c.refund.detail, /\/request\/0xd20DA0FF9087d053f0291524Eac12abA1ADBd945\/812$/);
  assert.equal(severity(c.foreign_submitter), "clear");
  assert.equal(severity(evaluateChainChecks(TESTNET, healthyRead(TESTNET, { logs: null })).refund), "unknown");
});

test("fulfillment by a different submitter is a warning event", () => {
  const c = evaluateChainChecks(
    TESTNET,
    healthyRead(TESTNET, {
      logs: {
        fromBlock: 1,
        toBlock: 2,
        refunds: [],
        foreignFulfillments: [{ requestId: 900n, submitter: "0x4444444444444444444444444444444444444444" }],
      },
    }),
  );
  assert.equal(c.foreign_submitter.severity, "warning");
  assert.equal(c.foreign_submitter.event, true);
  assert.match(c.foreign_submitter.detail, /request 900 by 0x4444/);
});

test("watchdog RPC failures warn after 3 consecutive runs", () => {
  assert.equal(evaluateRpcCheck(0, null), null);
  assert.equal(evaluateRpcCheck(2, "http 429"), null);
  const c = evaluateRpcCheck(3, "http 429");
  assert.equal(c.severity, "warning");
  assert.equal(c.title, "watchdog cannot read chain");
  assert.equal(c.detail, "3 consecutive runs failed (last error: http 429)");
});
