import assert from "node:assert/strict";
import { test } from "node:test";
import { beaconGroups } from "../src/beacon.js";
import {
  AGENT_API_CHECK_NAMES,
  CHECK_NAMES,
  backupBalanceCheckName,
  beaconMonitorFailure,
  beaconUsage,
  evaluateBackupReportChecks,
  evaluateBeaconAgreement,
  evaluateBeaconChecks,
  evaluateBeaconFresh,
  evaluateBeaconInfo,
  evaluateBeaconMonitor,
  evaluateBeaconRegistration,
  evaluateBeaconRelay,
  evaluateBeaconVerifier,
  evaluateBeaconVerify,
  evaluateChainChecks,
  evaluateReportChecks,
  evaluateRpcCheck,
  networkCheckNames,
} from "../src/checks.js";
import { NETWORKS, THRESHOLDS } from "../src/config.js";
import { MAINNET, TESTNET, healthyRead, withAgentApi } from "./helpers.js";

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

test("check names per network: backup checks follow the keeper balance, none without backups; agent API checks last while watched", () => {
  const keeperChecks = [
    ...CHECK_NAMES.slice(0, CHECK_NAMES.indexOf("balance") + 1),
    "backup_balance:0x75af60e2165e8e6d2f6cfd5d9ddda83446044685",
    ...CHECK_NAMES.slice(CHECK_NAMES.indexOf("balance") + 1),
  ];
  assert.deepEqual(networkCheckNames(withAgentApi(MAINNET, true)), [...keeperChecks, ...AGENT_API_CHECK_NAMES]);
  assert.deepEqual(networkCheckNames(withAgentApi(MAINNET, false)), keeperChecks);
  assert.deepEqual(networkCheckNames(MAINNET).slice(7, 11), [
    "backup_balance:0x75af60e2165e8e6d2f6cfd5d9ddda83446044685",
    "backup_heartbeat",
    "backup_unhealthy",
    "backup_role",
  ]);
  assert.ok(networkCheckNames(TESTNET).includes("backup_balance:0xbb2fde97a5f4855bef872c71fbb80be3170127ee"));
  const liveTestnet = withAgentApi(TESTNET, true);
  const { backupKeepers, ...unset } = liveTestnet;
  for (const net of [{ ...liveTestnet, backupKeepers: [] }, unset]) {
    // With the agent API watched, its checks follow the keeper's.
    assert.deepEqual(networkCheckNames(net), [...CHECK_NAMES, ...AGENT_API_CHECK_NAMES]);
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
      registryImpl: [].concat(MAINNET.implementations.registry)[0].toUpperCase().replace("0X", "0x"),
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

test("a listed implementation is accepted, so an approved upgrade raises no alarm", () => {
  const current = "0x00000000000000000000000000000000000000c1";
  const next = "0x00000000000000000000000000000000000000c2";
  const net = { ...MAINNET, implementations: { ...MAINNET.implementations, coordinator: [current, next] } };
  for (const impl of [current, next, next.toUpperCase().replace("0X", "0x")]) {
    assert.equal(severity(evaluateChainChecks(net, healthyRead(net, { coordinatorImpl: impl })).coordinator_impl), "clear");
  }
  const other = evaluateChainChecks(net, healthyRead(net, { coordinatorImpl: "0x00000000000000000000000000000000000000c3" }));
  assert.equal(other.coordinator_impl.severity, "alarm");
  assert.equal(other.coordinator_impl.detail, `ERC-1967 slot is 0x00000000000000000000000000000000000000c3, expected ${current} or ${next}`);
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

test("a listed registry implementation is accepted, so the upgrade for the beacon raises no alarm before it executes", () => {
  const current = [].concat(MAINNET.implementations.registry)[0];
  const next = "0x00000000000000000000000000000000000000d2";
  const net = { ...MAINNET, implementations: { ...MAINNET.implementations, registry: [current, next] } };
  for (const impl of [current, next, next.toUpperCase().replace("0X", "0x")]) {
    assert.equal(severity(evaluateChainChecks(net, healthyRead(net, { registryImpl: impl })).registry_impl), "clear");
  }
  const other = evaluateChainChecks(net, healthyRead(net, { registryImpl: "0x00000000000000000000000000000000000000d3" }));
  assert.equal(other.registry_impl.severity, "alarm");
  assert.equal(other.registry_impl.detail, `ERC-1967 slot is 0x00000000000000000000000000000000000000d3, expected ${current} or ${next}`);
  // As configured, the next implementation is not listed yet: the current one alone is expected.
  for (const configured of [MAINNET, TESTNET]) {
    assert.ok(Array.isArray(configured.implementations.registry));
    assert.equal(severity(evaluateChainChecks(configured, healthyRead(configured, { registryImpl: next })).registry_impl), "alarm");
  }
});

// ---------------------------------------------------------------------------------------------
// drand beacon

const GROUP = beaconGroups(NETWORKS)[0];
const RELAY = GROUP.relays[0];
const [MAINNET_TARGET] = GROUP.networks;
const group = (overrides = {}) => ({ fresh: 4, downRuns: 0, relays: {}, ...overrides });
const NO_USE = { only: [], mixed: [] };

test("beacon relay: a warning once it has not been fresh for 3 runs in a row", () => {
  assert.equal(THRESHOLDS.beaconRelayWarnRuns, 3);
  const at = (badRuns) => evaluateBeaconRelay(RELAY, { badRuns, reason: "http 503" });
  assert.equal(severity(at(0)), "clear");
  assert.equal(severity(at(2)), "clear");
  assert.equal(severity(at(3)), "warning");
  assert.equal(at(7).title, "drand relay api.drand.sh not serving fresh rounds");
  assert.equal(at(7).detail, "7 consecutive checks not fresh (last: http 503)");
  assert.equal(severity(evaluateBeaconRelay(RELAY, null)), "clear", "never checked");
});

test("how the catalogs in force use the beacon, from the networks' states: alone, among other sources, or not at all", () => {
  const states = (mainnet, testnet) => new Map([["network:arc-mainnet", mainnet], ["network:arc-testnet", testnet]].filter(([, s]) => s !== undefined));
  const use = (u, registration = "unregistered") => ({ registration, catalog: u === null ? null : { use: u } });
  assert.deepEqual(beaconUsage(GROUP, states(use("only"), use("none"))), { only: ["arc-mainnet"], mixed: [] });
  assert.deepEqual(beaconUsage(GROUP, states(use("only"), use("mixed"))), { only: ["arc-mainnet"], mixed: ["arc-testnet"] });
  assert.deepEqual(beaconUsage(GROUP, states(use("none"), use("none"))), NO_USE);
  // Not read yet: as serious as the beacon being registered makes it, since it might be in use, and otherwise nothing depends on it.
  assert.deepEqual(beaconUsage(GROUP, states(use(null, "registered"), use(null))), { only: [], mixed: ["arc-mainnet"] });
  assert.deepEqual(beaconUsage(GROUP, new Map()), NO_USE);
  assert.deepEqual(beaconUsage(GROUP, states({ readOk: false }, undefined)), NO_USE, "a state that has not been read at all");
});

test("beacon down: an alarm once no relay has been fresh for 2 runs in a row; how serious it is comes from the catalogs in force", () => {
  assert.equal(THRESHOLDS.beaconDownAlarmRuns, 2);
  const relays = Object.fromEntries(GROUP.relays.map((r) => [r.id, { reason: "timeout" }]));
  relays["api2.drand.sh"] = { reason: `latest round 5 is 9 rounds (27s) behind the schedule` };
  const at = (downRuns, usage) => evaluateBeaconFresh(GROUP, group({ fresh: 0, downRuns, relays }), usage);
  const reasons = "api.drand.sh: timeout, api2.drand.sh: latest round 5 is 9 rounds (27s) behind the schedule, api3.drand.sh: timeout, drand.cloudflare.com: timeout";
  for (const usage of [NO_USE, { only: ["arc-mainnet"], mixed: [] }, { only: [], mixed: ["arc-mainnet"] }]) {
    assert.equal(severity(at(0, usage)), "clear");
    assert.equal(severity(at(1, usage)), "clear");
  }
  // The beacon alone in a catalog in force: no fallback source, so the service is stopping.
  const only = at(2, { only: ["arc-mainnet", "arc-testnet"], mixed: [] });
  assert.deepEqual([only.severity, only.title], ["alarm", "drand beacon down, service stopping"]);
  assert.equal(
    only.detail,
    `no relay serves a fresh round (${reasons}); the catalog in force on arc-mainnet and arc-testnet lists only the drand beacon, so epoch publication stops there and requests cannot be served until one does`,
  );
  // On one network only, it names that one; the beacon alone anywhere outranks the beacon among other sources elsewhere.
  assert.match(at(2, { only: ["arc-testnet"], mixed: ["arc-mainnet"] }).detail, /the catalog in force on arc-testnet lists only/);
  // Among other sources: the epochs that select it cannot publish.
  const mixed = at(2, { only: [], mixed: ["arc-mainnet"] });
  assert.deepEqual([mixed.severity, mixed.title], ["alarm", "drand beacon down"]);
  assert.equal(mixed.detail, `no relay serves a fresh round (${reasons}); epochs on arc-mainnet that select the drand recipe cannot publish until one does`);
  // No catalog in force lists it: nothing depends on it yet, so a warning.
  const none = at(2, NO_USE);
  assert.deepEqual([none.severity, none.title], ["warning", "drand beacon down"]);
  assert.equal(none.detail, `no relay serves a fresh round (${reasons}); no catalog in force lists the drand beacon yet, so nothing depends on it`);
  assert.equal(at(2, undefined).severity, "warning", "no usage given is none");
  assert.equal(evaluateBeaconFresh(GROUP, group({ fresh: 0, downRuns: 9, relays: {} }), NO_USE).detail.includes("api.drand.sh: not checked"), true);
  assert.equal(severity(evaluateBeaconFresh(GROUP, null, NO_USE)), "clear");
});

test("beacon disagreement and chain info: a verdict that stays until a conclusive check says otherwise", () => {
  const state = (agreement, info) => ({ agreement, info });
  assert.equal(severity(evaluateBeaconAgreement(RELAY, state({ verdict: "ok" }))), "clear");
  assert.equal(severity(evaluateBeaconAgreement(RELAY, state(undefined))), "clear");
  const differs = evaluateBeaconAgreement(RELAY, state({ verdict: "differs", verdictReason: "round 5: no majority" }));
  assert.deepEqual([differs.severity, differs.title, differs.detail], ["warning", "drand relay api.drand.sh disagrees with the other relays", "round 5: no majority"]);
  // The only relay to return a signature that every registry rejects is named for it, not for disagreeing with anyone.
  const rejected = evaluateBeaconAgreement(RELAY, state({ verdict: "rejected", verdictReason: "round 5: signature 1111111111...1111 is rejected by the arc-mainnet registry and no other relay returned it" }));
  assert.deepEqual([rejected.severity, rejected.title], ["warning", "drand relay api.drand.sh serves a signature the registry rejects"]);
  assert.match(rejected.detail, /is rejected by the arc-mainnet registry and no other relay returned it$/);
  assert.equal(severity(evaluateBeaconInfo(RELAY, state(undefined, { verdict: "ok" }))), "clear");
  const drift = evaluateBeaconInfo(RELAY, state(undefined, { verdict: "drift", verdictReason: "chain info differs from the drand-evmnet preset: period 5 (expected 3)" }));
  assert.deepEqual([drift.severity, drift.title], ["warning", "drand relay api.drand.sh chain info differs from the configured beacon"]);
  assert.equal(severity(evaluateBeaconInfo(RELAY, null)), "clear");
});

test("beacon registration: nothing before it is registered, a mismatch warns, a recipe that is no beacon warns, a lost registration warns, an unread registry is unknown", () => {
  const registered = { readOk: true, registration: "registered", everRegistered: true, verdict: "ok" };
  assert.equal(severity(evaluateBeaconRegistration(MAINNET_TARGET, null)), "unknown", "not read yet");
  assert.equal(severity(evaluateBeaconRegistration(MAINNET_TARGET, registered)), "clear");
  const mismatch = evaluateBeaconRegistration(MAINNET_TARGET, { ...registered, verdict: "mismatch", verdictReason: "beaconOf(11) differs: period 9 (expected 3)" });
  assert.deepEqual([mismatch.severity, mismatch.title, mismatch.detail], ["warning", "arc-mainnet registry beacon registration mismatch", "beaconOf(11) differs: period 9 (expected 3)"]);

  // Before the upgrade and the registration: skipped without a word, whatever the reason.
  const early = { readOk: true, registration: "unregistered", registrationReason: "beaconOf reverted", everRegistered: false };
  assert.equal(severity(evaluateBeaconRegistration(MAINNET_TARGET, early)), "clear");
  const lost = evaluateBeaconRegistration(MAINNET_TARGET, { ...early, everRegistered: true });
  assert.deepEqual([lost.severity, lost.title, lost.detail], ["warning", "arc-mainnet registry beacon no longer registered", "beaconOf reverted; the beacon was registered before"]);

  // A recipe that exists but is no beacon (a zero verifier) is a distinct warning, with or without a registration before: the
  // configured id is what to check.
  for (const everRegistered of [false, true]) {
    const notBeacon = evaluateBeaconRegistration(MAINNET_TARGET, { readOk: true, registration: "notbeacon", registrationReason: "zero verifier", everRegistered, recipe: 11 });
    assert.deepEqual(
      [notBeacon.severity, notBeacon.title, notBeacon.detail],
      ["warning", "arc-mainnet registry beacon recipe misconfigured", "recipe 11 exists but is not a beacon; check the configured id"],
    );
  }
  assert.match(evaluateBeaconRegistration(MAINNET_TARGET, { readOk: true, registration: "notbeacon" }).detail, /^recipe 11 exists/, "the configured recipe when the state holds none");
  assert.equal(severity(evaluateBeaconRegistration(MAINNET_TARGET, { ...registered, readOk: false })), "unknown");
  assert.equal(severity(evaluateBeaconRegistration(MAINNET_TARGET, { readOk: false })), "unknown", "never read");
});

test("beacon verification: an alarm once the registry has rejected the round in 2 runs in a row, with the recipe monitored", () => {
  assert.equal(THRESHOLDS.beaconVerifyAlarmRuns, 2);
  const state = (failures, extra = {}) => ({ readOk: true, registration: "registered", verify: { failures, rejectedRound: 42, rejectedReason: "verifyBeacon returned false" }, ...extra });
  assert.equal(severity(evaluateBeaconVerify(MAINNET_TARGET, state(0))), "clear");
  assert.equal(severity(evaluateBeaconVerify(MAINNET_TARGET, state(1))), "clear");
  const alarmed = evaluateBeaconVerify(MAINNET_TARGET, state(2));
  assert.deepEqual([alarmed.severity, alarmed.title], ["alarm", "arc-mainnet registry rejects drand rounds"]);
  assert.equal(alarmed.detail, "verifyBeacon(11) rejected round 42 in 2 consecutive runs (verifyBeacon returned false): the registry cannot verify a real round");
  assert.match(evaluateBeaconVerify(MAINNET_TARGET, state(2, { recipe: 12 })).detail, /^verifyBeacon\(12\) rejected round 42/, "the recipe monitored, when it is not the configured one");
  assert.equal(severity(evaluateBeaconVerify(MAINNET_TARGET, state(5, { registration: "unregistered" }))), "clear", "nothing to verify against");
  assert.equal(severity(evaluateBeaconVerify(MAINNET_TARGET, state(5, { readOk: false }))), "unknown");
  assert.equal(severity(evaluateBeaconVerify(MAINNET_TARGET, null)), "unknown");
});

test("beacon verifier: an alarm at once when the registered verifier accepted a signature with its last byte flipped", () => {
  const state = (verdict, extra = {}) => ({ readOk: true, registration: "registered", verifier: "0x" + "ab".repeat(20), negative: { verdict, round: 42 }, ...extra });
  assert.equal(severity(evaluateBeaconVerifier(MAINNET_TARGET, state("ok"))), "clear");
  assert.equal(severity(evaluateBeaconVerifier(MAINNET_TARGET, state(undefined, { negative: undefined }))), "clear", "never checked");
  const accepts = evaluateBeaconVerifier(MAINNET_TARGET, state("accepts"));
  assert.deepEqual([accepts.severity, accepts.title], ["alarm", "arc-mainnet registered verifier accepts an invalid signature"]);
  assert.equal(
    accepts.detail,
    `verifyBeacon(11) returned true for round 42 with the last byte of its signature flipped: verifier 0x${"ab".repeat(20)} would accept a forged round`,
  );
  assert.match(evaluateBeaconVerifier(MAINNET_TARGET, state("accepts", { recipe: 12 })).detail, /^verifyBeacon\(12\) returned true/);
  assert.equal(severity(evaluateBeaconVerifier(MAINNET_TARGET, state("accepts", { registration: "unregistered" }))), "clear", "nothing registered");
  assert.equal(severity(evaluateBeaconVerifier(MAINNET_TARGET, state("accepts", { readOk: false }))), "unknown", "an alarm is kept, not resolved, by a run that read nothing");
  assert.equal(severity(evaluateBeaconVerifier(MAINNET_TARGET, null)), "unknown");
});

test("beacon monitor: a warning while any part of the last run failed on an error of the watchdog's own", () => {
  const states = (entries) => new Map(Object.entries(entries));
  const failed = { monitor: { at: NOW, reason: "internal error" } };
  assert.equal(severity(evaluateBeaconMonitor([GROUP], new Map())), "clear", "nothing has run yet");
  assert.equal(severity(evaluateBeaconMonitor([GROUP], states({ "group:drand-evmnet": { monitor: null }, "network:arc-mainnet": { monitor: null } }))), "clear");
  const relays = evaluateBeaconMonitor([GROUP], states({ "group:drand-evmnet": failed }));
  assert.deepEqual([relays.severity, relays.title], ["warning", "drand monitor failed internally"]);
  assert.equal(
    relays.detail,
    "the drand-evmnet relay reads failed on an error in the watchdog itself, not in a relay or a registry; what it could not check is unknown until it runs again",
  );
  assert.match(evaluateBeaconMonitor([GROUP], states({ "network:arc-testnet": failed })).detail, /^the arc-testnet registry read failed on an error/);
  assert.match(
    evaluateBeaconMonitor([GROUP], states({ "group:drand-evmnet": failed, "network:arc-mainnet": failed, "network:arc-testnet": failed })).detail,
    /^the drand-evmnet relay reads, the arc-mainnet registry read and the arc-testnet registry read failed on an error/,
  );
  // The condition of a run whose results could not be recorded says so in its own words.
  assert.equal(beaconMonitorFailure("x").detail, "x; what it could not check is unknown until it runs again");
});

test("beacon checks: every relay and network has its own, and the relays' warnings are unknown while none is fresh", () => {
  const relayStates = Object.fromEntries(GROUP.relays.map((r) => [r.id, { badRuns: 9, reason: "http 503" }]));
  const states = (fresh, networks = {}) =>
    new Map([["group:drand-evmnet", group({ fresh, downRuns: fresh === 0 ? 4 : 0, relays: relayStates })], ...Object.entries(networks)]);
  const conditions = evaluateBeaconChecks([GROUP], states(0));
  assert.deepEqual([...conditions.keys()], [
    "fresh:drand-evmnet",
    ...GROUP.relays.flatMap((r) => [`relay:drand-evmnet:${r.id}`, `agree:drand-evmnet:${r.id}`, `info:drand-evmnet:${r.id}`]),
    "registration:arc-mainnet",
    "verify:arc-mainnet",
    "verifier:arc-mainnet",
    "registration:arc-testnet",
    "verify:arc-testnet",
    "verifier:arc-testnet",
    "monitor",
  ]);
  // No catalog read, and no beacon registered: nothing depends on it, so the outage is a warning.
  assert.equal(conditions.get("fresh:drand-evmnet").severity, "warning");
  assert.ok(GROUP.relays.every((r) => conditions.get(`relay:drand-evmnet:${r.id}`) === undefined), "covered by the alert above");
  assert.equal(conditions.get("registration:arc-mainnet"), undefined, "no network state yet");
  assert.equal(conditions.get("verifier:arc-mainnet"), undefined);
  assert.equal(conditions.get("monitor"), null);

  // The catalog in force decides the level, network by network.
  const only = evaluateBeaconChecks([GROUP], states(0, { "network:arc-testnet": { readOk: true, registration: "unregistered", catalog: { use: "only" } } }));
  assert.deepEqual([only.get("fresh:drand-evmnet").severity, only.get("fresh:drand-evmnet").title], ["alarm", "drand beacon down, service stopping"]);
  assert.match(only.get("fresh:drand-evmnet").detail, /the catalog in force on arc-testnet lists only/);

  const one = evaluateBeaconChecks([GROUP], states(1));
  assert.equal(one.get("fresh:drand-evmnet"), null);
  assert.ok(GROUP.relays.every((r) => one.get(`relay:drand-evmnet:${r.id}`).severity === "warning"));
  // The monitor's own failure is one check for the whole monitor, and is not there without a beacon to watch.
  const failing = evaluateBeaconChecks([GROUP], states(1, { "network:arc-mainnet": { monitor: { at: NOW, reason: "internal error" } } }));
  assert.equal(failing.get("monitor").severity, "warning");
  assert.equal(evaluateBeaconChecks([], new Map()).size, 0);
  // Nothing stored yet: nothing to raise.
  assert.ok([...evaluateBeaconChecks([GROUP], new Map()).values()].every((c) => c === null || c === undefined));
});
