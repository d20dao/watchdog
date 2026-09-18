import assert from "node:assert/strict";
import { test } from "node:test";
import { runCron } from "../src/cron.js";
import { buildStatus, renderHtml } from "../src/status.js";
import { ingestReport, migrate, readAlerts, readChainState, readReportState, recentMessages } from "../src/store.js";
import { groupMessages } from "../src/telegram.js";
import { MAINNET, TESTNET, healthyRead, memoryStorage, pageText } from "./helpers.js";

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
  const kept = readChainState(storage, "arc-mainnet");
  assert.equal(kept.balanceWei, "7");
  assert.equal(kept.logCursor, 42);
  assert.deepEqual(kept.backupBalances, {});
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
