import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateListingDocumentCheck, evaluateProbeCheck } from "../src/checks.js";
import { AIRNODE_RECIPES, LIMITS } from "../src/config.js";
import {
  MAX_DATA_BYTES,
  applyDocumentResult,
  applyProbeResult,
  canonicalRequest,
  checkListingDocument,
  describeShape,
  listingUrls,
  nextSlot,
  planProbeTasks,
  shapeMismatch,
} from "../src/listings.js";
import { EPOCH_RECIPE_REQUESTS, listingDocument, loadSamples } from "./helpers.js";

const encoder = new TextEncoder();
const byId = Object.fromEntries(AIRNODE_RECIPES.map((recipe) => [recipe.id, recipe]));
const matches = (recipe, text) => shapeMismatch(recipe.shape, encoder.encode(text));

test("configuration: five recipes with unique ids, registry recipes, https gateways and signers", () => {
  assert.deepEqual(
    AIRNODE_RECIPES.map((r) => r.id),
    ["hyperliquid-btc-day-volume", "drpc-ethereum-blockhash", "tickerlayer-btcusd", "nodary-eth-usd", "drpc-base-blockhash"],
  );
  assert.equal(new Set(AIRNODE_RECIPES.map((r) => r.recipe)).size, AIRNODE_RECIPES.length);
  for (const r of AIRNODE_RECIPES) {
    assert.match(r.id, /^[a-z0-9-]+$/);
    assert.match(r.url, /^https:\/\/[a-z0-9.-]+\/$/);
    assert.match(r.signer, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.body) && Object.isFrozen(r.shape));
    assert.doesNotThrow(() => describeShape(r.shape));
  }
  assert.deepEqual(listingUrls(AIRNODE_RECIPES), [
    "https://airnode-hyperliquid.fly.dev/",
    "https://airnode-drpc.fly.dev/",
    "https://airnode-tickerlayer.fly.dev/",
    "https://airnode-nodary.fly.dev/",
  ]);
});

test("canonical requests equal EpochEntropy.recipeRequest for every configured recipe", () => {
  for (const r of AIRNODE_RECIPES) assert.equal(canonicalRequest(r.body), EPOCH_RECIPE_REQUESTS[r.recipe], r.id);
});

test("canonical requests of every sampled catalog recipe equal the registry literal", () => {
  const samples = loadSamples();
  assert.equal(samples.length, 16);
  const recipeOf = {
    "hyperliquid-btc-day-volume": 0,
    "drpc-ethereum-blockhash": 1,
    "tickerlayer-btcusd": 2,
    "tickerlayer-ethusd": 3,
    "nodary-eth-usd": 4,
    "hyperliquid-sol-mid": 5,
    "drpc-base-blockhash": 6,
    "nodary-btc-usd": 7,
  };
  for (const sample of samples) assert.equal(canonicalRequest(sample.body), EPOCH_RECIPE_REQUESTS[recipeOf[sample.recipe]], sample.recipe);
});

test("canonicalization sorts object keys at every depth, keeps array order, appends a projection", () => {
  assert.equal(
    canonicalRequest({ operation: "op", parameters: { b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, B: "x" } }),
    '["op",[["B","x"],["a",[["c",null],["d",[3,[["y",2],["z",1]]]]]],["b",1]]]',
  );
  assert.equal(canonicalRequest({ operation: "allMids", parameters: {}, responseProjection: { mid: "/SOL" } }), '["allMids",[],[["mid","/SOL"]]]');
  assert.equal(canonicalRequest({ operation: "op", parameters: { list: [] } }), '["op",[["list",[]]]]');
  // Key order in the configured body never matters.
  assert.equal(
    canonicalRequest({ parameters: { symbol: "BTCUSD", assetClass: "crypto" }, operation: "lastTrade" }),
    canonicalRequest(byId["tickerlayer-btcusd"].body),
  );
});

