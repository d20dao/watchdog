// Pure threshold evaluation. Each check yields:
//   undefined -> unknown this run (keep the existing alert state untouched)
//   null      -> condition clear
//   {severity: "warning" | "alarm", title, detail, event?} -> condition active
// `event: true` marks one-shot notices (refunds, foreign submitters, dropped events): they are
// reported once per occurrence and auto-resolve silently on the next run without new occurrences.

import { storedCalls } from "./agentapi.js";
import { LIMITS, THRESHOLDS, watchedAgentApi } from "./config.js";
import { formatDuration, formatGwei, formatUsdc, listWithMore, requestLink, shortAddress } from "./format.js";

export const CHECK_NAMES = Object.freeze([
  "heartbeat",
  "health_age",
  "unhealthy",
  "dropped_events",
  "pending",
  "refund",
  "balance",
  // Backup (follower) keeper reports, a stream of their own: see evaluateBackupReportChecks.
  "backup_heartbeat",
  "backup_unhealthy",
  "backup_role",
  "base_fee",
  "committer",
  "coordinator_impl",
  "registry_impl",
  "foreign_submitter",
  "rpc",
]);

/** Balance check of one backup keeper wallet: one alert per address, so each wallet resolves on its own. */
export const backupBalanceCheckName = (address) => `backup_balance:${address.toLowerCase()}`;

/**
 * Checks of the x402 agent API, for networks whose `agentApi` is enabled. They use the network's scope, so they reach
 * its Telegram group; the status page shows them in the network's Agent API section.
 */
export const AGENT_API_CHECK_NAMES = Object.freeze([
  "agent_api", // /health unreachable or not JSON, ok false with no cause below, or another relayer
  "agent_api_relayer_balance", // read on chain by the watchdog, so it works while the API is down
  "agent_api_funded",
  "agent_api_stuck",
  "agent_api_breaker",
  "agent_api_refund_due",
  "agent_api_in_doubt",
  "agent_api_alarm_loop",
]);

export const isAgentApiCheck = (check) => check === "agent_api" || check.startsWith("agent_api_");

/**
 * Every check of a network: the fixed checks, with one balance check per backup keeper after the keeper's own, then
 * the agent API checks when it is watched.
 */
export function networkCheckNames(net) {
  const backups = (net.backupKeepers ?? []).map(backupBalanceCheckName);
  const checks = CHECK_NAMES.flatMap((check) => (check === "balance" ? [check, ...backups] : [check]));
  return watchedAgentApi(net) ? [...checks, ...AGENT_API_CHECK_NAMES] : checks;
}

const warning = (title, detail, extra = {}) => ({ severity: "warning", title, detail, ...extra });
const alarm = (title, detail, extra = {}) => ({ severity: "alarm", title, detail, ...extra });
const lower = (a) => (typeof a === "string" ? a.toLowerCase() : a);

function balanceCondition(balanceWei, title, detail, alarmWei = THRESHOLDS.balanceAlarmWei, warnWei = THRESHOLDS.balanceWarnWei) {
  return balanceWei < alarmWei ? alarm(title, detail) : balanceWei < warnWei ? warning(title, detail) : null;
}

/** Time since the last report was received (a duplicate delivery counts). */
function heartbeatCondition(report, nowSec, title) {
  const silence = nowSec - report.lastReceivedAt;
  const detail = `last report ${formatDuration(silence)} ago`;
  return silence >= THRESHOLDS.heartbeatAlarmSeconds
    ? alarm(title, detail)
    : silence >= THRESHOLDS.heartbeatWarnSeconds
      ? warning(title, detail)
      : null;
}

/** `healthy: false` in the latest report: warning at once, alarm once the streak lasts 5 minutes of keeper time. */
function unhealthyCondition(report, title) {
  if (report.healthy) return null;
  const since = report.unhealthySince ?? report.reportObservedAt;
  const duration = Math.max(0, report.reportObservedAt - since);
  const faults = report.faults.length > 0 ? report.faults.join(", ") : "no fault codes";
  const detail = duration >= 60 ? `faults: ${faults} (for ${formatDuration(duration)})` : `faults: ${faults}`;
  return duration >= THRESHOLDS.unhealthyAlarmSeconds ? alarm(title, detail) : warning(title, detail);
}

