// Round networks (Robinhood Chain): configuration, the round reader against a fake JSON-RPC node, the checks, the cron run,
// Telegram routing to the network's own group, the health endpoint and the status flag.

import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { decodeBeaconSchedule, decodePricing, decodeRoundRequest, encodeGetRoundRequest, encodeIsBackupKeeper } from "../src/abi.js";
import { evaluateReportChecks, evaluateRoundChainChecks, roundCheckNames } from "../src/checks.js";
import {
  LIMITS,
  NETWORKS,
  ROUND_NETWORKS,
  ROUND_SELECTORS,
  THRESHOLDS,
  TOPICS,
  WATCHED_ROUND_NETWORKS,
  enabledNetworks,
  networkByName,
  reportThresholds,
} from "../src/config.js";
import { runCron } from "../src/cron.js";
import { handleFetch } from "../src/http.js";
import { applyRoundRead, codeCheckDue, codeHash, readLogs, readRoundChain, roundReadDue, walkRequests } from "../src/round.js";
import { buildStatus, renderHtml } from "../src/status.js";
import { BACKUP_STREAM, ingestReport, readAlerts, readRoundState, recentMessages } from "../src/store.js";
import { routeFor } from "../src/telegram.js";
import { addressWord, agentApiPoll, healthyBeaconRun, healthyRead, memoryStorage, pageText, sampleReport, word } from "./helpers.js";

const RH = ROUND_NETWORKS["robinhood-testnet"];
const NOW = 1791508306;
const ETH = 10n ** 18n;
const ZERO = "0x" + "0".repeat(40);
const OWNER = RH.owners[0];
const BACKUP = RH.backupKeepers[0];
const BACKUP_CHECK = `backup_balance:${BACKUP.toLowerCase()}`;
const PROXY_CODE = "0x6080604052";
const IMPL_CODE = "0x60806040526004361061";
const IMPL = RH.implementations.coordinator[0];

const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const selector = (signature) => hex(keccak_256(new TextEncoder().encode(signature))).slice(0, 10);

/** The testnet configuration with code pins that match the fake node's code. */
async function pinnedNet(overrides = {}) {
  return {
    ...RH,
    codeHashes: { proxy: await codeHash(PROXY_CODE), implementations: { [IMPL.toLowerCase()]: await codeHash(IMPL_CODE) } },
    ...overrides,
  };
}

/** A 17-word RoundRequest tuple. */
function roundRequest({ deadline = NOW + 30, fulfilled = false, refunded = false, feePaid = 25_000_000_000_000n } = {}) {
  return (
    "0x" +
    addressWord("0x1111111111111111111111111111111111111111") +
    word(100000) +
    word(131355450) +
    word(deadline) +
    addressWord("0x2222222222222222222222222222222222222222") +
    "a1".repeat(32) +
    "b2".repeat(32) +
    word(0) +
    word(21328727) +
    "c3".repeat(32) +
    "d4".repeat(32) +
    "e5".repeat(32) +
    "f6".repeat(32) +
    word(feePaid) +
    word(fulfilled ? 1 : 0) +
    word(fulfilled ? 1 : 0) +
    word(refunded ? 1 : 0)
  );
}

/**
 * A fake Robinhood node: the coordinator's views as deployed, requests by id, logs and code. Tests change `chain` to move it.
 * Records each batch's methods in `batches` and its endpoint in `urls`. `refuse(url, calls)` may answer an endpoint with an
 * HTTP status instead, as a capped or rate-limited endpoint does.
 */
function fakeNode(net) {
  const chain = {
    chainId: BigInt(net.chainId),
    head: 1000,
    timestamp: NOW,
    baseFee: 10_000_000n,
    next: 1n,
    keeper: net.keeper,
    owner: OWNER,
    pendingOwner: ZERO,
    feeRecipient: net.feeRecipients[0],
    pricing: [25_000_000_000_000n, 2n, 405000n],
    keeperFeeBps: 8000,
    refundBps: 10000,
    backupCount: 1,
    allowed: new Set(net.backupKeepers.map((a) => a.toLowerCase())),
    schedule: [0, 1791248239, 0, 0],
    identity: net.beacon.identity,
    impl: IMPL,
    balances: { [net.keeper.toLowerCase()]: 2n * ETH / 1000n, [BACKUP.toLowerCase()]: 2n * ETH / 1000n },
    code: { [net.coordinator.toLowerCase()]: PROXY_CODE, [IMPL.toLowerCase()]: IMPL_CODE },
    requests: new Map(),
    logs: [],
    fail: false,
  };
  const batches = [];
  const urls = [];
  let refuse = () => null;
  const answer = ({ method, params }) => {
    switch (method) {
      case "eth_chainId":
        return "0x" + chain.chainId.toString(16);
      case "eth_getBlockByNumber":
        return { number: "0x" + chain.head.toString(16), timestamp: "0x" + chain.timestamp.toString(16), baseFeePerGas: "0x" + chain.baseFee.toString(16) };
      case "eth_getStorageAt":
        return "0x" + addressWord(chain.impl);
      case "eth_getBalance":
        return "0x" + (chain.balances[params[0].toLowerCase()] ?? 0n).toString(16);
      case "eth_getCode":
        return chain.code[params[0].toLowerCase()] ?? "0x";
      case "eth_getLogs": {
        const from = parseInt(params[0].fromBlock, 16);
        const to = parseInt(params[0].toBlock, 16);
        return chain.logs.filter((log) => parseInt(log.blockNumber, 16) >= from && parseInt(log.blockNumber, 16) <= to);
      }
      case "eth_call": {
        const data = params[0].data;
        const S = ROUND_SELECTORS;
        const sel = data.slice(0, 10);
        if (sel === S.nextRequestId) return "0x" + word(chain.next);
        if (sel === S.keeper) return "0x" + addressWord(chain.keeper);
        if (sel === S.owner) return "0x" + addressWord(chain.owner);
        if (sel === S.pendingOwner) return "0x" + addressWord(chain.pendingOwner);
        if (sel === S.feeRecipient) return "0x" + addressWord(chain.feeRecipient);
        if (sel === S.pricing) return "0x" + chain.pricing.map(word).join("");
        if (sel === S.keeperFeeBps) return "0x" + word(chain.keeperFeeBps);
        if (sel === S.refundBps) return "0x" + word(chain.refundBps);
        if (sel === S.backupKeeperCount) return "0x" + word(chain.backupCount);
        if (sel === S.beaconSchedule) return "0x" + chain.schedule.map(word).join("");
        if (sel === S.beaconIdentity) return chain.identity;
        if (sel === S.isBackupKeeper) return "0x" + word(chain.allowed.has("0x" + data.slice(-40)) ? 1 : 0);
        if (sel === S.getRoundRequest) {
          const id = BigInt("0x" + data.slice(10));
          return chain.requests.get(id) ?? roundRequest({ fulfilled: true });
        }
        throw new Error(`unexpected call ${sel}`);
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
  const fetch = async (url, init) => {
    assert.ok(net.rpcs.includes(url) || (net.logRpcs ?? []).some((e) => e.url === url), "only the configured endpoints are read");
    if (chain.fail) return new Response("busy", { status: 503 });
    const calls = JSON.parse(init.body);
    const status = refuse(url, calls);
    if (status) return new Response("refused", { status });
    batches.push(calls.map((c) => c.method));
    urls.push(url);
    return Response.json(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: answer(c) })));
  };
  return { chain, batches, urls, fetch, setRefuse: (fn) => void (refuse = fn) };
}

