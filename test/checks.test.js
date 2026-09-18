import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECK_NAMES,
  backupBalanceCheckName,
  evaluateBackupReportChecks,
  evaluateChainChecks,
  evaluateReportChecks,
  evaluateRpcCheck,
  networkCheckNames,
} from "../src/checks.js";
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

test("backup reports: not configured until the first one; nothing to watch without backup keepers", () => {
  const clear = { backup_heartbeat: null, backup_unhealthy: null, backup_role: null };
  assert.deepEqual(evaluateBackupReportChecks(TESTNET, null, NOW), clear);
  const stale = reportState({ lastReceivedAt: NOW - 3600, healthy: false, faults: ["tick_failed"], role: "primary" });
  assert.deepEqual(evaluateBackupReportChecks({ ...TESTNET, backupKeepers: [] }, stale, NOW), clear);
  const { backupKeepers, ...unset } = TESTNET;
  assert.deepEqual(evaluateBackupReportChecks(unset, stale, NOW), clear);
  // The keeper's own report checks never look at the backup.
  assert.deepEqual(Object.keys(evaluateReportChecks(TESTNET, reportState(), NOW)), ["heartbeat", "health_age", "unhealthy", "dropped_events"]);
});

test("backup heartbeat uses the keeper's thresholds (150 s warning, 240 s alarm)", () => {
  const at = (silence) => evaluateBackupReportChecks(TESTNET, reportState({ lastReceivedAt: NOW - silence, role: "follower" }), NOW).backup_heartbeat;
  assert.equal(severity(at(149)), "clear");
  assert.equal(severity(at(150)), "warning");
  assert.equal(severity(at(239)), "warning");
  assert.equal(severity(at(240)), "alarm");
  assert.equal(at(302).title, "backup keeper heartbeat missing");
  assert.equal(at(302).detail, "last report 5m 2s ago");
});

test("backup unhealthy: warning immediately, alarm after 5 minutes continuously", () => {
  const at = (duration) =>
    evaluateBackupReportChecks(
      MAINNET,
      reportState({ healthy: false, faults: ["preparation_stalled"], role: "follower", reportObservedAt: NOW - 5, unhealthySince: NOW - 5 - duration }),
      NOW,
    ).backup_unhealthy;
  assert.equal(at(0).severity, "warning");
  assert.equal(at(0).title, "backup keeper unhealthy");
  assert.equal(at(0).detail, "faults: preparation_stalled");
  assert.equal(at(299).severity, "warning");
  assert.equal(at(300).severity, "alarm");
  assert.equal(at(4 * 3600).detail, "faults: preparation_stalled (for 4h)");
  assert.equal(severity(evaluateBackupReportChecks(MAINNET, reportState({ role: "follower" }), NOW).backup_unhealthy), "clear");
});

