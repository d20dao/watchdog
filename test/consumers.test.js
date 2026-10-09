// New consumer notice: history read silently, live consumers announced once, per-network flag and routing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyConsumers, consumerMessage, seedRange } from "../src/consumers.js";
import { NETWORKS, ROUND_NETWORKS } from "../src/config.js";
import { runCron } from "../src/cron.js";
import { recentMessages } from "../src/store.js";
import { healthyBeaconRun, healthyRead, memoryStorage } from "./helpers.js";

const ARC = NETWORKS["arc-mainnet"];
const RH = ROUND_NETWORKS["robinhood-mainnet"];
const NOW = 1791560000;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const count = (storage, table) => storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n;

test("flags: Arc and Robinhood mainnet announce new consumers, the testnets do not", () => {
  assert.equal(ARC.newConsumerNotice, true);
  assert.equal(RH.newConsumerNotice, true);
  assert.equal(NETWORKS["arc-testnet"].newConsumerNotice, false);
  assert.equal(ROUND_NETWORKS["robinhood-testnet"].newConsumerNotice, false);
  const storage = memoryStorage();
  const testnet = NETWORKS["arc-testnet"];
  assert.deepEqual(applyConsumers(storage, testnet, NOW, { nextRequestId: 5n, live: [{ id: 6n, consumer: A }] }), []);
  assert.equal(seedRange(storage, testnet), null);
  assert.equal(count(storage, "consumers") + count(storage, "consumer_state"), 0, "a network without the notice writes nothing");
});

test("history is read silently, a consumer seen live meanwhile waits, and each new consumer is announced once", () => {
  const storage = memoryStorage();
  // First run: live tracking starts at nextRequestId 160; nothing is known before it. A is new, B made a request at 155 too.
  let notices = applyConsumers(storage, ARC, NOW, { nextRequestId: 160n, live: [{ id: 161n, consumer: A }, { id: 162n, consumer: B }] });
  assert.deepEqual(notices, [], "nothing is announced before history is read through");
  assert.deepEqual(seedRange(storage, ARC), { fromId: 1n, toId: 101n });

  // History in two batches: B and C made requests before; A did not.
  notices = applyConsumers(storage, ARC, NOW + 60, {
    nextRequestId: 163n,
    seed: { fromId: 1n, toId: 101n, consumers: [{ id: 3n, consumer: C }] },
    live: [],
  });
  assert.deepEqual(notices, []);
  assert.deepEqual(seedRange(storage, ARC), { fromId: 101n, toId: 160n });
  // A batch that does not start where history stands is ignored.
  assert.deepEqual(applyConsumers(storage, ARC, NOW + 90, { seed: { fromId: 5n, toId: 160n, consumers: [{ id: 6n, consumer: A }] } }), []);
  notices = applyConsumers(storage, ARC, NOW + 120, {
    nextRequestId: 163n,
    seed: { fromId: 101n, toId: 160n, consumers: [{ id: 155n, consumer: B.toUpperCase().replace("0X", "0x") }] },
    live: [{ id: 163n, consumer: A }],
  });
  assert.deepEqual(notices.map((n) => n.text), [consumerMessage(ARC, A, "161")], "A waited and is new; B is old");
  assert.equal(seedRange(storage, ARC), null);

  // Later: a new consumer is announced at once, with its first request; seen again, never.
  notices = applyConsumers(storage, ARC, NOW + 180, { live: [{ id: 171n, consumer: "0xdddddddddddddddddddddddddddddddddddddddd" }, { id: 170n, consumer: "0xdddddddddddddddddddddddddddddddddddddddd" }] });
  assert.deepEqual(notices.map((n) => n.text), [`[arc-mainnet] NEW CONSUMER 0xdddddddddddddddddddddddddddddddddddddddd made its first request, 170 https://arc.d20dao.org/request/${ARC.coordinator}/170`]);
  assert.deepEqual(applyConsumers(storage, ARC, NOW + 240, { live: [{ id: 172n, consumer: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }] }), []);
  // Requests from before live tracking are history, never announced from a live read.
  assert.deepEqual(applyConsumers(storage, ARC, NOW + 300, { live: [{ id: 2n, consumer: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }] }), []);
  assert.equal(count(storage, "consumers"), 4, "one row per consumer");
});