const refundLog = (id, block, net = RH) => ({
  address: net.coordinator,
  blockNumber: "0x" + block.toString(16),
  transactionHash: "0x" + "ab".repeat(32),
  topics: [TOPICS.requestRefundedTo, "0x" + word(id), "0x" + addressWord("0x2222222222222222222222222222222222222222")],
  data: "0x" + word(25_000_000_000_000n) + word(1),
});
const fulfilledLog = (id, block, submitter, net = RH) => ({
  address: net.coordinator,
  blockNumber: "0x" + block.toString(16),
  topics: [TOPICS.randomnessFulfilled, "0x" + word(id), "0x" + addressWord(submitter)],
  data: "0x" + "d4".repeat(32),
});

// ---------------------------------------------------------------------------------------------
// Configuration and ABI

test("round selectors are the keccak256 of the coordinator's signatures, and the event topics are Arc's", () => {
  const signatures = {
    nextRequestId: "nextRequestId()",
    keeper: "keeper()",
    owner: "owner()",
    pendingOwner: "pendingOwner()",
    feeRecipient: "feeRecipient()",
    pricing: "pricing()",
    keeperFeeBps: "keeperFeeBps()",
    refundBps: "refundBps()",
    isBackupKeeper: "isBackupKeeper(address)",
    backupKeeperCount: "backupKeeperCount()",
    beaconSchedule: "beaconSchedule()",
    beaconIdentity: "beaconIdentity(uint8)",
    getRoundRequest: "getRoundRequest(uint256)",
  };
  assert.deepEqual(Object.keys(signatures).sort(), Object.keys(ROUND_SELECTORS).sort());
  for (const [key, signature] of Object.entries(signatures)) assert.equal(ROUND_SELECTORS[key], selector(signature), signature);
  assert.equal(TOPICS.randomnessFulfilled, hex(keccak_256(new TextEncoder().encode("RandomnessFulfilled(uint256,bytes32,address)"))));
  assert.equal(TOPICS.requestRefundedTo, hex(keccak_256(new TextEncoder().encode("RequestRefundedTo(uint256,address,uint256,bool)"))));
  assert.equal(encodeGetRoundRequest(35n), ROUND_SELECTORS.getRoundRequest + word(35));
  assert.equal(encodeIsBackupKeeper(BACKUP), ROUND_SELECTORS.isBackupKeeper + addressWord(BACKUP));
});