test("describeShape renders the expected data of each recipe", () => {
  assert.deepEqual(AIRNODE_RECIPES.map((r) => describeShape(r.shape)), [
    '{"symbol":"BTC","value":"<decimal>"}',
    '{"id":null,"jsonrpc":"2.0","result":"0x<64 lowercase hex>"}',
    '{"symbol":"BTCUSD","price":<number>,"size":<number>,"timestamp":<integer>}',
    '{"ETH/USD":{"value":<number>,"timestamp":<13-digit integer>,"category":"crypto"}}',
    '{"id":null,"jsonrpc":"2.0","result":"0x<64 lowercase hex>"}',
  ]);
});

test("shape: the data of every real sample of a configured recipe matches", () => {
  let checked = 0;
  for (const sample of loadSamples()) {
    const recipe = byId[sample.recipe];
    if (!recipe) continue;
    const data = sample.response.data;
    assert.equal(matches(recipe, typeof data === "string" ? data : JSON.stringify(data)), null, sample.recipe);
    checked++;
  }
  assert.equal(checked, 10);
});

test("shape: Hyperliquid decimal string", () => {
  const r = byId["hyperliquid-btc-day-volume"];
  for (const good of ["0", "0.5", "3252667967.0465483665", "10"]) assert.equal(matches(r, `{"symbol":"BTC","value":"${good}"}`), null, good);
  for (const bad of ["", "01", "1.", ".5", "1e5", "-1", "1,5", " 1", "NaN"]) {
    assert.notEqual(matches(r, `{"symbol":"BTC","value":"${bad}"}`), null, bad);
  }
  assert.equal(matches(r, '{"symbol":"ETH","value":"1"}'), 11);
  assert.equal(matches(r, '{"symbol":"BTC","value":1}'), 24);
  assert.notEqual(matches(r, '{"symbol":"BTC","value":"1","extra":1}'), null);
  assert.notEqual(matches(r, '{"symbol":"BTC","value":"1"} '), null);
  assert.notEqual(matches(r, '{"value":"1","symbol":"BTC"}'), null);
});

test("shape: dRPC block hash envelope", () => {
  const r = byId["drpc-ethereum-blockhash"];
  const envelope = (result, id = "null") => `{"id":${id},"jsonrpc":"2.0","result":"${result}"}`;
  assert.equal(matches(r, envelope("0x" + "0123456789abcdef".repeat(4))), null);
  assert.notEqual(matches(r, envelope("0x" + "A".repeat(64))), null, "uppercase hex");
  assert.notEqual(matches(r, envelope("0x" + "a".repeat(63))), null, "63 characters");
  assert.notEqual(matches(r, envelope("0x" + "a".repeat(65))), null, "65 characters");
  assert.notEqual(matches(r, envelope("a".repeat(64))), null, "no 0x");
  assert.notEqual(matches(r, envelope("0x" + "a".repeat(64), "1")), null, "numeric id");
  assert.notEqual(matches(r, '{"id":null,"jsonrpc":"2.0","result":null}'), null);
});

test("shape: TickerLayer trade numbers and millisecond timestamp", () => {
  const r = byId["tickerlayer-btcusd"];
  const trade = (price, size, timestamp) => `{"symbol":"BTCUSD","price":${price},"size":${size},"timestamp":${timestamp}}`;
  for (const [price, size] of [["76437.4", "0.03481735"], ["76446.12", "0.00003761"], ["1", "6e-8"], ["1E+2", "0"], ["2.5e10", "3.761e-05"]]) {
    assert.equal(matches(r, trade(price, size, "1789653336751")), null, `${price} ${size}`);
  }
  for (const [price, size] of [["-1", "1"], ["01", "1"], ["1.", "1"], ["1", "1e"], ["1", "1e+"], ["1", ".1"], ['"1"', "1"]]) {
    assert.notEqual(matches(r, trade(price, size, "1789653336751")), null, `${price} ${size}`);
  }
  assert.equal(matches(r, trade("1", "1", "1234567890123456")), null, "16 digits");
  for (const timestamp of ["0", "01789653336751", "12345678901234567", "1789653336751.5", "1e12", '"1789653336751"']) {
    assert.notEqual(matches(r, trade("1", "1", timestamp)), null, timestamp);
  }
  assert.notEqual(matches(r, '{"symbol":"BTCUSD","size":1,"price":1,"timestamp":1}'), null, "key order");
  assert.notEqual(matches(r, '{"symbol":"ETHUSD","price":1,"size":1,"timestamp":1}'), null, "symbol");
});

