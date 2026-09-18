import assert from "node:assert/strict";
import { test } from "node:test";
import { runCron } from "../src/cron.js";
import { buildStatus, renderHtml } from "../src/status.js";
import {
  BACKUP_STREAM,
  ingestReport,
  migrate,
  readAlerts,
  readBackupReportState,
  readChainState,
  readReportState,
  recentMessages,
} from "../src/store.js";
import { groupMessages } from "../src/telegram.js";
import { readAgentApi } from "../src/agentapi.js";
import { MAINNET, TESTNET, agentApiBody, agentApiPoll, healthyRead, memoryStorage, pageText } from "./helpers.js";

const T0 = 1789420000;
const USDC = 10n ** 18n;
const BACKUP = MAINNET.backupKeepers[0];
const BACKUP_CHECK = "backup_balance:0x75af60e2165e8e6d2f6cfd5d9ddda83446044685";
const TELEGRAM = { TELEGRAM_BOT_TOKEN: "123456:throwaway-token", TELEGRAM_CHAT_ID: "-1001234567890" };

function record(network, overrides = {}) {
  return {
    network,
    reportId: `r-${Math.random().toString(16).slice(2)}`,
    bodySha256: "00".repeat(32),
    receivedAt: T0,
    observedAt: T0,
    nodeId: "0x" + "ab".repeat(32),
    healthy: true,
    healthObservedAt: T0,
    sendEnabled: true,
    faults: [],
    droppedTotal: 0,
    droppedCount: 0,
    failedCounts: {},
    eventCount: 0,
    ...overrides,
  };
}

/** Harness with a controllable clock, per-network chain reads and a recording Telegram fetch. */
function harness(env = TELEGRAM) {
  const storage = memoryStorage();
  const state = {
    clock: T0,
    reads: { "arc-mainnet": healthyRead(MAINNET), "arc-testnet": healthyRead(TESTNET) },
    polls: {}, // agent API /health results per network; a healthy reply unless a test sets one
    polled: [],
    telegram: [],
    telegramStatus: 200,
    networks: undefined, // the real configuration unless a test sets its own
  };
  const fetch = async (url, init) => {
    assert.ok(url.startsWith("https://api.telegram.org/bot"), "only Telegram is fetched directly");
    state.telegram.push(JSON.parse(init.body));
    return new Response("{}", { status: state.telegramStatus });
  };
  const run = (minutes) => {
    if (minutes !== undefined) state.clock = T0 + minutes * 60;
    return runCron({
      storage,
      env,
      fetch,
      clock: () => state.clock * 1000,
      readChainImpl: async (net, cursor) => ({ ...state.reads[net.name], cursorSeen: cursor }),
      readAgentApiImpl: async (net) => {
        state.polled.push(net.name);
        const poll = state.polls[net.name] ?? agentApiPoll();
        if (poll instanceof Error) throw poll;
        return poll;
      },
      networks: state.networks,
      recipes: [], // AirnodeHub probes are covered in probe.test.js
    });
  };
  return { storage, state, run };
}

test("healthy networks with no reports: no alerts, chain figures stored", async () => {
  const h = harness();
  const summary = await h.run(0);
  assert.equal(summary.messagesQueued, 0);
  assert.equal(summary.notifier, "configured");
  assert.equal(h.state.telegram.length, 0);
  const chain = readChainState(h.storage, "arc-mainnet");
  assert.equal(chain.ok, true);
  assert.equal(chain.balanceWei, (50n * 10n ** 18n).toString());
  assert.equal(chain.logCursor, 1000);
  assert.equal(chain.consecutiveFailures, 0);
});

test("heartbeat: warning, alarm, repeat after 30 min, resolution; delivered to Telegram", async () => {
  const h = harness();
  ingestReport(h.storage, record("arc-mainnet"));
  await h.run(1);
  assert.equal(h.state.telegram.length, 0);

  await h.run(3); // 180 s silence
  assert.deepEqual(h.state.telegram.map((m) => m.text), ["[arc-mainnet] WARNING heartbeat missing: last report 3m ago"]);
  assert.equal(h.state.telegram[0].chat_id, TELEGRAM.TELEGRAM_CHAT_ID);
  assert.equal(h.state.telegram[0].disable_web_page_preview, true);

  await h.run(4); // 240 s: alarm
  await h.run(5);
  await h.run(34); // 30 min after first alarm
  await h.run(35);
  assert.deepEqual(h.state.telegram.slice(1).map((m) => m.text), [
    "[arc-mainnet] ALARM heartbeat missing: last report 4m ago",
    "[arc-mainnet] ALARM heartbeat missing: last report 34m ago (active 31 min)",
  ]);

  ingestReport(h.storage, record("arc-mainnet", { receivedAt: T0 + 35 * 60 + 10, observedAt: T0 + 35 * 60 + 10, healthObservedAt: T0 + 35 * 60 + 10 }));
  await h.run(36);
  assert.equal(h.state.telegram.at(-1).text, "[arc-mainnet] RESOLVED heartbeat missing after 33 min");
  assert.equal(readAlerts(h.storage, "arc-mainnet").length, 0);
  assert.ok(recentMessages(h.storage).every((m) => m.status === "sent"));
});

test("several messages in one run are grouped into one Telegram send", async () => {
  const h = harness();
  h.state.reads["arc-testnet"] = healthyRead(TESTNET, {
    balanceWei: 1n * 10n ** 18n,
    committer: "0x0000000000000000000000000000000000000001",
    block: { number: 1000, timestamp: T0, baseFeeWei: 43n * 10n ** 9n },
  });
  const summary = await h.run(0);
  assert.equal(summary.messagesQueued, 3);
  assert.equal(summary.messagesDelivered, 3);
  assert.equal(h.state.telegram.length, 1);
  const lines = h.state.telegram[0].text.split("\n\n");
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.startsWith("[arc-testnet] ALARM ")));
});