test("round networks: testnet and mainnet enabled and complete, unlisted; `enabled: false` switches a network off", () => {
  assert.deepEqual(Object.keys(WATCHED_ROUND_NETWORKS), ["robinhood-testnet", "robinhood-mainnet"]);
  for (const net of Object.values(WATCHED_ROUND_NETWORKS)) {
    assert.equal(net.kind, "round");
    assert.equal(net.statusListed, false, "unlisted until mainnet launch");
    assert.equal(net.ownTelegramGroup, true);
    assert.match(net.coordinator, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(net.implementations.coordinator.length > 0);
    for (const impl of net.implementations.coordinator) assert.match(net.codeHashes.implementations[impl.toLowerCase()], /^0x[0-9a-f]{64}$/, impl);
    assert.match(net.codeHashes.proxy, /^0x[0-9a-f]{64}$/);
    assert.match(net.beacon.identity, /^0x[0-9a-f]{64}$/);
    assert.ok(net.rpcs.every((url) => url.startsWith("https://")));
    assert.ok(!Object.hasOwn(NETWORKS, net.name), "never among the Arc networks");
  }
  const mainnet = ROUND_NETWORKS["robinhood-mainnet"];
  assert.equal(mainnet.chainId, "4663");
  assert.equal(mainnet.coordinator, "0xEc8b95B168c87294c45727Bd2ac903d09316D132");
  assert.deepEqual(mainnet.owners, ["0x7ad78fc8097DFEA5c12DBb503D6EB6E60f34B40B", "0xE953671bf063CF21F89BbA3bfdB4AFc5FE71078A"]);
  assert.notEqual(mainnet.coordinator.toLowerCase(), RH.coordinator.toLowerCase());
  assert.equal(networkByName("robinhood-mainnet"), mainnet);
  const switchedOff = enabledNetworks({ ...ROUND_NETWORKS, "robinhood-mainnet": { ...mainnet, enabled: false } });
  assert.deepEqual(Object.keys(switchedOff), ["robinhood-testnet"]);
  assert.equal(networkByName("robinhood-mainnet", NETWORKS, switchedOff), null);
  assert.equal(networkByName("robinhood-testnet"), RH);
  assert.equal(networkByName("arc-testnet"), NETWORKS["arc-testnet"]);
});

test("getRoundRequest, pricing and beaconSchedule return data", () => {
  const r = decodeRoundRequest(roundRequest({ deadline: 1791507310, feePaid: 25_000_000_000_000n }));
  assert.equal(r.deadline, 1791507310);
  assert.equal(r.round, 21328727);
  assert.equal(r.feePaidWei, 25_000_000_000_000n);
  assert.equal(r.fulfilled, false);
  assert.throws(() => decodeRoundRequest("0x" + word(1)), /17 words/);
  assert.deepEqual(decodePricing("0x" + word(25_000_000_000_000n) + word(2) + word(405000)), {
    minFeeWei: 25_000_000_000_000n,
    feeMultiplier: 2,
    fulfillGasOverhead: 405000,
  });
  assert.deepEqual(decodeBeaconSchedule("0x" + word(0) + word(1791248239) + word(1) + word(1791300000)), {
    beaconId: 0,
    since: 1791248239,
    nextBeaconId: 1,
    nextFrom: 1791300000,
  });
});

// ---------------------------------------------------------------------------------------------
// Request scan

test("the request walk settles the leading run, reports expiries once and stops at the first pending request", () => {
  const req = (fields) => decodeRoundRequest(roundRequest(fields));
  const requests = [
    { id: 5n, request: req({ fulfilled: true }) },
    { id: 6n, request: req({ deadline: NOW - 10 }) }, // expired unserved
    { id: 7n, request: req({ refunded: true, deadline: NOW - 5 }) },
    { id: 8n, request: req({ deadline: NOW + 20 }) }, // pending, 40 s old
    { id: 9n, request: req({ fulfilled: true }) },
    { id: 10n, request: req({ deadline: NOW + 55 }) },
  ];
  const walk = walkRequests(requests, 5n, NOW);
  assert.equal(walk.cursor, 8n);
  assert.deepEqual(walk.expired.map((e) => e.requestId), [6n]);
  assert.deepEqual(walk.pending.ids, [8n, 10n]);
  assert.deepEqual(walk.pending.oldest, { id: 8n, createdAt: NOW + 20 - 60, ageSeconds: 40 });
  // The first scan looks back at requests from before the watchdog: it settles their expiries without reporting them.
  assert.deepEqual(walkRequests(requests, 5n, NOW, { quiet: true }).expired, []);
  // A request that could not be read stops the walk: pending unknown, cursor before it.
  const broken = walkRequests([requests[0], { id: 6n, request: null }], 5n, NOW);
  assert.equal(broken.cursor, 6n);
  assert.equal(broken.pending, null);
});

test("round reader: two batches, figures decoded, first run looks back one window without reporting old expiries", async () => {
  const net = await pinnedNet();
  const node = fakeNode(net);
  node.chain.next = 41n; // ids 1..40; the first scan reads 9..40
  node.chain.requests.set(9n, roundRequest({ deadline: NOW - 600 })); // expired long before: settled quietly
  node.chain.requests.set(40n, roundRequest({ deadline: NOW + 50 })); // pending for 10 s
  const read = await readRoundChain(net, null, { fetch: node.fetch, nowSec: NOW });
  assert.equal(read.ok, true);
  assert.equal(read.complete, true);
  assert.equal(read.subrequests, 2);
  assert.equal(node.batches.length, 2);
  assert.ok(node.batches[0].filter((m) => m === "eth_getCode").length === 2, "the code is read on the first run");
  assert.deepEqual(node.batches[1], Array(32).fill("eth_call"), "no log scan on the first run, 32 requests");
  assert.deepEqual(node.urls, [net.rpcs[0], net.rpcs[0]], "state reads on the first endpoint");
  assert.equal(read.keeper, net.keeper.toLowerCase());
  assert.equal(read.owner, OWNER.toLowerCase());
  assert.deepEqual(read.pricing, { minFeeWei: 25_000_000_000_000n, feeMultiplier: 2, fulfillGasOverhead: 405000 });
  assert.deepEqual(read.backupAuthorized, [{ address: BACKUP, allowed: true }]);
  assert.equal(read.backupKeeperCount, 1n);
  assert.equal(read.beaconIdentity, net.beacon.identity);
  assert.equal(read.implementation, IMPL.toLowerCase());
  assert.equal(read.balanceWei, 2n * ETH / 1000n);
  assert.deepEqual(read.code, { ok: true, proxy: net.codeHashes.proxy, implementations: { [net.coordinator.toLowerCase()]: net.codeHashes.proxy, [IMPL.toLowerCase()]: net.codeHashes.implementations[IMPL.toLowerCase()] } });
  assert.deepEqual(read.scan.expired, []);
  assert.equal(read.scan.pending.count, 1);
  assert.equal(read.scan.pending.oldest.id, 40n);
  assert.equal(read.scanCursor, 40n);
  assert.equal(read.logCursor, 1000);

  const state = applyRoundRead(net, null, read, NOW);
  assert.equal(state.scanCursor, "40");
  assert.equal(state.codeCheck.verdict, "ok");
  assert.equal(state.codeCheck.nextAt, NOW + LIMITS.roundCodeCheckIntervalSeconds);
  assert.equal(codeCheckDue(net, state, NOW + 60), false, "the code is read once a day");
  assert.deepEqual(evaluateRoundChainChecks(net, read, state), {
    pending: null,
    expired: null,
    refund: null,
    balance: null,
    backup_keepers: null,
    base_fee: null,
    keeper: null,
    owner: null,
    fee_recipient: null,
    pricing: null,
    beacon: null,
    coordinator_impl: null,
    code_hash: null,
    foreign_submitter: null,
    [BACKUP_CHECK]: null,
  });
});

test("round reader: a later run reports a request that expired unserved, refunds and foreign fulfilments, and moves its cursors", async () => {
  const net = await pinnedNet();
  const node = fakeNode(net);
  node.chain.next = 3n;
  let state = applyRoundRead(net, null, await readRoundChain(net, null, { fetch: node.fetch, nowSec: NOW }), NOW);
  assert.equal(state.scanCursor, "3");

  // Two new requests: 3 is served by a stranger, 4 is never served.
  node.chain.next = 5n;
  node.chain.head = 1600;
  node.chain.timestamp = NOW + 120;
  node.chain.requests.set(4n, roundRequest({ deadline: NOW + 80 }));
  node.chain.logs = [fulfilledLog(3, 1200, "0x9999999999999999999999999999999999999999"), refundLog(2, 1500), fulfilledLog(1, 1300, BACKUP)];
  node.batches.length = 0;
  node.urls.length = 0;
  const read = await readRoundChain(net, state, { fetch: node.fetch, nowSec: NOW + 120 });
  assert.equal(node.batches[0].includes("eth_getCode"), false, "the code is not read again the same day");
  assert.deepEqual(node.batches.slice(1).sort(), [["eth_call", "eth_call"], ["eth_getLogs"]]);
  assert.equal(node.urls[node.batches.findIndex((b) => b[0] === "eth_getLogs")], net.logRpcs[0].url, "logs on the first log endpoint");
  assert.deepEqual(read.scan.expired.map((e) => e.requestId), [4n]);
  assert.equal(read.scanCursor, 5n);
  assert.deepEqual([read.logs.fromBlock, read.logs.toBlock], [1001, 1600]);
  assert.deepEqual(read.logs.refunds.map((r) => r.requestId), [2n]);
  assert.deepEqual(read.logs.foreignFulfillments.map((f) => f.requestId), [3n], "the backup keeper's fulfilment is ours");
  state = applyRoundRead(net, state, read, NOW + 120);
  const checks = evaluateRoundChainChecks(net, read, state);
  assert.equal(checks.expired.severity, "alarm");
  assert.equal(checks.expired.event, true);
  assert.match(checks.expired.detail, /request 4 \(fee 0\.000025 ETH\)/);
  assert.equal(checks.refund.severity, "alarm");
  assert.match(checks.refund.detail, /request 2 \(0\.000025 ETH paid to 0x2222/);
  assert.equal(checks.foreign_submitter.severity, "warning");

  // Nothing new: the next run reads only the logs since the cursor, and the one-shot alerts clear.
  node.chain.head = 1700;
  node.chain.logs = [];
  node.batches.length = 0;
  const quiet = await readRoundChain(net, state, { fetch: node.fetch, nowSec: NOW + 180 });
  assert.deepEqual(node.batches[1], ["eth_getLogs"]);
  assert.equal(quiet.subrequests, 2);
  assert.deepEqual([quiet.logs.fromBlock, quiet.logs.toBlock], [1601, 1700]);
  const cleared = evaluateRoundChainChecks(net, quiet, applyRoundRead(net, state, quiet, NOW + 180));
  assert.equal(cleared.expired, null);
  assert.equal(cleared.refund, null);
});

test("round reader: a log cursor far behind jumps to the recent blocks instead of deep history", async () => {
  const net = await pinnedNet();
  const node = fakeNode(net);
  node.chain.head = 100_000;
  const state = { scanCursor: "1", logCursor: 1000, codeCheck: null };
  const read = await readRoundChain(net, state, { fetch: node.fetch, nowSec: NOW });
  assert.equal(read.logs.fromBlock, 100_000 - LIMITS.roundLogScanMaxBlocks + 1);
  assert.equal(read.logs.toBlock, 100_000);
  assert.equal(read.logs.skippedBlocks, 100_000 - LIMITS.roundLogScanMaxBlocks - 1000);
  // Within the bound, a backlog is caught up oldest first.
  const behind = await readRoundChain(net, { ...state, logCursor: 100_000 - 12_000 }, { fetch: node.fetch, nowSec: NOW });
  assert.deepEqual([behind.logs.fromBlock, behind.logs.toBlock], [88_001, 88_000 + LIMITS.roundLogScanMaxBlocks]);
});

test("round reader: a failed node leaves every chain check unknown, and three failed runs warn", async () => {
  const net = await pinnedNet();
  const node = fakeNode(net);
  node.chain.fail = true;
  const read = await readRoundChain(net, null, { fetch: node.fetch, nowSec: NOW });
  assert.equal(read.ok, false);
  assert.equal(read.error, "http 503");
  const checks = evaluateRoundChainChecks(net, read, null);
  assert.ok(Object.entries(checks).every(([, v]) => v === undefined), JSON.stringify(checks));
  // A wrong chain is an endpoint failure too.
  const wrong = fakeNode(net);
  wrong.chain.chainId = 4663n;
  assert.equal((await readRoundChain(net, null, { fetch: wrong.fetch, nowSec: NOW })).error, "wrong chain id");
});

test("code hashes: a mismatch alarms and holds until a read matches; a failed read retries in an hour; new pins are due at once", async () => {
  const net = await pinnedNet();
  const node = fakeNode(net);
  node.chain.code[IMPL.toLowerCase()] = "0x6080";
  const first = await readRoundChain(net, null, { fetch: node.fetch, nowSec: NOW });
  const state = applyRoundRead(net, null, first, NOW);
  assert.equal(state.codeCheck.verdict, "mismatch");
  const checks = evaluateRoundChainChecks(net, first, state);
  assert.equal(checks.code_hash.severity, "alarm");
  assert.match(checks.code_hash.detail, new RegExp(`implementation ${IMPL.toLowerCase()}`));
  // The verdict stands while the code is not read, even when the chain read itself fails.
  assert.equal(evaluateRoundChainChecks(net, { ok: false }, state).code_hash.severity, "alarm");
  // A code read that failed keeps the verdict and is tried again an hour later.
  const failed = applyRoundRead(net, state, { ok: true, complete: true, block: { number: 1, timestamp: NOW }, code: { ok: false } }, NOW + 86400);
  assert.equal(failed.codeCheck.verdict, "mismatch");
  assert.equal(failed.codeCheck.nextAt, NOW + 86400 + LIMITS.roundCodeRetrySeconds);
  // Changed pins (an upgrade approved in the configuration): due now, and the old verdict no longer counts.
  const upgraded = { ...net, codeHashes: { ...net.codeHashes, implementations: { ...net.codeHashes.implementations, ["0x" + "12".repeat(20)]: "0x" + "34".repeat(32) } } };
  assert.equal(codeCheckDue(upgraded, state, NOW + 60), true);
  assert.equal(evaluateRoundChainChecks(upgraded, first, state).code_hash, undefined);
});

// ---------------------------------------------------------------------------------------------
// Checks

/** A healthy readRoundChain() result for the testnet, with overrides. */
function roundRead(overrides = {}) {
  return {
    ok: true,
    complete: true,
    rpc: "rpc.example",
    error: null,
    errors: [],
    subrequests: 2,
    block: { number: 1000, timestamp: NOW, baseFeeWei: 10_000_000n },
    nextRequestId: 10n,
    keeper: RH.keeper.toLowerCase(),
    owner: OWNER.toLowerCase(),
    pendingOwner: ZERO,
    feeRecipient: RH.feeRecipients[0].toLowerCase(),
    pricing: { minFeeWei: 25_000_000_000_000n, feeMultiplier: 2, fulfillGasOverhead: 405000 },
    keeperFeeBps: 8000,
    refundBps: 10000,
    backupKeeperCount: 1n,
    backupAuthorized: [{ address: BACKUP, allowed: true }],
    beaconSchedule: { beaconId: 0, since: 1791248239, nextBeaconId: 0, nextFrom: 0 },
    beaconIdentity: RH.beacon.identity,
    implementation: IMPL.toLowerCase(),
    balanceWei: 2n * ETH / 1000n,
    backupBalances: [{ address: BACKUP, balanceWei: 2n * ETH / 1000n }],
    code: null,
    scan: { fromId: 10n, ids: 0, cursor: 10n, expired: [], pending: { count: 0, ids: [], oldest: null, more: false } },
    logs: { fromBlock: 990, toBlock: 1000, skippedBlocks: 0, refunds: [], foreignFulfillments: [] },
    scanCursor: 10n,
    logCursor: 1000,
    ...overrides,
  };
}

test("round checks: role, owner, fee recipient, pricing, beacon and implementation drift", () => {
  const check = (overrides) => evaluateRoundChainChecks(RH, roundRead(overrides), null);
  const stranger = "0x9999999999999999999999999999999999999999";
  assert.equal(check({ keeper: stranger }).keeper.severity, "alarm");
  assert.equal(check({ owner: stranger }).owner.severity, "alarm");
  assert.equal(check({ pendingOwner: stranger }).owner.severity, "alarm");
  assert.match(check({ pendingOwner: stranger }).owner.title, /unknown address/);
  // The mainnet entry accepts both the deployer and the Safe as owner, and a pending move to the Safe only warns.
  const mainnet = { ...ROUND_NETWORKS["robinhood-mainnet"], coordinator: RH.coordinator, implementations: RH.implementations };
  const safe = "0xE953671bf063CF21F89BbA3bfdB4AFc5FE71078A";
  assert.equal(evaluateRoundChainChecks(mainnet, roundRead({ keeper: mainnet.keeper, owner: safe.toLowerCase() }), null).owner, null);
  assert.equal(evaluateRoundChainChecks(mainnet, roundRead({ keeper: mainnet.keeper, pendingOwner: safe }), null).owner.severity, "warning");
  assert.equal(check({ feeRecipient: stranger }).fee_recipient.severity, "alarm");
  const pricing = check({ pricing: { minFeeWei: 1n, feeMultiplier: 2, fulfillGasOverhead: 500000 }, refundBps: 5000 }).pricing;
  assert.equal(pricing.severity, "warning");
  assert.equal(pricing.detail, "minFee 1 wei (expected 25000000000000), fulfillGasOverhead 500000 (expected 405000), refundBps 5000 (expected 10000)");
  assert.equal(check({ beaconIdentity: "0x" + "00".repeat(32) }).beacon.severity, "alarm");
  assert.equal(check({ beaconSchedule: { beaconId: 1, since: 1, nextBeaconId: 1, nextFrom: 0 } }).beacon.title, "another beacon in force");
  assert.equal(check({ beaconSchedule: { beaconId: 0, since: 1, nextBeaconId: 1, nextFrom: 1791600000 } }).beacon.title, "beacon change scheduled");
  assert.equal(check({ implementation: stranger }).coordinator_impl.severity, "alarm");
  assert.equal(check({ backupAuthorized: [{ address: BACKUP, allowed: false }], backupKeeperCount: 0n }).backup_keepers.severity, "warning");
  assert.equal(check({ backupKeeperCount: 2n }).backup_keepers.severity, "alarm");
  // A view that could not be decoded leaves its check unknown.
  assert.equal(check({ owner: null }).owner, undefined);
  assert.equal(check({ backupAuthorized: [{ address: BACKUP, allowed: null }] }).backup_keepers, undefined);
});

test("round checks: ETH balances, base fee against the 3 gwei cap, and pending age", () => {
  const check = (overrides) => evaluateRoundChainChecks(RH, roundRead(overrides), null);
  assert.equal(check({ balanceWei: RH.balances.warnWei }).balance, null);
  assert.equal(check({ balanceWei: RH.balances.warnWei - 1n }).balance.severity, "warning");
  const low = check({ balanceWei: RH.balances.alarmWei - 1n }).balance;
  assert.equal(low.severity, "alarm");
  assert.match(low.detail, /holds 0\.0002999 ETH \(warning below 0\.001, alarm below 0\.0003\)/);
  assert.equal(check({ backupBalances: [{ address: BACKUP, balanceWei: RH.balances.backupWarnWei - 1n }] })[BACKUP_CHECK].severity, "warning");
  assert.equal(check({ backupBalances: [{ address: BACKUP, balanceWei: RH.balances.backupAlarmWei - 1n }] })[BACKUP_CHECK].severity, "alarm");
  // 2 x base fee against 3 gwei: no tip is paid on Robinhood Chain.
  assert.equal(check({ block: { number: 1, timestamp: NOW, baseFeeWei: 900_000_000n } }).base_fee, null);
  assert.equal(check({ block: { number: 1, timestamp: NOW, baseFeeWei: 1_000_000_000n } }).base_fee.severity, "warning");
  assert.equal(check({ block: { number: 1, timestamp: NOW, baseFeeWei: 1_300_000_000n } }).base_fee.detail, "2 x base fee = 2.6 gwei is 86.66% of the 3 gwei fee cap");
  const pending = (age, more = false) =>
    check({ scan: { expired: [], pending: { count: 2, ids: [7n, 8n], oldest: { id: 7n, createdAt: NOW - age, ageSeconds: age }, more } } }).pending;
  assert.equal(pending(24), null);
  assert.equal(pending(25).severity, "warning");
  assert.equal(pending(45, true).severity, "alarm");
  assert.equal(pending(45, true).detail, "request 7 pending for 45s (2+ pending)");
  assert.deepEqual(roundCheckNames(RH).slice(6, 10), ["refund", "balance", BACKUP_CHECK, "backup_heartbeat"]);
});

// ---------------------------------------------------------------------------------------------
// Cron, Telegram routing, health endpoint, status

const ROUTED = {
  TELEGRAM_BOT_TOKEN: "123456:throwaway-arc-token",
  TELEGRAM_CHAT_ID: "-100111",
  TELEGRAM_CHAT_ID_ROBINHOOD_TESTNET: "-100222",
  TELEGRAM_BOT_TOKEN_ROBINHOOD_TESTNET: "654321:throwaway-robinhood-token",
};

function cronHarness(env, net = RH) {
  const storage = memoryStorage();
  const state = { clock: NOW, read: roundRead(), telegram: [] };
  const fetch = async (url, init) => {
    assert.ok(url.startsWith("https://api.telegram.org/bot"));
    state.telegram.push({ token: url.slice("https://api.telegram.org/bot".length).split("/")[0], ...JSON.parse(init.body) });
    return new Response("{}");
  };
  const run = (seconds = 0) => {
    state.clock = NOW + seconds;
    return runCron({
      storage,
      env,
      fetch,
      clock: () => state.clock * 1000,
      networks: {},
      roundNetworks: { [net.name]: net },
      readRoundChainImpl: async () => state.read,
    });
  };
  return { storage, state, run };
}

test("routing: a round network goes only to its own group, with its own bot when set; Arc and the beacon keep theirs", () => {
  const own = new Set(["robinhood-testnet"]);
  assert.deepEqual(routeFor(ROUTED, "robinhood-testnet", own), { tokenSecret: "TELEGRAM_BOT_TOKEN_ROBINHOOD_TESTNET", chatId: "-100222" });
  assert.deepEqual(routeFor({ ...ROUTED, TELEGRAM_BOT_TOKEN_ROBINHOOD_TESTNET: " " }, "robinhood-testnet", own), {
    tokenSecret: "TELEGRAM_BOT_TOKEN",
    chatId: "-100222",
  });
  assert.equal(routeFor({ ...ROUTED, TELEGRAM_CHAT_ID_ROBINHOOD_TESTNET: "" }, "robinhood-testnet", own), null, "never the default chat");
  assert.deepEqual(routeFor(ROUTED, "arc-testnet", own), { tokenSecret: "TELEGRAM_BOT_TOKEN", chatId: "-100111" });
  assert.deepEqual(routeFor({ ...ROUTED, TELEGRAM_CHAT_ID_ARC_TESTNET: "-100333" }, "arc-testnet", own), { tokenSecret: "TELEGRAM_BOT_TOKEN", chatId: "-100333" });
  assert.deepEqual(routeFor(ROUTED, "beacon", own), { tokenSecret: "TELEGRAM_BOT_TOKEN", chatId: "-100111" });
});

test("cron: a dead Robinhood keeper alarms in the Robinhood group through its own bot, and resolves there", async () => {
  const h = cronHarness(ROUTED);
  ingestReport(h.storage, {
    network: RH.name,
    reportId: "r-1",
    bodySha256: "00".repeat(32),
    receivedAt: NOW,
    observedAt: NOW,
    nodeId: "0x" + "ab".repeat(32),
    healthy: true,
    healthObservedAt: NOW,
    sendEnabled: true,
    faults: [],
    role: "primary",
    droppedTotal: 0,
    droppedCount: 0,
    failedCounts: {},
    eventCount: 0,
  });
  let summary = await h.run(60);
  assert.equal(summary.messagesQueued, 0);
  assert.equal(summary.networks[RH.name].chain, "ok");
  // Testnet keepers report every 300 s: one missed report raises nothing, and nor does the 5-minute gap between chain reads.
  summary = await h.run(600);
  assert.equal(summary.messagesQueued, 0);
  summary = await h.run(660);
  assert.deepEqual(summary.networks[RH.name].activeAlerts, ["heartbeat"]);
  assert.match(h.state.telegram[0].text, /WARNING heartbeat missing: last report 11m ago/, "a warning after two missed reports");
  summary = await h.run(960);
  assert.equal(h.state.telegram.length, 2);
  assert.equal(h.state.telegram.at(-1).chat_id, "-100222");
  assert.equal(h.state.telegram.at(-1).token, ROUTED.TELEGRAM_BOT_TOKEN_ROBINHOOD_TESTNET);
  assert.match(h.state.telegram.at(-1).text, /^\[robinhood-testnet\] ALARM heartbeat missing: last report 16m ago/);

  // The chain shows it too: a request expires unserved (one message), and the stored state follows the read.
  h.state.read = roundRead({ scan: { expired: [{ requestId: 12n, deadline: NOW, feePaidWei: 25_000_000_000_000n }], pending: { count: 0, ids: [], oldest: null, more: false } }, scanCursor: 13n });
  summary = await h.run(1020);
  assert.equal(summary.networks[RH.name].chain, "not due", "read at 960, next at 1260");
  summary = await h.run(1260);
  assert.match(h.state.telegram.at(-1).text, /ALARM request expired without fulfilment: request 12/);
  assert.equal(readRoundState(h.storage, RH.name).scanCursor, "13");
  h.state.read = roundRead();
  summary = await h.run(1320);
  assert.deepEqual(summary.networks[RH.name].activeAlerts, ["heartbeat", "expired"], "not read: the one-shot stands until the next read");
  summary = await h.run(1560);
  assert.deepEqual(summary.networks[RH.name].activeAlerts, ["heartbeat"], "the one-shot expiry clears silently");

  ingestReport(h.storage, { network: RH.name, reportId: "r-2", bodySha256: "00".repeat(32), receivedAt: NOW + 1600, observedAt: NOW + 1600, nodeId: "0x" + "ab".repeat(32), healthy: true, healthObservedAt: NOW + 1600, sendEnabled: true, faults: [], droppedTotal: 0, droppedCount: 0, failedCounts: {}, eventCount: 0 });
  summary = await h.run(1620);
  assert.equal(summary.networks[RH.name].chain, "not due");
  assert.match(h.state.telegram.at(-1).text, /^\[robinhood-testnet\] RESOLVED heartbeat missing/, "report checks run every minute");
  assert.ok(h.state.telegram.every((m) => m.chat_id === "-100222"), "nothing reached the Arc chat");
});

test("report timing per network: testnet at 300 s, mainnet at 60 s, Arc unchanged", () => {
  const report = { lastReceivedAt: NOW, reportObservedAt: NOW, healthObservedAt: NOW, healthy: true, faults: [], droppedTotal: 0, droppedAlertedTotal: 0 };
  const heartbeat = (net, silence) => evaluateReportChecks(net, report, NOW + silence).heartbeat?.severity ?? null;
  const mainnet = ROUND_NETWORKS["robinhood-mainnet"];
  const arc = NETWORKS["arc-testnet"];
  assert.deepEqual([599, 660, 960].map((t) => heartbeat(RH, t)), [null, "warning", "alarm"]);
  assert.deepEqual([149, 150, 240].map((t) => heartbeat(mainnet, t)), [null, "warning", "alarm"]);
  assert.deepEqual([149, 150, 240].map((t) => heartbeat(arc, t)), [null, "warning", "alarm"]);
  assert.deepEqual(reportThresholds(arc), {
    heartbeatWarnSeconds: THRESHOLDS.heartbeatWarnSeconds,
    heartbeatAlarmSeconds: THRESHOLDS.heartbeatAlarmSeconds,
    healthAgeWarnSeconds: THRESHOLDS.healthAgeWarnSeconds,
    healthAgeAlarmSeconds: THRESHOLDS.healthAgeAlarmSeconds,
    unhealthyAlarmSeconds: THRESHOLDS.unhealthyAlarmSeconds,
  });
  // Unhealthy for one report interval only warns on testnet; for two it alarms.
  const sick = (duration) => evaluateReportChecks(RH, { ...report, healthy: false, faults: ["tick_failed"], unhealthySince: NOW - duration }, NOW).unhealthy.severity;
  assert.deepEqual([sick(300), sick(600)], ["warning", "alarm"]);
  assert.equal(RH.reports.intervalSeconds, 300);
  assert.equal(mainnet.reports.intervalSeconds, 60);
  assert.deepEqual([RH.readIntervalSeconds, mainnet.readIntervalSeconds], [300, 60]);
  assert.deepEqual([roundReadDue(RH, { checkedAt: NOW, complete: true }, NOW + 269), roundReadDue(RH, { checkedAt: NOW, complete: true }, NOW + 270)], [false, true]);
  assert.equal(roundReadDue(RH, { checkedAt: NOW, complete: false }, NOW + 60), true, "a failed read is tried again the next minute");
  assert.equal(roundReadDue(mainnet, { checkedAt: NOW, complete: true }, NOW + 45), true);
});

test("mainnet wallets: keeper and follower warn below 0.0002 ETH and alarm below 0.0001 ETH", () => {
  const mainnet = { ...ROUND_NETWORKS["robinhood-mainnet"], coordinator: RH.coordinator, implementations: RH.implementations };
  const follower = mainnet.backupKeepers[0];
  const check = (balanceWei) =>
    evaluateRoundChainChecks(mainnet, roundRead({ keeper: mainnet.keeper, balanceWei, backupBalances: [{ address: follower, balanceWei }] }), null);
  const severities = (balanceWei) => {
    const c = check(balanceWei);
    return [c.balance?.severity ?? null, c[`backup_balance:${follower.toLowerCase()}`]?.severity ?? null];
  };
  assert.deepEqual(severities(2n * ETH / 10000n), [null, null]);
  assert.deepEqual(severities(2n * ETH / 10000n - 1n), ["warning", "warning"]);
  assert.deepEqual(severities(ETH / 10000n - 1n), ["alarm", "alarm"]);
  assert.deepEqual(severities(5n * ETH / 10000n), [null, null], "a full mainnet wallet (about 0.0005 ETH) is fine");
});

test("cron: without its own chat a round network's alerts are kept, never sent to the default chat", async () => {
  const env = { TELEGRAM_BOT_TOKEN: ROUTED.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: ROUTED.TELEGRAM_CHAT_ID };
  const h = cronHarness(env);
  h.state.read = roundRead({ keeper: "0x9999999999999999999999999999999999999999" });
  const summary = await h.run(0);
  assert.equal(summary.messagesQueued, 1);
  assert.equal(h.state.telegram.length, 0);
  assert.deepEqual(recentMessages(h.storage).map((m) => [m.network, m.status]), [["robinhood-testnet", "not_sent"]]);
});

test("cron: three failed reads warn that the watchdog cannot read the chain", async () => {
  const h = cronHarness(ROUTED);
  h.state.read = { ok: false, complete: false, error: "http 503", errors: [], subrequests: 1, rpc: "rpc.testnet.chain.robinhood.com" };
  await h.run(0);
  await h.run(60);
  const summary = await h.run(120);
  assert.deepEqual(summary.networks[RH.name].activeAlerts, ["rpc"]);
  assert.match(h.state.telegram.at(-1).text, /WARNING watchdog cannot read chain: 3 consecutive runs failed \(last error: http 503\)/);
});

test("health endpoint: Robinhood testnet has its primary and backup streams; mainnet's needs its key", async () => {
  const storage = memoryStorage();
  const env = { HEALTH_KEY_ROBINHOOD_TESTNET: "throwaway-rh-key", HEALTH_KEY_ROBINHOOD_TESTNET_BACKUP: "throwaway-rh-backup-key" };
  const stub = {
    ingestReport: async (rec) => ingestReport(storage, rec),
    ingestBackupReport: async (rec) => ingestReport(storage, rec, BACKUP_STREAM),
  };
  const report = sampleReport({ chainId: RH.chainId, coordinator: RH.coordinator });
  const post = (path, key) =>
    handleFetch(
      new Request(`https://watchdog.d20dao.org${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": report.reportId },
        body: JSON.stringify(report),
      }),
      env,
      { waitUntil() {} },
      { stub: () => stub, now: () => NOW * 1000 },
    );
  assert.equal((await post("/v1/health/robinhood-testnet", env.HEALTH_KEY_ROBINHOOD_TESTNET)).status, 200);
  assert.equal((await post("/v1/health/robinhood-testnet/backup", env.HEALTH_KEY_ROBINHOOD_TESTNET_BACKUP)).status, 200);
  assert.equal((await post("/v1/health/robinhood-testnet", "wrong")).status, 401);
  assert.equal((await post("/v1/health/robinhood-mainnet", "anything")).status, 503, "receiver not configured without its key");
  assert.equal((await post("/v1/health/robinhood-devnet", "anything")).status, 404);
  // An Arc report is not a Robinhood one.
  const arc = sampleReport();
  const wrongChain = await handleFetch(
    new Request("https://watchdog.d20dao.org/v1/health/robinhood-testnet", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HEALTH_KEY_ROBINHOOD_TESTNET}`, "content-type": "application/json", "idempotency-key": arc.reportId },
      body: JSON.stringify(arc),
    }),
    env,
    { waitUntil() {} },
    { stub: () => stub, now: () => NOW * 1000 },
  );
  assert.equal(wrongChain.status, 422);
});

