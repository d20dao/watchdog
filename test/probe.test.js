import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { AIRNODE_RECIPES, LIMITS, NETWORKS, NETWORK_NAMES, watchedAgentApi } from "../src/config.js";
import { runCron } from "../src/cron.js";
import {
  attestationDigest,
  bytesToHex,
  evaluateResponse,
  hexToBytes,
  probeRecipe,
  readListingDocument,
  recoverSigner,
  requestHash,
  runProbeTasks,
  signedDataBytes,
} from "../src/probe.js";
import { buildStatus, renderHtml } from "../src/status.js";
import { readAlerts, readProbeStates } from "../src/store.js";
import { MAINNET, TESTNET, agentApiPoll, healthyRead, listingDocument, loadSamples, memoryStorage, pageText } from "./helpers.js";

// Agent API polls are covered in agentapi.test.js; here they always answer healthy without a fetch.
const readAgentApiImpl = async () => agentApiPoll();

const SAMPLES = loadSamples();
const byId = Object.fromEntries(AIRNODE_RECIPES.map((recipe) => [recipe.id, recipe]));
const sampleOf = (id, index = 0) => structuredClone(SAMPLES.filter((s) => s.recipe === id)[index]);
const N = secp256k1.Point.CURVE().n;

// Catalog recipes 3, 5 and 7 are not probed today; configured the same way, their real replies pass too.
const EXTRA_RECIPES = {
  "tickerlayer-ethusd": {
    ...byId["tickerlayer-btcusd"],
    id: "tickerlayer-ethusd",
    body: { operation: "lastTrade", parameters: { assetClass: "crypto", symbol: "ETHUSD" } },
    shape: [{ literal: '{"symbol":"ETHUSD","price":' }, ...byId["tickerlayer-btcusd"].shape.slice(1)],
  },
  "hyperliquid-sol-mid": {
    ...byId["hyperliquid-btc-day-volume"],
    id: "hyperliquid-sol-mid",
    body: { operation: "allMids", parameters: {}, responseProjection: { mid: "/SOL" } },
    shape: [{ literal: '{"mid":"' }, { number: "decimal" }, { literal: '"}' }],
  },
  "nodary-btc-usd": {
    ...byId["nodary-eth-usd"],
    id: "nodary-btc-usd",
    body: { operation: "latestFeeds", parameters: { name: "BTC/USD" } },
    shape: [{ literal: '{"BTC/USD":{"value":' }, ...byId["nodary-eth-usd"].shape.slice(1)],
  },
};

// ---------------------------------------------------------------------------------------------
// A throwaway signer for synthetic gateway replies

const TEST_KEY = new Uint8Array(32).fill(7);
const addressOf = (key) => "0x" + bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12));
const TEST_SIGNER = addressOf(TEST_KEY);
const ETH_PREFIX = new TextEncoder().encode("\x19Ethereum Signed Message:\n32");

function personalSign(digest, key) {
  const message = new Uint8Array(ETH_PREFIX.length + 32);
  message.set(ETH_PREFIX);
  message.set(digest, ETH_PREFIX.length);
  const recovered = secp256k1.sign(keccak_256(message), key, { prehash: false, format: "recovered" }); // recid || r || s
  const out = new Uint8Array(65);
  out.set(recovered.subarray(1), 0);
  out[64] = 27 + recovered[0];
  return "0x" + bytesToHex(out);
}

/** A gateway reply for `recipe`, signed with `key` over `hash` (the recipe's request hash by default). */
function signedReply(recipe, data, timestamp, { key = TEST_KEY, hash = requestHash(recipe.body), airnode = recipe.signer } = {}) {
  const digest = attestationDigest(hash, BigInt(timestamp), signedDataBytes(data));
  return { airnode, requestHash: hash, timestamp: String(timestamp), data, signature: personalSign(digest, key) };
}

function testRecipe(id, name, url, template, overrides = {}) {
  return { ...template, id, name, url, signer: TEST_SIGNER, ...overrides };
}

const NODARY_DATA = (ms) => ({ "ETH/USD": { value: 2458.9, timestamp: ms, category: "crypto" } });
const TRADE_DATA = (ms) => ({ symbol: "BTCUSD", price: 76437.4, size: 0.00003761, timestamp: ms });

// ---------------------------------------------------------------------------------------------
// Request hash and signature

