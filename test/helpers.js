// Test helpers: an in-memory stand-in for Durable Object SQL storage and hand-built ABI fixtures.

import { DatabaseSync } from "node:sqlite";
import { NETWORKS } from "../src/config.js";
import { migrate } from "../src/store.js";

/** Minimal emulation of ctx.storage.{sql.exec, transactionSync} backed by node:sqlite. */
export function memoryStorage() {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const storage = {
    db,
    sql: {
      exec(query, ...bindings) {
        const rows = db.prepare(query).all(...bindings).map((row) => ({ ...row }));
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
            return rows[0];
          },
        };
      },
    },
    transactionSync(fn) {
      if (depth > 0) return fn();
      db.exec("BEGIN");
      depth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
  };
  migrate(storage);
  return storage;
}

export const word = (value) => BigInt(value).toString(16).padStart(64, "0");
export const addressWord = (address) => address.slice(2).toLowerCase().padStart(64, "0");
export const bytes32 = (byte) => byte.repeat(32);

/** ABI-encode (uint256[] ids, uint256 nextCursor) by hand. */
export function encodePending(ids, nextCursor) {
  return "0x" + word(64) + word(nextCursor) + word(ids.length) + ids.map(word).join("");
}

/** ABI-encode the 17-word Request tuple by hand. */
export function encodeRequest(fields = {}) {
  const f = {
    consumer: "0x1111111111111111111111111111111111111111",
    callbackGasLimit: 150000,
    requestBlock: 100,
    targetBlock: 102,
    deadline: 1789420060,
    refundAddress: "0x2222222222222222222222222222222222222222",
    fulfilled: false,
    delivered: false,
    refunded: false,
    epochId: 7,
    ...fields,
  };
  return (
    "0x" +
    addressWord(f.consumer) +
    word(f.callbackGasLimit) +
    word(f.requestBlock) +
    word(f.targetBlock) +
    word(f.deadline) +
    addressWord(f.refundAddress) +
    bytes32("a1") + // clientSeed
    bytes32("b2") + // mappingHash
    bytes32("c3") + // blockHash
    bytes32("d4") + // randomness
    bytes32("e5") + // proofHash
    bytes32("f6") + // transcriptHash
    word(f.fulfilled ? 1 : 0) +
    word(f.delivered ? 1 : 0) +
    word(f.refunded ? 1 : 0) +
    word(f.epochId) +
    bytes32("07") // epochHash
  );
}

export const TESTNET = NETWORKS["arc-testnet"];
export const MAINNET = NETWORKS["arc-mainnet"];

/** The receiver doc's example envelope, filled with testnet deployment values. */
export function sampleReport(overrides = {}) {
  const origin = `5042002:${TESTNET.coordinator}:${TESTNET.keeper}`;
  return {
    version: 1,
    nodeId: "0x" + "ab".repeat(32),
    chainId: "5042002",
    coordinator: TESTNET.coordinator,
    reportId: "5f".repeat(32),
    observedAt: 1789420000,
    health: { observedAt: 1789420000, healthy: true, sendEnabled: true, faults: [] },
    summary: { completed: 1, rejected: 1, failed: 0, progress: 0 },
    events: {
      completed: [{ cursor: "101", requestId: "42", kind: "served", origin, observedAt: 1789420000 }],
      rejected: [{ cursor: "102", requestId: "43", kind: "not_allowlisted", origin, observedAt: 1789420000 }],
      failed: [],
      progress: [],
    },
    nextCursor: "102",
    droppedCount: 0,
    droppedTotal: 0,
    rejectionHistoryPrunedTotal: 0,
    ...overrides,
  };
}

/** Bootstrap shape: no health observation yet. */
export function bootstrapReport(overrides = {}) {
  return sampleReport({
    reportId: "b0".repeat(32),
    health: { healthy: false, faults: ["not_observed"] },
    summary: { completed: 0, rejected: 0, failed: 0, progress: 0 },
    events: { completed: [], rejected: [], failed: [], progress: [] },
    nextCursor: "0",
    ...overrides,
  });
}

/** A readChain() result with healthy defaults, for check and cron tests. */
export function healthyRead(net = TESTNET, overrides = {}) {
  return {
    ok: true,
    complete: true,
    rpc: "rpc.example",
    error: null,
    errors: [],
    subrequests: 2,
    block: { number: 1000, timestamp: 1789420000, baseFeeWei: 1n * 10n ** 9n },
    nextRequestId: 10n,
    committer: net.keeper.toLowerCase(),
    coordinatorImpl: "0xd20da0c375cefcda65703699a4090237057e9b68",
    registryImpl: "0xd20da0cf7ddc6123f9a87c0c210f8ecb934ca7d5",
    balanceWei: 50n * 10n ** 18n,
    pending: { count: 0, ids: [], oldest: null },
    logs: { fromBlock: 990, toBlock: 1000, refunds: [], foreignFulfillments: [] },
    logCursor: 1000,
    logSpan: 5000,
    ...overrides,
  };
}