test("status: an unlisted round network shows nothing, messages included; listed, it has its own section", async () => {
  const h = cronHarness(ROUTED);
  h.state.read = roundRead({ keeper: "0x9999999999999999999999999999999999999999" });
  await h.run(0);
  const hidden = buildStatus(h.storage, ROUTED, NOW + 10, {}, { [RH.name]: RH });
  assert.equal(hidden.roundNetworks, undefined);
  assert.deepEqual(hidden.recentMessages, []);
  assert.doesNotMatch(JSON.stringify(hidden), /robinhood/);
  assert.doesNotMatch(renderHtml(hidden), /robinhood/i);

  const listed = { ...RH, statusListed: true };
  const shown = buildStatus(h.storage, ROUTED, NOW + 10, {}, { [RH.name]: listed });
  const view = shown.roundNetworks[RH.name];
  assert.equal(view.chain.keeperBalanceEth, "0.002");
  assert.equal(view.chain.keeperIsConfigured, false);
  assert.equal(view.chain.codeHashes, "not checked");
  assert.deepEqual(view.alerts.map((a) => a.check), ["keeper"]);
  assert.equal(shown.recentMessages.length, 1);
  const text = pageText(renderHtml(shown));
  assert.match(text, /robinhood-testnet ALARM ALARM coordinator keeper is not the configured keeper/);
  assert.match(text, /Keeper balance 0\.002 ETH/);
  assert.match(text, /Roles and implementation MISMATCH/);
  assert.match(text, /0xbb2f…27Ee 0\.002 ETH/);
});