test("shape: Nodary feed", () => {
  const r = byId["nodary-eth-usd"];
  const feed = (value, timestamp, category = "crypto") => `{"ETH/USD":{"value":${value},"timestamp":${timestamp},"category":"${category}"}}`;
  assert.equal(matches(r, feed("2458.9", "1789653374566")), null);
  assert.equal(matches(r, feed("76634.54000000001", "1789653374566")), null);
  assert.notEqual(matches(r, feed("2458.9", "178965337456")), null, "12 digits");
  assert.notEqual(matches(r, feed("2458.9", "17896533745660")), null, "14 digits");
  assert.notEqual(matches(r, feed("2458.9", "0789653374566")), null, "leading zero");
  assert.notEqual(matches(r, feed("2458.9", "1789653374566", "stock")), null, "category");
  assert.notEqual(matches(r, feed('"2458.9"', "1789653374566")), null, "string value");
  assert.notEqual(matches(r, '{"BTC/USD":{"value":1,"timestamp":1789653374566,"category":"crypto"}}'), null, "feed name");
});

test("shape: 1 to 128 bytes", () => {
  const r = byId["hyperliquid-btc-day-volume"];
  assert.equal(shapeMismatch(r.shape, new Uint8Array(0)), 0);
  const prefix = '{"symbol":"BTC","value":"';
  const exact = prefix + "1".repeat(MAX_DATA_BYTES - prefix.length - 2) + '"}';
  assert.equal(encoder.encode(exact).length, 128);
  assert.equal(matches(r, exact), null);
  assert.equal(matches(r, prefix + "1".repeat(MAX_DATA_BYTES - prefix.length - 1) + '"}'), MAX_DATA_BYTES);
  assert.throws(() => shapeMismatch([{ bogus: true }], encoder.encode("x")), /unknown shape part/);
});

test("nextSlot lands on the phase, strictly after now", () => {
  assert.equal(nextSlot(1000, 720, 3600), 4320);
  assert.equal(nextSlot(720, 720, 3600), 4320);
  assert.equal(nextSlot(719, 720, 3600), 720);
  assert.equal(nextSlot(0, 2880, 3600), 2880);
});

test("planProbeTasks: everything is due at first; listing documents only in runs without a due probe; capped", () => {
  const now = 1789653600; // a whole hour
  const empty = new Map();
  const first = planProbeTasks(AIRNODE_RECIPES, empty, now);
  assert.equal(first.length, LIMITS.probeMaxPerRun);
  assert.ok(first.every((t) => t.kind === "probe"));
  assert.deepEqual(first.map((t) => t.phase), [0, 720, 1440, 2160, 2880]);
  assert.equal(planProbeTasks(AIRNODE_RECIPES, empty, now, 20).length, 5, "documents wait while probes are due");
  assert.deepEqual(planProbeTasks(AIRNODE_RECIPES, empty, now, 2).map((t) => t.recipes[0].id), ["hyperliquid-btc-day-volume", "drpc-ethereum-blockhash"]);

  // After a full round of probes, the four listing documents are due; dRPC's covers both of its recipes.
  const states = new Map(AIRNODE_RECIPES.map((r) => [r.id, { nextProbeAt: now + 60 }]));
  const documents = planProbeTasks(AIRNODE_RECIPES, states, now);
  assert.deepEqual(documents.map((t) => t.kind), ["document", "document", "document", "document"]);
  assert.deepEqual(documents.map((t) => t.phase), [0, 21600, 43200, 64800]);
  assert.deepEqual(documents[1].recipes.map((r) => r.id), ["drpc-ethereum-blockhash", "drpc-base-blockhash"]);

  // Nothing due until the next slot; the most overdue probe goes first.
  for (const s of states.values()) s.document = { nextCheckAt: now + 86400 };
  assert.deepEqual(planProbeTasks(AIRNODE_RECIPES, states, now), []);
  states.get("nodary-eth-usd").nextProbeAt = now - 600;
  states.get("drpc-ethereum-blockhash").nextProbeAt = now - 60;
  assert.deepEqual(planProbeTasks(AIRNODE_RECIPES, states, now).map((t) => t.recipes[0].id), ["nodary-eth-usd", "drpc-ethereum-blockhash"]);
  assert.deepEqual(planProbeTasks(AIRNODE_RECIPES, states, now, 1).map((t) => t.recipes[0].id), ["nodary-eth-usd"]);
  // A listing document is due when any recipe served at that URL is due.
  states.get("nodary-eth-usd").nextProbeAt = now + 60;
  states.get("drpc-ethereum-blockhash").nextProbeAt = now + 60;
  states.get("drpc-base-blockhash").document.nextCheckAt = now;
  assert.deepEqual(planProbeTasks(AIRNODE_RECIPES, states, now).map((t) => [t.kind, t.recipes.length]), [["document", 2]]);
});

