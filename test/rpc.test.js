import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPLEMENTATION_SLOT, TOPICS } from "../src/config.js";
import { readChain } from "../src/rpc.js";
import { MAINNET, TESTNET, addressWord, encodePending, encodeRequest, word } from "./helpers.js";

const NOW = 1789420000;

/** Fake JSON-RPC endpoint set. `failing` maps url -> Response factory used instead of answering. */
function mockRpc(net, options = {}) {
  const o = {
    chainId: BigInt(net.chainId),
    head: 62576776,
    timestamp: NOW,
    baseFee: 20n * 10n ** 9n,
    next: 973n,
    pending: [],
    requests: {},
    logs: [],
    committer: net.keeper,
    balance: 35n * 10n ** 18n,
    balances: {}, // lowercase address -> balance; others get `balance`
    balanceErrors: [], // lowercase addresses whose eth_getBalance answers with an error
    failing: {},
    itemErrors: {},
    ...options,
  };
  const calls = [];
  const fetch = async (url, init) => {
    const batch = JSON.parse(init.body);
    calls.push({ url, batch });
    if (o.failing[url]) return o.failing[url]();
    const answer = ({ id, method, params }) => {
      if (o.itemErrors[method]) return { jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } };
      switch (method) {
        case "eth_chainId":
          return "0x" + o.chainId.toString(16);
        case "eth_getBlockByNumber":
          return { number: "0x" + o.head.toString(16), timestamp: "0x" + o.timestamp.toString(16), baseFeePerGas: "0x" + o.baseFee.toString(16) };
        case "eth_getBalance": {
          const who = params[0].toLowerCase();
          if (o.balanceErrors.includes(who)) return { jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } };
          return "0x" + (o.balances[who] ?? o.balance).toString(16);
        }
        case "eth_getStorageAt":
          assert.equal(params[1], IMPLEMENTATION_SLOT);
          return params[0] === net.coordinator ? "0x" + addressWord("0xd20da0c375cefcda65703699a4090237057e9b68") : "0x" + addressWord("0xd20da0cf7ddc6123f9a87c0c210f8ecb934ca7d5");
        case "eth_getLogs":
          return o.logs;
        case "eth_call": {
          const data = params[0].data;
          if (data === "0x6a84a985") return "0x" + word(o.next);
          if (data === "0x5bc8e8f9") return "0x" + addressWord(o.committer);
          if (data.startsWith("0xfdfe72e6")) return encodePending(o.pending, o.next);
          if (data.startsWith("0xc58343ef")) return o.requests[BigInt("0x" + data.slice(10)).toString()];
          throw new Error("unexpected call " + data);
        }
        default:
          throw new Error("unexpected method " + method);
      }
    };
    return Response.json(
      batch.map((item) => {
        const result = answer(item);
        return result && result.error ? result : { jsonrpc: "2.0", id: item.id, result };
      }),
    );
  };
  return { fetch, calls, options: o };
}

test("round A reads head, figures and wiring from the primary endpoint in one batch", async () => {
  const rpc = mockRpc(MAINNET, { next: 15n });
  const read = await readChain(MAINNET, { logCursor: null, logSpan: null }, { fetch: rpc.fetch });
  assert.equal(read.ok, true);
  assert.equal(read.complete, true);
  assert.equal(read.rpc, "rpc.blockdaemon.mainnet.arc.io");
  assert.equal(read.block.number, 62576776);
  assert.equal(read.block.baseFeeWei, 20n * 10n ** 9n);
  assert.equal(read.nextRequestId, 15n);
  assert.equal(read.committer, MAINNET.keeper.toLowerCase());
  assert.equal(read.coordinatorImpl, "0xd20da0c375cefcda65703699a4090237057e9b68");
  assert.equal(read.balanceWei, 35n * 10n ** 18n);
  assert.deepEqual(read.pending, { count: 0, ids: [], oldest: null });
  // First run: cursor starts at head, no historical log scan.
  assert.equal(read.logs, null);
  assert.equal(read.logCursor, 62576776);
  assert.equal(rpc.calls.length, 2);
  // Seven fixed calls plus the backup keeper balance, all in the same batch.
  assert.equal(rpc.calls[0].batch.length, 8);
  assert.deepEqual(rpc.calls[0].batch[7].params, [MAINNET.backupKeepers[0], "latest"]);
  assert.deepEqual(read.backupBalances, [{ address: MAINNET.backupKeepers[0], balanceWei: 35n * 10n ** 18n }]);
  assert.equal(read.subrequests, 2);
  // Pending scan window: max(1, next - 256) with limit 256, pinned to the head block.
  const [pendingCall] = rpc.calls[1].batch;
  assert.equal(pendingCall.params[0].data, "0xfdfe72e6" + word(1) + word(256));
  assert.equal(pendingCall.params[1], "0x3bad888");
});