test("cron: a fault in a round network's evaluation stays there; the Arc networks' run is untouched", async () => {
  const storage = memoryStorage();
  const arc = NETWORKS["arc-testnet"];
  const summary = await runCron({
    storage,
    env: {},
    fetch: async () => assert.fail("nothing is fetched"),
    clock: () => NOW * 1000,
    networks: { [arc.name]: arc },
    roundNetworks: { [RH.name]: RH },
    readChainImpl: async (net) => healthyRead(net, { committer: "0x9999999999999999999999999999999999999999" }),
    readAgentApiImpl: async (net) => agentApiPoll({}, net),
    runBeaconImpl: async (plan) => healthyBeaconRun(plan),
    readRoundChainImpl: async () => ({ ok: true, complete: true, block: null }), // malformed: no head block
  });
  assert.deepEqual(summary.networks[RH.name].chain, "failed");
  assert.equal(summary.networks[RH.name].error, "internal error");
  assert.equal(readRoundState(storage, RH.name), null, "nothing of the round network was written");
  assert.deepEqual(summary.networks[arc.name].activeAlerts, ["committer"]);
  assert.deepEqual(readAlerts(storage, arc.name).map((a) => a.check), ["committer"]);
});

test("round reader: an endpoint that refuses eth_call (HTTP 429 from Workers) falls back, and logs fall back to dRPC in capped chunks", async () => {
  for (const net of Object.values(WATCHED_ROUND_NETWORKS)) {
    assert.ok(!/chain\.robinhood\.com/.test(net.rpcs[0]), `${net.name}: Robinhood's own endpoint is not first for state reads`);
    const drpc = net.logRpcs.find((e) => /drpc\.org/.test(e.url));
    assert.deepEqual([drpc.maxBlocks, drpc.maxBatch], [100, 3], `${net.name}: dRPC's keyless caps`);
  }
  const net = await pinnedNet();
  const node = fakeNode(net);
  node.chain.next = 3n;
  const first = applyRoundRead(net, null, await readRoundChain(net, null, { fetch: node.fetch, nowSec: NOW }), NOW);
  // Every state call to the first endpoint is refused, and so is every log call to Robinhood's own endpoint.
  node.setRefuse((url, calls) =>
    (url === net.rpcs[0] && calls.some((c) => c.method === "eth_call")) || (url === net.logRpcs[0].url && calls[0].method === "eth_getLogs") ? 429 : null,
  );
  node.chain.head = 1000 + 650;
  node.chain.logs = [refundLog(2, 1640)];
  node.batches.length = 0;
  node.urls.length = 0;
  const read = await readRoundChain(net, first, { fetch: node.fetch, nowSec: NOW + 60 });
  assert.equal(read.complete, true, read.error);
  assert.equal(read.rpc, new URL(net.rpcs[1]).host);
  assert.deepEqual([read.logs.fromBlock, read.logs.toBlock], [1001, 1650]);
  assert.deepEqual(read.logs.refunds.map((r) => r.requestId), [2n]);
  const drpc = net.logRpcs[1].url;
  const logBatches = node.batches.filter((b, i) => node.urls[i] === drpc);
  assert.deepEqual(logBatches.map((b) => b.length), [3, 3, 1], "650 blocks: 7 calls of at most 100 blocks, 3 to a batch");
  // Round A: 1 refused and 1 on the second endpoint (no request to scan); logs: 1 refused and 3 dRPC fetches.
  assert.equal(read.subrequests, 2 + 1 + 3);

  // A long backlog on dRPC is read 1,800 blocks a run.
  const behind = await readLogs(net, 10_000, 20_000, { fetch: node.fetch });
  assert.deepEqual([behind.logs.fromBlock, behind.logs.toBlock], [10_001, 11_800]);
  assert.equal(behind.cursor, 11_800);
  // Every log endpoint failing leaves the logs unknown and names the last error.
  node.setRefuse(() => 429);
  const none = await readLogs(net, 1000, 1100, { fetch: node.fetch });
  assert.equal(none.logs, null);
  assert.match(none.error, /drpc\.org: http 429/);
});