test("notifier not configured: alerts are evaluated and stored but never sent", async () => {
  const h = harness({});
  h.state.reads["arc-mainnet"] = healthyRead(MAINNET, { balanceWei: 3n * 10n ** 18n });
  const summary = await h.run(0);
  assert.equal(summary.notifier, "not configured");
  assert.equal(summary.messagesQueued, 1);
  assert.equal(summary.messagesDelivered, 0);
  assert.equal(h.state.telegram.length, 0);
  assert.equal(readAlerts(h.storage, "arc-mainnet")[0].check, "balance");
  assert.equal(recentMessages(h.storage)[0].status, "not_sent");
  const status = buildStatus(h.storage, {}, T0 + 5);
  assert.equal(status.notifier, "not configured");
  assert.equal(status.networks["arc-mainnet"].alerts[0].severity, "warning");
});

test("Telegram failure keeps the message pending and retries next run", async () => {
  const h = harness();
  h.state.reads["arc-mainnet"] = healthyRead(MAINNET, { balanceWei: 1n });
  h.state.telegramStatus = 502;
  const first = await h.run(0);
  assert.equal(first.deliveryError, "http 502");
  assert.equal(recentMessages(h.storage)[0].status, "pending");
  h.state.telegramStatus = 200;
  const second = await h.run(1);
  assert.equal(second.messagesQueued, 0);
  assert.equal(second.messagesDelivered, 1);
  assert.equal(h.state.telegram.length, 2);
  assert.equal(recentMessages(h.storage)[0].status, "sent");
});

test("RPC failures: chain alerts stay untouched, warning after 3 consecutive failed runs", async () => {
  const h = harness();
  h.state.reads["arc-testnet"] = healthyRead(TESTNET, { balanceWei: 1n });
  await h.run(0);
  assert.equal(h.state.telegram.length, 1);
  h.state.reads["arc-testnet"] = { ok: false, complete: false, error: "http 429", errors: [], subrequests: 2 };
  await h.run(1);
  await h.run(2);
  assert.equal(h.state.telegram.length, 1, "no resolution while the chain is unreadable");
  assert.equal(readAlerts(h.storage, "arc-testnet").length, 1);
  await h.run(3);
  assert.equal(h.state.telegram.at(-1).text, "[arc-testnet] WARNING watchdog cannot read chain: 3 consecutive runs failed (last error: http 429)");
  const chain = readChainState(h.storage, "arc-testnet");
  assert.equal(chain.consecutiveFailures, 3);
  assert.equal(chain.balanceWei, "1", "last known figures are kept");
  assert.equal(chain.logCursor, 1000, "cursor is kept");

  h.state.reads["arc-testnet"] = healthyRead(TESTNET);
  await h.run(4);
  const texts = h.state.telegram.map((m) => m.text).join("\n");
  assert.match(texts, /RESOLVED keeper balance low after 4 min/);
  assert.match(texts, /RESOLVED watchdog cannot read chain after 1 min/);
});

test("backup and keeper balance alerts are raised and resolved independently", async () => {
  const h = harness();
  const balances = (keeper, backup) =>
    (h.state.reads["arc-mainnet"] = healthyRead(MAINNET, { balanceWei: keeper, backupBalances: [{ address: BACKUP, balanceWei: backup }] }));
  const texts = () => h.state.telegram.flatMap((m) => m.text.split("\n\n"));

  balances(1n * USDC, 15n * 10n ** 17n);
  const first = await h.run(0);
  assert.deepEqual(texts(), [
    `[arc-mainnet] ALARM keeper balance low: keeper ${MAINNET.keeper} holds 1 USDC`,
    "[arc-mainnet] WARNING backup keeper 0x75Af…4685 balance low: 0x75Af60E2165e8E6d2f6cFD5d9dDDa83446044685 holds 1.5 USDC",
  ]);
  assert.deepEqual(first.networks["arc-mainnet"].activeAlerts, ["balance", BACKUP_CHECK]);
  const keys = h.storage.sql.exec("SELECT alert_key FROM alerts ORDER BY alert_key").toArray().map((r) => r.alert_key);
  assert.deepEqual(keys, ["arc-mainnet:backup_balance:0x75af60e2165e8e6d2f6cfd5d9ddda83446044685", "arc-mainnet:balance"]);

  // Backup refilled, keeper still low: only the backup resolves.
  balances(1n * USDC, 20n * USDC);
  const second = await h.run(5);
  assert.deepEqual(second.networks["arc-mainnet"].messages, ["[arc-mainnet] RESOLVED backup keeper 0x75Af…4685 balance low after 5 min"]);
  assert.deepEqual(readAlerts(h.storage, "arc-mainnet").map((a) => a.check), ["balance"]);

  // Backup drained again: it alarms on its own; the keeper alarm is not repeated inside its 30 minutes.
  balances(1n * USDC, 5n * 10n ** 17n);
  const third = await h.run(10);
  assert.deepEqual(third.networks["arc-mainnet"].messages, [
    "[arc-mainnet] ALARM backup keeper 0x75Af…4685 balance low: 0x75Af60E2165e8E6d2f6cFD5d9dDDa83446044685 holds 0.5 USDC",
  ]);

  // Keeper refilled, backup still low: only the keeper resolves.
  balances(50n * USDC, 5n * 10n ** 17n);
  const fourth = await h.run(12);
  assert.deepEqual(fourth.networks["arc-mainnet"].messages, ["[arc-mainnet] RESOLVED keeper balance low after 12 min"]);
  assert.deepEqual(fourth.networks["arc-mainnet"].activeAlerts, [BACKUP_CHECK]);

  // Backup balance unknown this run: its alert is kept as it is, neither resolved nor repeated.
  h.state.reads["arc-mainnet"] = healthyRead(MAINNET, { backupBalances: [{ address: BACKUP, balanceWei: null }] });
  const fifth = await h.run(45);
  assert.deepEqual(fifth.networks["arc-mainnet"].messages, []);
  assert.deepEqual(fifth.networks["arc-mainnet"].activeAlerts, [BACKUP_CHECK]);
  assert.equal(readChainState(h.storage, "arc-mainnet").backupBalances[BACKUP.toLowerCase()], (5n * 10n ** 17n).toString(), "last known balance kept");
});