test("requestHash of every configured recipe equals the requestHash its gateway signed", () => {
  for (const recipe of AIRNODE_RECIPES) {
    const samples = SAMPLES.filter((s) => s.recipe === recipe.id);
    assert.equal(samples.length, 2, recipe.id);
    for (const s of samples) assert.equal(requestHash(recipe.body), s.response.requestHash, recipe.id);
  }
  for (const s of SAMPLES) assert.equal(requestHash(s.body), s.response.requestHash, s.recipe);
});

test("every real sample recovers to its listing's signer", () => {
  for (const s of SAMPLES) {
    const r = s.response;
    const digest = attestationDigest(r.requestHash, BigInt(r.timestamp), signedDataBytes(r.data));
    assert.equal(recoverSigner(digest, hexToBytes(r.signature)), r.airnode.toLowerCase(), s.recipe);
  }
  // The gateway signs JSON.stringify(data): 3.761e-05 is signed as 0.00003761.
  const small = SAMPLES.find((s) => s.response.data?.size === 3.761e-5);
  assert.match(new TextDecoder().decode(signedDataBytes(small.response.data)), /"size":0\.00003761,/);
  assert.equal(new TextDecoder().decode(signedDataBytes('{"mid":"1"}')), '{"mid":"1"}', "string data is signed as is");
});

test("signature rules follow OpenZeppelin ECDSA.recover", () => {
  const r = sampleOf("nodary-eth-usd").response;
  const digest = attestationDigest(r.requestHash, BigInt(r.timestamp), signedDataBytes(r.data));
  const sig = hexToBytes(r.signature);

  // Malleable twin (n - s, flipped v) recovers the same key but is rejected on chain.
  const s = BigInt("0x" + bytesToHex(sig.subarray(32, 64)));
  const twin = sig.slice();
  twin.set(hexToBytes("0x" + (N - s).toString(16).padStart(64, "0")), 32);
  twin[64] = sig[64] === 27 ? 28 : 27;
  assert.throws(() => recoverSigner(digest, twin), /signature s is not in the lower half order/);

  const v0 = sig.slice();
  v0[64] = sig[64] - 27;
  assert.throws(() => recoverSigner(digest, v0), /signature v is not 27 or 28/);
  const zeroR = sig.slice();
  zeroR.fill(0, 0, 32);
  assert.throws(() => recoverSigner(digest, zeroR), /signature r or s is out of range/);
  assert.throws(() => recoverSigner(digest, sig.subarray(0, 64)), /signature is not 65 bytes/);

  // Different data under a valid signature recovers someone else.
  const other = attestationDigest(r.requestHash, BigInt(r.timestamp), signedDataBytes({ ...r.data, "ETH/USD": { ...r.data["ETH/USD"], value: 2458.8 } }));
  assert.notEqual(recoverSigner(other, sig), r.airnode.toLowerCase());
});

// ---------------------------------------------------------------------------------------------
// Judging replies

test("evaluateResponse passes the real replies of all eight catalog recipes", () => {
  for (const s of SAMPLES) {
    const recipe = byId[s.recipe] ?? EXTRA_RECIPES[s.recipe];
    assert.ok(recipe, s.recipe);
    const result = evaluateResponse(recipe, s.response, Number(s.response.timestamp) + 5);
    assert.deepEqual(result, { outcome: "ok", reason: null, signedLagSeconds: 5 }, s.recipe);
  }
});

