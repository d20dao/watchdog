// One watchdog run: read both chains, poll each watched x402 agent API, read the drand beacon's relays and registries
// and run any due AirnodeHub listing probes (network I/O, no storage held), then evaluate and commit every state change
// in one synchronous transaction, then deliver queued Telegram messages.

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
  evaluateAgentApiChecks,
  evaluateBackupReportChecks,
  evaluateBeaconChecks,
  evaluateChainChecks,
  evaluateListingDocumentCheck,
  evaluateProbeCheck,
  evaluateReportChecks,
  evaluateRpcCheck,
  listingCheckName,
  networkCheckNames,
  probeCheckName,
} from "./checks.js";
import { AIRNODE_RECIPES, AIRNODE_SCOPE, BEACON_SCOPE, LIMITS, NETWORKS, watchedAgentApi } from "./config.js";
import { applyDocumentResult, applyProbeResult, failedTaskResult, planProbeTasks } from "./listings.js";
import { readChain } from "./rpc.js";
import {
  deleteBeaconState,
  deleteProbeState,
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
  readProbeStates,
  readReportState,
  saveAlert,
  writeAgentApiState,
  writeBeaconState,
  writeChainState,
  writeProbeState,
} from "./store.js";
import { chatIdFor, groupMessages, notifierConfigured, sendTelegram } from "./telegram.js";

// The probe module carries the secp256k1 and keccak code; importing it lazily keeps it out of Worker startup.
const loadProbeModule = () => import("./probe.js");

/** Run planned probe tasks. Every task gets a result, even when the probe module cannot be loaded. */
async function runProbes(tasks, { fetch, clock, loadProbes }) {
  if (tasks.length === 0) return [];
  try {
    const { runProbeTasks } = await loadProbes();
    return await runProbeTasks(tasks, { fetch, clock });
  } catch {
    return tasks.map((task) => failedTaskResult(task, "internal error"));
  }
}