test("a backup wallet removed from the configuration resolves its alert and leaves the status", async () => {
  const h = harness();
  h.state.reads["arc-mainnet"] = healthyRead(MAINNET, { backupBalances: [{ address: BACKUP, balanceWei: 1n }] });
  await h.run(0);
  assert.equal(readAlerts(h.storage, "arc-mainnet")[0].check, BACKUP_CHECK);

  const withoutBackup = { ...MAINNET, backupKeepers: [] };
  h.state.networks = { "arc-mainnet": withoutBackup, "arc-testnet": TESTNET };
  h.state.reads["arc-mainnet"] = healthyRead(withoutBackup);
  const summary = await h.run(3);
  assert.deepEqual(summary.networks["arc-mainnet"].messages, ["[arc-mainnet] RESOLVED backup keeper 0x75Af…4685 balance low after 3 min"]);
  assert.equal(readAlerts(h.storage, "arc-mainnet").length, 0);
  assert.deepEqual(readChainState(h.storage, "arc-mainnet").backupBalances, {});
});

test("status JSON and HTML show backup keeper balances next to the keeper's", async () => {
  const h = harness();
  h.state.reads["arc-mainnet"] = healthyRead(MAINNET, { balanceWei: 7n * USDC, backupBalances: [{ address: BACKUP, balanceWei: 125n * 10n ** 17n }] });
  await h.run(0);
  const status = buildStatus(h.storage, TELEGRAM, T0 + 5);
  const m = status.networks["arc-mainnet"];
  assert.deepEqual(m.backupKeepers, [BACKUP]);
  assert.equal(m.chain.keeperBalanceUsdc, "7");
  assert.deepEqual(m.chain.backupKeeperBalances, [{ address: BACKUP, balanceUsdc: "12.5" }]);
  assert.deepEqual(status.networks["arc-testnet"].chain.backupKeeperBalances, [{ address: TESTNET.backupKeepers[0], balanceUsdc: "50" }]);
  const text = pageText(renderHtml(status));
  assert.ok(text.includes("Keeper balance 7 USDC"));
  assert.ok(text.includes("Backup keepers 0x75Af…4685 12.5 USDC"));
  assert.ok(text.includes("Backup keepers 0xbb2f…27Ee 50 USDC"));

  // A failed read keeps the last known balance; a wallet never read shows as unknown.
  h.state.reads["arc-mainnet"] = { ok: false, complete: false, error: "http 429", errors: [], subrequests: 2 };
  await h.run(1);
  assert.deepEqual(buildStatus(h.storage, TELEGRAM, T0 + 65).networks["arc-mainnet"].chain.backupKeeperBalances, [{ address: BACKUP, balanceUsdc: "12.5" }]);
  const added = "0x00000000000000000000000000000000000000c4";
  const later = buildStatus(h.storage, TELEGRAM, T0 + 65, [], { "arc-mainnet": { ...MAINNET, backupKeepers: [BACKUP, added] } });
  assert.deepEqual(later.networks["arc-mainnet"].chain.backupKeeperBalances, [
    { address: BACKUP, balanceUsdc: "12.5" },
    { address: added, balanceUsdc: null },
  ]);
  assert.ok(pageText(renderHtml(later)).includes("Backup keepers 0x75Af…4685 12.5 USDC 0x0000…00c4 unknown"));
});

test("a network without backup keepers: no backup checks, empty status lists, no HTML rows", async () => {
  const h = harness();
  const bare = { ...TESTNET, backupKeepers: [] };
  h.state.networks = { "arc-testnet": bare };
  h.state.reads["arc-testnet"] = healthyRead(bare, { balanceWei: 1n });
  const summary = await h.run(0);
  assert.deepEqual(summary.networks["arc-testnet"].activeAlerts, ["balance"]);
  assert.deepEqual(readChainState(h.storage, "arc-testnet").backupBalances, {});
  const status = buildStatus(h.storage, TELEGRAM, T0 + 5, [], h.state.networks);
  assert.deepEqual(Object.keys(status.networks), ["arc-testnet"]);
  assert.deepEqual(status.networks["arc-testnet"].backupKeepers, []);
  assert.deepEqual(status.networks["arc-testnet"].chain.backupKeeperBalances, []);
  const text = pageText(renderHtml(status));
  assert.ok(!text.includes("Backup keeper"));
  assert.ok(!text.includes("0xbb2f…27Ee"));
});