test("round A reads every backup keeper balance in the same batch, each on its own", async () => {
  const second = "0x00000000000000000000000000000000000000B2";
  const net = { ...MAINNET, backupKeepers: [MAINNET.backupKeepers[0], second, "0x00000000000000000000000000000000000000b3"] };
  const rpc = mockRpc(net, {
    balances: { [MAINNET.keeper.toLowerCase()]: 40n * 10n ** 18n, [MAINNET.backupKeepers[0].toLowerCase()]: 12n * 10n ** 18n, [second.toLowerCase()]: 0n },
    balanceErrors: ["0x00000000000000000000000000000000000000b3"],
  });
  const read = await readChain(net, { logCursor: 62576776, logSpan: 5000 }, { fetch: rpc.fetch });
  assert.equal(read.complete, true, "a failed balance item leaves the read complete");
  assert.equal(rpc.calls[0].batch.length, 10);
  assert.deepEqual(
    rpc.calls[0].batch.filter((c) => c.method === "eth_getBalance").map((c) => c.params),
    [MAINNET.keeper, ...net.backupKeepers].map((wallet) => [wallet, "latest"]),
  );
  assert.equal(read.subrequests, 2, "no extra round trip");
  assert.equal(read.balanceWei, 40n * 10n ** 18n);
  assert.deepEqual(read.backupBalances, [
    { address: MAINNET.backupKeepers[0], balanceWei: 12n * 10n ** 18n },
    { address: second, balanceWei: 0n },
    { address: "0x00000000000000000000000000000000000000b3", balanceWei: null },
  ]);
  assert.deepEqual(read.errors, ["backup balance 0x00000000000000000000000000000000000000b3: rpc error -32000"]);
});

test("round A reads the agent API relayer balance, last, only while the agent API is watched", async () => {
  const relayer = TESTNET.agentApi.relayer;
  const rpc = mockRpc(TESTNET, { balances: { [relayer.toLowerCase()]: 389n * 10n ** 15n } });
  const read = await readChain(TESTNET, { logCursor: 62576776, logSpan: 5000 }, { fetch: rpc.fetch });
  assert.equal(read.complete, true);
  assert.equal(rpc.calls[0].batch.length, 9, "seven fixed calls, the backup keeper and the relayer");
  assert.deepEqual(rpc.calls[0].batch[8].params, [relayer, "latest"]);
  assert.equal(read.agentRelayerBalanceWei, 389n * 10n ** 15n);
  assert.equal(read.subrequests, 2, "no extra round trip");

  // A failed balance item leaves the rest of the read intact.
  const failing = mockRpc(TESTNET, { balanceErrors: [relayer.toLowerCase()] });
  const partial = await readChain(TESTNET, { logCursor: 62576776, logSpan: 5000 }, { fetch: failing.fetch });
  assert.equal(partial.complete, true);
  assert.equal(partial.agentRelayerBalanceWei, null);
  assert.deepEqual(partial.errors, ["agent API relayer balance: rpc error -32000"]);

  // Not watched (mainnet until its API is live): not read at all.
  const off = mockRpc(MAINNET);
  const unwatched = await readChain(MAINNET, null, { fetch: off.fetch });
  assert.equal(MAINNET.agentApi.enabled, false);
  assert.ok(!off.calls[0].batch.some((c) => c.method === "eth_getBalance" && c.params[0] === MAINNET.agentApi.relayer));
  assert.equal(unwatched.agentRelayerBalanceWei, null);
});

