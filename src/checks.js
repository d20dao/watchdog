// Pure threshold evaluation. Each check yields:
//   undefined -> unknown this run (keep the existing alert state untouched)
//   null      -> condition clear
//   {severity: "warning" | "alarm", title, detail, event?} -> condition active
// `event: true` marks one-shot notices (refunds, foreign submitters, dropped events): they are
// reported once per occurrence and auto-resolve silently on the next run without new occurrences.

import { LIMITS, THRESHOLDS } from "./config.js";
import { formatDuration, formatGwei, formatUsdc, listWithMore, requestLink } from "./format.js";

export const CHECK_NAMES = Object.freeze([
  "heartbeat",
  "health_age",
  "unhealthy",
  "dropped_events",
  "pending",
  "refund",
  "balance",
  "base_fee",
  "committer",
  "coordinator_impl",
  "registry_impl",
  "foreign_submitter",
  "rpc",
]);

const warning = (title, detail, extra = {}) => ({ severity: "warning", title, detail, ...extra });
const alarm = (title, detail, extra = {}) => ({ severity: "alarm", title, detail, ...extra });
const lower = (a) => (typeof a === "string" ? a.toLowerCase() : a);

/** Checks driven by the keeper's own reports. `report` is the stored report state or null. */
export function evaluateReportChecks(net, report, nowSec) {
  const T = THRESHOLDS;
  if (!report) {
    // Heartbeat only applies once the network has ever reported.
    return { heartbeat: null, health_age: null, unhealthy: null, dropped_events: null };
  }
  const result = {};

  const silence = nowSec - report.lastReceivedAt;
  const heartbeatDetail = `last report ${formatDuration(silence)} ago`;
  result.heartbeat = silence >= T.heartbeatAlarmSeconds
    ? alarm("heartbeat missing", heartbeatDetail)
    : silence >= T.heartbeatWarnSeconds
      ? warning("heartbeat missing", heartbeatDetail)
      : null;

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

  if (report.healthy) {
    result.unhealthy = null;
  } else {
    const since = report.unhealthySince ?? report.reportObservedAt;
    const duration = Math.max(0, report.reportObservedAt - since);
    const faults = report.faults.length > 0 ? report.faults.join(", ") : "no fault codes";
    const detail = duration >= 60 ? `faults: ${faults} (for ${formatDuration(duration)})` : `faults: ${faults}`;
    result.unhealthy = duration >= T.unhealthyAlarmSeconds
      ? alarm("keeper unhealthy", detail)
      : warning("keeper unhealthy", detail);
  }

  result.dropped_events = report.droppedTotal > report.droppedAlertedTotal
    ? warning(
        "keeper dropped audit events",
        `droppedTotal rose by ${report.droppedTotal - report.droppedAlertedTotal} to ${report.droppedTotal}`,
        { event: true },
      )
    : null;
  return result;
}

/** Checks driven by the chain read. `chain` is a readChain() result; unknown figures stay undefined. */
export function evaluateChainChecks(net, chain) {
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
    const detail = `keeper ${net.keeper} holds ${formatUsdc(chain.balanceWei)} USDC`;
    result.balance = chain.balanceWei < T.balanceAlarmWei
      ? alarm("keeper balance low", detail)
      : chain.balanceWei < T.balanceWarnWei
        ? warning("keeper balance low", detail)
        : null;
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
    result.coordinator_impl = lower(chain.coordinatorImpl) === lower(net.implementations.coordinator)
      ? null
      : alarm("coordinator implementation changed", `ERC-1967 slot is ${chain.coordinatorImpl}, expected ${net.implementations.coordinator}`);
  }
  if (chain.registryImpl != null) {
    result.registry_impl = lower(chain.registryImpl) === lower(net.implementations.registry)
      ? null
      : alarm("registry implementation changed", `ERC-1967 slot is ${chain.registryImpl}, expected ${net.implementations.registry}`);
  }
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
