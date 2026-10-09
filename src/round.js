// Chain reader for round networks (Robinhood Chain's D20VRFCoordinatorRobinhood). Each read is a fast part (head, requests,
// balances), a slow part every slowIntervalSeconds (roles, pricing, beacon; the code hashes once a day) and the logs, within a
// budget of LIMITS.roundMaxSubrequests fetches (see readRoundChain). Public endpoints that limit by source IP refuse Cloudflare's
// shared egress at random, so every batch fails over to the next endpoint in the same run, chunked to what each endpoint takes.
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

/**
 * An endpoint's id in stored state and logs: its host, or "keyed" for the optional keyed endpoint from a secret, whose URL may
 * carry its key and is never stored or logged.
 */
export const endpointId = (url, keyed = null) => {
  if (keyed && url === keyed) return "keyed";
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
};

/** A batch refused for rate or plan limits fails the endpoint, so the read moves on to the next one in the same run. */
const notRateLimited = (items) => (items.some((item) => item?.rateLimited) ? "rate limited" : null);

/**
 * `list` (URLs, or log endpoints {url, ...}) in configured order with the endpoints still cooling down after a rate limit moved
 * to the end: they are tried only when every other one has failed. The keyed endpoint, when set, goes first.
 */
export function orderEndpoints(list, cooldowns, nowSec, urlOf = (e) => e, keyed = null) {
  const cooling = (e) => (cooldowns?.[endpointId(urlOf(e), keyed)] ?? 0) > nowSec;
  return [...list.filter((e) => !cooling(e)), ...list.filter(cooling)];
}

/** The cooldowns after a read: expired ones dropped, each endpoint that refused for its limits this run cooled again. */
export function nextCooldowns(previous, failures, nowSec, keyed = null) {
  const out = {};
  for (const [id, until] of Object.entries(previous ?? {})) if (until > nowSec) out[id] = until;
  for (const f of failures) if (f.rateLimited) out[endpointId(f.url, keyed)] = nowSec + LIMITS.roundRpcCooldownSeconds;
  return out;
}

/** The pins the code check compares with, as one string: a change of configuration makes the check due at once. */
export function codePinsKey(net) {
  const pins = net.codeHashes;
  if (!pins) return null;
  const impls = Object.entries(pins.implementations ?? {}).map(([a, h]) => `${lower(a)}=${lower(h)}`).sort();
  return [`proxy=${lower(pins.proxy)}`, ...impls].join(",");
}

/**
 * Whether this run reads the coordinator: every run for a network read each minute; for one read less often, once its interval
 * has passed since the last read (less 30 s, as runs drift), and at once after a read that failed or was partial.
 */