test("migrate adds the backup balance column to an existing chain_state table in place", () => {
  const storage = memoryStorage();
  // The chain_state table as first deployed, with a stored row.
  storage.db.exec("DROP TABLE chain_state");
  storage.db.exec(`CREATE TABLE chain_state (
     network TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, ok INTEGER NOT NULL, complete INTEGER NOT NULL, error TEXT,
     rpc TEXT, consecutive_failures INTEGER NOT NULL, last_success_at INTEGER, block_number INTEGER,
     block_timestamp INTEGER, base_fee_wei TEXT, balance_wei TEXT, next_request_id TEXT, pending_count INTEGER,
     oldest_pending_id TEXT, oldest_pending_age INTEGER, committer TEXT, coordinator_impl TEXT, registry_impl TEXT,
     log_cursor INTEGER, log_span INTEGER
   ) WITHOUT ROWID`);
  storage.db.exec("INSERT INTO chain_state (network, checked_at, ok, complete, consecutive_failures, balance_wei, log_cursor) VALUES ('arc-mainnet', 1, 1, 1, 0, '7', 42)");
  migrate(storage);
  migrate(storage); // idempotent
  const columns = storage.db.prepare("PRAGMA table_info(chain_state)").all().map((c) => c.name);
  assert.equal(columns.filter((name) => name === "backup_balances_json").length, 1);
  assert.equal(columns.filter((name) => name === "agent_relayer_balance_wei").length, 1);
  const kept = readChainState(storage, "arc-mainnet");
  assert.equal(kept.balanceWei, "7");
  assert.equal(kept.logCursor, 42);
  assert.deepEqual(kept.backupBalances, {});
  assert.equal(kept.agentRelayerBalanceWei, null);
});

/** Store a report on the backup (follower) stream, observed and received at `at`. */
const backupReport = (h, network, at, overrides = {}) =>
  ingestReport(h.storage, record(network, { receivedAt: at, observedAt: at, healthObservedAt: at, role: "follower", ...overrides }), BACKUP_STREAM);
const keeperReport = (h, network, at, overrides = {}) =>
  ingestReport(h.storage, record(network, { receivedAt: at, observedAt: at, healthObservedAt: at, ...overrides }));

test("backup keeper heartbeat: warning, alarm and resolution, independent of the keeper's", async () => {
  const env = { ...TELEGRAM, TELEGRAM_CHAT_ID_ARC_TESTNET: "-100testnet" };
  const h = harness(env);
  const texts = () => h.state.telegram.flatMap((m) => m.text.split("\n\n"));
  keeperReport(h, "arc-testnet", T0);
  backupReport(h, "arc-testnet", T0);
  await h.run(1);
  // The keeper keeps reporting; its backup goes silent.
  for (const minute of [2, 3, 4]) {
    keeperReport(h, "arc-testnet", T0 + minute * 60);
    await h.run(minute);
  }
  backupReport(h, "arc-testnet", T0 + 5 * 60);
  keeperReport(h, "arc-testnet", T0 + 5 * 60);
  await h.run(5);
  // Now the keeper goes silent while its backup reports: the backup's reports never stand in for the keeper's.
  for (const minute of [6, 7, 8]) {
    backupReport(h, "arc-testnet", T0 + minute * 60);
    await h.run(minute);
  }
  assert.deepEqual(texts(), [
    "[arc-testnet] WARNING backup keeper heartbeat missing: last report 3m ago",
    "[arc-testnet] ALARM backup keeper heartbeat missing: last report 4m ago",
    "[arc-testnet] RESOLVED backup keeper heartbeat missing after 2 min",
    "[arc-testnet] WARNING heartbeat missing: last report 3m ago",
  ]);
  assert.ok(h.state.telegram.every((m) => m.chat_id === "-100testnet"), "routed to the network's own chat");
  assert.deepEqual(readAlerts(h.storage, "arc-testnet").map((a) => a.check), ["heartbeat"]);
  assert.deepEqual(readAlerts(h.storage, "arc-mainnet"), [], "the other network never reported a backup: nothing raised");
});

test("backup unhealthy and wrong role alarm on their own; the keeper's state and alerts are untouched", async () => {
  const h = harness();
  // Today's incident: a follower stuck on preparation_stalled while the primary is healthy.
  for (let i = 0; i <= 12; i++) {
    const at = T0 + i * 30;
    keeperReport(h, "arc-testnet", at);
    backupReport(h, "arc-testnet", at, { healthy: false, faults: ["preparation_stalled"] });
    if (i % 2 === 0) await h.run(i / 2);
  }
  assert.deepEqual(h.state.telegram.map((m) => m.text), [
    "[arc-testnet] WARNING backup keeper unhealthy: faults: preparation_stalled",
    "[arc-testnet] ALARM backup keeper unhealthy: faults: preparation_stalled (for 5m)",
  ]);
  const keeper = readReportState(h.storage, "arc-testnet");
  assert.equal(keeper.healthy, true);
  assert.equal(keeper.unhealthySince, null);
  assert.deepEqual(keeper.faults, []);
  assert.deepEqual([keeper.duplicatesSeen, keeper.conflictsSeen], [0, 0]);
  assert.equal(readBackupReportState(h.storage, "arc-testnet").unhealthySince, T0);

  // A report on the backup route that says primary.
  backupReport(h, "arc-testnet", T0 + 7 * 60, { role: "primary" });
  keeperReport(h, "arc-testnet", T0 + 7 * 60);
  const wrong = await h.run(7);
  assert.deepEqual(wrong.networks["arc-testnet"].messages, [
    "[arc-testnet] RESOLVED backup keeper unhealthy after 7 min",
    "[arc-testnet] ALARM backup keeper not a follower: reports role primary",
  ]);
  assert.deepEqual(wrong.networks["arc-testnet"].activeAlerts, ["backup_role"]);

  backupReport(h, "arc-testnet", T0 + 8 * 60);
  keeperReport(h, "arc-testnet", T0 + 8 * 60);
  const fixed = await h.run(8);
  assert.deepEqual(fixed.networks["arc-testnet"].messages, ["[arc-testnet] RESOLVED backup keeper not a follower after 1 min"]);
  assert.equal(readAlerts(h.storage, "arc-testnet").length, 0);
});