test("probe state: failures count up, a failed probe keeps the last verdict, passing realigns to the phase", () => {
  const now = 1789653600;
  const phase = 720;
  let s = applyProbeResult(null, { outcome: "ok", latencyMs: 812, signedLagSeconds: 1 }, now, phase);
  assert.equal(s.failures, 0);
  assert.equal(s.verdict, "ok");
  assert.equal(s.lastOkAt, now);
  assert.equal(s.nextProbeAt, now + phase);
  assert.equal(evaluateProbeCheck(byId["nodary-eth-usd"], s), null);

  s = applyProbeResult(s, { outcome: "failure", reason: "timeout", latencyMs: 15000 }, now + 720, phase);
  assert.equal(s.failures, 1);
  assert.equal(s.verdict, "ok");
  assert.equal(s.nextProbeAt, now + 720 + LIMITS.probeRetrySeconds);
  assert.equal(evaluateProbeCheck(byId["nodary-eth-usd"], s), null, "one failed probe is not an alert");

  s = applyProbeResult(s, { outcome: "failure", reason: "http 503" }, now + 1320, phase);
  const warn = evaluateProbeCheck(byId["nodary-eth-usd"], s);
  assert.deepEqual(warn, { severity: "warning", title: "Nodary ETH/USD listing unreachable", detail: "2 consecutive probes failed (last: http 503)" });
  s = applyProbeResult(s, { outcome: "failure", reason: "http 503" }, now + 1920, phase);
  assert.equal(evaluateProbeCheck(byId["nodary-eth-usd"], s).severity, "warning");
  s = applyProbeResult(s, { outcome: "failure", reason: "http 503" }, now + 2520, phase);
  assert.equal(evaluateProbeCheck(byId["nodary-eth-usd"], s).severity, "alarm");

  s = applyProbeResult(s, { outcome: "signer", reason: "signature recovers 0x01" }, now + 3120, phase);
  assert.equal(s.failures, 0);
  assert.deepEqual(evaluateProbeCheck(byId["nodary-eth-usd"], s), { severity: "alarm", title: "Nodary ETH/USD signer mismatch", detail: "signature recovers 0x01" });
  s = applyProbeResult(s, { outcome: "failure", reason: "timeout" }, now + 3720, phase);
  assert.equal(evaluateProbeCheck(byId["nodary-eth-usd"], s).title, "Nodary ETH/USD signer mismatch", "a failed probe does not clear a mismatch");
  s = applyProbeResult(s, { outcome: "ok", signedLagSeconds: 2 }, now + 4320, phase);
  assert.equal(evaluateProbeCheck(byId["nodary-eth-usd"], s), null);
  assert.equal(s.nextProbeAt, now + 3600 + phase + 3600);

  const titles = ["request_hash", "data_shape", "timestamp"].map(
    (outcome) => evaluateProbeCheck(byId["nodary-eth-usd"], applyProbeResult(null, { outcome, reason: "x" }, now, 0)).title,
  );
  assert.deepEqual(titles, ["Nodary ETH/USD request hash mismatch", "Nodary ETH/USD data shape mismatch", "Nodary ETH/USD signed timestamp out of range"]);
});

