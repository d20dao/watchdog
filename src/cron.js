// One watchdog run: read both chains, poll each watched x402 agent API and read the drand beacon's relays and registries
// (network I/O, no storage held), then evaluate and commit every state change in one synchronous transaction, then deliver
// queued Telegram messages.

import { applyAgentApiPoll, readAgentApi } from "./agentapi.js";
import { alertKey, transition } from "./alerts.js";
import {
  applyGroupRun,
  applyNetworkRun,
  applyRelayRun,
  failedBeaconRun,
  groupStateKey,
  infoPhase,
  networkStateKey,
  planBeacon,
  runBeacon,
} from "./beacon.js";
import {
  BEACON_MONITOR_CHECK,
  beaconMonitorFailure,
  evaluateAgentApiChecks,
  evaluateBackupReportChecks,
  evaluateBeaconChecks,
  evaluateChainChecks,
  evaluateReportChecks,
  evaluateRpcCheck,
  networkCheckNames,
} from "./checks.js";
import { BEACON_SCOPE, LIMITS, NETWORKS, watchedAgentApi } from "./config.js";
import { readChain } from "./rpc.js";
import {
  deleteBeaconState,
  enqueueMessage,
  expireMessages,
  markDroppedAlerted,
  markMessages,
  pendingMessages,
  pruneMessages,
  pruneReports,
  readAgentApiState,
  readAlerts,
  readBackupReportState,
  readBeaconStates,
  readChainState,
  readReportState,
  saveAlert,
  writeAgentApiState,
  writeBeaconState,
  writeChainState,
} from "./store.js";
import { chatIdFor, groupMessages, notifierConfigured, sendTelegram } from "./telegram.js";

/**
 * The beacon's plan. A configuration or stored state it cannot plan from leaves the run without the beacon (`failed`), never
 * without the rest of the run.
 */
function planBeaconChecks(nets, storage, nowSec) {
  try {
    return planBeacon(nets, readBeaconStates(storage), nowSec);
  } catch {
    return { groups: [], failed: true };
  }
}

/**
 * Run the beacon plan. The run never throws, and a monitor that failed as a whole leaves every relay unknown, not down.
 * `headOf(name)` is a network's head block from this run's chain read.
 */
async function runBeaconChecks(plan, { fetch, clock, runBeaconImpl, headOf }) {
  if (plan.groups.length === 0) return { subrequests: 0, groups: [] };
  try {
    return await runBeaconImpl(plan, { fetch, clock, headOf });
  } catch {
    return failedBeaconRun(plan, "internal error");
  }
}

