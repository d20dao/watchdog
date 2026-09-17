// One watchdog run: read both chains (network I/O, no storage held), then evaluate and commit
// every state change in one synchronous transaction, then deliver queued Telegram messages.

import { alertKey, transition } from "./alerts.js";
import { CHECK_NAMES, evaluateChainChecks, evaluateReportChecks, evaluateRpcCheck } from "./checks.js";
import { LIMITS, NETWORKS, NETWORK_NAMES } from "./config.js";
import { readChain } from "./rpc.js";
import {
  enqueueMessage,
  expireMessages,
  markDroppedAlerted,
  markMessages,
  pendingMessages,
  pruneMessages,
  pruneReports,
  readAlerts,
  readChainState,
  readReportState,
  saveAlert,
  writeChainState,
} from "./store.js";
import { groupMessages, notifierConfigured, sendTelegram } from "./telegram.js";

export async function runCron({ storage, env, fetch, clock = () => Date.now(), readChainImpl = readChain }) {
  const cursors = NETWORK_NAMES.map((name) => {
    const prev = readChainState(storage, name);
    return prev ? { logCursor: prev.logCursor, logSpan: prev.logSpan } : null;
  });

  const reads = await Promise.all(
    NETWORK_NAMES.map(async (name, i) => {
      try {
        return await readChainImpl(NETWORKS[name], cursors[i], { fetch });
      } catch {
        return { ok: false, complete: false, error: "internal error", errors: [], subrequests: 0 };
      }
    }),
  );

  // Reports may have arrived while the reads were in flight; everything below re-reads current state.
  const now = Math.floor(clock() / 1000);
  const deliverable = notifierConfigured(env);
  const outcome = storage.transactionSync(() => {
    const networks = {};
    let enqueued = 0;
    NETWORK_NAMES.forEach((name, i) => {
      const net = NETWORKS[name];
      const read = reads[i];
      const failures = writeChainState(storage, name, now, read, readChainState(storage, name));
      const report = readReportState(storage, name);
      const conditions = {
        ...evaluateReportChecks(net, report, now),
        ...evaluateChainChecks(net, read),
        rpc: evaluateRpcCheck(failures, read.error),
      };
      const existing = new Map(readAlerts(storage, name).map((row) => [row.check, row]));
      const messages = [];
      for (const check of CHECK_NAMES) {
        const step = transition(existing.get(check) ?? null, conditions[check], now, name, check);
        if (step.write) saveAlert(storage, alertKey(name, check), step.row);
        if (step.message) {
          enqueueMessage(storage, now, name, step.message.severity, step.message.text, deliverable);
          messages.push(step.message.text);
          enqueued++;
        }
      }
      if (report && conditions.dropped_events) markDroppedAlerted(storage, name, report.droppedTotal);
      networks[name] = {
        chain: read.ok ? (read.complete ? "ok" : "partial") : "failed",
        error: read.error ?? null,
        rpc: read.rpc ?? null,
        subrequests: read.subrequests ?? 0,
        block: read.block?.number ?? null,
        pending: read.pending ? read.pending.count : null,
        oldestPendingAge: read.pending?.oldest?.ageSeconds ?? null,
        logs: read.logs ? { from: read.logs.fromBlock, to: read.logs.toBlock, refunds: read.logs.refunds.length, foreign: read.logs.foreignFulfillments.length } : null,
        activeAlerts: [...CHECK_NAMES].filter((check) => conditions[check] || (conditions[check] === undefined && existing.has(check))),
        messages,
      };
    });
    pruneReports(storage, now - LIMITS.reportRetentionSeconds);
    expireMessages(storage, now);
    if (enqueued > 0) pruneMessages(storage);
    return { networks, enqueued };
  });

  let delivered = 0;
  let telegramSubrequests = 0;
  let deliveryError = null;
  if (deliverable) {
    for (const group of groupMessages(pendingMessages(storage))) {
      telegramSubrequests++;
      const result = await sendTelegram(env, group.text, { fetch });
      const at = Math.floor(clock() / 1000);
      storage.transactionSync(() => markMessages(storage, group.ids, at, result.ok));
      if (!result.ok) {
        deliveryError = result.error;
        break;
      }
      delivered += group.ids.length;
    }
  }

  const chainSubrequests = Object.values(outcome.networks).reduce((sum, n) => sum + n.subrequests, 0);
  return {
    at: now,
    notifier: deliverable ? "configured" : "not configured",
    networks: outcome.networks,
    messagesQueued: outcome.enqueued,
    messagesDelivered: delivered,
    deliveryError,
    subrequests: chainSubrequests + telegramSubrequests,
  };
}