test("a network without backup keepers reads only the keeper balance", async () => {
  // Without a watched agent API either, so the keeper's is the only balance in round A.
  const { backupKeepers, agentApi, ...unset } = TESTNET;
  for (const net of [{ ...unset, backupKeepers: [] }, unset]) {
    const rpc = mockRpc(net);
    const read = await readChain(net, null, { fetch: rpc.fetch });
    assert.equal(read.ok, true);
    assert.equal(rpc.calls[0].batch.length, 7);
    assert.deepEqual(read.backupBalances, []);
    assert.equal(read.balanceWei, 35n * 10n ** 18n);
  }
  // Round A failed: backup balances are unknown, not empty.
  const down = mockRpc(TESTNET, { chainId: 1n });
  assert.equal((await readChain(TESTNET, null, { fetch: down.fetch })).backupBalances, null);
});

test("pending window and oldest age from the smallest three ids", async () => {
  const rpc = mockRpc(TESTNET, {
    next: 973n,
    pending: [968n, 969n, 970n, 972n],
    requests: {
      968: encodeRequest({ deadline: NOW + 60 - 50 }), // created 50 s ago
      969: encodeRequest({ deadline: NOW + 60 - 30 }),
      970: encodeRequest({ deadline: NOW + 60 - 10 }),
    },
  });
  const read = await readChain(TESTNET, { logCursor: 62576776, logSpan: 5000 }, { fetch: rpc.fetch });
  assert.equal(read.complete, true);
  assert.equal(rpc.calls[1].batch[0].params[0].data, "0xfdfe72e6" + word(973 - 256) + word(256));
  assert.equal(rpc.calls.length, 3);
  assert.deepEqual(
    rpc.calls[2].batch.map((c) => c.params[0].data),
    [968, 969, 970].map((id) => "0xc58343ef" + word(id)),
  );
  assert.equal(read.pending.count, 4);
  assert.deepEqual(read.pending.oldest, { id: 968n, createdAt: NOW - 50, ageSeconds: 50 });
});

test("log scan: cursor + 1 to head, capped at 5,000 blocks, refunds and foreign submitters", async () => {
  const log = (topic, id, who, data) => ({
    address: TESTNET.coordinator.toLowerCase(),
    topics: [topic, "0x" + word(id), "0x" + addressWord(who)],
    data,
    blockNumber: "0x10",
    transactionHash: "0x" + "ab".repeat(32),
  });
  const logs = [
    log(TOPICS.requestRefundedTo, 812, "0x3333333333333333333333333333333333333333", "0x" + word(10n ** 18n) + word(0)),
    log(TOPICS.randomnessFulfilled, 813, TESTNET.keeper, "0x" + "d4".repeat(32)),
    log(TOPICS.randomnessFulfilled, 814, "0x4444444444444444444444444444444444444444", "0x" + "d4".repeat(32)),
    { ...log(TOPICS.requestRefundedTo, 815, TESTNET.keeper, "0x" + word(1) + word(1)), removed: true },
    { ...log(TOPICS.requestRefundedTo, 816, TESTNET.keeper, "0x" + word(1) + word(1)), address: "0x0000000000000000000000000000000000000001" },
  ];
  const rpc = mockRpc(TESTNET, { head: 100000, logs });
  const behind = await readChain(TESTNET, { logCursor: 80000, logSpan: 5000 }, { fetch: rpc.fetch });
  const getLogs = rpc.calls[1].batch.find((c) => c.method === "eth_getLogs").params[0];
  assert.equal(getLogs.fromBlock, "0x" + (80001).toString(16));
  assert.equal(getLogs.toBlock, "0x" + (85000).toString(16));
  assert.equal(getLogs.address, TESTNET.coordinator);
  assert.deepEqual(getLogs.topics, [[TOPICS.requestRefundedTo, TOPICS.randomnessFulfilled]]);
  assert.equal(behind.logCursor, 85000);
  assert.deepEqual(behind.logs.refunds.map((r) => r.requestId), [812n]);
  assert.equal(behind.logs.refunds[0].paid, false);
  assert.deepEqual(behind.logs.foreignFulfillments.map((f) => f.requestId), [814n]);

  // A follower keeper authorized as a backup committer is one of ours, not a foreign submitter.
  const backup = TESTNET.backupKeepers[0];
  const withBackup = await readChain(TESTNET, { logCursor: 80000, logSpan: 5000 }, {
    fetch: mockRpc(TESTNET, { head: 100000, logs: [...logs, log(TOPICS.randomnessFulfilled, 817, backup, "0x" + "d4".repeat(32))] }).fetch,
  });
  assert.deepEqual(withBackup.logs.foreignFulfillments.map((f) => f.requestId), [814n]);

  const rpc2 = mockRpc(TESTNET, { head: 100000 });
  const near = await readChain(TESTNET, { logCursor: 99880, logSpan: 5000 }, { fetch: rpc2.fetch });
  const range = rpc2.calls[1].batch.find((c) => c.method === "eth_getLogs").params[0];
  assert.equal(range.toBlock, "0x" + (100000).toString(16));
  assert.equal(near.logCursor, 100000);

  // Cursor already at head: no call, empty result, cursor unchanged.
  const rpc3 = mockRpc(TESTNET, { head: 100000 });
  const atHead = await readChain(TESTNET, { logCursor: 100000, logSpan: 5000 }, { fetch: rpc3.fetch });
  assert.deepEqual(atHead.logs.refunds, []);
  assert.ok(!rpc3.calls[1].batch.some((c) => c.method === "eth_getLogs"));
});