export async function runCron({
  storage,
  env,
  fetch,
  clock = () => Date.now(),
  readChainImpl = readChain,
  readAgentApiImpl = readAgentApi,
  runBeaconImpl = runBeacon,
  networks: nets = NETWORKS,
}) {
  const names = Object.keys(nets);
  const cursors = names.map((name) => {
    const prev = readChainState(storage, name);
    return prev ? { logCursor: prev.logCursor, logSpan: prev.logSpan } : null;
  });
  const beaconPlan = planBeaconChecks(nets, storage, Math.floor(clock() / 1000));

  // Every chain read starts at once. The beacon's registry batch needs its network's head block and waits for that read only
  // when the beacon's relay steps have finished before it.
  const chainReads = names.map(async (name, i) => {
    try {
      return await readChainImpl(nets[name], cursors[i], { fetch });
    } catch {
      return { ok: false, complete: false, error: "internal error", errors: [], subrequests: 0 };
    }
  });
  const headOf = async (name) => {
    const read = await chainReads[names.indexOf(name)];
    return read?.ok && read.block ? read.block.number : null;
  };

  const [reads, polls, beaconRun] = await Promise.all([
    Promise.all(chainReads),
    // One /health GET per watched agent API; null for a network whose agent API is not watched.
    Promise.all(
      names.map(async (name) => {
        if (!watchedAgentApi(nets[name])) return null;
        try {
          return await readAgentApiImpl(nets[name], { fetch, clock });
        } catch {
          return { ok: false, httpStatus: null, latencyMs: null, reason: "internal error" };
        }
      }),
    ),
    // The drand relays and each network's registry: shared work, read once however many networks list the beacon.
    runBeaconChecks(beaconPlan, { fetch, clock, runBeaconImpl, headOf }),
  ]);

  // Reports may have arrived while the reads were in flight; everything below re-reads current state.
  const now = Math.floor(clock() / 1000);
  const deliverable = notifierConfigured(env);
  const outcome = storage.transactionSync(() => {
    const networks = {};
    let enqueued = 0;
    names.forEach((name, i) => {
      const net = nets[name];
      const read = reads[i];
      const failures = writeChainState(storage, name, now, read, readChainState(storage, name));
      const report = readReportState(storage, name);
      let agentApi = null;
      if (polls[i]) {
        agentApi = applyAgentApiPoll(readAgentApiState(storage, name), polls[i], now);
        writeAgentApiState(storage, name, now, agentApi);
      }
      const conditions = {
        ...evaluateReportChecks(net, report, now),
        ...evaluateBackupReportChecks(net, readBackupReportState(storage, name), now),
        ...evaluateChainChecks(net, read),
        rpc: evaluateRpcCheck(failures, read.error),
        ...evaluateAgentApiChecks(net, agentApi, read),
      };
      const existing = new Map(readAlerts(storage, name).map((row) => [row.check, row]));
      const checks = networkCheckNames(net);
      // A check no longer configured (a backup keeper wallet removed from the configuration) resolves its alert.
      for (const check of existing.keys()) {
        if (!checks.includes(check)) {
          checks.push(check);
          conditions[check] = null;
        }
      }
      const messages = [];
      for (const check of checks) {
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
        agentApi: agentApi
          ? {
              reachable: agentApi.reachable,
              ok: agentApi.reachable ? agentApi.health.ok : null,
              httpStatus: agentApi.httpStatus,
              reason: agentApi.reason,
              latencyMs: agentApi.latencyMs,
              relayerBalanceWei: read.agentRelayerBalanceWei == null ? null : read.agentRelayerBalanceWei.toString(),
            }
          : null,
        activeAlerts: checks.filter((check) => conditions[check] || (conditions[check] === undefined && existing.has(check))),
        messages,
      };
    });
    const beacon = commitBeacon(storage, beaconPlan, beaconRun, now, deliverable);
    enqueued += beacon.messages.length;
    pruneReports(storage, now - LIMITS.reportRetentionSeconds);
    expireMessages(storage, now);
    if (enqueued > 0) pruneMessages(storage);
    return { networks, beacon, enqueued };
  });

  let delivered = 0;
  let telegramSubrequests = 0;
  let deliveryError = null;
  if (deliverable) {
    // Messages are grouped per destination chat, so a network with its own group never lands in another one.
    const byChat = new Map();
    for (const message of pendingMessages(storage)) {
      const chatId = chatIdFor(env, message.network);
      if (!byChat.has(chatId)) byChat.set(chatId, []);
      byChat.get(chatId).push(message);
    }
    const groups = [];
    for (const [chatId, messages] of byChat) for (const group of groupMessages(messages)) groups.push({ ...group, chatId });
    for (const group of groups.slice(0, LIMITS.telegramMaxSendsPerRun)) {
      telegramSubrequests++;
      const result = await sendTelegram(env, group.text, { fetch, chatId: group.chatId });
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
    beacon: outcome.beacon,
    messagesQueued: outcome.enqueued,
    messagesDelivered: delivered,
    deliveryError,
    // Each agent API poll is exactly one fetch; the beacon run counts its own.
    subrequests: chainSubrequests + polls.filter(Boolean).length + beaconRun.subrequests + telegramSubrequests,
  };
}

/**
 * Work out the beacon run's states, alerts and messages from the stored states and the run, without writing anything.
 * `run` is runBeacon()'s result for `plan`; a run that does not match the plan throws.
 */
function evaluateBeaconRun(storage, plan, run, now) {
  const stored = readBeaconStates(storage);
  const states = new Map();
  const relays = [];
  const networks = [];
  plan.groups.forEach((group, g) => {
    const groupRun = run.groups[g];
    const key = groupStateKey(group.preset);
    const previous = stored.get(key) ?? null;
    const relayStates = {};
    group.relays.forEach((relay, i) => {
      const r = groupRun.relays[i];
      relayStates[relay.id] = applyRelayRun(previous?.relays?.[relay.id] ?? null, r, now, infoPhase(group, relay.id));
      relays.push({
        preset: group.preset.id,
        relay: relay.id,
        outcome: r.outcome,
        round: r.round ?? null,
        lagRounds: r.lagRounds ?? null,
        reason: r.reason ?? null,
        agreement: r.agreement?.outcome ?? null,
        info: r.info?.outcome ?? null,
        latencyMs: r.latencyMs ?? null,
      });
    });
    states.set(key, { ...applyGroupRun(previous, groupRun, now), relays: relayStates });
    group.networks.forEach((target, i) => {
      const n = groupRun.networks[i];
      states.set(networkStateKey(target.name), applyNetworkRun(stored.get(networkStateKey(target.name)) ?? null, n, now));
      networks.push({
        network: target.name,
        read: n.ok,
        registration: n.registration ?? null,
        verify: n.verify?.outcome ?? null,
        reason: n.reason ?? n.registrationReason ?? null,
      });
    });
  });
  // A group or network no longer configured drops its state, and its alerts resolve below.
  const dropped = [...stored.keys()].filter((key) => !states.has(key));

  const conditions = evaluateBeaconChecks(plan.groups, states);
  const existing = new Map(readAlerts(storage, BEACON_SCOPE).map((row) => [row.check, row]));
  for (const check of existing.keys()) if (!conditions.has(check)) conditions.set(check, null);
  const steps = [];
  for (const [check, condition] of conditions) steps.push({ check, step: transition(existing.get(check) ?? null, condition, now, BEACON_SCOPE, check) });
  return {
    states,
    dropped,
    steps,
    relays,
    networks,
    activeAlerts: [...conditions].filter(([, condition]) => condition).map(([check]) => check),
    messages: steps.filter(({ step }) => step.message).map(({ step }) => step.message.text),
  };
}

/**
 * Store the beacon run's states, evaluate the beacon alerts and queue their messages. Runs inside the run's transaction, and
 * a fault in the beacon stays in the beacon: everything is worked out first without writing, so a fault leaves the beacon's
 * rows and alerts as they were, raises the monitor's own warning (see recordMonitorFailure), and never rolls back the rest of
 * the run's state and alerts.
 */
function commitBeacon(storage, plan, run, now, deliverable) {
  let result;
  try {
    if (plan.failed) throw new Error("the beacon could not be planned");
    result = evaluateBeaconRun(storage, plan, run, now);
  } catch {
    return recordMonitorFailure(storage, now, deliverable);
  }
  try {
    for (const [key, state] of result.states) writeBeaconState(storage, key, now, state);
    for (const key of result.dropped) deleteBeaconState(storage, key);
    for (const { check, step } of result.steps) {
      if (step.write) saveAlert(storage, alertKey(BEACON_SCOPE, check), step.row);
      if (step.message) enqueueMessage(storage, now, BEACON_SCOPE, step.message.severity, step.message.text, deliverable);
    }
  } catch {
    // A row that could not be written is worked out again next run; nothing else in the run is touched.
  }
  return { relays: result.relays, networks: result.networks, activeAlerts: result.activeAlerts, messages: result.messages };
}

/**
 * The beacon's run could not be planned, evaluated or recorded: its rows and alerts stay as they were, and the monitor's own
 * warning is raised, if even that can be done. A warning is not repeated while it lasts.
 */
function recordMonitorFailure(storage, now, deliverable) {
  const messages = [];
  const activeAlerts = [];
  try {
    const existing = readAlerts(storage, BEACON_SCOPE).find((row) => row.check === BEACON_MONITOR_CHECK) ?? null;
    const condition = beaconMonitorFailure("the beacon's results could not be worked out or recorded this run");
    const step = transition(existing, condition, now, BEACON_SCOPE, BEACON_MONITOR_CHECK);
    if (step.write) saveAlert(storage, alertKey(BEACON_SCOPE, BEACON_MONITOR_CHECK), step.row);
    if (step.message) {
      enqueueMessage(storage, now, BEACON_SCOPE, step.message.severity, step.message.text, deliverable);
      messages.push(step.message.text);
    }
    activeAlerts.push(BEACON_MONITOR_CHECK);
  } catch {
    // Nothing more can be said about it.
  }
  return { relays: [], networks: [], activeAlerts, messages, error: "internal error" };
}