test("backup health alerts resolve when the network's backup keepers are removed from the configuration", async () => {
  const h = harness();
  backupReport(h, "arc-mainnet", T0, { healthy: false, faults: ["tick_failed"] });
  await h.run(10);
  assert.deepEqual(readAlerts(h.storage, "arc-mainnet").map((a) => a.check).sort(), ["backup_heartbeat", "backup_unhealthy"]);
  const withoutBackup = { ...MAINNET, backupKeepers: [] };
  h.state.networks = { "arc-mainnet": withoutBackup, "arc-testnet": TESTNET };
  h.state.reads["arc-mainnet"] = healthyRead(withoutBackup);
  const summary = await h.run(11);
  assert.deepEqual(summary.networks["arc-mainnet"].messages, [
    "[arc-mainnet] RESOLVED backup keeper heartbeat missing after 1 min",
    "[arc-mainnet] RESOLVED backup keeper unhealthy after 1 min",
  ]);
});

test("status JSON and HTML show backup keeper health next to its balance", async () => {
  const h = harness();
  h.state.reads["arc-mainnet"] = healthyRead(MAINNET, { backupBalances: [{ address: BACKUP, balanceWei: 125n * 10n ** 17n }] });
  await h.run(0);
  let status = buildStatus(h.storage, TELEGRAM, T0 + 5);
  assert.deepEqual(status.networks["arc-mainnet"].backupReport, { everReported: false });
  assert.deepEqual(status.networks["arc-testnet"].backupReport, { everReported: false });
  let text = pageText(renderHtml(status));
  assert.ok(text.includes("Backup keepers 0x75Af…4685 12.5 USDC Health Not reporting"));
  assert.ok(text.includes("Backup keepers 0xbb2f…27Ee 50 USDC Health Not reporting"));
  assert.equal(status.networks["arc-testnet"].alerts.length, 0, "not reporting raises nothing");

  keeperReport(h, "arc-testnet", T0 - 20);
  backupReport(h, "arc-testnet", T0 - 20, { healthy: false, faults: ["preparation_stalled"], reportId: "backup-report-1" });
  await h.run(0);
  status = buildStatus(h.storage, TELEGRAM, T0 + 5);
  const t = status.networks["arc-testnet"];
  // The same published fields as the keeper's report, plus its role.
  assert.deepEqual(Object.keys(t.backupReport), [...Object.keys(t.report), "role"]);
  assert.equal(t.backupReport.lastReceivedAgeSeconds, 25);
  assert.equal(t.backupReport.healthy, false);
  assert.deepEqual(t.backupReport.faults, ["preparation_stalled"]);
  assert.equal(t.backupReport.role, "follower");
  assert.equal(t.backupReport.conflictingDeliveries, 0);
  assert.equal(t.report.healthy, true);
  assert.ok(!JSON.stringify(status).includes("backup-report-1"), "no report ids");
  assert.deepEqual(t.alerts.map((a) => a.check), ["backup_unhealthy"]);
  text = pageText(renderHtml(status));
  assert.ok(text.includes("Keeper Healthy"));
  assert.ok(text.includes("Backup keepers 0xbb2f…27Ee 50 USDC Health Unhealthy Last report 25s ago Faults preparation_stalled Role follower"));
  assert.ok(text.includes("WARNING backup keeper unhealthy faults: preparation_stalled"));

  backupReport(h, "arc-testnet", T0, { role: "primary" });
  const html = renderHtml(buildStatus(h.storage, TELEGRAM, T0 + 5));
  assert.ok(html.includes(`<th scope="row">Role</th><td class="alarm">primary</td>`));
  assert.ok(html.includes(`<th scope="row">Health</th><td class="ok">Healthy</td>`));
});

test("migrate adds the role column and the backup tables to an existing database in place", () => {
  const storage = memoryStorage();
  // The report tables as deployed before backup reporting, with a stored row.
  for (const table of ["report_state", "backup_report_state", "backup_reports"]) storage.db.exec(`DROP TABLE ${table}`);
  storage.db.exec(`CREATE TABLE report_state (
     network TEXT PRIMARY KEY, first_received_at INTEGER NOT NULL, last_received_at INTEGER NOT NULL,
     last_report_id TEXT NOT NULL, report_observed_at INTEGER NOT NULL, health_observed_at INTEGER,
     healthy INTEGER NOT NULL, send_enabled INTEGER, faults_json TEXT NOT NULL, node_id TEXT NOT NULL,
     dropped_total INTEGER NOT NULL, dropped_alerted_total INTEGER NOT NULL, failed_last_json TEXT NOT NULL,
     failed_totals_json TEXT NOT NULL, unhealthy_since INTEGER, reports_stored INTEGER NOT NULL,
     duplicates_seen INTEGER NOT NULL, conflicts_seen INTEGER NOT NULL
   ) WITHOUT ROWID`);
  storage.db.exec(`INSERT INTO report_state VALUES ('arc-mainnet', 1, 2, 'r', 2, 2, 1, 1, '[]', '0xab', 0, 0, '{}', '{}', NULL, 9, 1, 0)`);
  migrate(storage);
  migrate(storage); // idempotent
  const columns = storage.db.prepare("PRAGMA table_info(report_state)").all().map((c) => c.name);
  assert.equal(columns.filter((name) => name === "role").length, 1);
  const kept = readReportState(storage, "arc-mainnet");
  assert.deepEqual([kept.lastReceivedAt, kept.reportsStored, kept.duplicatesSeen, kept.role], [2, 9, 1, null]);
  const objects = storage.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'backup_report%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(objects, ["backup_report_state", "backup_reports", "backup_reports_by_received_at"]);
  assert.equal(readBackupReportState(storage, "arc-mainnet"), null);
  assert.equal(ingestReport(storage, record("arc-mainnet", { role: "follower" }), BACKUP_STREAM), "stored");
  assert.equal(readBackupReportState(storage, "arc-mainnet").role, "follower");
  assert.equal(readReportState(storage, "arc-mainnet").reportsStored, 9);
});