test("evaluateResponse: request hash, airnode and signature mismatches", () => {
  const recipe = byId["drpc-ethereum-blockhash"];
  const base = sampleOf("drpc-base-blockhash").response;
  const at = (reply) => evaluateResponse(recipe, reply, Number(base.timestamp));

  assert.deepEqual(at(base), {
    outcome: "request_hash",
    reason: "gateway signed 0xd5ded974...2e3d, recipe expects 0xabe6d1ad...abda",
  });
  assert.equal(at({ ...base, requestHash: 42 }).reason, "gateway signed no valid requestHash, recipe expects 0xabe6d1ad...abda");

  const eth = sampleOf("drpc-ethereum-blockhash").response;
  const now = Number(eth.timestamp);
  const check = (reply) => evaluateResponse(recipe, reply, now);
  assert.deepEqual(check({ ...eth, airnode: "0x1111111111111111111111111111111111111111" }), {
    outcome: "signer",
    reason: `reply names airnode 0x1111111111111111111111111111111111111111, catalog expects ${recipe.signer}`,
  });
  assert.equal(check({ ...eth, airnode: "<script>" }).reason, `reply names airnode no valid address, catalog expects ${recipe.signer}`);

  // Signed by a different key while naming the catalog signer.
  const forged = signedReply(recipe, eth.data, eth.timestamp);
  assert.deepEqual(check(forged), { outcome: "signer", reason: `signature recovers ${TEST_SIGNER}, catalog expects ${recipe.signer}` });
  // Data changed after signing.
  const tampered = { ...eth, data: { ...eth.data, result: "0x" + "0".repeat(64) } };
  assert.equal(check(tampered).outcome, "signer");
  assert.match(check(tampered).reason, /^signature recovers 0x[0-9a-f]{40}, catalog expects /);
  assert.deepEqual(check({ ...eth, signature: "0x1234" }), { outcome: "signer", reason: "signature is not 65 bytes of hex" });
  assert.deepEqual(check({ ...eth, signature: eth.signature.slice(0, -2) + "01" }), { outcome: "signer", reason: "signature v is not 27 or 28" });
});

test("evaluateResponse: data shape and signed timestamp", () => {
  const recipe = testRecipe("test-feed", "Test feed", "https://airnode-test.example/", byId["nodary-eth-usd"]);
  const T = 1789653600;
  const ok = signedReply(recipe, NODARY_DATA(T * 1000 + 250), T);
  assert.deepEqual(evaluateResponse(recipe, ok, T + 240), { outcome: "ok", reason: null, signedLagSeconds: 240 });
  assert.deepEqual(evaluateResponse(recipe, ok, T + 241), { outcome: "timestamp", reason: "signed 241s before the probe (limit 240s)" });
  assert.equal(evaluateResponse(recipe, ok, T - 60).outcome, "ok");
  assert.deepEqual(evaluateResponse(recipe, ok, T - 61), { outcome: "timestamp", reason: "signed 61s after the probe (limit 60s)" });

  const wrongCategory = signedReply(recipe, { "ETH/USD": { value: 2458.9, timestamp: T * 1000, category: "stock" } }, T);
  assert.deepEqual(evaluateResponse(recipe, wrongCategory, T), {
    outcome: "data_shape",
    reason: '73 data bytes differ at byte 65 from {"ETH/USD":{"value":<number>,"timestamp":<13-digit integer>,"category":"crypto"}}',
  });
  const secondsTimestamp = signedReply(recipe, { "ETH/USD": { value: 1, timestamp: T, category: "crypto" } }, T);
  assert.equal(evaluateResponse(recipe, secondsTimestamp, T).outcome, "data_shape");

  assert.deepEqual(evaluateResponse(recipe, { ...ok, timestamp: T }, T), { outcome: "timestamp", reason: "timestamp is not a uint256 decimal string" });
  assert.equal(evaluateResponse(recipe, { ...ok, timestamp: "2".repeat(78) }, T).outcome, "timestamp");
  const { data, ...noData } = ok;
  assert.deepEqual(evaluateResponse(recipe, noData, T), { outcome: "data_shape", reason: "reply has no data" });

  // String data is signed and checked as is.
  const hyper = testRecipe("test-hyper", "Test hyper", "https://airnode-test.example/", byId["hyperliquid-btc-day-volume"]);
  assert.equal(evaluateResponse(hyper, signedReply(hyper, '{"symbol":"BTC","value":"1.5"}', T), T).outcome, "ok");
});

test("evaluateResponse: unsigned or unusable replies are failed probes, not mismatches", () => {
  const recipe = byId["nodary-eth-usd"];
  assert.deepEqual(evaluateResponse(recipe, { error: "upstream said no" }, 0), { outcome: "failure", reason: "unsigned gateway error" });
  assert.deepEqual(evaluateResponse(recipe, {}, 0), { outcome: "failure", reason: "reply is not a signed response" });
  assert.deepEqual(evaluateResponse(recipe, [1, 2], 0), { outcome: "failure", reason: "reply is not a JSON object" });
  assert.deepEqual(evaluateResponse(recipe, null, 0), { outcome: "failure", reason: "reply is not a JSON object" });
});

// ---------------------------------------------------------------------------------------------
// Network