test("backup role: primary on the backup route alarms; follower or no role yet is clear", () => {
  const at = (role) => evaluateBackupReportChecks(TESTNET, reportState({ role }), NOW).backup_role;
  assert.equal(severity(at("follower")), "clear");
  assert.equal(severity(at(null)), "clear");
  const wrong = at("primary");
  assert.equal(wrong.severity, "alarm");
  assert.equal(wrong.title, "backup keeper not a follower");
  assert.equal(wrong.detail, "reports role primary");
  assert.equal(wrong.event, undefined, "a standing condition until a follower report arrives");
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

test("backup keeper balances (< 2 USDC warning, < 1 USDC alarm), one check per wallet", () => {
  const backup = MAINNET.backupKeepers[0];
  const key = backupBalanceCheckName(backup);
  assert.equal(key, "backup_balance:0x75af60e2165e8e6d2f6cfd5d9ddda83446044685");
  const at = (wei) => evaluateChainChecks(MAINNET, healthyRead(MAINNET, { backupBalances: [{ address: backup, balanceWei: wei }] }));
  assert.equal(severity(at(2n * USDC)[key]), "clear");
  assert.equal(severity(at(45n * 10n ** 17n)[key]), "clear", "the mainnet backup's 4.5 USDC is enough");
  assert.equal(severity(at(2n * USDC - 1n)[key]), "warning");
  assert.equal(severity(at(1n * USDC)[key]), "warning");
  assert.equal(severity(at(1n * USDC - 1n)[key]), "alarm");
  assert.equal(severity(at(0n)[key]), "alarm");
  const low = at(1434567890123456789n)[key];
  assert.equal(low.title, "backup keeper 0x75Af…4685 balance low");
  assert.equal(low.detail, "0x75Af60E2165e8E6d2f6cFD5d9dDDa83446044685 holds 1.434567 USDC");
  assert.equal(at(1n)[key].event, undefined, "a standing condition, not a one-shot notice");

  // The keeper's own check is separate: a low backup leaves it clear, and the other way round.
  assert.equal(severity(at(1n).balance), "clear");
  const keeperLow = evaluateChainChecks(MAINNET, healthyRead(MAINNET, { balanceWei: 1n }));
  assert.equal(severity(keeperLow.balance), "alarm");
  assert.equal(severity(keeperLow[key]), "clear");

  // Unknown balance or failed read: unknown, so an existing alert is left alone.
  assert.equal(severity(at(null)[key]), "unknown");
  assert.equal(severity(evaluateChainChecks(MAINNET, healthyRead(MAINNET, { backupBalances: null }))[key]), "unknown");
  assert.equal(severity(evaluateChainChecks(MAINNET, { ok: false })[key]), "unknown");
  assert.ok(key in evaluateChainChecks(MAINNET, { ok: false }));
});

test("several backup keepers: each wallet has its own check, matched case-insensitively", () => {
  const a = "0x00000000000000000000000000000000000000Aa";
  const b = "0x00000000000000000000000000000000000000bB";
  const net = { ...TESTNET, backupKeepers: [a, b] };
  const c = evaluateChainChecks(net, healthyRead(net, {
    backupBalances: [{ address: a.toLowerCase(), balanceWei: 15n * 10n ** 17n }, { address: b, balanceWei: 9n * USDC }],
  }));
  assert.equal(c[backupBalanceCheckName(a)].severity, "warning");
  assert.equal(c[backupBalanceCheckName(a)].title, "backup keeper 0x0000…00Aa balance low");
  assert.equal(severity(c[backupBalanceCheckName(b)]), "clear");
  assert.deepEqual(networkCheckNames(net).slice(6, 9), ["balance", backupBalanceCheckName(a), backupBalanceCheckName(b)]);
});

test("check names per network: backup checks follow the keeper balance; none without backups", () => {
  assert.deepEqual(networkCheckNames(MAINNET), [
    ...CHECK_NAMES.slice(0, CHECK_NAMES.indexOf("balance") + 1),
    "backup_balance:0x75af60e2165e8e6d2f6cfd5d9ddda83446044685",
    ...CHECK_NAMES.slice(CHECK_NAMES.indexOf("balance") + 1),
  ]);
  assert.deepEqual(networkCheckNames(MAINNET).slice(7, 11), [
    "backup_balance:0x75af60e2165e8e6d2f6cfd5d9ddda83446044685",
    "backup_heartbeat",
    "backup_unhealthy",
    "backup_role",
  ]);
  assert.ok(networkCheckNames(TESTNET).includes("backup_balance:0xbb2fde97a5f4855bef872c71fbb80be3170127ee"));
  const { backupKeepers, ...unset } = TESTNET;
  for (const net of [{ ...TESTNET, backupKeepers: [] }, unset]) {
    assert.deepEqual(networkCheckNames(net), [...CHECK_NAMES]);
    const checks = evaluateChainChecks(net, healthyRead(net, { balanceWei: 1n }));
    assert.ok(!Object.keys(checks).some((check) => check.startsWith("backup_balance:")));
    assert.equal(checks.balance.severity, "alarm");
  }
});

test("2 x base fee + 1 gwei against the fee cap (> 60 % warning, > 85 % alarm)", () => {
  const at = (net, baseGwei) =>
    evaluateChainChecks(net, healthyRead(net, { block: { number: 1, timestamp: NOW, baseFeeWei: baseGwei * GWEI } })).base_fee;
  // Live value on both networks today: 20 gwei -> 41 gwei = 41 % of the testnet cap, not a warning.
  assert.equal(severity(at(TESTNET, 20n)), "clear");
  // Testnet cap 100 gwei: 30 gwei -> 61 gwei = 61 % warns; 42 gwei -> 85 gwei = exactly 85 % is not an alarm.
  const warn = at(TESTNET, 30n);
  assert.equal(warn.severity, "warning");
  assert.equal(warn.detail, "2 x base fee + 1 gwei = 61 gwei is 61% of the 100 gwei fee cap");
  assert.equal(severity(at(TESTNET, 42n)), "warning");
  assert.equal(severity(at(TESTNET, 43n)), "alarm"); // 87 %
  assert.equal(severity(at(MAINNET, 20n)), "clear"); // 41 of 2000 gwei
  assert.equal(severity(at(MAINNET, 900n)), "alarm"); // 1801 of 2000 gwei
});

test("committer and implementation slots", () => {
  assert.equal(severity(evaluateChainChecks(MAINNET, healthyRead(MAINNET)).committer), "clear");
  const wrong = evaluateChainChecks(
    MAINNET,
    healthyRead(MAINNET, {
      committer: "0x0000000000000000000000000000000000000001",
      coordinatorImpl: "0x0000000000000000000000000000000000000002",
      registryImpl: MAINNET.implementations.registry.toUpperCase().replace("0X", "0x"),
    }),
  );
  assert.equal(wrong.committer.severity, "alarm");
  assert.equal(wrong.coordinator_impl.severity, "alarm");
  assert.equal(severity(wrong.registry_impl), "clear", "checksum case is ignored");

  // Each network is compared against its own configured implementation, which may differ between networks.
  for (const net of [MAINNET, TESTNET]) {
    assert.equal(severity(evaluateChainChecks(net, healthyRead(net)).registry_impl), "clear");
    const foreign = evaluateChainChecks(net, healthyRead(net, { registryImpl: "0x00000000000000000000000000000000000000dd" }));
    assert.equal(foreign.registry_impl.severity, "alarm");
  }
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