/** Run the beacon plan. The run never throws, and a monitor that failed as a whole counts every relay as failed. */
async function runBeaconChecks(plan, { fetch, clock, runBeaconImpl }) {
  if (plan.groups.length === 0) return { subrequests: 0, groups: [] };
  try {
    return await runBeaconImpl(plan, { fetch, clock });
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
  recipes = AIRNODE_RECIPES,
  loadProbes = loadProbeModule,
}) {
  const names = Object.keys(nets);
  const cursors = names.map((name) => {
    const prev = readChainState(storage, name);
    return prev ? { logCursor: prev.logCursor, logSpan: prev.logSpan } : null;
  });
  const tasks = planProbeTasks(recipes, readProbeStates(storage), Math.floor(clock() / 1000));
  const beaconPlan = planBeacon(nets, readBeaconStates(storage), Math.floor(clock() / 1000));

  const [reads, polls, probeResults, beaconRun] = await Promise.all([
    Promise.all(
      names.map(async (name, i) => {
        try {
          return await readChainImpl(nets[name], cursors[i], { fetch });
        } catch {
          return { ok: false, complete: false, error: "internal error", errors: [], subrequests: 0 };
        }
      }),
    ),
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
    runProbes(tasks, { fetch, clock, loadProbes }),
    // The drand relays and each network's registry: shared work, read once however many networks list the beacon.
    runBeaconChecks(beaconPlan, { fetch, clock, runBeaconImpl }),
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
    const airnodehub = commitProbes(storage, recipes, tasks, probeResults, now, deliverable);
    enqueued += airnodehub.messages.length;
    // With no AirnodeHub recipe configured the catalog is drand alone: a drand outage stops the service.
    const beacon = commitBeacon(storage, beaconPlan, beaconRun, now, deliverable, recipes.length === 0);
    enqueued += beacon.messages.length;
    pruneReports(storage, now - LIMITS.reportRetentionSeconds);
    expireMessages(storage, now);
    if (enqueued > 0) pruneMessages(storage);
    return { networks, airnodehub, beacon, enqueued };
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
    airnodehub: outcome.airnodehub,
    beacon: outcome.beacon,
    messagesQueued: outcome.enqueued,
    messagesDelivered: delivered,
    deliveryError,
    // Each probe task and each agent API poll is exactly one fetch; the beacon run counts its own.
    subrequests: chainSubrequests + polls.filter(Boolean).length + tasks.length + beaconRun.subrequests + telegramSubrequests,
  };
}

/** Store probe results, evaluate the probe alerts and queue their messages. Runs inside the run's transaction. */
function commitProbes(storage, recipes, tasks, results, now, deliverable) {
  const states = readProbeStates(storage);
  const changed = new Set();
  const probes = [];
  tasks.forEach((task, i) => {
    const result = results[i];
    if (task.kind === "probe") {
      const recipe = task.recipes[0];
      states.set(recipe.id, applyProbeResult(states.get(recipe.id) ?? null, result, now, task.phase));
      changed.add(recipe.id);
      probes.push({ recipe: recipe.id, outcome: result.outcome, reason: result.reason ?? null, latencyMs: result.latencyMs ?? null });
    } else {
      task.recipes.forEach((recipe, j) => {
        states.set(recipe.id, applyDocumentResult(states.get(recipe.id) ?? null, result.results[j], result.latencyMs, now, task.phase));
        changed.add(recipe.id);
      });
      probes.push({ listingDocument: task.url, outcomes: result.results.map((r) => r.outcome), latencyMs: result.latencyMs ?? null });
    }
  });
  for (const id of changed) writeProbeState(storage, id, now, states.get(id));
  const configured = new Set(recipes.map((recipe) => recipe.id));
  for (const id of states.keys()) if (!configured.has(id)) deleteProbeState(storage, id);

  const conditions = new Map();
  for (const recipe of recipes) {
    const state = states.get(recipe.id) ?? null;
    conditions.set(probeCheckName(recipe), evaluateProbeCheck(recipe, state));
    conditions.set(listingCheckName(recipe), evaluateListingDocumentCheck(recipe, state));
  }
  const existing = new Map(readAlerts(storage, AIRNODE_SCOPE).map((row) => [row.check, row]));
  // A recipe removed from the configuration resolves its alerts.
  for (const check of existing.keys()) if (!conditions.has(check)) conditions.set(check, null);

  const messages = [];
  for (const [check, condition] of conditions) {
    const step = transition(existing.get(check) ?? null, condition, now, AIRNODE_SCOPE, check);
    if (step.write) saveAlert(storage, alertKey(AIRNODE_SCOPE, check), step.row);
    if (step.message) {
      enqueueMessage(storage, now, AIRNODE_SCOPE, step.message.severity, step.message.text, deliverable);
      messages.push(step.message.text);
    }
  }
  return {
    probes,
    activeAlerts: [...conditions].filter(([, condition]) => condition).map(([check]) => check),
    messages,
  };
}

/**
 * Store the beacon run's states, evaluate the beacon alerts and queue their messages. Runs inside the run's transaction.
 * `drandOnly`: no other source is configured, so a drand outage stops the service (see evaluateBeaconFresh).
 */
function commitBeacon(storage, plan, run, now, deliverable, drandOnly) {
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
  for (const [key, state] of states) writeBeaconState(storage, key, now, state);
  // A group or network no longer configured drops its state, and its alerts resolve below.
  for (const key of stored.keys()) if (!states.has(key)) deleteBeaconState(storage, key);

  const conditions = evaluateBeaconChecks(plan.groups, states, { drandOnly });
  const existing = new Map(readAlerts(storage, BEACON_SCOPE).map((row) => [row.check, row]));
  for (const check of existing.keys()) if (!conditions.has(check)) conditions.set(check, null);

  const messages = [];
  for (const [check, condition] of conditions) {
    const step = transition(existing.get(check) ?? null, condition, now, BEACON_SCOPE, check);
    if (step.write) saveAlert(storage, alertKey(BEACON_SCOPE, check), step.row);
    if (step.message) {
      enqueueMessage(storage, now, BEACON_SCOPE, step.message.severity, step.message.text, deliverable);
      messages.push(step.message.text);
    }
  }
  return {
    relays,
    networks,
    activeAlerts: [...conditions].filter(([, condition]) => condition).map(([check]) => check),
    messages,
  };
}