test("probeRecipe POSTs the configured body and never echoes the reply", async () => {
  const recipe = byId["tickerlayer-btcusd"];
  const sample = sampleOf("tickerlayer-btcusd");
  const T = Number(sample.response.timestamp);
  let ms = T * 1000;
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    ms += 812;
    return new Response(JSON.stringify(sample.response), { headers: { "content-type": "application/json" } });
  };
  const result = await probeRecipe(recipe, { fetch, clock: () => ms });
  assert.deepEqual(result, { outcome: "ok", reason: null, signedLagSeconds: 0, latencyMs: 812 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://airnode-tickerlayer.fly.dev/");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0].init.body), sample.body);

  const reply = (body, init) => async () => new Response(body, init);
  const run = (fetchImpl, options = {}) => probeRecipe(recipe, { fetch: fetchImpl, clock: () => ms, ...options });
  const secret = "SECRET-UPSTREAM-DETAIL";
  assert.deepEqual(await run(reply(secret, { status: 404 })), { outcome: "failure", reason: "http 404", latencyMs: 0 });
  assert.deepEqual(await run(reply(`<html>${secret}</html>`)), { outcome: "failure", reason: "invalid json", latencyMs: 0 });
  assert.deepEqual(await run(reply(JSON.stringify({ error: secret }))), { outcome: "failure", reason: "unsigned gateway error", latencyMs: 0 });
  assert.equal((await run(reply("x".repeat(LIMITS.probeMaxResponseBytes + 1)))).reason, "reply too large");
  let bodyRead = false;
  const declaredTooLarge = async () =>
    new Response(new ReadableStream({ pull: () => { bodyRead = true; } }, { highWaterMark: 0 }), {
      headers: { "content-length": String(LIMITS.probeMaxResponseBytes + 1) },
    });
  assert.equal((await run(declaredTooLarge)).reason, "reply too large");
  assert.equal(bodyRead, false, "a declared oversized body is not read");
  assert.equal((await run(async () => { throw new TypeError(`connect failed ${secret}`); })).reason, "network error");
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  assert.equal((await run(hang, { timeoutMs: 10 })).reason, "timeout");
});

test("readListingDocument checks every recipe served at the URL", async () => {
  const [eth, base] = [byId["drpc-ethereum-blockhash"], byId["drpc-base-blockhash"]];
  const doc = listingDocument(eth.signer, [{ operation: "jsonRpc", parameters: ["network", "method", "params"], required: ["network", "method"] }]);
  let request;
  const fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify(doc));
  };
  const result = await readListingDocument(eth.url, [eth, base], { fetch });
  assert.equal(request.init.method, "GET");
  assert.deepEqual(result.results, [{ outcome: "ok", reason: null }, { outcome: "ok", reason: null }]);
  const failed = await readListingDocument(eth.url, [eth, base], { fetch: async () => new Response("", { status: 502 }) });
  assert.deepEqual(failed.results.map((r) => r.reason), ["listing document: http 502", "listing document: http 502"]);
});