test("a failing log query keeps the cursor and halves the span", async () => {
  const rpc = mockRpc(TESTNET, { head: 100000, itemErrors: { eth_getLogs: true } });
  const read = await readChain(TESTNET, { logCursor: 80000, logSpan: 5000 }, { fetch: rpc.fetch });
  assert.equal(read.logs, null);
  assert.equal(read.logCursor, 80000);
  assert.equal(read.logSpan, 2500);
  assert.ok(read.errors.some((e) => e.startsWith("logs: rpc error -32000")));
});

test("falls back to the second endpoint and sticks to it for the run", async () => {
  const rpc = mockRpc(TESTNET, {
    failing: { "https://rpc.blockdaemon.testnet.arc.io": () => new Response("slow down", { status: 429 }) },
    pending: [970n],
    requests: { 970: encodeRequest({ deadline: NOW + 30 }) },
  });
  const read = await readChain(TESTNET, { logCursor: 62576700, logSpan: 5000 }, { fetch: rpc.fetch });
  assert.equal(read.complete, true);
  assert.equal(read.rpc, "rpc.testnet.arc.io");
  assert.deepEqual(rpc.calls.map((c) => new URL(c.url).host), [
    "rpc.blockdaemon.testnet.arc.io",
    "rpc.testnet.arc.io",
    "rpc.testnet.arc.io",
    "rpc.testnet.arc.io",
  ]);
  assert.equal(read.subrequests, 4);
});

test("wrong chain id and non-batch replies are endpoint failures", async () => {
  const wrongChain = mockRpc(TESTNET, { chainId: 5042n });
  const read = await readChain(TESTNET, null, { fetch: wrongChain.fetch });
  assert.equal(read.ok, false);
  assert.equal(read.error, "wrong chain id");
  assert.equal(wrongChain.calls.length, 2);

  const rejecting = mockRpc(TESTNET, {
    failing: {
      "https://rpc.blockdaemon.testnet.arc.io": () => Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600 } }),
      "https://rpc.testnet.arc.io": () => {
        throw new TypeError("connection reset");
      },
    },
  });
  const failed = await readChain(TESTNET, null, { fetch: rejecting.fetch });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "network error");
  assert.equal(failed.subrequests, 2);
});

test("round B failure yields a partial read with unknown pending and logs", async () => {
  let n = 0;
  const base = mockRpc(TESTNET, { head: 100000 });
  const fetch = async (url, init) => (++n === 1 ? base.fetch(url, init) : new Response("", { status: 503 }));
  const read = await readChain(TESTNET, { logCursor: 99000, logSpan: 5000 }, { fetch });
  assert.equal(read.ok, true);
  assert.equal(read.complete, false);
  assert.equal(read.pending, null);
  assert.equal(read.logs, null);
  assert.equal(read.logCursor, 99000);
  assert.equal(read.balanceWei, 35n * 10n ** 18n);
  assert.equal(read.error, "http 503");
});

test("timeouts abort the request, fall back, and report a timeout code", async () => {
  const hanging = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const started = Date.now();
  const read = await readChain(TESTNET, null, { fetch: hanging, timeoutMs: 30 });
  assert.equal(read.ok, false);
  assert.equal(read.error, "timeout");
  assert.equal(read.subrequests, 2);
  assert.ok(Date.now() - started < 2000);
});