test("backup report ids are pruned after 3 days, like the keeper's", async () => {
  const h = harness();
  backupReport(h, "arc-mainnet", T0 - 3 * 86400 - 1, { reportId: "old" });
  backupReport(h, "arc-mainnet", T0 - 60, { reportId: "new" });
  await h.run(0);
  const ids = h.storage.sql.exec("SELECT report_id FROM backup_reports ORDER BY report_id").toArray().map((r) => r.report_id);
  assert.deepEqual(ids, ["new"]);
});

test("refund events alarm once per occurrence and auto-resolve silently", async () => {
  const h = harness();
  const refund = { requestId: 812n, refundAddress: "0x3333333333333333333333333333333333333333", amountWei: 10n ** 18n, paid: true };
  h.state.reads["arc-mainnet"] = healthyRead(MAINNET, { logs: { fromBlock: 1, toBlock: 2, refunds: [refund], foreignFulfillments: [] } });
  await h.run(0);
  assert.match(h.state.telegram[0].text, /^\[arc-mainnet\] ALARM refund issued, investigate: request 812/);
  assert.equal(buildStatus(h.storage, TELEGRAM, T0).networks["arc-mainnet"].alerts[0].check, "refund");
  h.state.reads["arc-mainnet"] = healthyRead(MAINNET);
  await h.run(1);
  assert.equal(h.state.telegram.length, 1);
  assert.equal(readAlerts(h.storage, "arc-mainnet").length, 0);
});

test("unhealthy streak escalates after 5 minutes of keeper-observed time; dropped events notice once", async () => {
  const h = harness();
  for (let i = 0; i <= 12; i++) {
    const at = T0 + i * 30;
    ingestReport(h.storage, record("arc-testnet", { receivedAt: at, observedAt: at, healthObservedAt: at, healthy: false, faults: ["settlement_stalled"], droppedTotal: i < 6 ? 0 : 2 }));
    if (i % 2 === 0) await h.run(i / 2);
  }
  const texts = h.state.telegram.map((m) => m.text);
  assert.deepEqual(texts, [
    "[arc-testnet] WARNING keeper unhealthy: faults: settlement_stalled",
    "[arc-testnet] WARNING keeper dropped audit events: droppedTotal rose by 2 to 2",
    "[arc-testnet] ALARM keeper unhealthy: faults: settlement_stalled (for 5m)",
  ]);
  assert.equal(readReportState(h.storage, "arc-testnet").droppedAlertedTotal, 2);
});

test("reports older than 3 days are pruned", async () => {
  const h = harness();
  ingestReport(h.storage, record("arc-mainnet", { reportId: "old", receivedAt: T0 - 3 * 86400 - 1, observedAt: T0 - 3 * 86400 - 1 }));
  ingestReport(h.storage, record("arc-mainnet", { reportId: "new", receivedAt: T0 - 60, observedAt: T0 - 60 }));
  await h.run(0);
  const ids = h.storage.sql.exec("SELECT report_id FROM reports ORDER BY report_id").toArray().map((r) => r.report_id);
  assert.deepEqual(ids, ["new"]);
});

test("status JSON and HTML are sanitized and escaped", async () => {
  const h = harness();
  ingestReport(h.storage, record("arc-testnet", { receivedAt: T0 - 20, observedAt: T0 - 21, healthObservedAt: null, healthy: false, faults: ["not_observed"], failedCounts: { expired: 2 } }));
  await h.run(0);
  const status = buildStatus(h.storage, TELEGRAM, T0 + 5);
  const text = JSON.stringify(status);
  assert.ok(!text.includes("throwaway-token"));
  assert.ok(!text.includes(TELEGRAM.TELEGRAM_CHAT_ID));
  assert.ok(!text.includes("bodySha256") && !text.includes("reportId"));
  const t = status.networks["arc-testnet"];
  assert.equal(t.report.observed, false);
  assert.equal(t.report.lastReceivedAgeSeconds, 25);
  assert.deepEqual(t.report.failedEventsTotal, { expired: 2 });
  assert.equal(t.chain.keeperBalanceUsdc, "50");
  assert.equal(t.chain.baseFeeGwei, "1");
  assert.equal(t.chain.feeCapUsagePercent, 3);
  assert.equal(t.chain.committerIsKeeper, true);
  assert.equal(status.networks["arc-mainnet"].report.everReported, false);

  status.networks["arc-testnet"].alerts.push({ severity: "warning", title: "<b>x</b>", detail: "\"&'", activeSeconds: 1 });
  const html = renderHtml(status);
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(html.includes("&quot;&amp;&#39;"));
  assert.ok(!html.includes("<b>x</b>"));
  assert.match(html, /<meta name="color-scheme" content="dark">/);
});

test("groupMessages respects size and send limits", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, text: "x".repeat(1000) }));
  const groups = groupMessages(messages, 2500, 3);
  assert.deepEqual(groups.map((g) => g.ids), [[1, 2], [3, 4], [5, 6]]);
  assert.ok(groups.every((g) => g.text.length <= 2500));
  assert.equal(groupMessages([{ id: 1, text: "y".repeat(5000) }], 3800, 3)[0].text.length, 3800);
});