test("runProbeTasks keeps task order and at most probeConcurrency requests open", async () => {
  const recipes = AIRNODE_RECIPES;
  const tasks = recipes.map((recipe) => ({ kind: "probe", url: recipe.url, recipes: [recipe], phase: 0, due: 0 }));
  let open = 0;
  let peak = 0;
  const fetch = async (url) => {
    open++;
    peak = Math.max(peak, open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open--;
    return new Response("", { status: url.includes("nodary") ? 500 : 503 });
  };
  const results = await runProbeTasks(tasks, { fetch });
  assert.equal(peak, LIMITS.probeConcurrency);
  assert.deepEqual(results.map((r) => r.reason), ["http 503", "http 503", "http 503", "http 500", "http 503"]);
});

// ---------------------------------------------------------------------------------------------
// Runs: alert lifecycle, status and subrequest budget

const T0 = 1789653600; // a whole hour
const TELEGRAM = { TELEGRAM_BOT_TOKEN: "123456:throwaway-token", TELEGRAM_CHAT_ID: "-1001234567890" };
const ALPHA = testRecipe("alpha-feed", "Alpha feed", "https://airnode-alpha.example/", byId["nodary-eth-usd"]);
const BETA = testRecipe("beta-trade", "Beta trade", "https://airnode-beta.example/", byId["tickerlayer-btcusd"]);

/**
 * Gateways sign fresh replies with the test key at the harness clock. `modes[recipeId]` picks the behavior:
 * ok | http503 | hash | signer | shape | stale. `documents[url]` is a document object or an HTTP status.
 */
function harness(recipes, { env = TELEGRAM } = {}) {
  const storage = memoryStorage();
  const state = { clock: T0, modes: {}, documents: {}, telegram: [], gatewayCalls: [], open: 0, peak: 0 };
  for (const recipe of recipes) {
    state.documents[recipe.url] = listingDocument(TEST_SIGNER, recipes
      .filter((r) => r.url === recipe.url)
      .map((r) => ({ operation: r.body.operation, parameters: Object.keys(r.body.parameters), projection: r.body.responseProjection !== undefined })));
  }
  const dataFor = (recipe, ms) => (recipe.shape[0].literal.startsWith('{"symbol"') ? TRADE_DATA(ms) : NODARY_DATA(ms));
  const fetch = async (url, init) => {
    if (url.startsWith("https://api.telegram.org/")) {
      state.telegram.push(JSON.parse(init.body).text);
      return new Response("{}");
    }
    state.gatewayCalls.push({ url, method: init.method });
    state.open++;
    state.peak = Math.max(state.peak, state.open);
    await Promise.resolve();
    state.open--;
    if (init.method === "GET") {
      const doc = state.documents[url];
      return typeof doc === "number" ? new Response("", { status: doc }) : new Response(JSON.stringify(doc));
    }
    const body = JSON.parse(init.body);
    const recipe = recipes.find((r) => r.url === url && JSON.stringify(r.body) === JSON.stringify(body));
    const mode = state.modes[recipe.id] ?? "ok";
    const ms = state.clock * 1000 + 120;
    if (mode === "http503") return new Response("gateway down: SECRET-UPSTREAM-DETAIL", { status: 503 });
    const reply =
      mode === "hash" ? signedReply(recipe, dataFor(recipe, ms), state.clock, { hash: "0x" + "ab".repeat(32) })
      : mode === "signer" ? signedReply(recipe, dataFor(recipe, ms), state.clock, { key: new Uint8Array(32).fill(9) })
      : mode === "shape" ? signedReply(recipe, { ...dataFor(recipe, ms), extra: true }, state.clock)
      : mode === "stale" ? signedReply(recipe, dataFor(recipe, ms), state.clock - 600)
      : signedReply(recipe, dataFor(recipe, ms), state.clock);
    return new Response(JSON.stringify(reply));
  };
  const run = (minutes, reads = {}) => {
    if (minutes !== undefined) state.clock = T0 + Math.round(minutes * 60);
    return runCron({
      storage,
      env,
      fetch,
      clock: () => state.clock * 1000,
      readChainImpl: async (net) => reads[net.name] ?? healthyRead(net),
      readAgentApiImpl,
      recipes,
    });
  };
  const texts = () => state.telegram.flatMap((text) => text.split("\n\n")).filter((t) => t.startsWith("[airnodehub]"));
  return { storage, state, run, texts };
}

test("unreachable listing: warning after 2 failed probes, alarm after 4, retried every 10 minutes, resolved by a passing probe", async () => {
  const h = harness([ALPHA, BETA]);
  h.state.modes["alpha-feed"] = "http503";
  const first = await h.run(0);
  assert.deepEqual(first.airnodehub.probes.map((p) => p.recipe), ["alpha-feed", "beta-trade"]);
  assert.deepEqual(first.airnodehub.probes[0], { recipe: "alpha-feed", outcome: "failure", reason: "http 503", latencyMs: 0 });
  assert.deepEqual(h.texts(), []);
  assert.deepEqual((await h.run(1)).airnodehub.probes.map((p) => p.listingDocument), [ALPHA.url, BETA.url], "documents in the next run");
  assert.equal((await h.run(2)).airnodehub.probes.length, 0, "nothing due until the retry");

  await h.run(10);
  assert.deepEqual(h.texts(), ["[airnodehub] WARNING Alpha feed listing unreachable: 2 consecutive probes failed (last: http 503)"]);
  await h.run(20);
  assert.equal(h.texts().length, 1, "warnings never repeat");
  await h.run(30);
  assert.equal(h.texts()[1], "[airnodehub] ALARM Alpha feed listing unreachable: 4 consecutive probes failed (last: http 503)");
  assert.equal(readAlerts(h.storage, "airnodehub")[0].check, "probe:alpha-feed");

  h.state.modes["alpha-feed"] = "ok";
  await h.run(40);
  assert.equal(h.texts()[2], "[airnodehub] RESOLVED Alpha feed listing unreachable after 30 min");
  const alpha = readProbeStates(h.storage).get("alpha-feed");
  assert.equal(alpha.failures, 0);
  assert.equal(alpha.nextProbeAt, T0 + 3600, "back on its hourly phase");
  assert.equal(readProbeStates(h.storage).get("beta-trade").nextProbeAt, T0 + 5400, "the second recipe runs half an hour apart");
  assert.ok(!JSON.stringify(h.state.telegram).includes("SECRET"), "reply bodies never reach messages");
});

test("request hash mismatch alarms at once, repeats every 30 min, survives a failed probe, resolves when fixed", async () => {
  const h = harness([ALPHA, BETA]);
  h.state.modes["beta-trade"] = "hash";
  await h.run(0);
  const expected = requestHash(BETA.body);
  assert.deepEqual(h.texts(), [
    `[airnodehub] ALARM Beta trade request hash mismatch: gateway signed 0xabababab...abab, recipe expects ${expected.slice(0, 10)}...${expected.slice(-4)}`,
  ]);
  await h.run(10);
  await h.run(20);
  assert.equal(h.texts().length, 1);
  await h.run(30);
  assert.match(h.texts()[1], /^\[airnodehub\] ALARM Beta trade request hash mismatch: .* \(active 30 min\)$/);
  h.state.modes["beta-trade"] = "http503";
  await h.run(40);
  assert.equal(h.texts().length, 2, "a failed probe neither resolves nor repeats");
  assert.equal(readAlerts(h.storage, "airnodehub")[0].title, "Beta trade request hash mismatch");
  h.state.modes["beta-trade"] = "ok";
  await h.run(50);
  assert.equal(h.texts()[2], "[airnodehub] RESOLVED Beta trade request hash mismatch after 50 min");
});

test("signer, data shape and signed timestamp mismatches alarm on the first probe", async () => {
  const recipes = ["signer", "shape", "stale"].map((mode, i) =>
    testRecipe(`r-${mode}`, `Recipe ${mode}`, `https://airnode-${mode}.example/`, i === 1 ? byId["tickerlayer-btcusd"] : byId["nodary-eth-usd"]),
  );
  const h = harness(recipes);
  for (const r of recipes) h.state.modes[r.id] = r.id.slice(2);
  await h.run(0);
  const texts = h.texts();
  assert.equal(texts.length, 3);
  assert.match(texts[0], /^\[airnodehub\] ALARM Recipe signer signer mismatch: signature recovers 0x[0-9a-f]{40}, catalog expects 0x/);
  assert.match(texts[1], /^\[airnodehub\] ALARM Recipe shape data shape mismatch: \d+ data bytes differ at byte \d+ from \{"symbol":"BTCUSD"/);
  assert.equal(texts[2], "[airnodehub] ALARM Recipe stale signed timestamp out of range: signed 600s before the probe (limit 240s)");
});

test("listing document: a missing operation alarms, read failures stay quiet, restoring it resolves", async () => {
  const h = harness([ALPHA, BETA]);
  h.state.documents[BETA.url] = 500;
  await h.run(0); // probes
  await h.run(1); // listing documents
  assert.deepEqual(h.texts(), []);
  let status = buildStatus(h.storage, TELEGRAM, h.state.clock, [ALPHA, BETA]);
  assert.equal(status.airnodehub.recipes[1].listingDocument.status, "unknown");
  assert.equal(status.airnodehub.recipes[1].listingDocument.reason, "listing document: http 500");
  assert.equal(status.airnodehub.recipes[0].listingDocument.status, "ok");

  // The failed read is retried an hour later; the operation is gone by then.
  h.state.documents[BETA.url] = listingDocument(TEST_SIGNER, [{ operation: "quote", parameters: ["symbol"] }]);
  assert.equal((await h.run(60)).airnodehub.probes.every((p) => p.recipe), true, "probes due at minute 60 go first");
  await h.run(61);
  assert.deepEqual(h.texts(), ["[airnodehub] ALARM Beta trade operation missing from listing document: lastTrade is no longer offered"]);
  assert.equal(readAlerts(h.storage, "airnodehub").find((a) => a.check === "listing:beta-trade").severity, "alarm");

  h.state.documents[BETA.url] = listingDocument(TEST_SIGNER, [{ operation: "lastTrade", parameters: ["assetClass", "symbol"] }]);
  h.state.documents[ALPHA.url] = listingDocument("0x2222222222222222222222222222222222222222", [{ operation: "latestFeeds", parameters: ["name"] }]);
  await h.run(24 * 60); // probes; the still-active alarm is repeated (30 min passed)
  await h.run(24 * 60 + 1); // listing documents
  assert.deepEqual(h.texts().slice(1).sort(), [
    `[airnodehub] ALARM Alpha feed listing document signer mismatch: x-airnode.address is 0x2222222222222222222222222222222222222222, catalog expects ${TEST_SIGNER}`,
    "[airnodehub] ALARM Beta trade operation missing from listing document: lastTrade is no longer offered (active 1379 min)",
    "[airnodehub] RESOLVED Beta trade operation missing from listing document after 1380 min",
  ]);
  status = buildStatus(h.storage, TELEGRAM, h.state.clock, [ALPHA, BETA]);
  assert.equal(status.airnodehub.recipes[0].listingDocument.status, "alarm");
});

test("a recipe removed from the configuration resolves its alerts and drops its state", async () => {
  const h = harness([ALPHA, BETA]);
  h.state.modes["alpha-feed"] = "signer";
  await h.run(0);
  assert.equal(h.texts().length, 1);
  const summary = await runCron({
    storage: h.storage,
    env: TELEGRAM,
    fetch: async (url, init) => {
      if (url.startsWith("https://api.telegram.org/")) h.state.telegram.push(JSON.parse(init.body).text);
      return new Response("{}");
    },
    clock: () => (T0 + 120) * 1000,
    readChainImpl: async (net) => healthyRead(net),
    readAgentApiImpl,
    recipes: [BETA],
  });
  assert.ok(!JSON.stringify(summary.airnodehub.probes).includes("alpha"));
  assert.equal(h.texts()[1], "[airnodehub] RESOLVED Alpha feed signer mismatch after 2 min");
  assert.deepEqual([...readProbeStates(h.storage).keys()], ["beta-trade"]);
  assert.equal(readAlerts(h.storage, "airnodehub").length, 0);
});

test("status JSON and HTML show each recipe's last probe, latency, status and reason", async () => {
  const h = harness([ALPHA, BETA]);
  h.state.modes["alpha-feed"] = "http503";
  await h.run(0);
  await h.run(10);
  const status = buildStatus(h.storage, TELEGRAM, h.state.clock + 30, [ALPHA, BETA]);
  const [alpha, beta] = status.airnodehub.recipes;
  assert.equal(alpha.status, "warning");
  assert.equal(alpha.lastProbeAt, T0 + 600);
  assert.equal(alpha.lastProbeAgeSeconds, 30);
  assert.equal(alpha.latencyMs, 0);
  assert.equal(alpha.lastOutcome, "failure");
  assert.equal(alpha.reason, "http 503");
  assert.equal(alpha.consecutiveFailures, 2);
  assert.equal(alpha.nextProbeAt, T0 + 1200);
  assert.equal(beta.status, "ok");
  assert.equal(beta.lastOutcome, "ok");
  assert.equal(beta.reason, null);
  assert.equal(beta.signedLagSeconds, 0);
  assert.equal(beta.expectedData, '{"symbol":"BTCUSD","price":<number>,"size":<number>,"timestamp":<integer>}');
  assert.equal(status.airnodehub.alerts[0].title, "Alpha feed listing unreachable");
  assert.ok(!JSON.stringify(status).includes("SECRET"));

  const html = renderHtml(status);
  const text = pageText(html);
  assert.ok(text.includes("AirnodeHub listings WARNING"));
  assert.ok(text.includes("Alpha feed recipe 4 · latestFeeds WARNING 30s ago 0 ms"));
  assert.ok(text.includes("http 503 (2 failed in a row)"));
  assert.ok(text.includes("Beta trade recipe 2 · lastTrade OK"));
  // Severity reaches the page as its tone, not only as a word.
  assert.match(html, /class="[^"]*\bwarning\b[^"]*">WARNING<\/span>/);
  assert.match(html, /class="[^"]*\bok\b[^"]*">OK<\/span>/);

  // Never probed: shown as such; names are escaped.
  const fresh = buildStatus(memoryStorage(), {}, T0, [{ ...ALPHA, name: "<b>x</b>" }]);
  assert.equal(fresh.airnodehub.recipes[0].status, "not probed");
  const freshHtml = renderHtml(fresh);
  assert.ok(freshHtml.includes("&lt;b&gt;x&lt;/b&gt;") && freshHtml.includes("not probed yet"));
  assert.ok(!freshHtml.includes("<b>x</b>"));
  assert.equal(buildStatus(memoryStorage(), {}, T0).airnodehub.recipes.length, AIRNODE_RECIPES.length);
});

test("subrequest budget: at most 50 per run, and one probe per run once the schedule settles", async () => {
  // Static worst case: every RPC round falls back (3 rounds x 2 endpoints per network), one /health poll per network,
  // 3 Telegram sends and a full set of probe tasks.
  const worst = NETWORK_NAMES.length * (3 * 2 + 1) + LIMITS.telegramMaxSendsPerRun + LIMITS.probeMaxPerRun;
  assert.ok(worst <= 50, `worst case ${worst}`);
  const polled = NETWORK_NAMES.filter((name) => watchedAgentApi(NETWORKS[name])).length;

  // A fresh object with the real configuration: 5 probes and 4 listing documents are due, capped per run.
  const real = harness(AIRNODE_RECIPES);
  const failing = async (url, init) => {
    if (url.startsWith("https://api.telegram.org/")) return new Response("{}");
    real.state.gatewayCalls.push({ url, method: init.method });
    return new Response("", { status: 503 });
  };
  const fallbackReads = Object.fromEntries(NETWORK_NAMES.map((name) => [name, { ...healthyRead(name === "arc-mainnet" ? MAINNET : TESTNET), subrequests: 6, balanceWei: 1n }]));
  const runReal = (minutes) =>
    runCron({ storage: real.storage, env: TELEGRAM, fetch: failing, clock: () => (T0 + minutes * 60) * 1000, readChainImpl: async (net) => fallbackReads[net.name], readAgentApiImpl });
  const one = await runReal(0);
  assert.equal(real.state.gatewayCalls.length, LIMITS.probeMaxPerRun);
  assert.ok(real.state.gatewayCalls.every((c) => c.method === "POST"));
  assert.ok(one.subrequests <= 50);
  assert.equal(one.subrequests, 12 + polled + LIMITS.probeMaxPerRun + 1);
  const two = await runReal(1);
  assert.deepEqual(two.airnodehub.probes.map((p) => p.listingDocument), [
    "https://airnode-hyperliquid.fly.dev/",
    "https://airnode-drpc.fly.dev/",
    "https://airnode-tickerlayer.fly.dev/",
    "https://airnode-nodary.fly.dev/",
  ]);

  // A simulated day with five healthy recipes on four gateways, one run per minute.
  const recipes = AIRNODE_RECIPES.map((recipe, i) =>
    testRecipe(`sim-${i}`, `Sim ${i}`, recipe.url, i % 2 === 0 ? byId["nodary-eth-usd"] : byId["tickerlayer-btcusd"], { body: recipe.body }),
  );
  const sim = harness(recipes);
  const perRun = [];
  const probesPerRecipe = new Map();
  for (let minute = 0; minute < 24 * 60; minute++) {
    const before = sim.state.gatewayCalls.length;
    const summary = await sim.run(minute);
    perRun.push(sim.state.gatewayCalls.length - before);
    assert.ok(summary.subrequests <= 50);
    assert.equal(summary.messagesQueued, 0, `minute ${minute}`);
    for (const p of summary.airnodehub.probes) if (p.recipe && minute >= 60) probesPerRecipe.set(p.recipe, (probesPerRecipe.get(p.recipe) ?? 0) + 1);
  }
  assert.ok(sim.state.peak <= LIMITS.probeConcurrency);
  assert.ok(perRun.slice(60).every((n) => n <= 1), "after the first hour, at most one gateway request per run");
  assert.deepEqual([...probesPerRecipe.values()], [23, 23, 23, 23, 23], "one probe per recipe per hour");
  const documents = sim.state.gatewayCalls.filter((c) => c.method === "GET").length;
  assert.equal(documents, 4 + 4, "four listing documents at start, then once a day on their phases");
});