test("listing document state: a read failure keeps the verdict and retries hourly; a mismatch alarms", () => {
  const recipe = byId["drpc-base-blockhash"];
  const now = 1789653600;
  let s = applyDocumentResult({ failures: 0 }, { outcome: "ok", reason: null }, 300, now, 21600);
  assert.equal(s.failures, 0, "probe fields are kept");
  assert.equal((s.document.nextCheckAt - 21600) % 86400, 0, "daily, at the listing's phase");
  assert.ok(s.document.nextCheckAt > now && s.document.nextCheckAt <= now + 86400);
  assert.equal(evaluateListingDocumentCheck(recipe, s), null);
  s = applyDocumentResult(s, { outcome: "operation", reason: "jsonRpc is no longer offered" }, 300, now + 21600, 21600);
  assert.deepEqual(evaluateListingDocumentCheck(recipe, s), {
    severity: "alarm",
    title: "dRPC Base block hash operation missing from listing document",
    detail: "jsonRpc is no longer offered",
  });
  s = applyDocumentResult(s, { outcome: "failure", reason: "listing document: timeout" }, null, now + 30000, 21600);
  assert.equal(s.document.nextCheckAt, now + 30000 + LIMITS.listingDocumentRetrySeconds);
  assert.equal(evaluateListingDocumentCheck(recipe, s).severity, "alarm");
  s = applyDocumentResult(s, { outcome: "signer", reason: "x-airnode.address is 0x01" }, 1, now + 40000, 21600);
  assert.equal(evaluateListingDocumentCheck(recipe, s).title, "dRPC Base block hash listing document signer mismatch");
  assert.equal(evaluateListingDocumentCheck(recipe, applyDocumentResult(s, { outcome: "ok" }, 1, now + 50000, 0)), null);
  assert.equal(evaluateListingDocumentCheck(recipe, null), null);
});

test("checkListingDocument: signer, operation, parameters and projection", () => {
  const hyper = byId["hyperliquid-btc-day-volume"];
  const doc = listingDocument(hyper.signer, [
    { operation: "allMids", parameters: [] },
    { operation: "metaAndAssetCtxs", parameters: ["dex"], projection: true },
  ]);
  assert.deepEqual(checkListingDocument(hyper, doc), { outcome: "ok", reason: null });

  const other = listingDocument("0x1111111111111111111111111111111111111111", [{ operation: "metaAndAssetCtxs", parameters: ["dex"], projection: true }]);
  assert.deepEqual(checkListingDocument(hyper, other), {
    outcome: "signer",
    reason: `x-airnode.address is 0x1111111111111111111111111111111111111111, catalog expects ${hyper.signer}`,
  });
  const gone = listingDocument(hyper.signer, [{ operation: "allMids", parameters: [] }]);
  assert.deepEqual(checkListingDocument(hyper, gone), { outcome: "operation", reason: "metaAndAssetCtxs is no longer offered" });
  const noDex = listingDocument(hyper.signer, [{ operation: "metaAndAssetCtxs", parameters: ["coin"], projection: true }]);
  assert.equal(checkListingDocument(hyper, noDex).reason, "metaAndAssetCtxs no longer accepts parameter dex");
  const noProjection = listingDocument(hyper.signer, [{ operation: "metaAndAssetCtxs", parameters: ["dex"], projection: false }]);
  assert.equal(checkListingDocument(hyper, noProjection).reason, "metaAndAssetCtxs no longer accepts responseProjection");
  const required = listingDocument(hyper.signer, [{ operation: "metaAndAssetCtxs", parameters: ["dex", "apiKey"], required: ["apiKey"], projection: true }]);
  assert.equal(checkListingDocument(hyper, required).reason, "metaAndAssetCtxs now requires parameter apiKey");

  // Formats the check does not recognize never alert.
  assert.equal(checkListingDocument(hyper, []).outcome, "failure");
  assert.equal(checkListingDocument(hyper, { openapi: "3.1.0" }).outcome, "failure");
  assert.equal(checkListingDocument(hyper, { "x-airnode": { address: hyper.signer }, paths: {} }).outcome, "failure");
  // Addresses compare case-insensitively.
  assert.equal(checkListingDocument(hyper, listingDocument(hyper.signer.toLowerCase(), [{ operation: "metaAndAssetCtxs", parameters: ["dex"], projection: true }])).outcome, "ok");
});