test("each network's messages go to its own chat when one is configured", async () => {
  const { chatIdFor, sendTelegram } = await import("../src/telegram.js");
  const env = { ...TELEGRAM, TELEGRAM_CHAT_ID: "-100default", TELEGRAM_CHAT_ID_ARC_TESTNET: "-100testnet" };
  assert.equal(chatIdFor(env, "arc-testnet"), "-100testnet");
  assert.equal(chatIdFor(env, "arc-mainnet"), "-100default", "a network without its own chat uses the default");
  assert.equal(chatIdFor(env, "airnodehub"), "-100default");
  assert.equal(chatIdFor(env, null), "-100default");
  assert.equal(chatIdFor({ TELEGRAM_CHAT_ID: "  " }, "arc-testnet"), null, "blank chat ids do not count");

  const sent = [];
  const capture = async (url, init) => { sent.push(JSON.parse(init.body).chat_id); return { ok: true, status: 200 }; };
  await sendTelegram(env, "testnet alert", { fetch: capture, chatId: chatIdFor(env, "arc-testnet") });
  await sendTelegram(env, "mainnet alert", { fetch: capture, chatId: chatIdFor(env, "arc-mainnet") });
  assert.deepEqual(sent, ["-100testnet", "-100default"]);
});

test("sendTelegram never exposes the token in its result", async () => {
  const { sendTelegram } = await import("../src/telegram.js");
  const failing = async (url) => {
    throw new TypeError(`fetch failed for ${url}`);
  };
  const result = await sendTelegram(TELEGRAM, "hello", { fetch: failing });
  assert.deepEqual(result, { ok: false, error: "network error" });
  assert.ok(!JSON.stringify(result).includes("throwaway-token"));
});

// ---------------------------------------------------------------------------------------------
// x402 agent API

const TESTNET_RELAYER = TESTNET.agentApi.relayer;
const API_COUNTS = agentApiBody().counts;

test("agent API down: nothing on one failed poll, warning after 2, alarm after 5, resolved when it answers", async () => {
  const h = harness();
  await h.run(0);
  assert.deepEqual(h.state.polled, ["arc-testnet"], "only the watched agent API is polled");
  h.state.polls["arc-testnet"] = { ok: false, httpStatus: 522, latencyMs: 10, reason: "http 522" };
  await h.run(1);
  assert.equal(h.state.telegram.length, 0);
  for (let minute = 2; minute <= 4; minute++) await h.run(minute);
  h.state.polls["arc-testnet"] = new Error("boom"); // a poll that throws counts as failed too
  await h.run(5);
  delete h.state.polls["arc-testnet"];
  await h.run(6);
  assert.deepEqual(h.state.telegram.map((m) => m.text), [
    "[arc-testnet] WARNING agent API unreachable: https://api-testnet.d20dao.org/health failed 2 polls in a row (last: http 522)",
    "[arc-testnet] ALARM agent API unreachable: https://api-testnet.d20dao.org/health failed 5 polls in a row (last: internal error)",
    "[arc-testnet] RESOLVED agent API unreachable after 4 min",
  ]);
  assert.ok(h.state.telegram.every((m) => m.chat_id === TELEGRAM.TELEGRAM_CHAT_ID));
  assert.equal(readAlerts(h.storage, "arc-testnet").length, 0);
});

test("a refund owed alarms with what to do, stays put while the API is down, and resolves once handled", async () => {
  const h = harness();
  h.state.polls["arc-testnet"] = agentApiPoll({ ok: false, counts: { ...API_COUNTS, refundDue: 1 } });
  await h.run(0);
  assert.deepEqual(h.state.telegram.map((m) => m.text), [
    "[arc-testnet] ALARM agent API refund owed: 1 paid call could not be served and its payer is owed a refund. " +
      "Refund each payer by hand, then mark it handled in the agent API's operator refund list; this clears when none is left",
  ]);
  h.state.polls["arc-testnet"] = { ok: false, httpStatus: null, latencyMs: 10000, reason: "timeout" };
  await h.run(1);
  assert.equal(h.state.telegram.length, 1, "unknown while the API is down: no repeat, no resolution");
  assert.deepEqual(readAlerts(h.storage, "arc-testnet").map((a) => a.check), ["agent_api_refund_due"]);
  h.state.polls["arc-testnet"] = agentApiPoll({ counts: { ...API_COUNTS, refundHandled: 1 } });
  await h.run(2);
  assert.equal(h.state.telegram.at(-1).text, "[arc-testnet] RESOLVED agent API refund owed after 2 min");
});

test("the relayer balance is read on chain: one warning while low, even with the API down; resolved when topped up", async () => {
  const h = harness();
  h.state.reads["arc-testnet"] = healthyRead(TESTNET, { agentRelayerBalanceWei: 388995233348750000n });
  h.state.polls["arc-testnet"] = { ok: false, httpStatus: null, latencyMs: 10, reason: "network error" };
  await h.run(0);
  delete h.state.polls["arc-testnet"];
  for (let minute = 1; minute < 40; minute++) await h.run(minute);
  assert.deepEqual(h.state.telegram.map((m) => m.text), [
    `[arc-testnet] WARNING agent API relayer balance low: relayer ${TESTNET_RELAYER} holds 0.388995 USDC (warning below 1, alarm below 0.36); top it up before sales stop at 3 calls' cost`,
  ]);
  assert.equal(readChainState(h.storage, "arc-testnet").agentRelayerBalanceWei, "388995233348750000");
  // A failed chain read keeps the stored balance and the alert.
  h.state.reads["arc-testnet"] = { ok: false, complete: false, error: "timeout", errors: [], subrequests: 2 };
  await h.run(40);
  assert.equal(readChainState(h.storage, "arc-testnet").agentRelayerBalanceWei, "388995233348750000");
  h.state.reads["arc-testnet"] = healthyRead(TESTNET, { agentRelayerBalanceWei: 5n * USDC });
  await h.run(41);
  assert.equal(h.state.telegram.at(-1).text, "[arc-testnet] RESOLVED agent API relayer balance low after 41 min");
});

