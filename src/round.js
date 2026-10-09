// Chain reader for round networks (Robinhood Chain's D20VRFCoordinatorRobinhood): at most two JSON-RPC batches per run.
//   Round A (latest): chainId, head block, nextRequestId, keeper, owner, pendingOwner, feeRecipient, pricing, keeperFeeBps,
//                     refundBps, backupKeeperCount, isBackupKeeper for each configured backup, beaconSchedule, beaconIdentity,
//                     the implementation slot and every keeper wallet's balance; once a day also the runtime code of the proxy
//                     and of each accepted implementation, whose keccak256 is compared with the pinned hashes.
//   Round B (pinned to head, only when there is something to read): coordinator logs since the stored cursor, and
//                     getRoundRequest for the requests from the oldest one not yet settled, at most LIMITS.roundScanMaxIds.
// The public RPC keeps only about 6,000 blocks of state, so nothing reads deep history: requests are read by id at the head,
// and a log cursor left far behind jumps to the recent blocks. Contracts see L1 block numbers in block.number; everything
// here uses the RPC's own (L2) block numbers and timestamps.

import {
  AbiError,
  decodeAddress,
  decodeBeaconSchedule,
  decodeBool,
  decodeBytes32,
  decodeCoordinatorLog,
  decodePricing,
  decodeRoundRequest,
  decodeUint16,
  decodeUint256,
  encodeBeaconIdentity,
  encodeGetRoundRequest,
  encodeIsBackupKeeper,
  hexToBigInt,
  hexToSafeNumber,
  toQuantity,
} from "./abi.js";
import { IMPLEMENTATION_SLOT, LIMITS, ROUND_SELECTORS, TOPICS } from "./config.js";
import { RpcSession } from "./rpc.js";

const lower = (a) => (typeof a === "string" ? a.toLowerCase() : a);
const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function pick(item, decode, errors, label) {
  if (!item || "error" in item) {
    errors.push(`${label}: ${item ? item.error : "missing"}`);
    return null;
  }
  try {
    return decode(item.result);
  } catch (err) {
    errors.push(`${label}: ${err instanceof AbiError ? "decode error" : "invalid result"}`);
    return null;
  }
}

function decodeBlock(block) {
  if (!block || typeof block !== "object") throw new AbiError("no block");
  return {
    number: hexToSafeNumber(block.number),
    timestamp: hexToSafeNumber(block.timestamp),
    baseFeeWei: block.baseFeePerGas == null ? null : hexToBigInt(block.baseFeePerGas),
  };
}

/** The pins the code check compares with, as one string: a change of configuration makes the check due at once. */
export function codePinsKey(net) {
  const pins = net.codeHashes;
  if (!pins) return null;
  const impls = Object.entries(pins.implementations ?? {}).map(([a, h]) => `${lower(a)}=${lower(h)}`).sort();
  return [`proxy=${lower(pins.proxy)}`, ...impls].join(",");
}

/** Whether this run reads the runtime code: pins configured, and the last check due or made under other pins. */
export function codeCheckDue(net, previous, nowSec) {
  const key = codePinsKey(net);
  if (!key) return false;
  const check = previous?.codeCheck;
  return !check || check.pins !== key || nowSec >= (check.nextAt ?? 0);
}