/** Checks driven by the keeper's own reports. `report` is the stored report state or null. */
export function evaluateReportChecks(net, report, nowSec) {
  const T = THRESHOLDS;
  if (!report) {
    // Heartbeat only applies once the network has ever reported.
    return { heartbeat: null, health_age: null, unhealthy: null, dropped_events: null };
  }
  const result = {};

  result.heartbeat = heartbeatCondition(report, nowSec, "heartbeat missing");

  // Staleness of the keeper's health observation when it built its latest report, measured on the
  // keeper clock. Delivery gaps are the heartbeat check's job, so retained retries do not double-alert.
  if (report.healthObservedAt == null) {
    result.health_age = null; // bootstrap shape: covered by the unhealthy check (not_observed)
  } else {
    const lag = Math.max(0, report.reportObservedAt - report.healthObservedAt);
    const detail = `keeper health observation was ${formatDuration(lag)} old in its latest report`;
    result.health_age = lag >= T.healthAgeAlarmSeconds
      ? alarm("keeper health observation stale", detail)
      : lag >= T.healthAgeWarnSeconds
        ? warning("keeper health observation stale", detail)
        : null;
  }

  result.unhealthy = unhealthyCondition(report, "keeper unhealthy");

  result.dropped_events = report.droppedTotal > report.droppedAlertedTotal
    ? warning(
        "keeper dropped audit events",
        `droppedTotal rose by ${report.droppedTotal - report.droppedAlertedTotal} to ${report.droppedTotal}`,
        { event: true },
      )
    : null;
  return result;
}

/**
 * Checks driven by the backup keeper's reports (POST /v1/health/<network>/backup). `backup` is the stored backup
 * report state or null. A backup that never reported is not configured, and a network without `backupKeepers`
 * has no backup to watch: both clear, so removing the wallet from the configuration resolves these alerts too.
 */
export function evaluateBackupReportChecks(net, backup, nowSec) {
  if (!backup || (net.backupKeepers ?? []).length === 0) {
    return { backup_heartbeat: null, backup_unhealthy: null, backup_role: null };
  }
  return {
    backup_heartbeat: heartbeatCondition(backup, nowSec, "backup keeper heartbeat missing"),
    backup_unhealthy: unhealthyCondition(backup, "backup keeper unhealthy"),
    // No role in the bootstrap shape: nothing to compare yet.
    backup_role: backup.role == null || backup.role === "follower"
      ? null
      : alarm("backup keeper not a follower", `reports role ${backup.role}`),
  };
}