test("mainnet's agent API is off: not polled, not read, no checks, no section; the enabled flag turns it on", async () => {
  const h = harness();
  const summary = await h.run(0);
  assert.equal(summary.networks["arc-mainnet"].agentApi, null);
  assert.equal(summary.networks["arc-testnet"].agentApi.reachable, true);
  assert.equal(summary.subrequests, 2 + 2 + 1, "two chain batches per network and one /health poll");
  let status = buildStatus(h.storage, TELEGRAM, T0 + 5);
  assert.deepEqual(status.networks["arc-mainnet"].agentApi, { enabled: false });
  assert.ok(!pageText(renderHtml(status)).includes("Agent API · arc-mainnet"));

  const live = { ...MAINNET, agentApi: { ...MAINNET.agentApi, enabled: true } };
  h.state.networks = { "arc-mainnet": live, "arc-testnet": TESTNET };
  h.state.reads["arc-mainnet"] = healthyRead(live, { agentRelayerBalanceWei: 3n * USDC });
  await h.run(1);
  assert.deepEqual(h.state.polled, ["arc-testnet", "arc-mainnet", "arc-testnet"]);
  assert.deepEqual(h.state.telegram.map((m) => m.text), [
    "[arc-mainnet] WARNING agent API relayer balance low: relayer 0x8B465645ed88F6d487d279003aD3681e7aF8e8B7 holds 3 USDC (warning below 4, alarm below 1); top it up before sales stop at 3 calls' cost",
  ]);
  status = buildStatus(h.storage, TELEGRAM, T0 + 65, [], h.state.networks);
  assert.equal(status.networks["arc-mainnet"].agentApi.url, "https://api.d20dao.org");
  assert.ok(pageText(renderHtml(status)).includes("Agent API · arc-mainnet"));

  // Switched off again: its alerts resolve and it is no longer polled.
  h.state.networks = { "arc-mainnet": MAINNET, "arc-testnet": TESTNET };
  await h.run(2);
  assert.equal(h.state.telegram.at(-1).text, "[arc-mainnet] RESOLVED agent API relayer balance low after 1 min");
  assert.deepEqual(h.state.polled.slice(3), ["arc-testnet"]);
});

test("status JSON and HTML: the Agent API section shows the figures and its own alerts, never payers or payment ids", async () => {
  const h = harness();
  const body = agentApiBody({
    ok: false,
    counts: { ...API_COUNTS, refundDue: 2, refundHandled: 1 },
    inDoubt: { count: 1, overdue: 0, oldestSeconds: 90 },
    breaker: { state: "open", failures: 3, attempts: 3, openForSeconds: 42 },
    payer: "0x1234567890abcdef1234567890abcdef12345678",
    refunds: [{ paymentId: "0x" + "ab".repeat(32), payer: "0x1234567890abcdef1234567890abcdef12345678" }],
  });
  h.state.polls["arc-testnet"] = await readAgentApi(TESTNET, { fetch: async () => new Response(JSON.stringify(body), { status: 503 }) });
  h.state.reads["arc-testnet"] = healthyRead(TESTNET, { agentRelayerBalanceWei: 388995233348750000n });
  await h.run(0);
  const status = buildStatus(h.storage, TELEGRAM, T0 + 5);
  const a = status.networks["arc-testnet"].agentApi;
  assert.equal(a.status, "not ok");
  assert.equal(a.httpStatus, 503);
  assert.equal(a.relayerBalanceUsdc, "0.388995");
  assert.equal(a.relayerWarnBelowUsdc, "1");
  assert.equal(a.relayerAlarmBelowUsdc, "0.36");
  assert.equal(a.health.refundsOwed, 2);
  assert.equal(a.health.refundsHandled, 1);
  assert.deepEqual(a.alerts.map((x) => x.check).sort(), ["agent_api_breaker", "agent_api_refund_due", "agent_api_relayer_balance"]);
  assert.ok(!status.networks["arc-testnet"].alerts.some((x) => x.check.startsWith("agent_api")), "listed under agentApi only");
  const json = JSON.stringify(status);
  assert.ok(!json.includes("0x1234") && !json.includes("abab"), "no payer or payment id");

  const html = renderHtml(status);
  assert.ok(!html.includes("0x1234") && !html.includes("abab"));
  const text = pageText(html);
  assert.ok(text.includes("Agent API · arc-testnet ALARM"));
  assert.match(text, /API Not OK checked 5s ago/);
  assert.ok(text.includes("Relayer balance 0.388995 USDC warning below 1 · alarm below 0.36"));
  assert.ok(text.includes("Refunds owed 2 1 handled"));
  assert.ok(text.includes("In-doubt payments 1 oldest 1m 30s"));
  assert.ok(text.includes("Reports ok no Relayer funded yes Sender ok Settlement breaker open, 42s left Delivery breaker closed"));
  assert.ok(text.includes("Wallet 0xF6b4…05C3 Calls in progress 0 Relayer alarm 1m 59s ago"));
  assert.match(html, /<p class="pill alarm">/);
});

test("migrate creates the agent API state table on an existing database", () => {
  const storage = memoryStorage();
  storage.db.exec("DROP TABLE agent_api_state");
  migrate(storage);
  const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  assert.ok(tables.includes("agent_api_state"));
});