/** keccak256 of 0x-prefixed runtime code, 0x-prefixed. Loaded on first use, so the Worker entry never evaluates the hash code. */
export async function codeHash(code) {
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const body = typeof code === "string" && /^0x([0-9a-fA-F]{2})*$/.test(code) ? code.slice(2) : null;
  if (body === null) throw new AbiError("code is not hex bytes");
  const bytes = Uint8Array.from(body.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  return "0x" + Array.from(keccak_256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Walk the requests read this run, in id order, at head time `nowTs`. A fulfilled or refunded request is settled; an open one
 * past its deadline expired unserved; an open one within it is pending. Deadlines rise with ids, so every expired request lies
 * before the first pending one, and the cursor moves past the leading run of settled and expired requests only.
 * `requests` is [{id, request}] (request null when it could not be read: the walk stops there).
 * `quiet`: expired requests are settled without being reported (the first scan, which looks back at requests from before it).
 */
export function walkRequests(requests, cursor, nowTs, { quiet = false, more = false } = {}) {
  const expired = [];
  const pendingIds = [];
  let oldest = null;
  let next = cursor;
  let advancing = true;
  let known = true;
  for (const { id, request } of requests) {
    if (!request) {
      known = false;
      break;
    }
    const open = !request.fulfilled && !request.refunded;
    if (open && nowTs <= request.deadline) {
      advancing = false;
      pendingIds.push(id);
      const createdAt = request.deadline - LIMITS.requestTimeoutSeconds;
      if (!oldest) oldest = { id, createdAt, ageSeconds: Math.max(0, nowTs - createdAt) };
      continue;
    }
    // Settled, or expired unserved. Only the leading run is acted on: anything after a pending request waits for the cursor.
    if (!advancing) continue;
    if (open && !quiet) expired.push({ requestId: id, deadline: request.deadline, consumer: request.consumer, feePaidWei: request.feePaidWei });
    next = id + 1n;
  }
  return {
    cursor: next,
    expired,
    // `more`: ids after the window were not read, so the count is a lower bound.
    pending: known ? { count: pendingIds.length, ids: pendingIds, oldest, more } : null,
  };
}

/**
 * Read one round network. `previous` is the stored round state (see applyRoundRead) or null.
 * Result always has {ok, complete, rpc, error, errors, subrequests}; figures are null when unknown. `scan` is null when the
 * requests were not read; `logs` is null when unknown or not scanned; `code` is null when the code was not read this run.
 */
export async function readRoundChain(net, previous, { fetch, timeoutMs, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const session = new RpcSession(net.rpcs, { fetch, timeoutMs });
  const backups = net.backupKeepers ?? [];
  const errors = [];
  const out = {
    ok: false,
    complete: false,
    rpc: null,
    error: null,
    errors,
    subrequests: 0,
    block: null,
    nextRequestId: null,
    keeper: null,
    owner: null,
    pendingOwner: null,
    feeRecipient: null,
    pricing: null,
    keeperFeeBps: null,
    refundBps: null,
    backupKeeperCount: null,
    backupAuthorized: null,
    beaconSchedule: null,
    beaconIdentity: null,
    implementation: null,
    balanceWei: null,
    backupBalances: null,
    code: null,
    scan: null,
    logs: null,
    scanCursor: previous?.scanCursor == null ? null : BigInt(previous.scanCursor),
    logCursor: previous?.logCursor ?? null,
  };
  const finish = () => {
    out.subrequests = session.subrequests;
    out.rpc = session.endpoint;
    return out;
  };
  const call = (data, tag = "latest") => ["eth_call", [{ to: net.coordinator, data }, tag]];

  // Round A
  const S = ROUND_SELECTORS;
  const roundA = [
    ["eth_chainId", []],
    ["eth_getBlockByNumber", ["latest", false]],
    call(S.nextRequestId),
    call(S.keeper),
    call(S.owner),
    call(S.pendingOwner),
    call(S.feeRecipient),
    call(S.pricing),
    call(S.keeperFeeBps),
    call(S.refundBps),
    call(S.backupKeeperCount),
    call(S.beaconSchedule),
    // Without a configured beacon the slot holds a call whose answer is not used, so the indexes below stay fixed.
    net.beacon ? call(encodeBeaconIdentity(net.beacon.id)) : ["eth_chainId", []],
    ["eth_getStorageAt", [net.coordinator, IMPLEMENTATION_SLOT, "latest"]],
    ["eth_getBalance", [net.keeper, "latest"]],
  ];
  const authorizedIndex = roundA.length;
  for (const wallet of backups) roundA.push(call(encodeIsBackupKeeper(wallet)));
  const backupIndex = roundA.length;
  for (const wallet of backups) roundA.push(["eth_getBalance", [wallet, "latest"]]);
  const codeIndex = roundA.length;
  const codeTargets = codeCheckDue(net, previous, nowSec)
    ? [net.coordinator, ...Object.keys(net.codeHashes.implementations ?? {})]
    : [];
  for (const address of codeTargets) roundA.push(["eth_getCode", [address, "latest"]]);

  const a = await session.batch(roundA, (items) => {
    try {
      if (!("result" in items[0]) || hexToBigInt(items[0].result) !== BigInt(net.chainId)) return "wrong chain id";
      if (!("result" in items[1])) return `block: ${items[1].error}`;
      decodeBlock(items[1].result);
      return null;
    } catch {
      return "invalid head block";
    }
  });
  if (!a) {
    out.error = session.lastError ?? "all endpoints failed";
    return finish();
  }
  out.ok = true;
  out.block = decodeBlock(a[1].result);
  out.nextRequestId = pick(a[2], decodeUint256, errors, "nextRequestId");
  out.keeper = pick(a[3], decodeAddress, errors, "keeper");
  out.owner = pick(a[4], decodeAddress, errors, "owner");
  out.pendingOwner = pick(a[5], decodeAddress, errors, "pendingOwner");
  out.feeRecipient = pick(a[6], decodeAddress, errors, "feeRecipient");
  out.pricing = pick(a[7], decodePricing, errors, "pricing");
  out.keeperFeeBps = pick(a[8], decodeUint16, errors, "keeperFeeBps");
  out.refundBps = pick(a[9], decodeUint16, errors, "refundBps");
  out.backupKeeperCount = pick(a[10], decodeUint256, errors, "backupKeeperCount");
  out.beaconSchedule = pick(a[11], decodeBeaconSchedule, errors, "beaconSchedule");
  if (net.beacon) out.beaconIdentity = pick(a[12], decodeBytes32, errors, "beaconIdentity");
  out.implementation = pick(a[13], decodeAddress, errors, "implementation slot");
  out.balanceWei = pick(a[14], hexToBigInt, errors, "balance");
  out.backupAuthorized = backups.map((address, i) => ({
    address,
    allowed: pick(a[authorizedIndex + i], decodeBool, errors, `isBackupKeeper ${address}`),
  }));
  out.backupBalances = backups.map((address, i) => ({
    address,
    balanceWei: pick(a[backupIndex + i], hexToBigInt, errors, `backup balance ${address}`),
  }));
  if (codeTargets.length > 0) {
    const hashes = {};
    let failed = false;
    for (const [i, address] of codeTargets.entries()) {
      const item = a[codeIndex + i];
      try {
        if (!item || "error" in item) throw new AbiError(item ? item.error : "missing");
        hashes[lower(address)] = await codeHash(item.result);
      } catch (err) {
        failed = true;
        errors.push(`code ${address}: ${err instanceof AbiError ? err.message : "invalid result"}`);
      }
    }
    out.code = failed ? { ok: false } : { ok: true, proxy: hashes[lower(net.coordinator)], implementations: hashes };
  }
  if (out.block.baseFeeWei == null) errors.push("block: no baseFeePerGas");

  const head = out.block.number;
  const blockTag = toQuantity(head);

  // Round B
  const calls = [];
  let logsIndex = -1;
  let logRange = null;
  if (out.logCursor == null) {
    // First run: start watching from the current head, no historical backfill.
    out.logCursor = head;
    out.logs = { fromBlock: null, toBlock: null, skippedBlocks: 0, refunds: [], foreignFulfillments: [] };
  } else if (out.logCursor < head) {
    let fromBlock = out.logCursor + 1;
    let skippedBlocks = 0;
    if (head - out.logCursor > LIMITS.roundLogMaxLagBlocks) {
      // Far behind (the watchdog was down): the recent blocks only, never deep history the RPC may no longer serve.
      const jumpTo = head - LIMITS.roundLogScanMaxBlocks + 1;
      skippedBlocks = jumpTo - fromBlock;
      fromBlock = jumpTo;
    }
    logRange = { fromBlock, toBlock: Math.min(head, fromBlock + LIMITS.roundLogScanMaxBlocks - 1), skippedBlocks };
    logsIndex = calls.length;
    calls.push([
      "eth_getLogs",
      [
        {
          address: net.coordinator,
          fromBlock: toQuantity(logRange.fromBlock),
          toBlock: toQuantity(logRange.toBlock),
          topics: [[TOPICS.requestRefundedTo, TOPICS.randomnessFulfilled]],
        },
      ],
    ]);
  } else {
    out.logs = { fromBlock: null, toBlock: null, skippedBlocks: 0, refunds: [], foreignFulfillments: [] };
  }

  let scanIds = [];
  let quiet = false;
  let more = false;
  if (out.nextRequestId != null) {
    const next = out.nextRequestId;
    const window = BigInt(LIMITS.roundScanMaxIds);
    if (out.scanCursor == null) {
      // First run: look back one window for pending requests, without reporting the expired ones from before the watchdog.
      out.scanCursor = next > window ? next - window : 1n;
      quiet = true;
    }
    if (out.scanCursor > next) out.scanCursor = next; // never ahead of the chain (a redeployed coordinator, a rolled-back head)
    const end = out.scanCursor + window < next ? out.scanCursor + window : next;
    more = end < next;
    for (let id = out.scanCursor; id < end; id++) scanIds.push(id);
  }
  const scanIndex = calls.length;
  for (const id of scanIds) calls.push(call(encodeGetRoundRequest(id), blockTag));

  let bFailed = false;
  if (calls.length > 0) {
    const b = await session.batch(calls);
    if (!b) {
      bFailed = true;
      errors.push(`round B: ${session.lastError ?? "failed"}`);
    } else {
      if (logsIndex >= 0) {
        const logs = pick(b[logsIndex], (r) => decodeLogs(r, net), errors, "logs");
        if (logs) {
          out.logs = { ...logRange, ...logs };
          out.logCursor = logRange.toBlock;
        }
      }
      if (out.nextRequestId != null) {
        const requests = scanIds.map((id, i) => ({ id, request: pick(b[scanIndex + i], decodeRoundRequest, errors, `getRoundRequest ${id}`) }));
        const walk = walkRequests(requests, out.scanCursor, out.block.timestamp, { quiet, more });
        out.scan = { fromId: scanIds[0] ?? out.scanCursor, ids: scanIds.length, ...walk };
        out.scanCursor = walk.cursor;
      }
    }
  } else if (out.nextRequestId != null) {
    out.scan = { fromId: out.scanCursor, ids: 0, ...walkRequests([], out.scanCursor, out.block.timestamp) };
  }

  // As on Arc, a view that could not be decoded leaves its figure unknown without failing the read; the requests and logs must be read.
  out.complete = !bFailed && out.logs != null && out.scan?.pending != null;
  if (!out.complete) out.error = bFailed ? session.lastError ?? "partial read" : errors.find((e) => /^(logs|getRoundRequest)/.test(e)) ?? "partial read";
  return finish();
}

/** Whether a fulfilment came from one of this network's own keeper wallets. */
function ourSubmitter(submitter, net) {
  return sameAddress(submitter, net.keeper) || (net.backupKeepers ?? []).some((wallet) => sameAddress(submitter, wallet));
}

function decodeLogs(result, net) {
  if (!Array.isArray(result)) throw new AbiError("logs not an array");
  const refunds = [];
  const foreignFulfillments = [];
  for (const log of result) {
    if (!log || log.removed === true) continue;
    if (!sameAddress(log.address, net.coordinator)) continue;
    const decoded = decodeCoordinatorLog(log);
    if (!decoded) continue;
    if (decoded.kind === "refund") refunds.push(decoded);
    else if (!ourSubmitter(decoded.submitter, net)) foreignFulfillments.push(decoded);
  }
  return { refunds, foreignFulfillments };
}

// ---------------------------------------------------------------------------------------------
// Stored state

const str = (v) => (v == null ? null : v.toString());

/**
 * The stored state after a read: the previous state with this read's known figures. Unknown figures keep their previous values,
 * and the code check keeps its last verdict until a read of the code succeeds. Pure; `now` is the run's time in seconds.
 */
export function applyRoundRead(net, previous, read, now) {
  const prev = previous ?? {};
  const success = read.ok && read.complete;
  const keep = (value, key) => (value == null ? prev[key] ?? null : value);
  const state = {
    checkedAt: now,
    ok: read.ok,
    complete: success,
    error: success ? null : read.error ?? "failed",
    rpc: read.rpc ?? null,
    consecutiveFailures: success ? 0 : (prev.consecutiveFailures ?? 0) + 1,
    lastSuccessAt: success ? now : prev.lastSuccessAt ?? null,
    blockNumber: read.ok ? read.block.number : prev.blockNumber ?? null,
    blockTimestamp: read.ok ? read.block.timestamp : prev.blockTimestamp ?? null,
    baseFeeWei: keep(str(read.block?.baseFeeWei), "baseFeeWei"),
    nextRequestId: keep(str(read.nextRequestId), "nextRequestId"),
    keeper: keep(read.keeper, "keeper"),
    owner: keep(read.owner, "owner"),
    pendingOwner: keep(read.pendingOwner, "pendingOwner"),
    feeRecipient: keep(read.feeRecipient, "feeRecipient"),
    pricing: read.pricing
      ? { minFeeWei: str(read.pricing.minFeeWei), feeMultiplier: read.pricing.feeMultiplier, fulfillGasOverhead: read.pricing.fulfillGasOverhead }
      : prev.pricing ?? null,
    keeperFeeBps: keep(read.keeperFeeBps, "keeperFeeBps"),
    refundBps: keep(read.refundBps, "refundBps"),
    implementation: keep(read.implementation, "implementation"),
    balanceWei: keep(str(read.balanceWei), "balanceWei"),
    backupBalances: mergeByAddress(read.ok ? read.backupBalances : null, prev.backupBalances, (b) => str(b.balanceWei)),
    pendingCount: read.ok && read.scan?.pending ? read.scan.pending.count : null,
    oldestPendingId: read.ok && read.scan?.pending?.oldest ? read.scan.pending.oldest.id.toString() : null,
    oldestPendingAge: read.ok && read.scan?.pending?.oldest ? read.scan.pending.oldest.ageSeconds : null,
    scanCursor: read.ok ? str(read.scanCursor) : prev.scanCursor ?? null,
    logCursor: read.ok ? read.logCursor : prev.logCursor ?? null,
    codeCheck: applyCodeRead(net, prev.codeCheck ?? null, read.code, now),
  };
  return state;
}

/** {lowercase address: value} from this read's list, else the previous value; wallets no longer configured are dropped. */
function mergeByAddress(list, previous, value) {
  const prev = previous ?? {};
  if (!Array.isArray(list)) return prev;
  const merged = {};
  for (const entry of list) {
    const key = entry.address.toLowerCase();
    const v = value(entry) ?? prev[key];
    if (v != null) merged[key] = v;
  }
  return merged;
}

/**
 * The code check's state: {pins, checkedAt, nextAt, verdict: "ok" | "mismatch" | null, detail}. A successful read compares the
 * hashes with the pins and is due again a day later; a failed one keeps the verdict and is retried an hour later.
 */
export function applyCodeRead(net, previous, code, now) {
  const pins = codePinsKey(net);
  if (!pins) return null;
  // Not read this run: the last check stands (a check made under other pins is due, and its verdict is not used).
  if (!code) return previous;
  if (!code.ok) {
    return {
      pins,
      checkedAt: previous?.checkedAt ?? null,
      nextAt: now + LIMITS.roundCodeRetrySeconds,
      verdict: previous?.pins === pins ? previous.verdict ?? null : null,
      detail: previous?.pins === pins ? previous.detail ?? null : null,
    };
  }
  const mismatches = [];
  if (lower(code.proxy) !== lower(net.codeHashes.proxy)) mismatches.push(`proxy ${net.coordinator} code hash ${code.proxy}, pinned ${net.codeHashes.proxy}`);
  for (const [address, pinned] of Object.entries(net.codeHashes.implementations ?? {})) {
    const seen = code.implementations?.[lower(address)];
    if (lower(seen) !== lower(pinned)) mismatches.push(`implementation ${address} code hash ${seen ?? "unknown"}, pinned ${pinned}`);
  }
  return {
    pins,
    checkedAt: now,
    nextAt: now + LIMITS.roundCodeCheckIntervalSeconds,
    verdict: mismatches.length === 0 ? "ok" : "mismatch",
    detail: mismatches.length === 0 ? null : mismatches.join("; "),
  };
}
