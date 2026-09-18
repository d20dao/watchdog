// Test helpers: an in-memory stand-in for Durable Object SQL storage and hand-built ABI fixtures.

import { readFileSync } from "node:fs";
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

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** What a reader sees on a rendered status page: no style, logo or tags, entities decoded, whitespace collapsed. */
export function pageText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity])
    .replace(/\s+/g, " ")
    .trim();
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
    coordinatorImpl: net.implementations.coordinator.toLowerCase(),
    registryImpl: net.implementations.registry.toLowerCase(),
    balanceWei: 50n * 10n ** 18n,
    backupBalances: (net.backupKeepers ?? []).map((address) => ({ address, balanceWei: 50n * 10n ** 18n })),
    pending: { count: 0, ids: [], oldest: null },
    logs: { fromBlock: 990, toBlock: 1000, refunds: [], foreignFulfillments: [] },
    logCursor: 1000,
    logSpan: 5000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// AirnodeHub fixtures

/** EpochEntropy.recipeRequest(recipe) for the built-in recipes 0-5, as the Arc Mainnet and Testnet registries return them. */
export const EPOCH_RECIPE_REQUESTS = Object.freeze([
  '["metaAndAssetCtxs",[["dex",""]],[["symbol","/0/universe/0/name"],["value","/1/0/dayNtlVlm"]]]',
  '["jsonRpc",[["method","eth_call"],["network","ethereum"],["params",[[["data","0x27e86d6e"],["to","0xcA11bde05977b3631167028862bE2a173976CA11"]],"latest"]]]]',
  '["lastTrade",[["assetClass","crypto"],["symbol","BTCUSD"]]]',
  '["lastTrade",[["assetClass","crypto"],["symbol","ETHUSD"]]]',
  '["latestFeeds",[["name","ETH/USD"]]]',
  '["jsonRpc",[["method","eth_call"],["network","base"],["params",[[["data","0x27e86d6e"],["to","0xcA11bde05977b3631167028862bE2a173976CA11"]],"latest"]]]]',
]);
/** Listings with recipe files in the keeper repo that the registry does not build in; registering one appends a new id. */
export const UNREGISTERED_RECIPE_REQUESTS = Object.freeze({
  "hyperliquid-sol-mid": '["allMids",[],[["mid","/SOL"]]]',
  "nodary-btc-usd": '["latestFeeds",[["name","BTC/USD"]]]',
});

/**
 * Real signed gateway replies, two per catalog recipe, collected 2026-09-17:
 * one JSON per line, {recipe, url, body, response: {airnode, requestHash, timestamp, data, signature}}.
 */
export function loadSamples() {
  const text = readFileSync(new URL("./fixtures/airnodehub-samples-2026-09-17.jsonl", import.meta.url), "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/**
 * A listing OpenAPI document in the gateway format: x-airnode.address plus one POST / schema alternative per
 * operation. `operations` = [{operation, parameters: [names], required?: [names], projection?: bool}].
 */
export function listingDocument(address, operations) {
  return {
    openapi: "3.1.0",
    info: { title: "test listing", version: "0.1.0" },
    paths: {
      "/": {
        get: { summary: "This document" },
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  oneOf: operations.map((op) => ({
                    title: op.operation,
                    type: "object",
                    required: ["operation", "parameters"],
                    additionalProperties: false,
                    properties: {
                      operation: { const: op.operation, description: "test operation" },
                      parameters: {
                        type: "object",
                        additionalProperties: false,
                        required: op.required ?? [],
                        properties: Object.fromEntries(op.parameters.map((name) => [name, { type: "string" }])),
                      },
                      ...(op.projection ? { responseProjection: { type: "object", additionalProperties: { type: "string" } } } : {}),
                    },
                  })),
                },
              },
            },
          },
        },
      },
    },
    "x-airnode": { address, version: "0.1.0" },
  };
}
