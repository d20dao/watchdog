// Pure threshold evaluation. Each check yields:
//   undefined -> unknown this run (keep the existing alert state untouched)
//   null      -> condition clear
//   {severity: "warning" | "alarm", title, detail, event?} -> condition active
// `event: true` marks one-shot notices (refunds, foreign submitters, dropped events): they are
// reported once per occurrence and auto-resolve silently on the next run without new occurrences.

import { storedCalls } from "./agentapi.js";
import { groupStateKey, networkStateKey } from "./beacon.js";
import { LIMITS, THRESHOLDS, watchedAgentApi } from "./config.js";
import { formatDuration, formatEth, formatGwei, formatUsdc, listWithMore, requestLink, shortAddress } from "./format.js";
import { codePinsKey } from "./round.js";

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
// Round networks (Robinhood Chain). `chain` is a readRoundChain() result, `state` the stored state after it (applyRoundRead).

/** The checks of a round network: no registry, so no committer or registry implementation; the coordinator's roles instead. */
export const ROUND_CHECK_NAMES = Object.freeze([
  "heartbeat",
  "health_age",
  "unhealthy",
  "dropped_events",
  "pending",
  "expired",
  "refund",
  "balance",
  "backup_heartbeat",
  "backup_unhealthy",
  "backup_role",
  "backup_keepers",
  "base_fee",
  "keeper",
  "owner",
  "fee_recipient",
  "pricing",
  "beacon",
  "coordinator_impl",
  "code_hash",
  "foreign_submitter",
  "rpc",
]);

/** Every check of a round network, with one balance check per backup keeper after the keeper's own. */
export function roundCheckNames(net) {
  const backups = (net.backupKeepers ?? []).map(backupBalanceCheckName);
  return ROUND_CHECK_NAMES.flatMap((check) => (check === "balance" ? [check, ...backups] : [check]));
}

const ZERO_ADDRESS = "0x" + "0".repeat(40);
const accepts = (list, address) => [].concat(list ?? []).some((a) => lower(a) === lower(address));
/** " <link>" for a network with a request explorer, else nothing. */
const roundLink = (net, id) => (net.explorer ? ` ${requestLink(net, id)}` : "");

/** The code check's condition from the stored state: unknown until a check under the configured pins has run. */
export function evaluateCodeHash(net, codeCheck) {
  if (!net.codeHashes) return null;
  if (!codeCheck || codeCheck.pins !== codePinsKey(net) || !codeCheck.verdict) return undefined;
  return codeCheck.verdict === "mismatch" ? alarm("runtime code differs from the pinned hash", codeCheck.detail ?? "") : null;
}

/**
 * Checks driven by a round network's chain read. The code check comes from the stored state, so it holds its verdict between
 * the daily reads; everything else is unknown when the read failed.
 */
