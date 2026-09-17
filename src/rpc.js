// Chain reader: at most three JSON-RPC batches per network per run.
//   Round A (latest): chainId, head block, nextRequestId, committer, both implementation slots, keeper balance.
//   Round B (pinned to head): getPendingRequestIds window + coordinator logs since the stored cursor.
//   Round C (pinned to head, only when something is pending): getRequest for the smallest ids.
// Endpoints are tried in configured order; after a failure the run sticks to the next endpoint.

import {
  AbiError,
  decodeAddress,
  decodeCoordinatorLog,
  decodePendingRequestIds,
  decodeRequest,
  decodeUint256,
  encodeGetPendingRequestIds,
  encodeGetRequest,
  hexToBigInt,
  hexToSafeNumber,
  toQuantity,
} from "./abi.js";
import { IMPLEMENTATION_SLOT, LIMITS, SELECTORS, TOPICS } from "./config.js";
import { FetchTimeoutError, fetchText } from "./net.js";

export class RpcSession {
  constructor(urls, { fetch, timeoutMs = LIMITS.rpcTimeoutMs }) {
    this.urls = urls;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.index = 0;
    this.subrequests = 0;
    this.lastError = null;
  }

  get endpoint() {
    try {
      return new URL(this.urls[this.index]).host;
    } catch {
      return null;
    }
  }

  /**
   * Send one batch. `validate(items)` may return an error code to reject a response
   * (e.g. wrong chain) and move on to the next endpoint.
   * Returns an array of {result} | {error} in call order, or null when every endpoint failed.
   */
  async batch(calls, validate) {
    const payload = JSON.stringify(
      calls.map(([method, params], i) => ({ jsonrpc: "2.0", id: i + 1, method, params })),
    );
    while (this.index < this.urls.length) {
      const outcome = await this.#attempt(this.urls[this.index], payload, calls.length);
      if (outcome.items) {
        const problem = validate ? validate(outcome.items) : null;
        if (!problem) return outcome.items;
        this.lastError = problem;
      } else {
        this.lastError = outcome.error;
      }
      this.index++;
    }
    return null;
  }

  async #attempt(url, payload, count) {
    this.subrequests++;
    let response;
    try {
      response = await fetchText(
        this.fetch,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: payload,
        },
        this.timeoutMs,
      );
    } catch (err) {
      return { error: err instanceof FetchTimeoutError ? "timeout" : "network error" };
    }
    if (!response.ok) return { error: `http ${response.status}` };
    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      return { error: "invalid json" };
    }
    if (!Array.isArray(parsed)) return { error: "batch rejected" };
    const items = new Array(count);
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || !Number.isInteger(entry.id)) continue;
      const i = entry.id - 1;
      if (i < 0 || i >= count || items[i]) continue;
      items[i] = "error" in entry && entry.error != null
        ? { error: `rpc error ${Number.isInteger(entry.error?.code) ? entry.error.code : "unknown"}` }
        : { result: entry.result };
    }
    for (let i = 0; i < count; i++) if (!items[i]) return { error: "incomplete batch" };
    return { items };
  }
}

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

const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Read one network. `cursor` = {logCursor, logSpan} from the previous run (either may be null).
 * Result always has {ok, complete, rpc, error, errors, subrequests}; figures are null when unknown.
 * `pending` is null when unknown; `logs` is null when unknown or not scanned.
 */