test("a network deployed with no requests yet has no history: the first consumer is announced at once, with the site's link on Robinhood", () => {
  const storage = memoryStorage();
  assert.deepEqual(applyConsumers(storage, RH, NOW, { nextRequestId: 1n, live: [] }), []);
  const notices = applyConsumers(storage, RH, NOW + 60, { live: [{ id: 1n, consumer: A }] });
  assert.deepEqual(notices.map((n) => n.text), [
    `[robinhood-mainnet] NEW CONSUMER ${A} made its first request, 1 https://d20dao.org/explorer/request/4663/${RH.coordinator}/1`,
  ]);
});

test("cron: an Arc mainnet notice goes to the default chat, a Robinhood mainnet one to its own group, as info", async () => {
  const storage = memoryStorage();
  const env = {
    TELEGRAM_BOT_TOKEN: "123456:throwaway-token",
    TELEGRAM_CHAT_ID: "-100111",
    TELEGRAM_CHAT_ID_ROBINHOOD_MAINNET: "-100444",
  };
  const sent = [];
  const fetch = async (url, init) => {
    assert.ok(url.startsWith("https://api.telegram.org/bot"));
    sent.push(JSON.parse(init.body));
    return new Response("{}");
  };
  const arcReads = [];
  let clock = NOW;
  const run = (arcRead, roundRead) =>
    runCron({
      storage,
      env,
      fetch,
      clock: () => clock * 1000,
      networks: { [ARC.name]: ARC },
      roundNetworks: { [RH.name]: RH },
      readChainImpl: async (net, cursor, deps) => {
        arcReads.push(deps.consumerSeed);
        return arcRead;
      },
      readAgentApiImpl: async () => ({ ok: false, httpStatus: null, latencyMs: null, reason: "not polled in this test" }),
      runBeaconImpl: async (plan) => healthyBeaconRun(plan),
      readRoundChainImpl: async () => roundRead,
    });
  const roundRead = (overrides = {}) => ({
    ok: true,
    complete: true,
    errors: [],
    subrequests: 1,
    block: { number: 10, timestamp: NOW, baseFeeWei: 10_000_000n },
    nextRequestId: 1n,
    scan: { expired: [], pending: { count: 0, ids: [], oldest: null, more: false } },
    logs: { fromBlock: 1, toBlock: 10, skippedBlocks: 0, refunds: [], foreignFulfillments: [], requests: [] },
    consumers: [],
    ...overrides,
  });
  // First run: Arc has 59 old requests, Robinhood none.
  await run(healthyRead(ARC, { nextRequestId: 60n, logs: { fromBlock: 1, toBlock: 2, refunds: [], foreignFulfillments: [], requests: [] } }), roundRead());
  assert.equal(arcReads.at(-1), null, "no history range before the first run");
  // Second run: Arc reads its history (one consumer, the same that requests now); Robinhood gets its first consumer.
  clock += 60;
  await run(
    healthyRead(ARC, {
      nextRequestId: 61n,
      consumerSeed: { fromId: 1n, toId: 60n, consumers: [{ id: 1n, consumer: A }] },
      logs: { fromBlock: 3, toBlock: 4, refunds: [], foreignFulfillments: [], requests: [{ id: 60n, consumer: A }] },
    }),
    roundRead({ nextRequestId: 2n, logs: { fromBlock: 11, toBlock: 20, skippedBlocks: 0, refunds: [], foreignFulfillments: [], requests: [{ id: 1n, consumer: B }] } }),
  );
  assert.deepEqual(arcReads.at(-1), { fromId: 1n, toId: 60n });
  // Third run: a new Arc consumer.
  clock += 60;
  await run(
    healthyRead(ARC, { nextRequestId: 62n, logs: { fromBlock: 5, toBlock: 6, refunds: [], foreignFulfillments: [], requests: [{ id: 61n, consumer: C }] } }),
    roundRead({ nextRequestId: 2n }),
  );
  const notices = sent.filter((m) => m.text.includes("NEW CONSUMER"));
  assert.deepEqual(
    notices.map((m) => [m.chat_id, m.text.split(" ").slice(0, 4).join(" ")]),
    [
      ["-100444", `[robinhood-mainnet] NEW CONSUMER ${B}`],
      ["-100111", `[arc-mainnet] NEW CONSUMER ${C}`],
    ],
  );
  assert.ok(recentMessages(storage).filter((m) => m.text.includes("NEW CONSUMER")).every((m) => m.severity === "info"));
});