/** Checks driven by the chain read. `chain` is a readChain() result; unknown figures stay undefined. */
export function evaluateChainChecks(net, chain) {
  const backups = net.backupKeepers ?? [];
  const result = {
    pending: undefined,
    refund: undefined,
    balance: undefined,
    base_fee: undefined,
    committer: undefined,
    coordinator_impl: undefined,
    registry_impl: undefined,
    foreign_submitter: undefined,
  };
  for (const wallet of backups) result[backupBalanceCheckName(wallet)] = undefined;
  if (!chain || !chain.ok) return result;
  const T = THRESHOLDS;

  if (chain.pending) {
    const oldest = chain.pending.oldest;
    if (chain.pending.count === 0) {
      result.pending = null;
    } else if (oldest) {
      const detail = `request ${oldest.id} pending for ${formatDuration(oldest.ageSeconds)} (${chain.pending.count} pending) ${requestLink(net, oldest.id)}`;
      result.pending = oldest.ageSeconds >= T.pendingAlarmSeconds
        ? alarm("request pending too long", detail)
        : oldest.ageSeconds >= T.pendingWarnSeconds
          ? warning("request pending too long", detail)
          : null;
    }
  }

  if (chain.logs) {
    const refunds = chain.logs.refunds;
    if (refunds.length === 0) {
      result.refund = null;
    } else {
      const items = refunds.map(
        (r) => `request ${r.requestId} (${formatUsdc(r.amountWei)} USDC ${r.paid ? "paid" : "credited"} to ${r.refundAddress})`,
      );
      result.refund = alarm(
        "refund issued, investigate",
        `${listWithMore(items, LIMITS.maxIdsInMessage)} ${requestLink(net, refunds[0].requestId)}`,
        { event: true },
      );
    }
    const foreign = chain.logs.foreignFulfillments;
    if (foreign.length === 0) {
      result.foreign_submitter = null;
    } else {
      const items = foreign.map((f) => `request ${f.requestId} by ${f.submitter}`);
      result.foreign_submitter = warning(
        "randomness fulfilled by another submitter",
        `${listWithMore(items, LIMITS.maxIdsInMessage)} (keeper ${net.keeper}) ${requestLink(net, foreign[0].requestId)}`,
        { event: true },
      );
    }
  }

  if (chain.balanceWei != null) {
    result.balance = balanceCondition(chain.balanceWei, "keeper balance low", `keeper ${net.keeper} holds ${formatUsdc(chain.balanceWei)} USDC`);
  }
  const backupBalances = new Map((chain.backupBalances ?? []).map((b) => [lower(b.address), b.balanceWei]));
  for (const wallet of backups) {
    const balanceWei = backupBalances.get(lower(wallet));
    if (balanceWei == null) continue;
    result[backupBalanceCheckName(wallet)] = balanceCondition(
      balanceWei,
      `backup keeper ${shortAddress(wallet)} balance low`,
      `${wallet} holds ${formatUsdc(balanceWei)} USDC`,
      THRESHOLDS.backupBalanceAlarmWei,
      THRESHOLDS.backupBalanceWarnWei,
    );
  }

  if (chain.block?.baseFeeWei != null) {
    const needed = 2n * chain.block.baseFeeWei + T.feeHeadroomWei;
    const percent = Number((needed * 10000n) / net.feeCapWei) / 100;
    const detail = `2 x base fee + 1 gwei = ${formatGwei(needed)} gwei is ${percent}% of the ${formatGwei(net.feeCapWei)} gwei fee cap`;
    result.base_fee = needed * 100n > net.feeCapWei * T.feeAlarmPercent
      ? alarm("base fee near fee cap", detail)
      : needed * 100n > net.feeCapWei * T.feeWarnPercent
        ? warning("base fee near fee cap", detail)
        : null;
  }

  if (chain.committer != null) {
    result.committer = lower(chain.committer) === lower(net.keeper)
      ? null
      : alarm("registry committer is not the keeper", `committer() is ${chain.committer}, expected ${net.keeper}`);
  }
  if (chain.coordinatorImpl != null) {
    const expected = [].concat(net.implementations.coordinator);
    result.coordinator_impl = expected.some((a) => lower(a) === lower(chain.coordinatorImpl))
      ? null
      : alarm("coordinator implementation changed", `ERC-1967 slot is ${chain.coordinatorImpl}, expected ${expected.join(" or ")}`);
  }
  if (chain.registryImpl != null) {
    const expected = [].concat(net.implementations.registry);
    result.registry_impl = expected.some((a) => lower(a) === lower(chain.registryImpl))
      ? null
      : alarm("registry implementation changed", `ERC-1967 slot is ${chain.registryImpl}, expected ${expected.join(" or ")}`);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// x402 agent API. `poll` is the stored poll state after this run's poll (see applyAgentApiPoll), `chain` this run's
// readChain() result.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Health figures only count when this run's poll succeeded: after a failed poll they are unknown, so their alerts are
 * neither resolved nor repeated, and the poll alert itself warns after 2 failed polls in a row and alarms after 5.
 * A network whose agent API is not watched clears every check.
 */
export function evaluateAgentApiChecks(net, poll, chain) {
  const result = Object.fromEntries(AGENT_API_CHECK_NAMES.map((check) => [check, undefined]));
  const api = watchedAgentApi(net);
  if (!api) return Object.fromEntries(AGENT_API_CHECK_NAMES.map((check) => [check, null]));
  const T = THRESHOLDS;

  const warnWei = T.agentApiRelayerWarnWei[net.name];
  const alarmWei = T.agentApiRelayerAlarmWei[net.name] ?? 0n;
  if (warnWei == null) {
    result.agent_api_relayer_balance = null;
  } else if (chain?.ok && chain.agentRelayerBalanceWei != null) {
    result.agent_api_relayer_balance = balanceCondition(
      chain.agentRelayerBalanceWei,
      "agent API relayer balance low",
      `relayer ${api.relayer} holds ${formatUsdc(chain.agentRelayerBalanceWei)} USDC (warning below ${formatUsdc(warnWei)}, alarm below ${formatUsdc(alarmWei)}); top it up before sales stop at 3 calls' cost`,
      alarmWei,
      warnWei,
    );
  }

  if (!poll) return result;
  const failures = poll.failures ?? 0;
  if (failures > 0) {
    if (failures >= T.agentApiDownWarnPolls) {
      const detail = `${api.url}/health failed ${failures} polls in a row (last: ${poll.reason ?? "unknown"})`;
      result.agent_api = failures >= T.agentApiDownAlarmPolls ? alarm("agent API unreachable", detail) : warning("agent API unreachable", detail);
    }
    return result;
  }
  const h = poll.health;
  if (!h) return result;

  if (h.relayerFunded === false) {
    const balance = h.relayerBalance == null ? "" : ` holds ${h.relayerBalance} USDC,`;
    result.agent_api_funded = alarm(
      "agent API relayer cannot pay for calls",
      `the API reports its relayer${balance} under ${h.relayerMinCalls ?? 3} calls' cost: it has stopped selling`,
    );
  } else if (h.relayerFunded === true) {
    result.agent_api_funded = null;
  }

  if (h.stuck === true) {
    result.agent_api_stuck = alarm("agent API sender stuck", "the relayer's transaction sender reports stuck: the API refuses new calls");
  } else if (h.stuck === false) {
    result.agent_api_stuck = null;
  }

  const settlement = h.settlementBreaker ?? {};
  const delivery = h.deliveryBreaker ?? {};
  if (settlement.state && delivery.state) {
    const open = [];
    if (settlement.state === "open") {
      open.push(`settlement breaker open (${settlement.failures ?? "?"} of ${settlement.attempts ?? "?"} recent settle calls failed)`);
    }
    if (delivery.state === "open") {
      open.push(`delivery breaker open (${delivery.expiries ?? "?"} requests expired unserved, ${delivery.failures ?? "?"} failed to open)`);
    }
    const detail = `${open.join("; ")}: the API refuses new calls until it closes`;
    // The settlement breaker closes by itself a minute after settle calls stop failing; the delivery breaker means
    // paid calls are not being served.
    result.agent_api_breaker = open.length === 0
      ? null
      : delivery.state === "open"
        ? alarm("agent API breaker open", detail)
        : warning("agent API breaker open", detail);
  }

  const owed = h.counts?.refundDue;
  if (owed != null) {
    result.agent_api_refund_due = owed === 0
      ? null
      : alarm(
          "agent API refund owed",
          `${plural(owed, "paid call")} could not be served and ${owed === 1 ? "its payer is" : "their payers are"} owed a refund. ` +
            "Refund each payer by hand, then mark it handled in the agent API's operator refund list; this clears when none is left",
        );
  }

  const overdue = h.inDoubt?.overdue;
  if (overdue != null) {
    result.agent_api_in_doubt = overdue === 0
      ? null
      : alarm(
          "agent API payments in doubt",
          `${plural(overdue, "settlement")} unconfirmed past the API's limit (oldest ${formatDuration(h.inDoubt.oldestSeconds ?? 0)}): ` +
            "Gateway has confirmed neither way whether the payer was charged",
        );
  }

  const stored = storedCalls(h);
  if (stored === 0) {
    result.agent_api_alarm_loop = null; // nothing stored: the relayer's alarm rightly stops
  } else if (stored != null && h.lastAlarmSecondsAgo != null) {
    result.agent_api_alarm_loop = h.lastAlarmSecondsAgo >= T.agentApiAlarmLoopSeconds
      ? alarm(
          "agent API relayer alarm loop stopped",
          `its last alarm ran ${formatDuration(h.lastAlarmSecondsAgo)} ago with ${plural(stored, "call")} stored; it runs at least every 10 min while any are`,
        )
      : null;
  }

  // The API's own `ok` also needs its relay contract configured, which no field above shows.
  const explained = [result.agent_api_funded, result.agent_api_stuck, result.agent_api_breaker, result.agent_api_refund_due, result.agent_api_in_doubt].some(Boolean);
  result.agent_api = h.relayerMatches === false
    ? alarm("agent API relayer differs", `/health names a relayer other than ${api.relayer}, the wallet the watchdog checks`)
    : h.ok === false && !explained
      ? alarm("agent API not ok", "/health reports ok: false, and none of the fields the watchdog checks explains it")
      : null;
  return result;
}

/** Watchdog's own chain access. `failures` counts consecutive runs with a failed or partial read. */
export function evaluateRpcCheck(failures, lastError) {
  if (failures < THRESHOLDS.rpcFailureRuns) return null;
  return warning(
    "watchdog cannot read chain",
    `${failures} consecutive runs failed${lastError ? ` (last error: ${lastError})` : ""}`,
  );
}

// ---------------------------------------------------------------------------------------------
// AirnodeHub listing probes (scope AIRNODE_SCOPE). `state` is the stored probe state of a recipe or null.

/** Alert check names of one recipe: its signed-reply probe and its listing document check. */
export const probeCheckName = (recipe) => `probe:${recipe.id}`;
export const listingCheckName = (recipe) => `listing:${recipe.id}`;

const PROBE_MISMATCH_TITLES = Object.freeze({
  request_hash: "request hash mismatch",
  signer: "signer mismatch",
  data_shape: "data shape mismatch",
  timestamp: "signed timestamp out of range",
});

/**
 * Mismatches (request hash, signer, data shape, signed timestamp) alarm at once and stay until a probe passes:
 * a probe that fails in transit says nothing about whether a changed listing was fixed. Failed probes
 * (unreachable, HTTP error, unsigned or unparsable reply) warn after 2 in a row and alarm after 4.
 */
export function evaluateProbeCheck(recipe, state) {
  if (!state) return null;
  if (state.verdict && state.verdict !== "ok") {
    return alarm(`${recipe.name} ${PROBE_MISMATCH_TITLES[state.verdict] ?? "listing changed"}`, state.verdictReason ?? "");
  }
  const failures = state.failures ?? 0;
  if (failures < THRESHOLDS.probeWarnFailures) return null;
  const title = `${recipe.name} listing unreachable`;
  const detail = `${failures} consecutive probes failed (last: ${state.reason ?? "unknown"})`;
  return failures >= THRESHOLDS.probeAlarmFailures ? alarm(title, detail) : warning(title, detail);
}

/** The daily listing document check only alarms on a conclusive change; reading failures are left to the probe. */
export function evaluateListingDocumentCheck(recipe, state) {
  const doc = state?.document;
  if (!doc || !doc.verdict || doc.verdict === "ok") return null;
  const title = doc.verdict === "signer" ? "listing document signer mismatch" : "operation missing from listing document";
  return alarm(`${recipe.name} ${title}`, doc.verdictReason ?? "");
}