export async function readChain(net, cursor, { fetch, timeoutMs } = {}) {
  const session = new RpcSession(net.rpcs, { fetch, timeoutMs });
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
    committer: null,
    coordinatorImpl: null,
    registryImpl: null,
    balanceWei: null,
    pending: null,
    logs: null,
    logCursor: cursor?.logCursor ?? null,
    logSpan: cursor?.logSpan ?? LIMITS.logScanMaxBlocks,
  };
  const finish = () => {
    out.subrequests = session.subrequests;
    out.rpc = session.endpoint;
    return out;
  };

  // Round A
  const a = await session.batch(
    [
      ["eth_chainId", []],
      ["eth_getBlockByNumber", ["latest", false]],
      ["eth_call", [{ to: net.coordinator, data: SELECTORS.nextRequestId }, "latest"]],
      ["eth_call", [{ to: net.registry, data: SELECTORS.committer }, "latest"]],
      ["eth_getStorageAt", [net.coordinator, IMPLEMENTATION_SLOT, "latest"]],
      ["eth_getStorageAt", [net.registry, IMPLEMENTATION_SLOT, "latest"]],
      ["eth_getBalance", [net.keeper, "latest"]],
    ],
    (items) => {
      try {
        if (!("result" in items[0]) || hexToBigInt(items[0].result) !== BigInt(net.chainId)) return "wrong chain id";
        if (!("result" in items[1])) return `block: ${items[1].error}`;
        decodeBlock(items[1].result);
        return null;
      } catch {
        return "invalid head block";
      }
    },
  );
  if (!a) {
    out.error = session.lastError ?? "all endpoints failed";
    return finish();
  }
  out.ok = true;
  out.block = decodeBlock(a[1].result);
  out.nextRequestId = pick(a[2], decodeUint256, errors, "nextRequestId");
  out.committer = pick(a[3], decodeAddress, errors, "committer");
  out.coordinatorImpl = pick(a[4], decodeAddress, errors, "coordinator slot");
  out.registryImpl = pick(a[5], decodeAddress, errors, "registry slot");
  out.balanceWei = pick(a[6], hexToBigInt, errors, "balance");
  if (out.block.baseFeeWei == null) errors.push("block: no baseFeePerGas");

  const head = out.block.number;
  const blockTag = toQuantity(head);

  // Round B
  const calls = [];
  let pendingIndex = -1;
  let logsIndex = -1;
  let logRange = null;
  if (out.nextRequestId != null) {
    const next = out.nextRequestId;
    if (next <= 1n) {
      out.pending = { count: 0, ids: [], oldest: null };
    } else {
      const window = BigInt(LIMITS.pendingScanWindow);
      const fromId = next > window ? next - window : 1n;
      pendingIndex = calls.length;
      calls.push(["eth_call", [{ to: net.coordinator, data: encodeGetPendingRequestIds(fromId, window) }, blockTag]]);
    }
  }
  if (out.logCursor == null) {
    // First run: start watching from the current head, no historical backfill.
    out.logCursor = head;
  } else if (out.logCursor < head) {
    const span = Math.min(Math.max(out.logSpan, LIMITS.logScanMinBlocks), LIMITS.logScanMaxBlocks);
    logRange = { fromBlock: out.logCursor + 1, toBlock: Math.min(head, out.logCursor + span) };
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
    out.logs = { fromBlock: null, toBlock: null, refunds: [], foreignFulfillments: [] };
  }

  let bFailed = false;
  if (calls.length > 0) {
    const b = await session.batch(calls);
    if (!b) {
      bFailed = true;
      errors.push(`round B: ${session.lastError ?? "failed"}`);
    } else {
      if (pendingIndex >= 0) {
        const decoded = pick(b[pendingIndex], (r) => decodePendingRequestIds(r, LIMITS.pendingScanWindow), errors, "pending ids");
        if (decoded) out.pending = { count: decoded.ids.length, ids: decoded.ids, oldest: null };
      }
      if (logsIndex >= 0) {
        const logs = pick(b[logsIndex], (r) => decodeLogs(r, net), errors, "logs");
        if (logs) {
          out.logs = { ...logRange, ...logs };
          out.logCursor = logRange.toBlock;
          out.logSpan = Math.min(LIMITS.logScanMaxBlocks, Math.max(out.logSpan, LIMITS.logScanMinBlocks) * 2);
        } else {
          out.logSpan = Math.max(LIMITS.logScanMinBlocks, Math.floor(out.logSpan / 2));
        }
      }
    }
  }

  // Round C
  let cFailed = false;
  if (out.pending && out.pending.count > 0) {
    const sorted = [...out.pending.ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const sample = sorted.slice(0, LIMITS.pendingDetailLimit);
    const c = await session.batch(
      sample.map((id) => ["eth_call", [{ to: net.coordinator, data: encodeGetRequest(id) }, blockTag]]),
    );
    if (!c) {
      cFailed = true;
      errors.push(`round C: ${session.lastError ?? "failed"}`);
      out.pending = null;
    } else {
      let oldest = null;
      let known = 0;
      sample.forEach((id, i) => {
        const request = pick(c[i], decodeRequest, errors, `getRequest ${id}`);
        if (!request) return;
        known++;
        const createdAt = request.deadline - LIMITS.requestTimeoutSeconds;
        const ageSeconds = Math.max(0, out.block.timestamp - createdAt);
        if (!oldest || ageSeconds > oldest.ageSeconds) oldest = { id, createdAt, ageSeconds };
      });
      if (known === 0) out.pending = null;
      else out.pending.oldest = oldest;
    }
  }

  out.complete = !bFailed && !cFailed;
  if (!out.complete) out.error = session.lastError ?? "partial read";
  return finish();
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
    else if (!sameAddress(decoded.submitter, net.keeper)) foreignFulfillments.push(decoded);
  }
  return { refunds, foreignFulfillments };
}