export function roundReadDue(net, previous, nowSec) {
  const interval = net.readIntervalSeconds ?? 60;
  if (!previous || previous.checkedAt == null || !previous.complete) return true;
  return nowSec - previous.checkedAt >= Math.max(0, interval - 30);
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

/** Calls an endpoint takes in one batch: dRPC (keyless or keyed) at most 3, others any number. */
export function batchCap(url) {
  try {
    const host = new URL(url).host.toLowerCase();
    return host === "drpc.org" || host.endsWith(".drpc.org") ? 3 : Infinity;
  } catch {
    return Infinity;
  }
}

/** Whether the slow part (roles, pricing, beacon; the code hashes once a day) is read this run. */
export function slowReadDue(net, previous, nowSec) {
  if (codeCheckDue(net, previous, nowSec)) return true;
  const interval = net.slowIntervalSeconds ?? 600;
  return previous?.slowAt == null || nowSec - previous.slowAt >= Math.max(0, interval - 30);
}

/**
 * Batches over an ordered endpoint list, like RpcSession, with two differences: each endpoint's batch is split into chunks it
 * accepts (batchCap), and every fetch draws on the network's run budget (`budget.left`). An endpoint that fails any chunk, or
 * whose answers `validate` rejects, is left for the next one for the rest of the run. Running out of budget fails nothing: the
 * batch returns null with `exhausted` set, and the caller defers that part.
 */
export class RoundSession {
  constructor(urls, { fetch, timeoutMs, budget }) {
    this.urls = urls;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.budget = budget;
    this.index = 0;
    this.subrequests = 0;
    this.failures = [];
    this.lastError = null;
    this.exhausted = false;
  }

  get url() {
    return this.index < this.urls.length ? this.urls[this.index] : null;
  }

  async batch(calls, validate) {
    this.exhausted = false;
    while (this.index < this.urls.length) {
      const url = this.urls[this.index];
      const cap = batchCap(url);
      const items = [];
      let problem = null;
      let rateLimited = false;
      for (let i = 0; i < calls.length; i += cap) {
        if (this.budget.left <= 0) {
          this.exhausted = true;
          this.lastError = "subrequest budget";
          return null;
        }
        this.budget.left--;
        this.subrequests++;
        const one = new RpcSession([url], { fetch: this.fetch, timeoutMs: this.timeoutMs });
        const part = await one.batch(calls.slice(i, i + cap));
        if (!part) {
          problem = one.lastError ?? "failed";
          rateLimited = one.failures[0]?.rateLimited ?? false;
          break;
        }
        items.push(...part);
      }
      if (!problem && validate) {
        problem = validate(items);
        rateLimited = problem != null && items.some((item) => item?.rateLimited);
      }
      if (!problem) return items;
      this.failures.push({ url, error: problem, rateLimited });
      this.lastError = problem;
      this.index++;
    }
    return null;
  }
}

/**
 * Read one round network. `previous` is the stored round state (see applyRoundRead) or null. One run spends at most
 * LIMITS.roundMaxSubrequests fetches, in this order:
 *   fast (every read)     chainId, head block, nextRequestId and every keeper wallet's balance
 *   requests              getRoundRequest from the oldest request not yet settled
 *   slow (slowReadDue)    keeper, owner, pendingOwner, feeRecipient, pricing, keeperFeeBps, refundBps, backupKeeperCount,
 *                         isBackupKeeper per backup, beaconSchedule, beaconIdentity and the implementation slot; once a day
 *                         also the runtime code of the proxy and each accepted implementation
 *   logs                  with what is left of the budget (readLogs)
 * A part the budget cannot cover is deferred to a later run, not failed. Result always has {ok, complete, rpc, error, errors,
 * subrequests}; figures are null when unknown or not read this run. `scan` is null when the requests were not read; `logs` is null
 * when unknown; `code` is null when the code was not read this run; `slow` says whether the slow part was read.
 */
export async function readRoundChain(net, previous, { fetch, timeoutMs, nowSec = Math.floor(Date.now() / 1000), keyedRpc = null, consumerSeed = null } = {}) {
  const keyed = typeof keyedRpc === "string" && /^https:\/\//.test(keyedRpc.trim()) ? keyedRpc.trim() : null;
  const cooldowns = previous?.cooldowns ?? {};
  const budget = { left: LIMITS.roundMaxSubrequests };
  const stateUrls = [...(keyed ? [keyed] : []), ...orderEndpoints(net.rpcs, cooldowns, nowSec)];
  const session = new RoundSession(stateUrls, { fetch, timeoutMs, budget });
  const backups = net.backupKeepers ?? [];
  const errors = [];
  const out = {
    ok: false,
    complete: false,
    rpc: null,
    error: null,
    errors,
    subrequests: 0,
    // Endpoints that refused a batch for their limits this run: [{endpoint, step}] (ids, never URLs).
    rateLimited: [],
    cooldowns,
    deferred: [],
    slow: false,
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
    // New consumer notice: [{id, consumer}] of the requests decoded this run, and a batch of old requests (see readChain).
    consumers: [],
    consumerSeed: null,
    scanCursor: previous?.scanCursor == null ? null : BigInt(previous.scanCursor),
    logCursor: previous?.logCursor ?? null,
  };
  let logRead = null;
  const finish = () => {
    out.subrequests = session.subrequests + (logRead?.subrequests ?? 0);
    out.rpc = session.url ? endpointId(session.url, keyed) : null;
    const failures = [
      ...session.failures.map((f) => ({ ...f, step: "state" })),
      ...(logRead?.failures ?? []).map((f) => ({ ...f, step: "logs" })),
    ];
    out.rateLimited = failures.filter((f) => f.rateLimited).map((f) => ({ endpoint: endpointId(f.url, keyed), step: f.step }));
    out.cooldowns = nextCooldowns(cooldowns, failures, nowSec, keyed);
    return out;
  };
  const call = (data) => ["eth_call", [{ to: net.coordinator, data }, "latest"]];

  // Fast
  const fast = [["eth_chainId", []], ["eth_getBlockByNumber", ["latest", false]], call(ROUND_SELECTORS.nextRequestId), ["eth_getBalance", [net.keeper, "latest"]]];
  for (const wallet of backups) fast.push(["eth_getBalance", [wallet, "latest"]]);
  const a = await session.batch(fast, (items) => {
    try {
      if (notRateLimited(items)) return "rate limited";
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
  out.balanceWei = pick(a[3], hexToBigInt, errors, "balance");
  out.backupBalances = backups.map((address, i) => ({ address, balanceWei: pick(a[4 + i], hexToBigInt, errors, `backup balance ${address}`) }));
  if (out.block.baseFeeWei == null) errors.push("block: no baseFeePerGas");
  const head = out.block.number;

  // Requests. On an endpoint that takes 3 calls a batch, at most three batches' worth a run; a backlog is read over later runs.
  let scanFailed = false;
  if (out.nextRequestId != null) {
    const next = out.nextRequestId;
    const cap = batchCap(session.url);
    const window = BigInt(Number.isFinite(cap) ? Math.min(LIMITS.roundScanMaxIds, cap * 3) : LIMITS.roundScanMaxIds);
    let quiet = false;
    if (out.scanCursor == null) {
      // First run: look back one window for pending requests, without reporting the expired ones from before the watchdog.
      out.scanCursor = next > window ? next - window : 1n;
      quiet = true;
    }
    if (out.scanCursor > next) out.scanCursor = next; // never ahead of the chain (a redeployed coordinator, a rolled-back head)
    const end = out.scanCursor + window < next ? out.scanCursor + window : next;
    const scanIds = [];
    for (let id = out.scanCursor; id < end; id++) scanIds.push(id);
    const b = scanIds.length === 0 ? [] : await session.batch(scanIds.map((id) => call(encodeGetRoundRequest(id))), notRateLimited);
    if (b === null && session.exhausted) {
      out.deferred.push("requests");
    } else if (b === null) {
      scanFailed = true;
      errors.push(`getRoundRequest: ${session.lastError ?? "failed"}`);
    } else {
      // Ids past the window (or the head of a first scan) are unread: `pending.more`.
      const requests = scanIds.map((id, i) => ({ id, request: pick(b[i], decodeRoundRequest, errors, `getRoundRequest ${id}`) }));
      for (const { id, request } of requests) if (request) out.consumers.push({ id, consumer: request.consumer });
      const walk = walkRequests(requests, out.scanCursor, out.block.timestamp, { quiet, more: end < next });
      out.scan = { fromId: scanIds[0] ?? out.scanCursor, ids: scanIds.length, ...walk };
      out.scanCursor = walk.cursor;
    }
  }

  // Slow
  let slowFailed = false;
  if (slowReadDue(net, previous, nowSec)) {
    const S = ROUND_SELECTORS;
    const slow = [
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
    ];
    const authorizedIndex = slow.length;
    for (const wallet of backups) slow.push(call(encodeIsBackupKeeper(wallet)));
    const codeIndex = slow.length;
    const codeTargets = codeCheckDue(net, previous, nowSec) ? [net.coordinator, ...Object.keys(net.codeHashes.implementations ?? {})] : [];
    for (const address of codeTargets) slow.push(["eth_getCode", [address, "latest"]]);
    const c = await session.batch(slow, notRateLimited);
    if (c === null && session.exhausted) {
      out.deferred.push("roles");
    } else if (c === null) {
      slowFailed = true;
      errors.push(`roles: ${session.lastError ?? "failed"}`);
    } else {
      out.slow = true;
      out.keeper = pick(c[0], decodeAddress, errors, "keeper");
      out.owner = pick(c[1], decodeAddress, errors, "owner");
      out.pendingOwner = pick(c[2], decodeAddress, errors, "pendingOwner");
      out.feeRecipient = pick(c[3], decodeAddress, errors, "feeRecipient");
      out.pricing = pick(c[4], decodePricing, errors, "pricing");
      out.keeperFeeBps = pick(c[5], decodeUint16, errors, "keeperFeeBps");
      out.refundBps = pick(c[6], decodeUint16, errors, "refundBps");
      out.backupKeeperCount = pick(c[7], decodeUint256, errors, "backupKeeperCount");
      out.beaconSchedule = pick(c[8], decodeBeaconSchedule, errors, "beaconSchedule");
      if (net.beacon) out.beaconIdentity = pick(c[9], decodeBytes32, errors, "beaconIdentity");
      out.implementation = pick(c[10], decodeAddress, errors, "implementation slot");
      out.backupAuthorized = backups.map((address, i) => ({ address, allowed: pick(c[authorizedIndex + i], decodeBool, errors, `isBackupKeeper ${address}`) }));
      if (codeTargets.length > 0) {
        const hashes = {};
        let failed = false;
        for (const [i, address] of codeTargets.entries()) {
          const item = c[codeIndex + i];
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
    }
  }

  // Logs, with what is left
  logRead = await readLogs(net, out.logCursor, head, { fetch, timeoutMs, cooldowns, nowSec, keyed, budget });
  out.logRpc = logRead.rpc;
  if (logRead.logs) {
    out.logs = logRead.logs;
    out.logCursor = logRead.cursor;
    if (logRead.deferred) out.deferred.push("logs");
  } else {
    errors.push(`logs: ${logRead.error}`);
  }

  // Old requests for the new consumer notice, with what is left of the budget: never a failure, the rest comes next run.
  if (consumerSeed && budget.left > 0 && session.url) {
    const cap = batchCap(session.url);
    const most = Number.isFinite(cap) ? cap * budget.left : LIMITS.consumerSeedBatch;
    const ids = [];
    for (let id = BigInt(consumerSeed.fromId); id < BigInt(consumerSeed.toId) && ids.length < most; id++) ids.push(id);
    const d = ids.length === 0 ? null : await session.batch(ids.map((id) => call(encodeGetRoundRequest(id))), notRateLimited);
    if (d) {
      const consumers = [];
      for (const [i, id] of ids.entries()) {
        const request = pick(d[i], decodeRoundRequest, [], `getRoundRequest ${id}`);
        if (!request) break;
        consumers.push({ id, consumer: request.consumer });
      }
      if (consumers.length > 0) out.consumerSeed = { fromId: ids[0], toId: ids[0] + BigInt(consumers.length), consumers };
    }
  }

  // As on Arc, a view that could not be decoded leaves its figure unknown without failing the read; what was due and could be
  // paid for must be read. A part deferred for the budget is not a failure.
  const scanKnown = out.scan?.pending != null || out.deferred.includes("requests") || out.nextRequestId == null;
  out.complete = !scanFailed && !slowFailed && out.logs != null && scanKnown && out.nextRequestId != null;
  if (!out.complete) {
    out.error = errors.find((e) => /^(logs|getRoundRequest|roles|nextRequestId)/.test(e)) ?? session.lastError ?? "partial read";
  }
  return finish();
}

/**
 * The endpoints logs are read from: the keyed endpoint when set, then `logRpcs` ([{url, maxBlocks}], in order), or the state
 * endpoints when none are configured. A dRPC endpoint (keyless or keyed) is read in chunks of at most 100 blocks, 3 to a fetch.
 */
export function logEndpoints(net, keyed = null) {
  const list = Array.isArray(net.logRpcs) && net.logRpcs.length > 0 ? net.logRpcs : net.rpcs.map((url) => ({ url }));
  const full = keyed ? [{ url: keyed }, ...list] : list;
  return full.map((e) => ({
    url: e.url,
    maxBlocks: Number.isFinite(batchCap(e.url)) ? Math.min(e.maxBlocks ?? LIMITS.roundDrpcLogBlocks, LIMITS.roundDrpcLogBlocks) : e.maxBlocks ?? LIMITS.roundLogScanMaxBlocks,
    maxBatch: Math.min(batchCap(e.url), e.maxBatch ?? Infinity),
  }));
}

/**
 * Read the coordinator's refund and fulfilment logs from `cursor` + 1 towards `head`, trying each log endpoint in order (the keyed
 * one first, then the others with those cooling down after a rate limit last). On an endpoint the range is split into calls of at
 * most `maxBlocks` blocks, sent `maxBatch` to a fetch. Each fetch draws on `budget`; when it runs out, the blocks read so far are
 * returned (`deferred`) and the rest waits for the next run. Any failure moves the range to the next endpoint.
 * Returns {logs, cursor, rpc, deferred, subrequests, failures} or {logs: null, error, subrequests, failures}.
 */
export async function readLogs(net, cursor, head, { fetch, timeoutMs, cooldowns = {}, nowSec = 0, keyed = null, budget = { left: Infinity } } = {}) {
  const empty = { fromBlock: null, toBlock: null, skippedBlocks: 0, refunds: [], foreignFulfillments: [], requests: [] };
  // First run: start watching from the current head, no historical backfill.
  if (cursor == null) return { logs: empty, cursor: head, rpc: null, subrequests: 0, failures: [] };
  if (cursor >= head) return { logs: empty, cursor, rpc: null, subrequests: 0, failures: [] };
  let fromBlock = cursor + 1;
  let skippedBlocks = 0;
  if (head - cursor > LIMITS.roundLogMaxLagBlocks) {
    // Far behind (the watchdog was down): the recent blocks only, never deep history the RPC may no longer serve.
    const jumpTo = head - LIMITS.roundLogScanMaxBlocks + 1;
    skippedBlocks = jumpTo - fromBlock;
    fromBlock = jumpTo;
  }
  let subrequests = 0;
  let error = "no log endpoint";
  const failures = [];
  const [first, ...rest] = logEndpoints(net, keyed);
  const ordered = keyed ? [first, ...orderEndpoints(rest, cooldowns, nowSec, (e) => e.url)] : orderEndpoints([first, ...rest], cooldowns, nowSec, (e) => e.url);
  for (const endpoint of ordered) {
    const toBlock = Math.min(head, fromBlock + LIMITS.roundLogScanMaxBlocks - 1);
    const chunks = [];
    for (let from = fromBlock; from <= toBlock; from += endpoint.maxBlocks) chunks.push([from, Math.min(toBlock, from + endpoint.maxBlocks - 1)]);
    const session = new RpcSession([endpoint.url], { fetch, timeoutMs });
    const refunds = [];
    const foreignFulfillments = [];
    const requests = [];
    let readTo = null;
    let failed = null;
    let deferred = false;
    for (let i = 0; i < chunks.length; i += endpoint.maxBatch) {
      if (budget.left <= 0) {
        deferred = true;
        break;
      }
      budget.left--;
      const group = chunks.slice(i, i + endpoint.maxBatch);
      const items = await session.batch(
        group.map(([from, to]) => [
          "eth_getLogs",
          [{ address: net.coordinator, fromBlock: toQuantity(from), toBlock: toQuantity(to), topics: [[TOPICS.requestRefundedTo, TOPICS.randomnessFulfilled, TOPICS.randomnessRequested]] }],
        ]),
        notRateLimited,
      );
      if (!items) {
        failed = session.lastError ?? "failed";
        break;
      }
      for (const item of items) {
        const errs = [];
        const decoded = pick(item, (r) => decodeLogs(r, net), errs, "logs");
        if (!decoded) {
          failed = errs[0] ?? "logs: failed";
          break;
        }
        refunds.push(...decoded.refunds);
        foreignFulfillments.push(...decoded.foreignFulfillments);
        requests.push(...decoded.requests);
      }
      if (failed) break;
      readTo = group.at(-1)[1];
    }
    subrequests += session.subrequests;
    failures.push(...session.failures);
    if (!failed) {
      if (readTo == null) return { logs: empty, cursor, rpc: null, deferred: true, subrequests, failures };
      return {
        logs: { fromBlock, toBlock: readTo, skippedBlocks, refunds, foreignFulfillments, requests },
        cursor: readTo,
        rpc: endpointId(endpoint.url, keyed),
        deferred,
        subrequests,
        failures,
      };
    }
    error = `${endpointId(endpoint.url, keyed)}: ${failed}`;
  }
  return { logs: null, error, subrequests, failures };
}

/** Whether a fulfilment came from one of this network's own keeper wallets. */
function ourSubmitter(submitter, net) {
  return sameAddress(submitter, net.keeper) || (net.backupKeepers ?? []).some((wallet) => sameAddress(submitter, wallet));
}

function decodeLogs(result, net) {
  if (!Array.isArray(result)) throw new AbiError("logs not an array");
  const refunds = [];
  const foreignFulfillments = [];
  const requests = [];
  for (const log of result) {
    if (!log || log.removed === true) continue;
    if (!sameAddress(log.address, net.coordinator)) continue;
    const decoded = decodeCoordinatorLog(log);
    if (!decoded) continue;
    if (decoded.kind === "requested") requests.push({ id: decoded.requestId, consumer: decoded.consumer });
    else if (decoded.kind === "refund") refunds.push(decoded);
    else if (!ourSubmitter(decoded.submitter, net)) foreignFulfillments.push(decoded);
  }
  return { refunds, foreignFulfillments, requests };
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
    // When the slow part (roles, pricing, beacon) was last read: it is read again slowIntervalSeconds later.
    slowAt: read.ok && read.slow ? now : prev.slowAt ?? null,
    // Endpoints cooling down after a rate limit: {id: until}. Kept from a read that failed too, since that is when they matter.
    cooldowns: read.cooldowns ?? prev.cooldowns ?? {},
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