export function evaluateRoundChainChecks(net, chain, state) {
  const backups = net.backupKeepers ?? [];
  const result = {
    pending: undefined,
    expired: undefined,
    refund: undefined,
    balance: undefined,
    backup_keepers: undefined,
    base_fee: undefined,
    keeper: undefined,
    owner: undefined,
    fee_recipient: undefined,
    pricing: undefined,
    beacon: undefined,
    coordinator_impl: undefined,
    code_hash: evaluateCodeHash(net, state?.codeCheck ?? null),
    foreign_submitter: undefined,
  };
  for (const wallet of backups) result[backupBalanceCheckName(wallet)] = undefined;
  if (!chain || !chain.ok) return result;
  const T = THRESHOLDS;

  const pending = chain.scan?.pending;
  if (pending) {
    const oldest = pending.oldest;
    if (pending.count === 0 || !oldest) {
      result.pending = null;
    } else {
      const count = `${pending.count}${pending.more ? "+" : ""} pending`;
      const detail = `request ${oldest.id} pending for ${formatDuration(oldest.ageSeconds)} (${count})${roundLink(net, oldest.id)}`;
      result.pending = oldest.ageSeconds >= T.pendingAlarmSeconds
        ? alarm("request pending too long", detail)
        : oldest.ageSeconds >= T.pendingWarnSeconds
          ? warning("request pending too long", detail)
          : null;
    }
  }

  if (chain.scan) {
    const expired = chain.scan.expired;
    result.expired = expired.length === 0
      ? null
      : alarm(
          "request expired without fulfilment",
          `${listWithMore(expired.map((e) => `request ${e.requestId} (fee ${formatEth(e.feePaidWei)} ETH)`), LIMITS.maxIdsInMessage)}: ` +
            `the fee is refundable to the refund address; check the keepers${roundLink(net, expired[0].requestId)}`,
          { event: true },
        );
  }

  if (chain.logs) {
    const refunds = chain.logs.refunds;
    if (refunds.length === 0) {
      result.refund = null;
    } else {
      const items = refunds.map(
        (r) => `request ${r.requestId} (${formatEth(r.amountWei)} ETH ${r.paid ? "paid" : "credited"} to ${r.refundAddress})`,
      );
      result.refund = alarm("refund issued, investigate", `${listWithMore(items, LIMITS.maxIdsInMessage)}${roundLink(net, refunds[0].requestId)}`, { event: true });
    }
    const foreign = chain.logs.foreignFulfillments;
    if (foreign.length === 0) {
      result.foreign_submitter = null;
    } else {
      const items = foreign.map((f) => `request ${f.requestId} by ${f.submitter}`);
      result.foreign_submitter = warning(
        "randomness fulfilled by another submitter",
        `${listWithMore(items, LIMITS.maxIdsInMessage)} (keeper ${net.keeper})${roundLink(net, foreign[0].requestId)}`,
        { event: true },
      );
    }
  }

  if (chain.balanceWei != null) {
    result.balance = balanceCondition(
      chain.balanceWei,
      "keeper balance low",
      `keeper ${net.keeper} holds ${formatEth(chain.balanceWei)} ETH (warning below ${formatEth(T.roundBalanceWarnWei)}, alarm below ${formatEth(T.roundBalanceAlarmWei)})`,
      T.roundBalanceAlarmWei,
      T.roundBalanceWarnWei,
    );
  }
  const backupBalances = new Map((chain.backupBalances ?? []).map((b) => [lower(b.address), b.balanceWei]));
  for (const wallet of backups) {
    const balanceWei = backupBalances.get(lower(wallet));
    if (balanceWei == null) continue;
    result[backupBalanceCheckName(wallet)] = balanceCondition(
      balanceWei,
      `backup keeper ${shortAddress(wallet)} balance low`,
      `${wallet} holds ${formatEth(balanceWei)} ETH`,
      T.roundBackupBalanceAlarmWei,
      T.roundBackupBalanceWarnWei,
    );
  }

  // Backup keepers: each configured one must be allowed, and no other may be.
  const authorized = chain.backupAuthorized ?? [];
  if (authorized.length === backups.length && authorized.every((b) => b.allowed != null) && chain.backupKeeperCount != null) {
    const missing = authorized.filter((b) => !b.allowed).map((b) => b.address);
    const allowed = BigInt(authorized.length - missing.length);
    result.backup_keepers = chain.backupKeeperCount > allowed
      ? alarm(
          "unknown backup keeper allowed",
          `backupKeeperCount() is ${chain.backupKeeperCount}, but only ${allowed} of the configured backup keepers are allowed`,
        )
      : missing.length > 0
        ? warning("backup keeper not allowed", `isBackupKeeper is false for ${missing.join(", ")}: it cannot take over while the primary is down`)
        : null;
  }

  if (chain.block?.baseFeeWei != null) {
    const headroom = net.feeHeadroomWei ?? T.feeHeadroomWei;
    const needed = 2n * chain.block.baseFeeWei + headroom;
    const percent = Number((needed * 10000n) / net.feeCapWei) / 100;
    const formula = headroom === 0n ? "2 x base fee" : `2 x base fee + ${formatGwei(headroom)} gwei`;
    const detail = `${formula} = ${formatGwei(needed)} gwei is ${percent}% of the ${formatGwei(net.feeCapWei)} gwei fee cap`;
    result.base_fee = needed * 100n > net.feeCapWei * T.feeAlarmPercent
      ? alarm("base fee near fee cap", detail)
      : needed * 100n > net.feeCapWei * T.feeWarnPercent
        ? warning("base fee near fee cap", detail)
        : null;
  }

  if (chain.keeper != null) {
    result.keeper = lower(chain.keeper) === lower(net.keeper)
      ? null
      : alarm("coordinator keeper is not the configured keeper", `keeper() is ${chain.keeper}, expected ${net.keeper}`);
  }
  if (chain.owner != null) {
    const pendingOwner = chain.pendingOwner != null && lower(chain.pendingOwner) !== ZERO_ADDRESS ? chain.pendingOwner : null;
    result.owner = !accepts(net.owners, chain.owner)
      ? alarm("coordinator owner changed", `owner() is ${chain.owner}, expected ${[].concat(net.owners).join(" or ")}`)
      : pendingOwner && !accepts(net.owners, pendingOwner)
        ? alarm("ownership transfer pending to an unknown address", `pendingOwner() is ${pendingOwner}`)
        : pendingOwner
          ? warning("ownership transfer pending", `pendingOwner() is ${pendingOwner}; it takes effect when that address accepts`)
          : null;
  }
  if (chain.feeRecipient != null) {
    result.fee_recipient = accepts(net.feeRecipients, chain.feeRecipient)
      ? null
      : alarm("fee recipient changed", `feeRecipient() is ${chain.feeRecipient}, expected ${[].concat(net.feeRecipients).join(" or ")}`);
  }
  if (chain.pricing && chain.keeperFeeBps != null && chain.refundBps != null) {
    const p = net.pricing;
    const drift = [];
    if (chain.pricing.minFeeWei !== p.minFeeWei) drift.push(`minFee ${chain.pricing.minFeeWei} wei (expected ${p.minFeeWei})`);
    if (chain.pricing.feeMultiplier !== p.feeMultiplier) drift.push(`feeMultiplier ${chain.pricing.feeMultiplier} (expected ${p.feeMultiplier})`);
    if (chain.pricing.fulfillGasOverhead !== p.fulfillGasOverhead) {
      drift.push(`fulfillGasOverhead ${chain.pricing.fulfillGasOverhead} (expected ${p.fulfillGasOverhead})`);
    }
    if (chain.keeperFeeBps !== p.keeperFeeBps) drift.push(`keeperFeeBps ${chain.keeperFeeBps} (expected ${p.keeperFeeBps})`);
    if (chain.refundBps !== p.refundBps) drift.push(`refundBps ${chain.refundBps} (expected ${p.refundBps})`);
    result.pricing = drift.length === 0 ? null : warning("coordinator pricing changed", drift.join(", "));
  }

  if (!net.beacon) {
    result.beacon = null;
  } else if (chain.beaconSchedule && chain.beaconIdentity != null) {
    const s = chain.beaconSchedule;
    result.beacon = lower(chain.beaconIdentity) !== lower(net.beacon.identity)
      ? alarm("beacon registration differs", `beaconIdentity(${net.beacon.id}) is ${chain.beaconIdentity}, pinned ${net.beacon.identity}`)
      : s.beaconId !== net.beacon.id
        ? warning("another beacon in force", `beaconSchedule() has beacon ${s.beaconId} in force since ${s.since}; the watchdog pins beacon ${net.beacon.id}`)
        : s.nextFrom !== 0
          ? warning("beacon change scheduled", `beacon ${s.nextBeaconId} takes over for requests from ${new Date(s.nextFrom * 1000).toISOString()}`)
          : null;
  }

  if (chain.implementation != null) {
    const expected = [].concat(net.implementations.coordinator);
    result.coordinator_impl = expected.some((a) => lower(a) === lower(chain.implementation))
      ? null
      : alarm("coordinator implementation changed", `ERC-1967 slot is ${chain.implementation}, expected ${expected.join(" or ") || "none configured"}`);
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
// drand beacon monitor (scope BEACON_SCOPE). `states` is readBeaconStates(): the stored state of each group, which holds
// its relays' states, and of each network (see src/beacon.js). A group is `{preset, relays: [{id, url}], networks}` as
// beaconGroups() builds it from the configuration.

/** Alert check names: one per beacon, one per relay for each concern, one per network for each concern. */
export const beaconFreshCheckName = (preset) => `fresh:${preset.id}`;
export const beaconRelayCheckName = (preset, relay) => `relay:${preset.id}:${relay.id}`;
export const beaconAgreementCheckName = (preset, relay) => `agree:${preset.id}:${relay.id}`;
export const beaconInfoCheckName = (preset, relay) => `info:${preset.id}:${relay.id}`;
export const beaconRegistrationCheckName = (network) => `registration:${network}`;
export const beaconVerifyCheckName = (network) => `verify:${network}`;
export const beaconVerifierCheckName = (network) => `verifier:${network}`;
/** The monitor's own failures (an error in the watchdog, not in a relay or a registry): one alert for the whole monitor. */
export const BEACON_MONITOR_CHECK = "monitor";

/** "a", "a and b", "a, b and c" */
const listOf = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : String(items[0] ?? ""));

/**
 * How the catalogs in force use the beacon, from the networks' states: the networks whose catalog lists the beacon alone
 * (`only`: no other source, so an outage stops the service there) and those whose catalog lists it among other sources
 * (`mixed`: the epochs that select it cannot publish). A catalog not read yet while the beacon is registered is assumed to
 * be `mixed`: an outage is not made less serious on a guess. Any other network does not use the beacon.
 */
export function beaconUsage(group, states) {
  const usage = { only: [], mixed: [] };
  for (const target of group.networks) {
    const state = states.get(networkStateKey(target.name));
    const use = state?.catalog?.use ?? (state?.registration === "registered" ? "mixed" : "none");
    if (use === "only") usage.only.push(target.name);
    else if (use === "mixed") usage.mixed.push(target.name);
  }
  return usage;
}

/**
 * No relay serves a fresh round, for beaconDownAlarmRuns runs in a row: the registry cannot publish an epoch without a
 * round. How serious that is comes from the catalogs in force (`usage`, see beaconUsage), read from the chain:
 *   a catalog that lists the beacon alone (no fallback source)   alarm: the service is stopping
 *   a catalog that lists it among other sources                  alarm: the epochs that select it cannot publish
 *   no catalog that lists it                                     warning: nothing depends on it yet
 * The level follows the catalogs from run to run, so a catalog that changes during an outage changes the alert's level.
 */
export function evaluateBeaconFresh(group, state, usage = { only: [], mixed: [] }) {
  if (!state || (state.downRuns ?? 0) < THRESHOLDS.beaconDownAlarmRuns) return null;
  const reasons = group.relays.map((relay) => `${relay.id}: ${state.relays?.[relay.id]?.reason ?? "not checked"}`).join(", ");
  const down = `no relay serves a fresh round (${reasons})`;
  if (usage.only.length > 0) {
    return alarm(
      "drand beacon down, service stopping",
      `${down}; the catalog in force on ${listOf(usage.only)} lists only the drand beacon, so epoch publication stops there and requests cannot be served until one does`,
    );
  }
  if (usage.mixed.length > 0) {
    return alarm("drand beacon down", `${down}; epochs on ${listOf(usage.mixed)} that select the drand recipe cannot publish until one does`);
  }
  return warning("drand beacon down", `${down}; no catalog in force lists the drand beacon yet, so nothing depends on it`);
}

/** One relay failing or lagging while others serve: a warning after beaconRelayWarnRuns runs in a row. */
export function evaluateBeaconRelay(relay, state) {
  const runs = state?.badRuns ?? 0;
  if (runs < THRESHOLDS.beaconRelayWarnRuns) return null;
  return warning(`drand relay ${relay.id} not serving fresh rounds`, `${runs} consecutive checks not fresh (last: ${state.reason ?? "unknown"})`);
}

/**
 * A relay whose signature for the common round differs from the other relays', or is the only one and is rejected by every
 * registry that lists the beacon; stays until a comparison agrees or a registry accepts what it serves.
 */
export function evaluateBeaconAgreement(relay, state) {
  const agreement = state?.agreement;
  if (agreement?.verdict === "differs") return warning(`drand relay ${relay.id} disagrees with the other relays`, agreement.verdictReason ?? "");
  if (agreement?.verdict === "rejected") return warning(`drand relay ${relay.id} serves a signature the registry rejects`, agreement.verdictReason ?? "");
  return null;
}

/** A relay whose daily chain info differs from the configured beacon; stays until a read matches. */
export function evaluateBeaconInfo(relay, state) {
  const info = state?.info;
  return info?.verdict === "drift" ? warning(`drand relay ${relay.id} chain info differs from the configured beacon`, info.verdictReason ?? "") : null;
}

/**
 * The registry's registration of the beacon against the configuration. Before the registry is upgraded and the beacon
 * registered (beaconOf reverts) there is nothing to compare and nothing is raised; once it has been seen registered, losing
 * the registration is a fault (the state holds it until the second run that says so, see applyNetworkRun). A recipe that
 * exists but is no beacon (a zero verifier) is a fault of the configured id. Unknown while the registry could not be read.
 */
export function evaluateBeaconRegistration(target, state) {
  if (!state || state.readOk === false || !state.registration) return undefined;
  if (state.registration === "registered") {
    return state.verdict === "mismatch" ? warning(`${target.name} registry beacon registration mismatch`, state.verdictReason ?? "") : null;
  }
  if (state.registration === "notbeacon") {
    return warning(
      `${target.name} registry beacon recipe misconfigured`,
      `recipe ${state.recipe ?? target.beacon.recipe} exists but is not a beacon; check the configured id`,
    );
  }
  return state.everRegistered
    ? warning(
        `${target.name} registry beacon no longer registered`,
        `${state.registrationReason ?? "not registered"}; the beacon was registered before`,
      )
    : null;
}

/**
 * The registry rejecting the round it was asked to verify (verifyBeacon false or reverting) for beaconVerifyAlarmRuns
 * runs in a row, while its beacon is registered: it cannot verify a real round, so it cannot publish one either. Only a
 * rejection of a signature that at least two relays returned, or that another network's registry accepted, is counted (see
 * settleRound); a signature one relay alone returned is that relay's fault to answer for.
 */
export function evaluateBeaconVerify(target, state) {
  if (!state || state.readOk === false || !state.registration) return undefined;
  if (state.registration !== "registered") return null;
  const failures = state.verify?.failures ?? 0;
  if (failures < THRESHOLDS.beaconVerifyAlarmRuns) return null;
  return alarm(
    `${target.name} registry rejects drand rounds`,
    `verifyBeacon(${state.recipe ?? target.beacon.recipe}) rejected round ${state.verify.rejectedRound} in ${failures} consecutive runs (${state.verify.rejectedReason ?? "unknown"}): the registry cannot verify a real round`,
  );
}

/**
 * The registered verifier accepting a signature that is not one: the round's signature with its last byte flipped. Nothing else
 * in the registration proves the verifier is sound (its slot signer is derived from whichever verifier the registry names
 * unless the configuration pins it), so an alarm at once, until a later check has it rejected.
 */
export function evaluateBeaconVerifier(target, state) {
  if (!state || state.readOk === false || !state.registration) return undefined;
  if (state.registration !== "registered" || state.negative?.verdict !== "accepts") return null;
  return alarm(
    `${target.name} registered verifier accepts an invalid signature`,
    `verifyBeacon(${state.recipe ?? target.beacon.recipe}) returned true for round ${state.negative.round} with the last byte of its signature flipped: verifier ${state.verifier ?? "unknown"} would accept a forged round`,
  );
}

/** The condition of the monitor's own failure: a warning, and what it could not check is unknown, not down. */
export const beaconMonitorFailure = (detail) => warning("drand monitor failed internally", `${detail}; what it could not check is unknown until it runs again`);

/**
 * The monitor failing on an error of its own: a warning while any part of the last run did (the relay reads of a group, or
 * a registry read).
 */
export function evaluateBeaconMonitor(groups, states) {
  const failing = [];
  for (const group of groups) {
    if (states.get(groupStateKey(group.preset))?.monitor) failing.push(`the ${group.preset.id} relay reads`);
    for (const target of group.networks) if (states.get(networkStateKey(target.name))?.monitor) failing.push(`the ${target.name} registry read`);
  }
  return failing.length === 0 ? null : beaconMonitorFailure(`${listOf(failing)} failed on an error in the watchdog itself, not in a relay or a registry`);
}

/**
 * Every beacon condition of a run, as a Map from check name to condition (undefined, null or {severity, ...} as at the top
 * of this file). While no relay is fresh the relays' own warnings are unknown: the alarm covers them.
 */
export function evaluateBeaconChecks(groups, states) {
  const conditions = new Map();
  for (const group of groups) {
    const { preset } = group;
    const state = states.get(groupStateKey(preset)) ?? null;
    conditions.set(beaconFreshCheckName(preset), evaluateBeaconFresh(group, state, beaconUsage(group, states)));
    const down = state !== null && state.fresh === 0;
    for (const relay of group.relays) {
      const relayState = state?.relays?.[relay.id] ?? null;
      conditions.set(beaconRelayCheckName(preset, relay), down ? undefined : evaluateBeaconRelay(relay, relayState));
      conditions.set(beaconAgreementCheckName(preset, relay), evaluateBeaconAgreement(relay, relayState));
      conditions.set(beaconInfoCheckName(preset, relay), evaluateBeaconInfo(relay, relayState));
    }
    for (const target of group.networks) {
      const networkState = states.get(networkStateKey(target.name)) ?? null;
      conditions.set(beaconRegistrationCheckName(target.name), evaluateBeaconRegistration(target, networkState));
      conditions.set(beaconVerifyCheckName(target.name), evaluateBeaconVerify(target, networkState));
      conditions.set(beaconVerifierCheckName(target.name), evaluateBeaconVerifier(target, networkState));
    }
  }
  if (groups.length > 0) conditions.set(BEACON_MONITOR_CHECK, evaluateBeaconMonitor(groups, states));
  return conditions;
}
