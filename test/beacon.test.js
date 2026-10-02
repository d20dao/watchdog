import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  applyGroupRun,
  applyNetworkRun,
  applyRelayRun,
  beaconGroups,
  beaconWorstSubrequests,
  catalogUse,
  checkChainInfo,
  chooseRecipe,
  compareRegistration,
  currentRound,
  expectedSlotSigner,
  failedBeaconRun,
  flipLastByte,
  judgeAgreement,
  judgeLatest,
  matchesPreset,
  parseRoundReply,
  planBeacon,
  readBeaconOf,
  readCatalog,
  readCheck,
  readEpoch,
  readSlotSigner,
  relayId,
  roundTime,
  runBeacon,
  settleRound,
} from "../src/beacon.js";
import { DRAND_EVMNET, DRAND_RELAYS, LIMITS, NETWORKS, SELECTORS, THRESHOLDS } from "../src/config.js";
import {
  BEACON_RECIPE,
  DRAND_ONLY_CATALOG,
  FIXTURE,
  LAST_REAL_ROUND,
  NOW,
  PRESET,
  PRE_SWITCH_CATALOG,
  UNPINNED,
  VERIFIER,
  ZERO_BEACON,
  beaconFetch,
  drandWorld,
  encodeBeaconOfResult,
  encodeCatalogAtResult,
  realSignature,
  registeredBeacon,
  registryOf,
  roundRecord,
  slotSignerFor,
  withVerifier,
} from "./beacon-helpers.js";
import { MAINNET, TESTNET, addressWord, word } from "./helpers.js";

// The chain data in test/fixtures/drand-evmnet-2026-09-29.json is real: drand evmnet's /info and rounds 1, 21056714,
// 21056750 and 21056968, as api.drand.sh, api2.drand.sh, api3.drand.sh and drand.cloudflare.com served them that day
// (all four identically). It is a byte for byte copy of test/fixtures/drand-evmnet-2026-09-29.json in the keeper repo.
// Rounds the fixture does not hold are made up in the shape of a real one: this module never checks a BLS signature,
// the registry's verifyBeacon does.

const HOSTS = DRAND_RELAYS.map((url) => new URL(url).host);
const [API, API2, API3, CLOUDFLARE] = HOSTS;

// ---------------------------------------------------------------------------------------------
// Configuration against the real chain

test("the configured beacon is the chain the relays served", () => {
  assert.equal(PRESET, DRAND_EVMNET);
  assert.equal(PRESET.chainHash, FIXTURE.info.hash);
  assert.equal(PRESET.publicKey, FIXTURE.info.public_key);
  assert.equal(PRESET.scheme, FIXTURE.info.schemeID);
  assert.equal(PRESET.period, FIXTURE.info.period);
  assert.equal(PRESET.genesis, FIXTURE.info.genesis_time);
  assert.equal(PRESET.chainHash.length, 64, "32 bytes");
  assert.equal(PRESET.publicKey.length, 256, "128 bytes: a G2 point on bn254");
  for (const { signature } of FIXTURE.rounds) assert.equal(signature.length, PRESET.signatureBytes * 2);
  assert.deepEqual(checkChainInfo(PRESET, JSON.stringify(FIXTURE.info)), { outcome: "ok", reason: null });
});

test("round times follow the chain's clock: round r is due at genesis + (r - 1) x period", () => {
  assert.equal(roundTime(PRESET, 1), PRESET.genesis);
  assert.equal(new Date(roundTime(PRESET, LAST_REAL_ROUND) * 1000).toISOString(), "2026-09-29T14:26:16.000Z", "the day the fixture was fetched");
  for (const { round } of FIXTURE.rounds) {
    const due = roundTime(PRESET, round);
    assert.equal(currentRound(PRESET, due), round);
    assert.equal(currentRound(PRESET, due + 2), round);
    assert.equal(currentRound(PRESET, due + 3), round + 1);
    assert.equal(currentRound(PRESET, due - 1), round - 1);
  }
  assert.equal(currentRound(PRESET, PRESET.genesis - 1), 0, "no round before genesis");
  assert.equal(currentRound(PRESET, NOW), LAST_REAL_ROUND);
});

test("each network lists the beacon as recipe 11 with public https relays; registry implementations are lists", () => {
  for (const net of Object.values(NETWORKS)) {
    assert.equal(net.beacon.recipe, 11);
    assert.equal(net.beacon.preset, DRAND_EVMNET);
    assert.ok(net.beacon.verifier == null || /^0x[0-9a-fA-F]{40}$/.test(net.beacon.verifier), "unset until the verifier is deployed");
    const hosts = net.beacon.relays.map(relayId);
    assert.equal(new Set(hosts).size, hosts.length, "one entry per relay");
    for (const url of net.beacon.relays) assert.match(url, /^https:\/\/[a-z0-9.-]+$/, "no path and no trailing slash");
    // A reviewed upgrade is approved by listing its implementation before it executes.
    assert.ok(Array.isArray(net.implementations.registry) && net.implementations.registry.length >= 1);
    for (const address of net.implementations.registry) assert.match(address, /^0x[0-9a-fA-F]{40}$/);
  }
  assert.deepEqual(HOSTS, ["api.drand.sh", "api2.drand.sh", "api3.drand.sh", "drand.cloudflare.com"]);
});

test("the beacon selectors are the keccak256 selectors of their signatures", () => {
  const selector = (signature) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4)).toString("hex");
  assert.equal(SELECTORS.beaconOf, selector("beaconOf(uint8)"));
  assert.equal(SELECTORS.slotSigner, selector("slotSigner(uint8)"));
  assert.equal(SELECTORS.verifyBeacon, selector("verifyBeacon(uint8,uint64,bytes)"));
  assert.equal(SELECTORS.epochForBlock, selector("epochForBlock(uint256)"));
  assert.equal(SELECTORS.catalogAt, selector("catalogAt(uint64)"));
});

// ---------------------------------------------------------------------------------------------
// Relay replies

test("a relay's round record: the real ones parse", () => {
  for (const real of FIXTURE.rounds) {
    assert.deepEqual(parseRoundReply(PRESET, JSON.stringify(real)), { ok: true, round: real.round, signature: real.signature });
    assert.deepEqual(parseRoundReply(PRESET, JSON.stringify(real), real.round), { ok: true, round: real.round, signature: real.signature });
  }
  const upper = { ...FIXTURE.rounds[1], signature: FIXTURE.rounds[1].signature.toUpperCase() };
  assert.equal(parseRoundReply(PRESET, JSON.stringify(upper)).signature, FIXTURE.rounds[1].signature, "hex case does not matter");
});

test("a relay's round record: a round other than the one asked for, bad hex, and anything else unusable fail with a short reason", () => {
  const [, second, third] = FIXTURE.rounds;
  const reason = (text, expected) => {
    const result = parseRoundReply(PRESET, text, expected);
    assert.equal(result.ok, false, text);
    return result.reason;
  };
  assert.equal(reason(JSON.stringify(second), third.round), "asked for round 21056750, got round 21056714");
  assert.equal(reason(JSON.stringify(second), 21056715), "asked for round 21056715, got round 21056714");

  const signature = (value) => JSON.stringify({ ...second, signature: value });
  const badHex = "signature is not 64 bytes of hex";
  assert.equal(reason(signature("z" + second.signature.slice(1))), badHex, "not hex");
  assert.equal(reason(signature(second.signature.slice(2))), badHex, "too short");
  assert.equal(reason(signature(second.signature + "00")), badHex, "too long");
  assert.equal(reason(signature("0x" + second.signature.slice(2))), badHex, "a 0x prefix is not what drand serves");
  assert.equal(reason(signature(12345)), badHex, "not a string");
  assert.equal(reason(JSON.stringify({ round: second.round })), badHex, "no signature");

  assert.equal(reason("not json"), "invalid json");
  assert.equal(reason("[1, 2]"), "reply is not a round record");
  assert.equal(reason("null"), "reply is not a round record");
  for (const round of ['"21056714"', "0", "-3", "1.5", "1e400", "null"]) {
    assert.equal(reason(`{"round": ${round}, "signature": "${second.signature}"}`), "reply has no valid round", round);
  }
  assert.ok(!reason(JSON.stringify({ ...second, signature: "SECRET-BODY-TEXT" })).includes("SECRET"), "a reply's text never reaches a reason");
});

test("chain info: every field of the preset is compared, and a reply's values are shown only when plain", () => {
  const check = (changes) => checkChainInfo(PRESET, JSON.stringify({ ...FIXTURE.info, ...changes }));
  assert.deepEqual(check({ groupHash: "anything", metadata: { beaconID: "other" } }), { outcome: "ok", reason: null }, "fields the preset does not hold are ignored");
  assert.equal(check({ period: 5 }).reason, "chain info differs from the drand-evmnet preset: period 5 (expected 3)");
  assert.equal(check({ genesis_time: 1727521076 }).reason, "chain info differs from the drand-evmnet preset: genesis_time 1727521076 (expected 1727521075)");
  assert.equal(check({ schemeID: "pedersen-bls-chained" }).reason, "chain info differs from the drand-evmnet preset: schemeID pedersen-bls-chained (expected bls-bn254-unchained-on-g1)");
  assert.match(check({ hash: "ff".repeat(32) }).reason, /^chain info differs from the drand-evmnet preset: hash ffffffffff\.\.\.ffff \(expected 04f1e9062b\.\.\.c8c3\)$/);
  assert.match(check({ public_key: FIXTURE.info.public_key.replace(/^07/, "08") }).reason, /public_key 08e1d1d335\.\.\.[0-9a-f]{4} \(expected 07e1d1d335\.\.\./);
  const many = check({ period: 5, hash: "00".repeat(32) });
  assert.equal(many.outcome, "drift");
  assert.match(many.reason, /hash 0000000000\.\.\.0000 \(expected .*\); period 5 \(expected 3\)$/);
  assert.match(check({ period: "<script>alert(1)</script>" }).reason, /period invalid \(expected 3\)/, "an odd value is not repeated");
  assert.match(check({ schemeID: "<b>x</b>" }).reason, /schemeID invalid/);
  assert.equal(check({ hash: 12 }).outcome, "drift");
  assert.equal(check({ hash: undefined }).outcome, "drift", "a missing field differs");
  assert.deepEqual(checkChainInfo(PRESET, "{}"), { outcome: "failure", reason: "reply is not a chain info" });
  assert.deepEqual(checkChainInfo(PRESET, "[]"), { outcome: "failure", reason: "reply is not a chain info" });
  assert.deepEqual(checkChainInfo(PRESET, "nope"), { outcome: "failure", reason: "invalid json" });
});

// ---------------------------------------------------------------------------------------------
// Judgments

test("freshness: a round at most 3 behind the schedule is fresh, further behind is stale, and a relay cannot be far ahead", () => {
  assert.equal(THRESHOLDS.beaconMaxLagRounds, 3);
  const judge = (round) => judgeLatest(PRESET, { ok: true, round, signature: "aa".repeat(64) }, NOW);
  const due = LAST_REAL_ROUND;
  assert.deepEqual(judge(due), { outcome: "fresh", reason: null, round: due, lagRounds: 0 });
  assert.deepEqual(judge(due - 3), { outcome: "fresh", reason: null, round: due - 3, lagRounds: 3 }, "about 10 s behind is still fresh");
  assert.deepEqual(judge(due - 4), {
    outcome: "stale",
    reason: "latest round 21056964 is 4 rounds (12s) behind the schedule",
    round: due - 4,
    lagRounds: 4,
  });
  assert.equal(judge(due - 1000).reason, "latest round 21055968 is 1000 rounds (3000s) behind the schedule");
  assert.equal(judge(due - 1000 * 1000).outcome, "stale");
  // A relay a round or two ahead is only our clock a second behind; further ahead it cannot be on this chain's schedule.
  assert.equal(judge(due + 1).outcome, "fresh");
  assert.equal(judge(due + 1).lagRounds, 0);
  assert.equal(judge(due + 2).outcome, "fresh");
  assert.deepEqual(judge(due + 3), {
    outcome: "failure",
    reason: "round 21056971 is ahead of the schedule (round 21056968 is due)",
    round: null,
    lagRounds: null,
  });
  assert.deepEqual(judgeLatest(PRESET, { ok: false, reason: "http 503" }, NOW), { outcome: "failure", reason: "http 503", round: null, lagRounds: null });
  // No reply at all is marked, since the watchdog's own network may be at fault; a monitor that failed says nothing of the relay.
  assert.deepEqual(judgeLatest(PRESET, { ok: false, reason: "timeout", transport: true }, NOW), { outcome: "failure", reason: "timeout", round: null, lagRounds: null, transport: true });
  assert.deepEqual(judgeLatest(PRESET, { ok: false, reason: "internal error", internal: true }, NOW), { outcome: "unknown", reason: "internal error", round: null, lagRounds: null });
  // The verdict follows the clock it is given: the same round is stale a minute later.
  assert.equal(judgeLatest(PRESET, { ok: true, round: due, signature: "" }, NOW + 60).outcome, "stale");
});

test("agreement: the signature most relays returned wins; a split with no majority stands for nothing", () => {
  const sig = (n) => String(n).repeat(128);
  const answers = (...pairs) => pairs.map(([id, signature]) => ({ id, signature: sig(signature) }));

  const same = judgeAgreement(answers([API, 1], [API2, 1], [API3, 1], [CLOUDFLARE, 1]), 100);
  assert.deepEqual(
    { signature: same.signature, majority: same.majority, count: same.count, differing: [...same.differing] },
    { signature: sig(1), majority: true, count: 4, differing: [] },
  );

  const odd = judgeAgreement(answers([API, 2], [API2, 1], [API3, 1], [CLOUDFLARE, 1]), 100);
  assert.equal(odd.signature, sig(1));
  assert.equal(odd.majority, true);
  assert.deepEqual([...odd.differing.keys()], [API], "the first relay is the odd one out; being first does not make it the reference");
  assert.equal(odd.differing.get(API), "round 100: signature 2222222222...2222 differs from 1111111111...1111, which 3 relays returned");

  const three = judgeAgreement(answers([API, 1], [API2, 2], [API3, 2], [CLOUDFLARE, 3]), 100);
  assert.equal(three.signature, sig(2));
  assert.deepEqual([...three.differing.keys()], [API, CLOUDFLARE]);
  assert.match(three.differing.get(CLOUDFLARE), /which 2 relays returned$/);

  const tie = judgeAgreement(answers([API, 1], [API2, 1], [API3, 2], [CLOUDFLARE, 2]), 100);
  assert.equal(tie.majority, false);
  assert.equal(tie.signature, sig(1), "ties go to the earliest relay, but nothing is verified with it");
  assert.deepEqual([...tie.differing.keys()], HOSTS, "every relay is in the split");
  assert.equal(tie.differing.get(API), "round 100: no majority, the relays returned 2 different signatures");

  const pair = judgeAgreement(answers([API, 1], [API2, 2]), 100);
  assert.equal(pair.majority, false);
  const lone = judgeAgreement(answers([API3, 7]), 100);
  assert.deepEqual({ majority: lone.majority, count: lone.count, differing: lone.differing.size }, { majority: true, count: 1, differing: 0 });

  // Every distinct signature comes with its relays, most relays first and the earliest relay first among equals: these are
  // what goes to verifyBeacon.
  assert.deepEqual(three.groups, [
    { signature: sig(2), ids: [API2, API3] },
    { signature: sig(1), ids: [API] },
    { signature: sig(3), ids: [CLOUDFLARE] },
  ]);
  assert.deepEqual(tie.groups.map((g) => g.ids), [[API, API2], [API3, CLOUDFLARE]]);
});

// ---------------------------------------------------------------------------------------------
// The registry's answers

test("the slot signer is derived from the beacon and the verifier as the registry does it", async () => {
  const beacon = registeredBeacon();
  const expected = await expectedSlotSigner(PRESET, VERIFIER);
  assert.match(expected, /^0x[0-9a-f]{40}$/);
  assert.equal(expected, slotSignerFor(beacon), "against the formula written out on its own");
  // Every input matters.
  const other = (changes) => slotSignerFor(registeredBeacon(changes));
  assert.notEqual(other({ verifier: "0x" + "cd".repeat(20) }), expected);
  assert.notEqual(other({ genesis: PRESET.genesis + 1 }), expected);
  assert.notEqual(other({ period: 4 }), expected);
  assert.notEqual(other({ chainHash: "0x" + "00".repeat(32) }), expected);
  assert.notEqual(other({ publicKey: "0x" + "00".repeat(128) }), expected);
  assert.equal(await expectedSlotSigner(PRESET, VERIFIER.toUpperCase().replace("0X", "0x")), expected, "the verifier's case does not matter");
  assert.notEqual(await expectedSlotSigner({ ...PRESET, period: 4 }, VERIFIER), expected);
});

test("beaconOf: a revert means not registered yet, a zero verifier a recipe that is no beacon; anything else unusable says nothing", () => {
  const item = (result) => ({ result });
  assert.deepEqual(readBeaconOf({ error: "rpc error 3", revert: true }), { state: "unregistered", reason: "beaconOf reverted" });
  assert.deepEqual(readBeaconOf(item(encodeBeaconOfResult(ZERO_BEACON))), { state: "notbeacon", reason: "zero verifier" });
  const registered = readBeaconOf(item(encodeBeaconOfResult(registeredBeacon())));
  assert.equal(registered.state, "registered");
  assert.deepEqual(registered.tuple, registeredBeacon());
  assert.deepEqual(readBeaconOf({ error: "rpc error -32000" }), { state: "unknown", reason: "beaconOf: rpc error -32000" });
  assert.deepEqual(readBeaconOf(item("0x")), { state: "unknown", reason: "beaconOf: decode error" });
  assert.deepEqual(readBeaconOf(item("0x1234")), { state: "unknown", reason: "beaconOf: decode error" });
  assert.deepEqual(readBeaconOf(item(null)), { state: "unknown", reason: "beaconOf: decode error" });

  // Hex as a node writes it may be upper case: it is read lowercase, so a registration is not a mismatch for its case.
  const shouting = "0x" + encodeBeaconOfResult(registeredBeacon()).slice(2).toUpperCase();
  assert.deepEqual(readBeaconOf(item(shouting)).tuple, registeredBeacon());

  assert.deepEqual(readSlotSigner({ result: "0x" + addressWord(VERIFIER) }), { state: "ok", address: VERIFIER });
  assert.deepEqual(readSlotSigner({ error: "rpc error 3", revert: true }), { state: "reverted" });
  assert.deepEqual(readSlotSigner({ error: "rpc error -32000" }), { state: "unknown" });
  assert.deepEqual(readSlotSigner({ result: "0x12" }), { state: "unknown" });
});

test("verifyBeacon: true accepts the signature, false or a revert rejects it, an endpoint's own error says nothing", () => {
  const yes = "0x" + "0".repeat(63) + "1";
  const no = "0x" + "0".repeat(64);
  assert.deepEqual(readCheck({ result: yes }), { result: "accepted", how: "returned true" });
  assert.deepEqual(readCheck({ result: no }), { result: "rejected", how: "returned false" });
  assert.deepEqual(readCheck({ error: "rpc error 3", revert: true }), { result: "rejected", how: "reverted" });
  assert.deepEqual(readCheck({ error: "rpc error -32000" }), { result: "unknown", how: "verifyBeacon: rpc error -32000" });
  assert.deepEqual(readCheck({ result: "0x02" }), { result: "unknown", how: "verifyBeacon: decode error" });
  assert.deepEqual(readCheck({ result: "0x" }), { result: "unknown", how: "verifyBeacon: decode error" });
});

test("epochForBlock and catalogAt: the epoch and the recipes of its catalog; a revert or anything unusable is no answer", () => {
  assert.deepEqual(readEpoch({ result: "0x" + word(7) }), { state: "ok", id: 7 });
  assert.deepEqual(readEpoch({ error: "rpc error 3", revert: true }), { state: "reverted" });
  assert.deepEqual(readEpoch({ error: "rpc error -32000" }), { state: "unknown" });
  assert.deepEqual(readEpoch({ result: "0x" }), { state: "unknown" });
  assert.deepEqual(readEpoch({ result: "0x" + word(1n << 70n) }), { state: "unknown" }, "not a uint64");

  const catalog = readCatalog({ result: encodeCatalogAtResult({ hash: "0x" + "ab".repeat(32), recipes: [0, 3, 11] }) });
  assert.deepEqual(catalog, { state: "ok", hash: "0x" + "ab".repeat(32), recipes: [0, 3, 11] });
  assert.deepEqual(readCatalog({ result: encodeCatalogAtResult(DRAND_ONLY_CATALOG) }).recipes, [BEACON_RECIPE]);
  assert.deepEqual(readCatalog({ error: "rpc error 3", revert: true }), { state: "reverted" });
  assert.deepEqual(readCatalog({ error: "rpc error -32005" }), { state: "unknown" });
  assert.deepEqual(readCatalog({ result: "0x1234" }), { state: "unknown" });
});

test("a registration is compared with the configured chain hash, key, genesis, period, verifier and slot signer", async () => {
  const beacon = { recipe: 11, preset: PRESET, relays: DRAND_RELAYS, verifier: null };
  const signer = { state: "ok", address: slotSignerFor(registeredBeacon()) };
  const expected = await expectedSlotSigner(PRESET, VERIFIER);
  const compare = (changes = {}, options = {}) =>
    compareRegistration(options.beacon ?? beacon, PRESET, registeredBeacon(changes), options.signer ?? signer, options.expected ?? expected);
  assert.deepEqual(compare(), []);
  assert.deepEqual(compare({ genesis: 5 }), ["genesis 5 (expected 1727521075)"]);
  assert.deepEqual(compare({ period: 30 }), ["period 30 (expected 3)"]);
  assert.deepEqual(compare({ chainHash: "0x" + "00".repeat(32) }), ["chainHash 0x00000000...0000 (expected 0x04f1e906...c8c3)"]);
  assert.deepEqual(compare({ publicKey: "0x" + "00".repeat(128) }), ["publicKey 0x00000000...0000 (expected 0x07e1d1d3...ee0b)"]);
  assert.deepEqual(compare({ genesis: 5, period: 30 }).length, 2);
  // Hex is compared without regard to case, whatever a node writes.
  const shout = (hex) => "0x" + hex.slice(2).toUpperCase();
  assert.deepEqual(compare({ chainHash: shout(`0x${PRESET.chainHash}`), publicKey: shout(`0x${PRESET.publicKey}`) }), []);
  assert.equal(matchesPreset(PRESET, registeredBeacon({ chainHash: shout(`0x${PRESET.chainHash}`) })), true);
  // The verifier is compared only when the configuration names one, and then case-insensitively.
  assert.deepEqual(compare({}, { beacon: { ...beacon, verifier: VERIFIER.toUpperCase().replace("0X", "0x") } }), []);
  assert.deepEqual(compare({}, { beacon: { ...beacon, verifier: "0x" + "cd".repeat(20) } }), [`verifier ${VERIFIER} (expected 0x${"cd".repeat(20)})`]);
  assert.deepEqual(compare({}, { signer: { state: "ok", address: "0x" + "11".repeat(20) } }), [`slotSigner 0x${"11".repeat(20)} (expected ${expected})`]);
  assert.deepEqual(compare({}, { signer: { state: "ok", address: expected.toUpperCase().replace("0X", "0x") } }), []);
  assert.deepEqual(compare({}, { signer: { state: "reverted" } }), ["slotSigner reverted"]);
  assert.deepEqual(compare({}, { signer: { state: "unknown" } }), [], "an unreadable slot signer is not a mismatch");
});

test("the recipe monitored is the configured one, or the catalog's when the configured one is not the beacon", () => {
  const beacon = { recipe: 11, preset: PRESET, relays: DRAND_RELAYS, verifier: null };
  const answers = (entries) => new Map(Object.entries(entries).map(([id, answer]) => [Number(id), answer]));
  const registered = (changes) => ({ state: "registered", tuple: registeredBeacon(changes) });
  const other = { state: "notbeacon", reason: "zero verifier" };
  assert.equal(matchesPreset(PRESET, registeredBeacon()), true);
  assert.equal(matchesPreset(PRESET, registeredBeacon({ period: 30 })), false);

  // The configured id while it is the beacon, whatever the catalog says.
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: registered(), 12: registered() }), [12]), 11);
  // Not (yet) a registration at all: the configured id stays, and the registry's answer about it is what is reported.
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: { state: "unregistered" }, 0: other }), [0, 1, 2, 3]), 11);
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: registered() }), []), 11, "nothing in force lists 12");
  // A recipe that is no beacon while the catalog in force lists the beacon under another id: that id.
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: registered() }), [12]), 12);
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: { state: "unregistered" }, 3: other, 12: registered() }), [3, 12]), 12);
  // A registration of another chain, or one that could not be read, is not the beacon.
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: registered({ period: 30 }) }), [12]), 11);
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: { state: "unknown" } }), [12]), 11);
  // The configured id wins when it matches too, and a registration mismatching the preset is the configured id's to report.
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: registered({ period: 30 }) }), [11]), 11);

  // A recipe followed before stays followed through a read that says nothing about it (a node that is behind reverts, an
  // endpoint errs) while the catalog in force lists it...
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: { state: "unregistered" } }), [12], 12), 12);
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: { state: "unknown" } }), [12], 12), 12);
  // ... but not when it turned out to be something else, is not listed any more, or is the configured one.
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: other }), [12], 12), 11);
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: registered({ period: 30 }) }), [12], 12), 11);
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: { state: "unregistered" } }), [0, 1], 12), 11);
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: { state: "unregistered" } }), [11], 11), 11);
  assert.equal(chooseRecipe(beacon, PRESET, answers({ 11: other, 12: { state: "unregistered" }, 13: registered() }), [12, 13], 12), 13, "another that is the beacon comes first");
});

test("the catalog's use of the beacon: only it, among other sources, or not at all; what cannot be told stays as it was", () => {
  const answers = (entries) => new Map(Object.entries(entries).map(([id, answer]) => [Number(id), answer]));
  const signed = { state: "notbeacon" };
  const known = answers({ 0: signed, 1: signed, 2: signed, 3: signed, 11: { state: "registered" } });
  assert.equal(catalogUse([11], 11, known), "only");
  assert.equal(catalogUse([11, 11], 11, known), "only", "one slot or two, it is the beacon alone");
  assert.equal(catalogUse([0, 1, 2, 11], 11, known), "mixed");
  assert.equal(catalogUse([0, 1, 2, 3], 11, known), "none");
  assert.equal(catalogUse([], 11, known), "none");
  // A slot nobody has asked beaconOf about, or that could not be read, might be the beacon under another id.
  assert.equal(catalogUse([12], 11, known, "none"), "none");
  assert.equal(catalogUse([12], 11, known, "only"), "only", "as it was known to be");
  assert.equal(catalogUse([12], 11, known), "none", "when it was not known");
  assert.equal(catalogUse([0, 5], 11, answers({ 0: signed, 5: { state: "unknown" } }), "mixed"), "mixed");
  // Once every listed recipe was read and none is the beacon, it is not used.
  assert.equal(catalogUse([12], 11, answers({ 12: signed }), "only"), "none");
});

test("a signature with its last byte flipped is another signature", () => {
  const real = realSignature(21056967);
  const flipped = flipLastByte(real);
  assert.equal(flipped.length, real.length);
  assert.equal(flipped.slice(0, -2), real.slice(0, -2));
  assert.notEqual(flipped.slice(-2), real.slice(-2));
  assert.equal(flipLastByte(flipped), real, "an inversion, so twice is the original");
  assert.equal(flipLastByte("00".repeat(64)), "00".repeat(63) + "ff");
  assert.equal(flipLastByte("ab".repeat(64)), "ab".repeat(63) + "54");
});

// The verdicts of settleRound: who is at fault when the relays and the registries do not agree. A signature is a repeated
// digit, so 1 and 2 are two signatures of round 100; relays answer with one each.
const sigOf = (n) => String(n).repeat(128);
const shortOf = (n) => `${String(n).repeat(10)}...${String(n).repeat(4)}`;
function sampleOf(...pairs) {
  const answers = pairs.map(([id, n]) => ({ id, signature: sigOf(n) }));
  const verdict = judgeAgreement(answers, 100);
  return { round: 100, answers, verdict, candidates: verdict.groups, majority: verdict.majority };
}
/** What registry `name` answered for each candidate, in order: "accepted", "rejected" or "unknown". */
const readOf = (name, ...results) => ({
  name,
  skip: null,
  checks: results.map((result) => ({ result, how: { accepted: "returned true", rejected: "returned false", unknown: "verifyBeacon: rpc error -32000" }[result] })),
});

test("settling a round: a signature a registry accepts is the round's, however few relays returned it", () => {
  // Three relays return one signature and the fourth another; the registry accepts the fourth's (case c).
  const sample = sampleOf([API, 1], [API2, 1], [API3, 1], [CLOUDFLARE, 2]);
  const settled = settleRound(sample, [readOf("arc-mainnet", "rejected", "accepted")]);
  assert.equal(settled.winner, 1);
  assert.deepEqual(settled.verify, { "arc-mainnet": { outcome: "ok", round: 100, reason: null } });
  const differs = `round 100: signature ${shortOf(1)} differs from ${shortOf(2)}, which 1 relay returned and the arc-mainnet registry accepts`;
  assert.deepEqual([...settled.agreements], [
    [API, { outcome: "differs", round: 100, reason: differs }],
    [API2, { outcome: "differs", round: 100, reason: differs }],
    [API3, { outcome: "differs", round: 100, reason: differs }],
    [CLOUDFLARE, { outcome: "agree", round: 100, reason: null }],
  ]);
  // The other way round, the majority's signature is accepted and the odd relay is flagged, as by a plain comparison.
  const usual = settleRound(sampleOf([API, 1], [API2, 1], [API3, 1], [CLOUDFLARE, 2]), [readOf("arc-mainnet", "accepted", "rejected")]);
  assert.equal(usual.winner, 0);
  assert.deepEqual([...usual.agreements].map(([id, a]) => [id, a.outcome]), [[API, "agree"], [API2, "agree"], [API3, "agree"], [CLOUDFLARE, "differs"]]);
  assert.match(usual.agreements.get(CLOUDFLARE).reason, /which 3 relays returned and the arc-mainnet registry accepts$/);
  // A single relay whose signature a registry accepts is right, with nothing to compare it with.
  const lone = settleRound(sampleOf([API3, 1]), [readOf("arc-mainnet", "accepted")]);
  assert.deepEqual([...lone.agreements], [[API3, { outcome: "agree", round: 100, reason: null }]]);
  assert.equal(lone.verify["arc-mainnet"].outcome, "ok");
});

test("settling a round: a registry that rejects what another accepts is at fault", () => {
  const sample = sampleOf([API, 1], [API2, 1], [API3, 1], [CLOUDFLARE, 1]);
  const settled = settleRound(sample, [readOf("arc-mainnet", "rejected"), readOf("arc-testnet", "accepted")]);
  assert.deepEqual(settled.verify, {
    "arc-mainnet": {
      outcome: "invalid",
      round: 100,
      reason: "verifyBeacon returned false for the signature 4 of 4 relays returned; the arc-testnet registry accepts it",
    },
    "arc-testnet": { outcome: "ok", round: 100, reason: null },
  });
  // Even a signature one relay alone returned counts against the registry that rejects it, when another registry accepts it.
  const one = settleRound(sampleOf([API, 1]), [readOf("arc-mainnet", "rejected"), readOf("arc-testnet", "accepted")]);
  assert.equal(one.verify["arc-mainnet"].outcome, "invalid");
  assert.equal(one.verify["arc-mainnet"].reason, "verifyBeacon returned false; the arc-testnet registry accepts it");
  // A registry that could not tell is not counted either way; one that reverted rejected the signature.
  const unsure = settleRound(sample, [readOf("arc-mainnet", "unknown"), readOf("arc-testnet", "accepted")]);
  assert.deepEqual(unsure.verify["arc-mainnet"], { outcome: "unknown", round: 100, reason: "verifyBeacon: rpc error -32000" });
});

test("settling a round: with no registry accepting, a signature at least two relays returned counts against a registry that rejects it", () => {
  const four = settleRound(sampleOf([API, 1], [API2, 1], [API3, 1], [CLOUDFLARE, 1]), [readOf("arc-mainnet", "rejected")]);
  assert.equal(four.winner, null);
  assert.deepEqual(four.verify["arc-mainnet"], { outcome: "invalid", round: 100, reason: "verifyBeacon returned false for the signature 4 of 4 relays returned" });
  assert.ok([...four.agreements.values()].every((a) => a.outcome === "agree"), "the relays agree with each other; the registry is the odd one out");
  const two = settleRound(sampleOf([API, 1], [API2, 1]), [{ ...readOf("arc-mainnet", "rejected"), checks: [{ result: "rejected", how: "reverted" }] }]);
  assert.equal(two.verify["arc-mainnet"].reason, "verifyBeacon reverted for the signature 2 of 2 relays returned");
  // With a majority that is not everyone, the others are flagged as by a plain comparison.
  const three = settleRound(sampleOf([API, 1], [API2, 2], [API3, 2], [CLOUDFLARE, 2]), [readOf("arc-mainnet", "rejected", "rejected")]);
  assert.equal(three.verify["arc-mainnet"].outcome, "invalid");
  assert.deepEqual([...three.agreements].map(([id, a]) => [id, a.outcome]), [[API, "differs"], [API2, "agree"], [API3, "agree"], [CLOUDFLARE, "agree"]]);
  assert.equal(three.agreements.get(API).reason, `round 100: signature ${shortOf(1)} differs from ${shortOf(2)}, which 3 relays returned`);
});

test("settling a round: a signature one relay alone returned is that relay's to answer for, not the registry's", () => {
  // The only answer of the round (the other relays failed, or were not fresh) and the registry rejects it (cases a and b).
  const lone = settleRound(sampleOf([CLOUDFLARE, 1]), [readOf("arc-mainnet", "rejected")]);
  assert.deepEqual(lone.verify["arc-mainnet"], { outcome: "uncorroborated", round: 100, reason: "verifyBeacon returned false for a signature only one relay returned" });
  assert.deepEqual([...lone.agreements], [
    [CLOUDFLARE, { outcome: "rejected", round: 100, reason: `round 100: signature ${shortOf(1)} is rejected by the arc-mainnet registry and no other relay returned it` }],
  ]);
  // Every registry that lists the beacon must reject it; the relay is named for all of them.
  const both = settleRound(sampleOf([CLOUDFLARE, 1]), [readOf("arc-mainnet", "rejected"), readOf("arc-testnet", "rejected")]);
  assert.match(both.agreements.get(CLOUDFLARE).reason, /is rejected by the arc-mainnet and arc-testnet registries and no other relay returned it$/);
  // A registry that could not tell leaves the relay unjudged.
  const unsure = settleRound(sampleOf([CLOUDFLARE, 1]), [readOf("arc-mainnet", "rejected"), readOf("arc-testnet", "unknown")]);
  assert.equal(unsure.agreements.size, 0);
  assert.equal(unsure.verify["arc-mainnet"].outcome, "uncorroborated");
  assert.equal(unsure.verify["arc-testnet"].outcome, "unknown");
  // No registry lists the beacon: nothing to judge it by.
  assert.equal(settleRound(sampleOf([CLOUDFLARE, 1]), []).agreements.size, 0);
});

test("settling a round: with the relays split and no registry accepting any signature nobody is blamed but the relays", () => {
  const split = sampleOf([API, 1], [API2, 1], [API3, 2], [CLOUDFLARE, 2]);
  const settled = settleRound(split, [readOf("arc-mainnet", "rejected", "rejected")]);
  assert.equal(settled.winner, null);
  assert.deepEqual(settled.verify["arc-mainnet"], {
    outcome: "uncorroborated",
    round: 100,
    reason: "verifyBeacon rejected every signature, and the relays split with no majority",
  });
  assert.ok([...settled.agreements.values()].every((a) => a.outcome === "differs" && a.reason === "round 100: no majority, the relays returned 2 different signatures"));
  assert.equal(settled.agreements.size, 4);
  assert.equal(settleRound(split, [readOf("arc-mainnet", "rejected", "unknown")]).verify["arc-mainnet"].outcome, "unknown");
  // A registry that does accept one of them settles it.
  const arbitrated = settleRound(split, [readOf("arc-mainnet", "rejected", "accepted")]);
  assert.equal(arbitrated.winner, 1);
  assert.deepEqual([...arbitrated.agreements].map(([id, a]) => [id, a.outcome]), [[API, "differs"], [API2, "differs"], [API3, "agree"], [CLOUDFLARE, "agree"]]);
  assert.equal(arbitrated.verify["arc-mainnet"].outcome, "ok");
  // With no registry, the relays are compared with each other as ever.
  assert.equal(settleRound(split, []).agreements.get(API).reason, "round 100: no majority, the relays returned 2 different signatures");
});

test("settling a round: the reasons name the registries that accept, one or several", () => {
  const sample = sampleOf([API, 1], [API2, 1], [CLOUDFLARE, 2]);
  const one = settleRound(sample, [readOf("arc-mainnet", "rejected", "accepted")]);
  assert.match(one.agreements.get(API).reason, /which 1 relay returned and the arc-mainnet registry accepts$/);
  const two = settleRound(sample, [readOf("arc-mainnet", "rejected", "accepted"), readOf("arc-testnet", "rejected", "accepted")]);
  assert.match(two.agreements.get(API).reason, /which 1 relay returned and the arc-mainnet and arc-testnet registries accept$/);
  const third = settleRound(sampleOf([API, 1], [API2, 1]), [readOf("a", "rejected"), readOf("b", "accepted"), readOf("c", "accepted")]);
  assert.equal(third.verify.a.reason, "verifyBeacon returned false for the signature 2 of 2 relays returned; the b and c registries accept it");
});

test("settling a round: registries that asked nothing are skipped with their reason; the one accepted by more registries wins", () => {
  const sample = sampleOf([API, 1], [API2, 1], [API3, 2]);
  const idle = { name: "arc-testnet", checks: null, skip: "the monitored recipe changed" };
  const settled = settleRound(sample, [readOf("arc-mainnet", "accepted", "rejected"), idle]);
  assert.deepEqual(settled.verify["arc-testnet"], { outcome: "skipped", round: null, reason: "the monitored recipe changed" });
  assert.equal(settled.verify["arc-mainnet"].outcome, "ok");
  // Each of two registries accepts a different signature (one of them accepts an invalid one): the more registries agree, the
  // more relays returned it, the earlier it is.
  const clash = settleRound(sample, [readOf("a", "accepted", "rejected"), readOf("b", "rejected", "accepted")]);
  assert.equal(clash.winner, 0, "two relays against one");
  const three = settleRound(sample, [readOf("a", "rejected", "accepted"), readOf("b", "rejected", "accepted"), readOf("c", "accepted", "rejected")]);
  assert.equal(three.winner, 1, "two registries against one");
});

// ---------------------------------------------------------------------------------------------
// Groups and the schedule

test("relays are shared: one group per beacon, each relay once however many networks list it", () => {
  const groups = beaconGroups(NETWORKS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].preset, PRESET);
  assert.deepEqual(groups[0].relays.map((r) => r.id), HOSTS);
  assert.deepEqual(groups[0].relays.map((r) => r.url), DRAND_RELAYS);
  assert.deepEqual(groups[0].networks.map((n) => n.name), ["arc-mainnet", "arc-testnet"]);

  // Relays listed by one network only join the group; a trailing slash and the case of the host do not make a new relay.
  const extra = { ...TESTNET, beacon: { ...TESTNET.beacon, relays: [...DRAND_RELAYS, "https://Relay.Example/", "https://api.drand.sh/"] } };
  const merged = beaconGroups({ "arc-mainnet": MAINNET, "arc-testnet": extra })[0];
  assert.deepEqual(merged.relays.map((r) => r.id), [...HOSTS, "relay.example"]);
  assert.equal(merged.relays.at(-1).url, "https://Relay.Example");

  // A network without a beacon is not watched; two beacons make two groups.
  const { beacon, ...bare } = MAINNET;
  assert.deepEqual(beaconGroups({ "arc-mainnet": bare }), []);
  const other = { ...PRESET, id: "other-chain", chainHash: "ab".repeat(32) };
  assert.equal(beaconGroups({ "arc-mainnet": MAINNET, "arc-testnet": { ...TESTNET, beacon: { ...TESTNET.beacon, preset: other } } }).length, 2);
  assert.equal(relayId("not a url"), "not a url", "an unusable address is its own id: it fails visibly instead of stopping the run");
});

test("chain info is due for one relay per run, each at its own hour of the day", () => {
  assert.equal(LIMITS.beaconInfoMaxPerRun, 1);
  const plan = (states) => planBeacon(NETWORKS, states, NOW).groups[0].info.map((entry) => entry.id);
  // Never read: all four are due, the first goes first.
  assert.deepEqual(plan(new Map()), [API]);
  const state = (nextCheckAt) => ({ relays: Object.fromEntries(HOSTS.map((host, i) => [host, { info: { nextCheckAt: nextCheckAt[i] } }])) });
  const stored = (nextCheckAt) => new Map([["group:drand-evmnet", state(nextCheckAt)]]);
  assert.deepEqual(plan(stored([NOW + 60, NOW - 30, NOW - 90, NOW + 5])), [API3], "the most overdue relay");
  assert.deepEqual(plan(stored([NOW + 60, NOW + 60, NOW + 60, NOW + 60])), [], "none due");
  assert.deepEqual(plan(stored([NOW, NOW + 1, NOW + 1, NOW + 1])), [API], "due at the second it is set for");
});

test("each network of the plan carries the state it was left in: what the next registry batch asks about depends on it", () => {
  const stored = { recipe: 12, epoch: { id: 5, block: 1000 }, catalog: { epochId: 5, recipes: [12], use: "only" } };
  const [group] = planBeacon(NETWORKS, new Map([["network:arc-mainnet", stored]]), NOW).groups;
  assert.deepEqual(group.networks.map((n) => [n.name, n.previous]), [["arc-mainnet", stored], ["arc-testnet", null]]);
  assert.equal(group.networks[0].beacon, NETWORKS["arc-mainnet"].beacon);
  assert.equal(group.networks[0].net, NETWORKS["arc-mainnet"]);
});

// ---------------------------------------------------------------------------------------------
// A run against a fake drand network and fake registries

const LATEST = LAST_REAL_ROUND;
const COMMON = LAST_REAL_ROUND - 1; // the round before the lowest latest round: what the relays are compared at

/**
 * The world, one registry per network, and a run of the plan for `nets` at the world's clock. `head` is every network's head
 * block, as this run's chain read gives it (none by default); `options.states` are the stored states the plan is made from.
 * `nets` are UNPINNED by default: the fake registries report a made-up verifier, whatever the configuration pins.
 */
function setup({ nets = UNPINNED, head = null } = {}) {
  const world = drandWorld();
  const registries = Object.fromEntries(Object.values(nets).map((net) => [net.name, registryOf(net)]));
  const { fetch, rpcCalls } = beaconFetch(world, registries);
  const headOf = head === null ? undefined : async () => head;
  const run = (options = {}) => runBeacon(planBeacon(nets, options.states ?? new Map(), world.now), { fetch, clock: () => world.now * 1000, headOf, ...options });
  return { world, registries, rpcCalls, run, fetch };
}

const outcomes = (group) => group.relays.map((r) => [r.id, r.outcome]);
const agreements = (group) => group.relays.map((r) => r.agreement?.outcome ?? null);
/** The state a network was left in by an earlier run: the recipe monitored, the epoch and the catalog it read. */
const left = (name, state) => new Map([[`network:${name}`, state]]);

test("a healthy run before the registry lists a beacon: relays fresh and agreeing, registries 'not registered', nothing to verify", async () => {
  const { world, rpcCalls, run } = setup();
  const result = await run();
  const [group] = result.groups;
  assert.deepEqual(group.relays.map((r) => [r.id, r.outcome, r.round, r.lagRounds]), HOSTS.map((id) => [id, "fresh", LATEST, 0]));
  assert.equal(group.commonRound, COMMON);
  assert.deepEqual(group.relays.map((r) => r.agreement), HOSTS.map(() => ({ outcome: "agree", round: COMMON, reason: null })));
  assert.deepEqual(group.relays.map((r) => r.info?.outcome ?? null), ["ok", null, null, null], "one relay's chain info per run");
  assert.deepEqual(world.calls.filter((c) => c.kind === "latest").map((c) => c.host), HOSTS);
  assert.deepEqual(world.calls.filter((c) => c.kind === "round").map((c) => [c.host, c.round]), HOSTS.map((host) => [host, COMMON]));
  assert.deepEqual(world.calls.filter((c) => c.kind === "info").map((c) => c.host), [API]);
  for (const network of group.networks) {
    assert.deepEqual(
      { ok: network.ok, registration: network.registration, why: network.registrationReason, verdict: network.verdict, verify: network.verify },
      { ok: true, registration: "unregistered", why: "beaconOf reverted", verdict: null, verify: { outcome: "skipped", round: null, reason: "beacon not registered" } },
    );
  }
  assert.deepEqual(rpcCalls.map((c) => [new URL(c.url).host, c.count]), [
    ["rpc.blockdaemon.mainnet.arc.io", 5],
    ["rpc.blockdaemon.testnet.arc.io", 5],
  ], "one batch per network: chain id, beaconOf, slotSigner, verifyBeacon and verifyBeacon with the signature's last byte flipped");
  assert.equal(result.subrequests, 4 + 4 + 1 + 2, "four latest rounds, four earlier ones, one chain info and two registries");
});

test("every request is a bounded GET of the relay's own path, and the RPC client makes the registry calls", async () => {
  const { world, fetch } = setup();
  const seen = [];
  const spy = async (url, init) => {
    seen.push({ url, init });
    return fetch(url, init);
  };
  await runBeacon(planBeacon(UNPINNED, new Map(), NOW), { fetch: spy, clock: () => NOW * 1000 });
  const relays = seen.filter((r) => !r.init.body);
  assert.equal(relays.length, 9);
  for (const { init } of relays) {
    assert.equal(init.method, "GET");
    assert.equal(init.headers.accept, "application/json");
    assert.match(init.headers["user-agent"], /^d20dao-watchdog /);
    assert.ok(init.signal instanceof AbortSignal, "every fetch has a timeout");
  }
  const chain = PRESET.chainHash;
  assert.deepEqual(relays.map((r) => r.url), [
    ...DRAND_RELAYS.map((url) => `${url}/${chain}/public/latest`),
    `${DRAND_RELAYS[0]}/${chain}/info`,
    ...DRAND_RELAYS.map((url) => `${url}/${chain}/public/${COMMON}`),
  ]);
  assert.equal(world.calls.length, 9);
  const rpc = seen.filter((r) => r.init.body);
  assert.deepEqual(rpc.map((r) => JSON.parse(r.init.body).map((call) => call.method)), [
    ["eth_chainId", "eth_call", "eth_call", "eth_call", "eth_call"],
    ["eth_chainId", "eth_call", "eth_call", "eth_call", "eth_call"],
  ]);
});

test("a registry that lists the beacon as configured: registered, the slot signer matches, the round verifies", async () => {
  const { registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  const result = await run();
  const [mainnet, testnet] = result.groups[0].networks;
  assert.deepEqual(mainnet, {
    name: "arc-mainnet",
    ok: true,
    reason: null,
    recipe: 11,
    registration: "registered",
    registrationReason: null,
    epoch: null,
    notBeacons: [],
    catalog: null,
    verifier: VERIFIER,
    slotSigner: slotSignerFor(registeredBeacon()),
    verdict: "ok",
    verdictReason: null,
    verify: { outcome: "ok", round: COMMON, reason: null },
    negative: { outcome: "rejected", round: COMMON, reason: null },
  });
  // The other network's registry is asked separately and does not list it yet.
  assert.equal(testnet.registration, "unregistered");
  // The calls: the recipe, then the round the four relays agree on with the signature they returned, then the same round
  // with the last byte of that signature flipped, which no verifier may accept.
  const real = roundRecord(COMMON).signature;
  assert.deepEqual(registries["arc-mainnet"].calls, [
    { method: "beaconOf", recipe: 11 },
    { method: "slotSigner", recipe: 11 },
    { method: "verifyBeacon", recipe: 11, round: COMMON, offset: 96, signature: real },
    { method: "verifyBeacon", recipe: 11, round: COMMON, offset: 96, signature: flipLastByte(real) },
  ]);
});

test("the registry batch also reads the epoch and the catalog in force, in the same one fetch: no call waits for another's answer", async () => {
  const { registries, rpcCalls, run } = setup({ head: 1234 });
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  registries["arc-mainnet"].catalog = DRAND_ONLY_CATALOG;
  registries["arc-mainnet"].epoch = (block) => Math.floor(block / 200) + 100;
  // The first run has no epoch from an earlier one: it reads epochForBlock, and catalogAt has nothing to ask about yet.
  let result = await run();
  let [mainnet] = result.groups[0].networks;
  assert.deepEqual([mainnet.epoch, mainnet.catalog], [{ id: 106, block: 1234 }, null]);
  assert.deepEqual(registries["arc-mainnet"].calls.map((c) => c.method), ["beaconOf", "slotSigner", "verifyBeacon", "verifyBeacon", "epochForBlock"]);
  assert.deepEqual(registries["arc-mainnet"].calls.at(-1), { method: "epochForBlock", block: 1234 });

  // The next asks catalogAt about that epoch and the one after it, not knowing which the head will turn out to be in.
  registries["arc-mainnet"].calls.length = 0;
  rpcCalls.length = 0;
  result = await run({ states: left("arc-mainnet", { recipe: 11, epoch: { id: 106, block: 1234 } }) });
  [mainnet] = result.groups[0].networks;
  assert.deepEqual(registries["arc-mainnet"].calls.map((c) => c.method), ["beaconOf", "slotSigner", "verifyBeacon", "verifyBeacon", "epochForBlock", "catalogAt", "catalogAt"]);
  assert.deepEqual(registries["arc-mainnet"].calls.slice(-2), [{ method: "catalogAt", epoch: 106 }, { method: "catalogAt", epoch: 107 }]);
  assert.deepEqual(mainnet.catalog, { epochId: 106, hash: "0x" + "c1".repeat(32), recipes: [11], use: "only" });
  assert.deepEqual(mainnet.epoch, { id: 106, block: 1234 });
  // One fetch per network, whatever the batch holds: the fetch count is what the free plan limits.
  assert.deepEqual(rpcCalls.map((c) => [new URL(c.url).host, c.count]), [["rpc.blockdaemon.mainnet.arc.io", 8], ["rpc.blockdaemon.testnet.arc.io", 6]]);
  assert.equal(result.subrequests, 4 + 4 + 1 + 2);
});

test("the catalog in force is that of the epoch the head is in: the previous run's, or the next one from the run in which it starts", async () => {
  const { registries, run } = setup({ head: 1234 });
  const mainnet = registries["arc-mainnet"];
  mainnet.beaconOf = registeredBeacon();
  mainnet.catalog = (epoch) => (epoch >= 107 ? DRAND_ONLY_CATALOG : PRE_SWITCH_CATALOG); // the switch is at epoch 107
  const states = () => left("arc-mainnet", { recipe: 11, epoch: { id: 106, block: 1200 } });
  const read = async (epoch) => {
    mainnet.epoch = epoch;
    const [network] = (await run({ states: states() })).groups[0].networks;
    return [network.epoch?.id ?? null, network.catalog.epochId, network.catalog.recipes, network.catalog.use];
  };
  // The head is still in epoch 106: its catalog, and the switch of epoch 107 is not in force yet.
  assert.deepEqual(await read(() => 106), [106, 106, [0, 1, 2, 3], "none"]);
  // The head is in epoch 107, which the run before did not know of: the switch is in force in this very run.
  assert.deepEqual(await read(() => 107), [107, 107, [11], "only"]);
  // Runs were missed and the head is further on: the nearest epoch asked about is the best there is.
  assert.deepEqual(await read(() => 110), [110, 107, [11], "only"]);
  // Without an answer about the head's epoch, the earlier one.
  assert.deepEqual(await read("revert"), [null, 106, [0, 1, 2, 3], "none"]);
  assert.deepEqual(await read(() => 2 ** 70), [null, 106, [0, 1, 2, 3], "none"]);
});

test("a registry that cannot answer epochForBlock or catalogAt leaves what was known of them; nothing else is disturbed", async () => {
  const { registries, run } = setup({ head: 1234 });
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  registries["arc-mainnet"].epoch = "revert";
  registries["arc-mainnet"].catalog = "revert";
  const states = left("arc-mainnet", { recipe: 11, epoch: { id: 6, block: 1200 }, catalog: { epochId: 6, recipes: [11], use: "only" } });
  const [mainnet] = (await run({ states })).groups[0].networks;
  assert.deepEqual([mainnet.epoch, mainnet.catalog], [null, null], "nothing new: the state keeps what it had");
  assert.deepEqual([mainnet.registration, mainnet.verify.outcome], ["registered", "ok"]);
  // A registry that answers them with nonsense is no different.
  registries["arc-mainnet"].epoch = () => 2 ** 70;
  registries["arc-mainnet"].catalog = () => ({ recipes: Array.from({ length: 65 }, () => 3) });
  const [nonsense] = (await run({ states })).groups[0].networks;
  assert.deepEqual([nonsense.epoch, nonsense.catalog, nonsense.registration], [null, null, "registered"]);
});

test("without a head block there is no epoch to read; the catalog is still asked about the epoch of the run before", async () => {
  const { registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  const states = left("arc-mainnet", { recipe: 11, epoch: { id: 6, block: 1200 } });
  const [mainnet] = (await run({ states })).groups[0].networks;
  assert.deepEqual(registries["arc-mainnet"].calls.map((c) => c.method), ["beaconOf", "slotSigner", "verifyBeacon", "verifyBeacon", "catalogAt", "catalogAt"]);
  assert.equal(mainnet.epoch, null);
  assert.deepEqual(mainnet.catalog.recipes, [0, 1, 2, 3]);
  // A head that is no block number is no head.
  const bad = await run({ states, headOf: async () => "1234" });
  assert.equal(bad.groups[0].networks[0].epoch, null);
  const throwing = await run({ states, headOf: async () => { throw new Error("boom"); } });
  assert.equal(throwing.groups[0].networks[0].epoch, null);
  assert.equal(throwing.groups[0].networks[0].ok, true, "the head is not needed for the rest");
});

test("a recipe the catalog lists that is a signed recipe is asked about once: it stays one", async () => {
  const { registries, run } = setup({ head: 1234 });
  const mainnet = registries["arc-mainnet"];
  mainnet.beaconOf = registeredBeacon();
  const beaconOfCalls = () => mainnet.calls.filter((c) => c.method === "beaconOf").map((c) => c.recipe);
  // The catalog lists recipes 0 to 3, which the last run has not asked about: they are asked about now, and seen to be signed.
  let states = left("arc-mainnet", { recipe: 11, epoch: { id: 6, block: 1200 }, catalog: { epochId: 6, recipes: [0, 1, 2, 3], use: "none" } });
  let full = await run({ states });
  assert.deepEqual(beaconOfCalls(), [11, 0, 1, 2, 3]);
  let [network] = full.groups[0].networks;
  assert.deepEqual(network.notBeacons, [0, 1, 2, 3]);
  assert.equal(network.catalog.use, "none");
  states = advance(states, full);
  assert.deepEqual(states.get("network:arc-mainnet").notBeacons, [0, 1, 2, 3]);
  // From then on only the recipe monitored is asked about, and the catalog is read as before.
  mainnet.calls.length = 0;
  full = await run({ states });
  assert.deepEqual(beaconOfCalls(), [11]);
  [network] = full.groups[0].networks;
  assert.deepEqual([network.catalog.recipes, network.catalog.use, network.notBeacons], [[0, 1, 2, 3], "none", [0, 1, 2, 3]]);
  // A catalog that lists them again, in another order or among others, is known at once; only a recipe not seen before is asked about.
  mainnet.catalog = { recipes: [3, 0, 5] };
  full = await run({ states });
  states = advance(states, full);
  mainnet.calls.length = 0;
  full = await run({ states });
  assert.deepEqual(beaconOfCalls(), [11, 5], "recipe 5 is new");
  assert.equal(full.groups[0].networks[0].catalog.use, "none");
  states = advance(states, full);
  // The monitored recipe is asked about every run, whatever it was: a mistaken configuration is not made permanent.
  mainnet.beaconOf = ZERO_BEACON;
  mainnet.calls.length = 0;
  full = await run({ states });
  assert.deepEqual(beaconOfCalls(), [11]);
  assert.deepEqual(full.groups[0].networks[0].notBeacons, [0, 1, 2, 3, 5], "recipe 11 is not among them");
});

test("a stored state that is not what the monitor wrote is ignored, not tripped over", async () => {
  const { registries, run } = setup({ head: 1234 });
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  const odd = [
    { recipe: "x", epoch: { id: "abc" }, catalog: { recipes: "0,1" } },
    { recipe: 999, epoch: { id: -1 }, catalog: { recipes: [1, 300, "z", null, 1.5] } },
    { epoch: 5 },
    { catalog: 5 },
    { recipe: null, epoch: null, catalog: null },
    { notBeacons: "0,1,2", catalog: { recipes: [0, 1] } },
    { notBeacons: [1, 300, "z", null, 0.5], catalog: { recipes: [1, 300] } },
    { notBeacons: 7 },
  ];
  for (const stored of odd) {
    const [mainnet] = (await run({ states: left("arc-mainnet", stored) })).groups[0].networks;
    assert.deepEqual([mainnet.ok, mainnet.registration, mainnet.recipe], [true, "registered", 11], JSON.stringify(stored));
  }
});

test("a registration that differs from the configuration is a mismatch, with the differences named", async () => {
  const { registries, run } = setup();
  const expected = slotSignerFor(registeredBeacon());
  registries["arc-mainnet"].beaconOf = registeredBeacon({ period: 5, chainHash: "0x" + "00".repeat(32) });
  registries["arc-mainnet"].slotSigner = "0x" + "11".repeat(20);
  const [mainnet] = (await run()).groups[0].networks;
  assert.equal(mainnet.registration, "registered");
  assert.equal(mainnet.verdict, "mismatch");
  assert.equal(
    mainnet.verdictReason,
    "beaconOf(11) differs from the configured drand-evmnet beacon: period 5 (expected 3); chainHash 0x00000000...0000 (expected 0x04f1e906...c8c3); " +
      `slotSigner 0x${"11".repeat(20)} (expected ${await expectedSlotSigner(PRESET, VERIFIER)})`,
  );
  assert.notEqual(expected, "0x" + "11".repeat(20));
  assert.equal(mainnet.verify.outcome, "ok", "the round still verifies: a mismatch is a finding of its own");

  // A slot signer that cannot be read is no finding; one that reverts is.
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  registries["arc-mainnet"].slotSigner = "revert";
  assert.equal((await run()).groups[0].networks[0].verdictReason, "beaconOf(11) differs from the configured drand-evmnet beacon: slotSigner reverted");
});

test("a configured verifier is pinned: the registry's must equal it, and the slot signer is derived from the configured one", async () => {
  const pinned = "0x" + "12".repeat(20);
  const nets = { "arc-mainnet": withVerifier(MAINNET, pinned) };
  const { registries, run } = setup({ nets });
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  const [mainnet] = (await run()).groups[0].networks;
  assert.equal(mainnet.verdict, "mismatch");
  assert.equal(
    mainnet.verdictReason,
    `beaconOf(11) differs from the configured drand-evmnet beacon: verifier ${VERIFIER} (expected ${pinned}); ` +
      `slotSigner ${slotSignerFor(registeredBeacon())} (expected ${await expectedSlotSigner(PRESET, pinned)})`,
  );
  registries["arc-mainnet"].beaconOf = registeredBeacon({ verifier: pinned.toUpperCase().replace("0X", "0x") });
  assert.equal((await run()).groups[0].networks[0].verdict, "ok", "the same verifier in another case");
});

test("verifyBeacon rejecting the round, by false or by a revert, is invalid; an endpoint error is unknown", async () => {
  const { registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  const verify = async () => (await run()).groups[0].networks[0].verify;
  registries["arc-mainnet"].verify = false;
  assert.deepEqual(await verify(), { outcome: "invalid", round: COMMON, reason: "verifyBeacon returned false for the signature 4 of 4 relays returned" });
  registries["arc-mainnet"].verify = "revert";
  assert.deepEqual(await verify(), { outcome: "invalid", round: COMMON, reason: "verifyBeacon reverted for the signature 4 of 4 relays returned" });
});

test("a registry that answers with errors says nothing; one that is unreachable or on another chain is not read", async () => {
  const { registries, run, world } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  registries["arc-mainnet"].error = { code: -32005, message: "rate limit reached" };
  let [mainnet] = (await run()).groups[0].networks;
  assert.deepEqual(
    { ok: mainnet.ok, registration: mainnet.registration, why: mainnet.registrationReason, verify: mainnet.verify },
    { ok: true, registration: "unknown", why: "beaconOf: rpc error -32005", verify: { outcome: "skipped", round: null, reason: "registration unknown" } },
  );
  delete registries["arc-mainnet"].error;

  registries["arc-mainnet"].beaconOf = "0x";
  mainnet = (await run()).groups[0].networks[0];
  assert.deepEqual([mainnet.registration, mainnet.registrationReason], ["unknown", "beaconOf: decode error"], "empty return data is no answer");

  registries["arc-mainnet"].down = 503;
  const down = await run();
  assert.deepEqual(down.groups[0].networks[0], { name: "arc-mainnet", ok: false, reason: "http 503" });
  assert.equal(down.groups[0].networks[1].ok, true, "the other network is read on its own");
  assert.equal(down.subrequests, 4 + 4 + 1 + 2 + 1, "both endpoints of the unreachable network were tried");
  delete registries["arc-mainnet"].down;

  registries["arc-mainnet"].chainId = 1;
  assert.deepEqual((await run()).groups[0].networks[0], { name: "arc-mainnet", ok: false, reason: "wrong chain id" });
  assert.ok(world.calls.length > 0);
});

test("one relay failing does not disturb the others; the common round is the lowest fresh round less one", async () => {
  const { world, run } = setup();
  world.relays[API2].status = 503;
  const [group] = (await run()).groups;
  assert.deepEqual(outcomes(group), [[API, "fresh"], [API2, "failure"], [API3, "fresh"], [CLOUDFLARE, "fresh"]]);
  assert.equal(group.relays[1].reason, "http 503");
  assert.deepEqual(agreements(group), ["agree", null, "agree", "agree"]);
  assert.equal(world.calls.filter((c) => c.kind === "round").length, 3, "only fresh relays are asked for the earlier round");

  // A relay a round behind lowers the common round; one within the limit stays in the comparison.
  world.relays[API2].status = undefined;
  world.relays[API3].lag = 3;
  const lagging = (await run()).groups[0];
  assert.equal(lagging.commonRound, LATEST - 3 - 1);
  assert.deepEqual(lagging.relays.map((r) => r.lagRounds), [0, 0, 3, 0]);
  assert.deepEqual(agreements(lagging), ["agree", "agree", "agree", "agree"]);
});

test("a relay more than 3 rounds behind is stale, and is left out of the comparison", async () => {
  const { world, run } = setup();
  world.relays[CLOUDFLARE].lag = 4;
  const [group] = (await run()).groups;
  assert.deepEqual(outcomes(group), [[API, "fresh"], [API2, "fresh"], [API3, "fresh"], [CLOUDFLARE, "stale"]]);
  assert.equal(group.relays[3].reason, `latest round ${LATEST - 4} is 4 rounds (12s) behind the schedule`);
  assert.equal(group.relays[3].round, LATEST - 4);
  assert.equal(group.commonRound, COMMON, "the stale relay does not lower it");
  assert.deepEqual(agreements(group), ["agree", "agree", "agree", null]);
});

test("a relay's unusable answers: bad hex, a wrong round, an oversize reply, invalid json and a 425 are failures with a reason", async () => {
  const { world, run } = setup();
  const failure = async (relay, edit) => {
    Object.assign(world.relays[relay], edit);
    const [group] = (await run()).groups;
    world.relays[relay] = {};
    return group.relays.find((r) => r.id === relay);
  };
  // Answers to /public/latest.
  const badHex = await failure(API, { body: (kind, record) => JSON.stringify({ ...record, signature: "zz" + record.signature.slice(2) }) });
  assert.deepEqual([badHex.outcome, badHex.reason, badHex.round], ["failure", "signature is not 64 bytes of hex", null]);
  const invalid = await failure(API, { body: () => "<html>502 Bad Gateway</html>" });
  assert.equal(invalid.reason, "invalid json");
  const wrong = await failure(API, { body: (kind, record) => (kind === "latest" ? JSON.stringify({ ...record, round: "x" }) : JSON.stringify(record)) });
  assert.equal(wrong.reason, "reply has no valid round");
  const oversize = await failure(API, { body: () => JSON.stringify({ padding: "x".repeat(LIMITS.beaconMaxResponseBytes) }) });
  assert.equal(oversize.reason, "reply too large");
  const status425 = await failure(API, { status: 425 });
  assert.equal(status425.reason, "http 425");
  const status = await failure(API, { status: 500 });
  assert.equal(status.reason, "http 500");

  // Answers to the earlier round: the relay is fresh, but its comparison fails.
  const asked = await failure(API2, { body: (kind, record) => (kind === "round" ? JSON.stringify({ ...record, round: record.round + 1 }) : JSON.stringify(record)) });
  assert.deepEqual([asked.outcome, asked.agreement], ["fresh", { outcome: "failure", round: COMMON, reason: `asked for round ${COMMON}, got round ${LATEST}` }]);
  const early = await failure(API2, { roundStatus: 425 });
  assert.deepEqual([early.outcome, early.agreement], ["fresh", { outcome: "failure", round: COMMON, reason: "http 425" }]);
  const big = await failure(API2, { body: (kind, record) => (kind === "round" ? "x".repeat(LIMITS.beaconMaxResponseBytes + 1) : JSON.stringify(record)) });
  assert.equal(big.agreement.reason, "reply too large");
  const info = await failure(API, { infoStatus: 404 });
  assert.deepEqual(info.info, { outcome: "failure", reason: "http 404", latencyMs: 0 });
  const bigInfo = await failure(API, { body: (kind, record) => (kind === "info" ? "x".repeat(LIMITS.beaconMaxResponseBytes + 1) : JSON.stringify(record)) });
  assert.equal(bigInfo.info.reason, "reply too large");
  // Nothing an unusable answer says is repeated.
  const secret = await failure(API, { body: () => JSON.stringify({ round: LATEST, signature: "SECRET-IN-THE-BODY" }) });
  assert.ok(!JSON.stringify(secret).includes("SECRET"));
});

test("a relay that never answers times out, and the run does not wait for it", async () => {
  const { world, run } = setup();
  world.relays[API3].hang = true;
  const started = Date.now();
  const result = await run({ timeoutMs: 30 });
  assert.ok(Date.now() - started < 1000);
  const [group] = result.groups;
  assert.deepEqual([group.relays[2].outcome, group.relays[2].reason], ["failure", "timeout"]);
  assert.deepEqual(outcomes(group).map(([, outcome]) => outcome), ["fresh", "fresh", "failure", "fresh"]);
  // A relay that hangs on the earlier round is a failed comparison only.
  world.relays[API3].hang = false;
  world.relays[API2].hang = true;
  const again = await run({ timeoutMs: 30 });
  assert.equal(again.groups[0].relays[1].outcome, "failure");
  // No connection at all: no relay answers and no registry does either. That may be the watchdog's own network, so the relays
  // are not counted as down (see "a run in which every relay was unreachable...").
  const noConnection = await run({ fetch: async () => { throw new TypeError("fetch failed: SECRET-HOST"); }, timeoutMs: 30 });
  assert.ok(noConnection.groups[0].relays.every((r) => r.outcome === "unknown" && r.reason === "network error, and no registry answered either"));
  assert.ok(!JSON.stringify(noConnection).includes("SECRET"));
});

test("a relay whose signature differs is flagged, the majority's signature is the one verified", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  world.relays[API].salt = "forked";
  const [group] = (await run()).groups;
  assert.deepEqual(agreements(group), ["differs", "agree", "agree", "agree"]);
  const forked = roundRecord(COMMON, "forked").signature;
  const real = roundRecord(COMMON).signature;
  assert.equal(
    group.relays[0].agreement.reason,
    `round ${COMMON}: signature ${forked.slice(0, 10)}...${forked.slice(-4)} differs from ${real.slice(0, 10)}...${real.slice(-4)}, which 3 relays returned and the arc-mainnet registry accepts`,
  );
  // Both signatures went to the registry, the majority's first, and the round's is the one it accepted.
  const asked = registries["arc-mainnet"].calls.filter((c) => c.method === "verifyBeacon").map((c) => c.signature);
  assert.deepEqual(asked, [real, forked, flipLastByte(real)]);
  assert.equal(group.networks[0].verify.outcome, "ok");
  assert.equal(group.relays[0].outcome, "fresh", "a relay that disagrees still serves fresh rounds");
});

test("relays split with no majority: the registry says which side is right, and with none to say, nobody is blamed but the relays", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  world.relays[API].salt = "x";
  world.relays[API2].salt = "x";
  // The registry accepts the signature the other two return: those two are right, and the first two are flagged.
  let [group] = (await run()).groups;
  assert.deepEqual(agreements(group), ["differs", "differs", "agree", "agree"]);
  assert.equal(group.networks[0].verify.outcome, "ok");
  assert.equal(group.sampleRound, COMMON);
  // A registry that accepts neither: every relay is flagged for the split and the registry is not blamed for it.
  registries["arc-mainnet"].verify = false;
  [group] = (await run()).groups;
  assert.deepEqual(agreements(group), ["differs", "differs", "differs", "differs"]);
  assert.equal(group.relays[0].agreement.reason, `round ${COMMON}: no majority, the relays returned 2 different signatures`);
  assert.deepEqual(group.networks[0].verify, {
    outcome: "uncorroborated",
    round: COMMON,
    reason: "verifyBeacon rejected every signature, and the relays split with no majority",
  });
  // With no registry listing the beacon there is nobody to ask: as before, the relays are compared with each other.
  registries["arc-mainnet"].beaconOf = "revert";
  [group] = (await run()).groups;
  assert.deepEqual(agreements(group), ["differs", "differs", "differs", "differs"]);
  assert.deepEqual(group.networks[0].verify, { outcome: "skipped", round: null, reason: "beacon not registered" });
});

test("with one fresh relay there is nothing to compare: its latest round is verified", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  for (const host of [API, API2, API3]) world.relays[host].status = 503;
  const result = await run();
  const [group] = result.groups;
  assert.deepEqual(outcomes(group), [[API, "failure"], [API2, "failure"], [API3, "failure"], [CLOUDFLARE, "fresh"]]);
  assert.equal(group.commonRound, null);
  assert.equal(world.calls.filter((c) => c.kind === "round").length, 0);
  assert.deepEqual(group.networks[0].verify, { outcome: "ok", round: LATEST, reason: null });
  assert.equal(registries["arc-mainnet"].calls.find((c) => c.method === "verifyBeacon").signature, roundRecord(LATEST).signature);
  assert.equal(result.subrequests, 4 + 0 + 1 + 2);
});

test("no relay serves a fresh round: nothing to verify, but the registries are still read", async () => {
  const { world, registries, rpcCalls, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  for (const host of HOSTS) world.relays[host].status = 503;
  const result = await run();
  const [group] = result.groups;
  assert.ok(group.relays.every((r) => r.outcome === "failure" && r.reason === "http 503" && r.agreement === null));
  assert.equal(group.commonRound, null);
  const [mainnet, testnet] = group.networks;
  assert.deepEqual([mainnet.registration, mainnet.verdict, mainnet.verify], ["registered", "ok", { outcome: "skipped", round: null, reason: "no fresh relay" }]);
  assert.equal(testnet.registration, "unregistered");
  assert.deepEqual(rpcCalls.map((c) => c.count), [3, 3], "no verifyBeacon call without a round");
  assert.equal(result.subrequests, 4 + 0 + 1 + 2);

  // Every relay stale is the same as every relay down.
  for (const host of HOSTS) world.relays[host] = { lag: 10 };
  assert.deepEqual((await run()).groups[0].relays.map((r) => r.outcome), ["stale", "stale", "stale", "stale"]);
});

// Who is at fault when a registry rejects what the relays serve: the four cases the review raised.
const short = (hex) => `${hex.slice(0, 10)}...${hex.slice(-4)}`;

test("three relays fail and the one fresh relay serves a wrong signature: that relay is the suspect and the registry is not blamed", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  registries["arc-testnet"].beaconOf = registeredBeacon();
  for (const host of [API, API2, API3]) world.relays[host].status = 503;
  world.relays[CLOUDFLARE].salt = "wrong";
  const [group] = (await run()).groups;
  const wrong = roundRecord(LATEST, "wrong").signature;
  // Every registry rejects it (a real verifier accepts only the real signature) and no other relay returned it.
  for (const network of group.networks) {
    assert.deepEqual(network.verify, { outcome: "uncorroborated", round: LATEST, reason: "verifyBeacon returned false for a signature only one relay returned" });
  }
  assert.deepEqual(group.relays[3].agreement, {
    outcome: "rejected",
    round: LATEST,
    reason: `round ${LATEST}: signature ${short(wrong)} is rejected by the arc-mainnet and arc-testnet registries and no other relay returned it`,
  });
  assert.equal(group.relays[3].outcome, "fresh", "it still serves fresh rounds");
  assert.deepEqual(outcomes(group).map(([, outcome]) => outcome), ["failure", "failure", "failure", "fresh"]);
});

test("two fresh relays and the honest one fails the earlier round: the other's signature is rejected, and that relay alone is at fault", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  world.relays[API2].status = 503;
  world.relays[API3].status = 503;
  world.relays[API].roundStatus = 503; // the honest relay fails the common-round fetch
  world.relays[CLOUDFLARE].salt = "wrong";
  const [group] = (await run()).groups;
  assert.deepEqual(outcomes(group), [[API, "fresh"], [API2, "failure"], [API3, "failure"], [CLOUDFLARE, "fresh"]]);
  assert.deepEqual(group.relays[0].agreement, { outcome: "failure", round: COMMON, reason: "http 503" });
  assert.deepEqual([group.relays[3].agreement.outcome, group.relays[3].agreement.round], ["rejected", COMMON]);
  assert.deepEqual(group.networks[0].verify, { outcome: "uncorroborated", round: COMMON, reason: "verifyBeacon returned false for a signature only one relay returned" });
});

test("three relays agree on a bad signature and one honest relay serves the real one: the three are flagged, the registry is not blamed", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  for (const host of [API, API2, API3]) world.relays[host].salt = "bad";
  const [group] = (await run()).groups;
  assert.deepEqual(agreements(group), ["differs", "differs", "differs", "agree"]);
  const bad = roundRecord(COMMON, "bad").signature;
  const real = realSignature(COMMON);
  for (const relay of group.relays.slice(0, 3)) {
    assert.equal(relay.agreement.reason, `round ${COMMON}: signature ${short(bad)} differs from ${short(real)}, which 1 relay returned and the arc-mainnet registry accepts`);
  }
  // The round is the one the registry accepted, so the registry rejected nothing it should have accepted.
  assert.deepEqual(group.networks[0].verify, { outcome: "ok", round: COMMON, reason: null });
  const asked = registries["arc-mainnet"].calls.filter((c) => c.method === "verifyBeacon").map((c) => c.signature);
  assert.deepEqual(asked, [bad, real, flipLastByte(bad)], "the larger group's signature first, then the other, then the one that must be rejected");
});

test("a registry is blamed when another network's registry accepts what it rejects, or at least two relays returned what it rejects", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  registries["arc-testnet"].beaconOf = registeredBeacon();
  registries["arc-mainnet"].verify = () => false; // rejects the real signature too
  // One relay alone returns the round: normally a rejection would be that relay's to answer for, but the other registry accepts it.
  for (const host of [API, API2, API3]) world.relays[host].status = 503;
  let [group] = (await run()).groups;
  assert.deepEqual(group.networks[0].verify, { outcome: "invalid", round: LATEST, reason: "verifyBeacon returned false; the arc-testnet registry accepts it" });
  assert.deepEqual(group.networks[1].verify, { outcome: "ok", round: LATEST, reason: null });
  assert.equal(group.relays[3].agreement.outcome, "agree", "a registry has verified what it serves");

  // Two relays returning it are corroboration enough, though no other registry lists the beacon.
  registries["arc-testnet"].beaconOf = "revert";
  world.relays[API].status = undefined;
  [group] = (await run()).groups;
  assert.deepEqual(group.networks[0].verify, { outcome: "invalid", round: COMMON, reason: "verifyBeacon returned false for the signature 2 of 2 relays returned" });
  assert.deepEqual(agreements(group), ["agree", null, null, "agree"], "the two relays agree with each other");
});

test("a relay's signature that a registry accepts is verified: it clears what an earlier lone answer said", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  for (const host of [API, API2, API3]) world.relays[host].status = 503;
  const [group] = (await run()).groups;
  assert.deepEqual(group.relays[3].agreement, { outcome: "agree", round: LATEST, reason: null });
  // Without a registry that lists the beacon, a lone answer has nothing to be judged by, as before.
  registries["arc-mainnet"].beaconOf = "revert";
  assert.equal((await run()).groups[0].relays[3].agreement, null);
});

test("the registered verifier must reject a signature with its last byte flipped; one that accepts it is caught", async () => {
  const { registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  const negative = async () => (await run()).groups[0].networks[0].negative;
  assert.deepEqual(await negative(), { outcome: "rejected", round: COMMON, reason: null });
  const real = realSignature(COMMON);
  assert.deepEqual(registries["arc-mainnet"].calls.filter((c) => c.method === "verifyBeacon").map((c) => c.signature), [real, flipLastByte(real)]);

  // A verifier that accepts everything accepts the flipped signature too: the round verifies, and so would any other.
  registries["arc-mainnet"].verify = true;
  assert.deepEqual(await negative(), { outcome: "accepted", round: COMMON, reason: "verifyBeacon returned true for a signature with its last byte flipped" });
  // A revert is a rejection.
  registries["arc-mainnet"].verify = "revert";
  assert.equal((await negative()).outcome, "rejected");

  // An endpoint's own error says nothing: the last call of the batch is this check.
  const world = drandWorld();
  const registry = registryOf(MAINNET);
  registry.beaconOf = registeredBeacon();
  const { fetch } = beaconFetch(world, { "arc-mainnet": registry, "arc-testnet": registryOf(TESTNET) });
  const tampered = async (url, init) => {
    const response = await fetch(url, init);
    if (!init.body) return response;
    const items = await response.json();
    const last = items.at(-1);
    delete last.result;
    last.error = { code: -32005, message: "rate limit" };
    return Response.json(items);
  };
  const unsure = await runBeacon(planBeacon(UNPINNED, new Map(), world.now), { fetch: tampered, clock: () => world.now * 1000 });
  assert.deepEqual(unsure.groups[0].networks[0].negative, { outcome: "unknown", round: COMMON, reason: "verifyBeacon: rpc error -32005" });
});

test("there is no signature to flip when no round was compared: the check is skipped with the reason", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  for (const host of HOSTS) world.relays[host].status = 503;
  const [mainnet, testnet] = (await run()).groups[0].networks;
  assert.deepEqual(mainnet.negative, { outcome: "skipped", round: null, reason: "no fresh relay" });
  assert.deepEqual(testnet.negative, { outcome: "skipped", round: null, reason: "beacon not registered" });
});

test("a recipe that exists but is no beacon is reported as such; one that reverts is not registered yet", async () => {
  const { registries, run } = setup();
  registries["arc-mainnet"].beaconOf = ZERO_BEACON; // recipe 11 exists, as a signed recipe
  const [mainnet, testnet] = (await run()).groups[0].networks;
  assert.deepEqual([mainnet.registration, mainnet.registrationReason, mainnet.recipe], ["notbeacon", "zero verifier", 11]);
  assert.deepEqual(mainnet.verify, { outcome: "skipped", round: null, reason: "recipe is not a beacon" });
  assert.deepEqual([testnet.registration, testnet.registrationReason], ["unregistered", "beaconOf reverted"]);
});

/** The states the networks are left in by `result`, as the cron stores them: the input of the next run. */
function advance(states, result, now = NOW) {
  const next = new Map(states);
  for (const network of result.groups[0].networks) next.set(`network:${network.name}`, applyNetworkRun(states.get(`network:${network.name}`) ?? null, network, now));
  return next;
}

test("the catalog in force lists the beacon under another recipe than the configured one: that one is monitored, from the run after", async () => {
  const { registries, run } = setup({ head: 1234 });
  const mainnet = registries["arc-mainnet"];
  mainnet.beaconOf = ZERO_BEACON; // the configured recipe 11 exists and is a signed recipe
  mainnet.beacons[12] = registeredBeacon(); // the beacon was registered as recipe 12
  mainnet.catalog = { recipes: [12] }; // and the catalog in force lists it
  const at = (result) => result.groups[0].networks[0];

  // Run 1 reads the epoch only. Run 2 reads the catalog, and learns it lists recipe 12, which it has not asked beaconOf about.
  let states = new Map();
  let result = await run({ states });
  assert.deepEqual([at(result).recipe, at(result).registration, at(result).epoch, at(result).catalog], [11, "notbeacon", { id: 6, block: 1234 }, null]);
  states = advance(states, result);
  result = await run({ states });
  assert.deepEqual([at(result).recipe, at(result).registration], [11, "notbeacon"]);
  assert.deepEqual(at(result).catalog, { epochId: 6, hash: "0x" + "c1".repeat(32), recipes: [12], use: "none" }, "what recipe 12 is is not known yet");
  states = advance(states, result);

  // Run 3 asks about it: it is the beacon, so it is the recipe monitored. slotSigner and verifyBeacon were asked about 11.
  result = await run({ states });
  assert.deepEqual([at(result).recipe, at(result).registration, at(result).verifier], [12, "registered", VERIFIER]);
  assert.deepEqual(at(result).verify, { outcome: "skipped", round: null, reason: "the monitored recipe changed" });
  assert.deepEqual(at(result).negative, { outcome: "skipped", round: null, reason: "the monitored recipe changed" });
  assert.equal(at(result).catalog.use, "only");
  assert.deepEqual(mainnet.calls.filter((c) => c.method === "beaconOf").slice(-2).map((c) => c.recipe), [11, 12]);
  states = advance(states, result);

  // Run 4 asks about 12 throughout.
  mainnet.calls.length = 0;
  result = await run({ states });
  assert.deepEqual(at(result).verify, { outcome: "ok", round: COMMON, reason: null });
  assert.deepEqual([...new Set(mainnet.calls.filter((c) => c.method !== "epochForBlock" && c.method !== "catalogAt").map((c) => c.recipe))].sort(), [11, 12]);
  assert.ok(mainnet.calls.filter((c) => c.method === "slotSigner" || c.method === "verifyBeacon").every((c) => c.recipe === 12));
  assert.deepEqual(at(result).slotSigner, slotSignerFor(registeredBeacon()));
  assert.equal(at(result).recipe, 12);
});

test("a recipe the catalog no longer lists is not followed: the configured one is monitored again", async () => {
  const { registries, run } = setup({ head: 1234 });
  const mainnet = registries["arc-mainnet"];
  mainnet.beaconOf = ZERO_BEACON;
  mainnet.beacons[12] = registeredBeacon();
  mainnet.catalog = { recipes: [0, 1, 2, 3] };
  let states = left("arc-mainnet", { recipe: 12, epoch: { id: 6, block: 1200 }, catalog: { epochId: 6, recipes: [12], use: "only" } });
  let full = await run({ states });
  let [result] = full.groups[0].networks;
  assert.equal(result.recipe, 11, "not the beacon and not in the catalog in force: the configured recipe, and what it turned out to be");
  assert.equal(result.registration, "notbeacon");
  assert.deepEqual(result.catalog.recipes, [0, 1, 2, 3]);
  assert.equal(result.catalog.use, "only", "the new recipes were not asked about yet: it stays as it was known to be for a run");
  states = advance(states, full);
  full = await run({ states });
  [result] = full.groups[0].networks;
  assert.equal(result.catalog.use, "none", "now every recipe listed has been asked about, and none is the beacon");
  // The catalog cannot be read this run: the recipe followed stays followed.
  mainnet.catalog = "revert";
  states = left("arc-mainnet", { recipe: 12, epoch: { id: 6, block: 1200 }, catalog: { epochId: 6, recipes: [12], use: "only" } });
  assert.equal((await run({ states })).groups[0].networks[0].recipe, 12);
});

// A run in which the relays could not be reached: the relays' fault, or the watchdog's own network?

test("a run in which every relay was unreachable is unknown unless a registry answered: that proves the watchdog's network works", async () => {
  const { world, registries, fetch, run } = setup();
  const unreachable = (except = []) => async (url, init) => {
    if (new URL(url).host in world.relays && !except.includes(new URL(url).host)) throw new TypeError("fetch failed");
    return fetch(url, init);
  };
  // The registries answer: the watchdog's network works, so the relays are down.
  let [group] = (await run({ fetch: unreachable() })).groups;
  assert.ok(group.relays.every((r) => r.outcome === "failure" && r.reason === "network error"));
  assert.equal(group.networks[0].ok, true);
  // Nothing answers, relay or registry: it may be the watchdog's own network.
  registries["arc-mainnet"].down = 503;
  registries["arc-testnet"].down = 503;
  [group] = (await run({ fetch: unreachable() })).groups;
  assert.ok(group.relays.every((r) => r.outcome === "unknown" && r.reason === "network error, and no registry answered either"));
  assert.equal(group.internal, false, "no fault of the monitor's own");
  // Timeouts are no reply either.
  world.relays[API].hang = true;
  world.relays[API2].hang = true;
  world.relays[API3].hang = true;
  world.relays[CLOUDFLARE].hang = true;
  [group] = (await run({ timeoutMs: 20 })).groups;
  assert.ok(group.relays.every((r) => r.outcome === "unknown" && r.reason === "timeout, and no registry answered either"));
  // One reply, an error status, is enough to show the network works: the relays are judged as ever.
  world.relays[CLOUDFLARE].hang = false;
  world.relays[CLOUDFLARE].status = 503;
  [group] = (await run({ timeoutMs: 20 })).groups;
  assert.deepEqual(group.relays.map((r) => [r.outcome, r.reason]), [["failure", "timeout"], ["failure", "timeout"], ["failure", "timeout"], ["failure", "http 503"]]);
  // A single registry that answers is enough.
  world.relays[CLOUDFLARE].status = undefined;
  world.relays[CLOUDFLARE].hang = true;
  delete registries["arc-testnet"].down;
  [group] = (await run({ timeoutMs: 20 })).groups;
  assert.ok(group.relays.every((r) => r.outcome === "failure" && r.reason === "timeout"));
});

test("a failure of the monitor's own on one relay's read leaves that relay unknown, not down, and marks the run", async () => {
  const { run } = setup();
  let calls = 0;
  const clock = () => {
    if (++calls === 1) throw new Error("boom: SECRET-DETAIL");
    return NOW * 1000;
  };
  const result = await run({ clock });
  const [group] = result.groups;
  assert.deepEqual(outcomes(group), [[API, "unknown"], [API2, "fresh"], [API3, "fresh"], [CLOUDFLARE, "fresh"]]);
  assert.equal(group.relays[0].reason, "internal error");
  assert.equal(group.internal, true);
  assert.ok(!JSON.stringify(result).includes("SECRET"), "an error's text goes nowhere");
  assert.equal(group.commonRound, COMMON, "the others were compared");
  assert.ok(group.networks.every((n) => n.ok === true), "the registries were read");
});

test("relay fetches are bounded: at most beaconConcurrency in flight, every reply size-limited", async () => {
  const world = drandWorld();
  const registries = { "arc-mainnet": registryOf(MAINNET), "arc-testnet": registryOf(TESTNET) };
  const { fetch } = beaconFetch(world, registries);
  let open = 0;
  let peak = 0;
  const slow = async (url, init) => {
    open++;
    peak = Math.max(peak, open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open--;
    return fetch(url, init);
  };
  await runBeacon(planBeacon(UNPINNED, new Map(), NOW), { fetch: slow, clock: () => NOW * 1000 });
  assert.equal(LIMITS.beaconConcurrency, 4);
  assert.equal(peak, 4, "four latest reads and the chain info are five tasks; the registries add two more calls after them");
  assert.equal(LIMITS.beaconMaxResponseBytes, 4096);
  assert.equal(LIMITS.beaconTimeoutMs, 5000);
});

test("an RPC session can be injected: the registry calls go through it, and its fetches are counted", async () => {
  const world = drandWorld();
  const seen = [];
  const createSession = (net) => ({
    subrequests: 2,
    lastError: null,
    async batch(calls, validate) {
      seen.push({ network: net.name, methods: calls.map(([method]) => method), data: calls.slice(1).map(([, [call]]) => call.data.slice(0, 10)) });
      const items = calls.map(([method]) => (method === "eth_chainId" ? { result: "0x" + BigInt(net.chainId).toString(16) } : { error: "rpc error 3", revert: true }));
      assert.equal(validate(items), null, "the chain id is validated");
      assert.equal(validate([{ result: "0x1" }]), "wrong chain id");
      return items;
    },
  });
  const result = await runBeacon(planBeacon(UNPINNED, new Map(), NOW), { fetch: world.answer, clock: () => NOW * 1000, createSession });
  assert.deepEqual(seen.map((s) => s.network), ["arc-mainnet", "arc-testnet"]);
  assert.deepEqual(seen[0].methods, ["eth_chainId", "eth_call", "eth_call", "eth_call", "eth_call"]);
  assert.deepEqual(seen[0].data, [SELECTORS.beaconOf, SELECTORS.slotSigner, SELECTORS.verifyBeacon, SELECTORS.verifyBeacon]);
  assert.equal(result.subrequests, 4 + 4 + 1 + 2 + 2);
  assert.ok(result.groups[0].networks.every((n) => n.registration === "unregistered"));

  // A session that cannot be made, or that throws, fails that network's read only.
  const broken = await runBeacon(planBeacon(UNPINNED, new Map(), NOW), {
    fetch: world.answer,
    clock: () => NOW * 1000,
    createSession: (net) => {
      if (net.name === "arc-mainnet") throw new Error("boom");
      return { subrequests: 0, batch: async () => { throw new Error("boom"); } };
    },
  });
  assert.deepEqual(broken.groups[0].networks, [
    { name: "arc-mainnet", ok: false, reason: "internal error", internal: true },
    { name: "arc-testnet", ok: false, reason: "internal error", internal: true },
  ]);
  assert.equal(broken.groups[0].relays[0].outcome, "fresh", "the relays are unaffected");
  assert.equal(broken.groups[0].internal, false, "the relay reads were fine: what failed is marked on the networks");
  assert.ok(broken.groups[0].networks.every((n) => n.internal === true), "unlike an unreachable registry, the monitor's own failure is marked");
});

test("the default RPC session bounds a registry's reply: a longer one fails that endpoint, and the next is tried", async () => {
  const { registries, fetch } = setup();
  assert.equal(LIMITS.beaconRpcMaxResponseBytes, 32 * 1024);
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  const oversize = () => new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "0x" + "ab".repeat(LIMITS.beaconRpcMaxResponseBytes) }]));
  const first = async (url, init) => (url === MAINNET.rpcs[0] ? oversize() : fetch(url, init));
  const result = await runBeacon(planBeacon(UNPINNED, new Map(), NOW), { fetch: first, clock: () => NOW * 1000 });
  const [mainnet] = result.groups[0].networks;
  assert.deepEqual([mainnet.ok, mainnet.registration], [true, "registered"], "the second endpoint answered");
  assert.equal(result.subrequests, 4 + 4 + 1 + 3, "the mainnet registry took its second endpoint");
  // With every endpoint answering too much the registry is not read, for that reason.
  const all = async (url, init) => (MAINNET.rpcs.includes(url) ? oversize() : fetch(url, init));
  const none = await runBeacon(planBeacon(UNPINNED, new Map(), NOW), { fetch: all, clock: () => NOW * 1000 });
  assert.deepEqual(none.groups[0].networks[0], { name: "arc-mainnet", ok: false, reason: "reply too large" });
  assert.equal(none.groups[0].networks[1].ok, true);
});

test("a plan without groups is an empty run, and a monitor that fails as a whole never throws", async () => {
  const empty = await runBeacon({ groups: [] }, { fetch: async () => assert.fail("nothing to fetch") });
  assert.deepEqual(empty, { subrequests: 0, groups: [] });
  const plan = planBeacon(UNPINNED, new Map(), NOW);
  // A clock that throws is a bug in the run itself: it says nothing about the relays, so they are unknown, not down.
  const result = await runBeacon(plan, { fetch: async () => new Response("{}"), clock: () => { throw new Error("boom"); } });
  assert.ok(result.groups[0].relays.every((r) => r.outcome === "unknown" && r.reason === "internal error"));
  assert.ok(result.groups[0].networks.every((n) => n.ok === false && n.reason === "internal error" && n.internal === true));
  assert.equal(result.groups[0].internal, true);
  assert.equal(result.subrequests, 0);
  assert.deepEqual(failedBeaconRun(plan, "internal error").groups, result.groups, "what the cron builds when the whole call throws");
});

test("the worst case of one run: two rounds per relay, one chain info and every endpoint of each registry", () => {
  assert.equal(beaconWorstSubrequests(NETWORKS), 2 * 4 + 1 + 2 * 2);
  assert.equal(beaconWorstSubrequests({}), 0);
  const { beacon, ...bare } = TESTNET;
  assert.equal(beaconWorstSubrequests({ "arc-mainnet": MAINNET, "arc-testnet": bare }), 2 * 4 + 1 + 2);
});

test("the worst case of one run does happen: relays up, chain info due and every registry endpoint failing is 13 fetches", async () => {
  const { registries, run, world } = setup();
  for (const registry of Object.values(registries)) registry.down = 503;
  const result = await run();
  assert.equal(result.subrequests, beaconWorstSubrequests(NETWORKS));
  assert.equal(result.subrequests, 13);
  assert.equal(world.calls.length, 9);
  assert.ok(result.groups[0].networks.every((n) => n.ok === false && n.reason === "http 503"));
  assert.ok(17 + result.subrequests <= 50, "on top of the chain reads, agent API polls and Telegram sends of a worst-case run");
});

// ---------------------------------------------------------------------------------------------
// State

const relayRun = (over = {}) => ({ id: API, outcome: "fresh", reason: null, round: 100, lagRounds: 0, latencyMs: 30, agreement: null, info: null, ...over });

test("relay state counts the runs it was not fresh in a row and remembers the last fresh one", () => {
  let state = applyRelayRun(null, relayRun(), 1000, 0);
  assert.deepEqual(state, { checkedAt: 1000, latencyMs: 30, outcome: "fresh", reason: null, round: 100, lagRounds: 0, badRuns: 0, lastOkAt: 1000 });
  state = applyRelayRun(state, relayRun({ outcome: "failure", reason: "timeout", round: null, lagRounds: null, latencyMs: 5000 }), 1060, 0);
  assert.deepEqual([state.badRuns, state.lastOkAt, state.round, state.reason, state.outcome], [1, 1000, null, "timeout", "failure"]);
  state = applyRelayRun(state, relayRun({ outcome: "stale", reason: "behind", round: 90, lagRounds: 10 }), 1120, 0);
  assert.deepEqual([state.badRuns, state.round, state.lagRounds, state.lastOkAt], [2, 90, 10, 1000]);
  state = applyRelayRun(state, relayRun(), 1180, 0);
  assert.deepEqual([state.badRuns, state.lastOkAt, state.reason], [0, 1180, null]);
});

test("a run that could not tell is unknown for a relay: it adds to the runs it was not fresh in a row, and to none", () => {
  const failure = relayRun({ outcome: "failure", reason: "http 503", round: null, lagRounds: null });
  const unknown = relayRun({ outcome: "unknown", reason: "internal error", round: null, lagRounds: null, latencyMs: null });
  let state = applyRelayRun(null, failure, 1000, 0);
  state = applyRelayRun(state, failure, 1060, 0);
  assert.equal(state.badRuns, 2);
  state = applyRelayRun(state, unknown, 1120, 0);
  assert.deepEqual([state.badRuns, state.outcome, state.reason, state.checkedAt, state.lastOkAt], [2, "unknown", "internal error", 1120, null]);
  state = applyRelayRun(state, failure, 1180, 0);
  assert.equal(state.badRuns, 3, "the streak went on where it was");
  // Nor does it end one: a relay that was failing does not look fine for a run.
  state = applyRelayRun(state, unknown, 1240, 0);
  assert.equal(state.badRuns, 3);
  state = applyRelayRun(state, relayRun(), 1300, 0);
  assert.deepEqual([state.badRuns, state.lastOkAt], [0, 1300]);
  // A verdict on the signatures, and the daily chain info, are not touched by it either.
  state = applyRelayRun(state, relayRun({ agreement: { outcome: "differs", round: 9, reason: "forked" } }), 1360, 0);
  state = applyRelayRun(state, unknown, 1420, 0);
  assert.deepEqual([state.agreement.verdict, state.badRuns], ["differs", 0]);
});

test("a relay's verdicts, on agreement and on chain info, are the latest conclusive result: an unusable check keeps them", () => {
  const agreement = (outcome, reason = null) => relayRun({ agreement: { outcome, round: 99, reason } });
  let state = applyRelayRun(null, agreement("differs", "round 99: forked"), 1000, 0);
  assert.deepEqual(state.agreement, { checkedAt: 1000, round: 99, outcome: "differs", reason: "round 99: forked", verdict: "differs", verdictReason: "round 99: forked" });
  state = applyRelayRun(state, agreement("failure", "http 503"), 1060, 0);
  assert.deepEqual([state.agreement.outcome, state.agreement.verdict, state.agreement.verdictReason], ["failure", "differs", "round 99: forked"]);
  state = applyRelayRun(state, relayRun(), 1120, 0);
  assert.equal(state.agreement.verdict, "differs", "a run that compared nothing leaves it as it is");
  state = applyRelayRun(state, agreement("agree"), 1180, 0);
  assert.deepEqual([state.agreement.verdict, state.agreement.verdictReason], ["ok", null]);
  // A signature every registry rejects, and no other relay returned, is a verdict of its own; it clears when one is accepted.
  state = applyRelayRun(state, agreement("rejected", "round 99: rejected by the arc-mainnet registry"), 1240, 0);
  assert.deepEqual([state.agreement.outcome, state.agreement.verdict, state.agreement.verdictReason], ["rejected", "rejected", "round 99: rejected by the arc-mainnet registry"]);
  state = applyRelayRun(state, agreement("failure", "http 503"), 1300, 0);
  assert.equal(state.agreement.verdict, "rejected");
  state = applyRelayRun(state, agreement("agree"), 1360, 0);
  assert.equal(state.agreement.verdict, "ok");

  const info = (outcome, reason = null) => relayRun({ info: { outcome, reason, latencyMs: 40 } });
  // Relay 2 of 4 (phase 43200): after a read that matched the next one is at its hour of the day; after one that failed or
  // differed, within the hour, so a stale answer does not stand for a day.
  state = applyRelayRun(state, info("drift", "period 5"), 50000, 43200);
  assert.deepEqual(state.info, { checkedAt: 50000, latencyMs: 40, outcome: "drift", reason: "period 5", verdict: "drift", verdictReason: "period 5", nextCheckAt: 50000 + LIMITS.beaconInfoRetrySeconds });
  state = applyRelayRun(state, info("drift", "period 5"), 53600, 43200);
  assert.equal(state.info.nextCheckAt, 53600 + LIMITS.beaconInfoRetrySeconds, "a difference that stays is read every hour");
  state = applyRelayRun(state, info("failure", "http 500"), 130000, 43200);
  assert.deepEqual([state.info.verdict, state.info.verdictReason, state.info.nextCheckAt], ["drift", "period 5", 130000 + LIMITS.beaconInfoRetrySeconds]);
  state = applyRelayRun(state, info("ok"), 140000, 43200);
  assert.deepEqual([state.info.verdict, state.info.nextCheckAt], ["ok", 172800 + 43200]);
  assert.equal(LIMITS.beaconInfoRetrySeconds, 3600);
});

test("group state counts the runs in a row without a fresh relay", () => {
  const relays = (...outcomes) => outcomes.map((outcome, i) => relayRun({ id: HOSTS[i], outcome, round: outcome === "fresh" ? 100 + i : null }));
  const run = (...outcomes) => ({ relays: relays(...outcomes), commonRound: 99 });
  let state = applyGroupRun(null, run("fresh", "failure", "stale", "fresh"), 1000);
  assert.deepEqual(state, { checkedAt: 1000, fresh: 2, total: 4, downRuns: 0, lastFreshAt: 1000, latestRound: 103, commonRound: 99, monitor: null });
  state = applyGroupRun(state, run("failure", "failure", "stale", "failure"), 1060);
  assert.deepEqual([state.fresh, state.downRuns, state.lastFreshAt, state.latestRound], [0, 1, 1000, null]);
  state = applyGroupRun(state, run("failure", "failure", "stale", "failure"), 1120);
  assert.equal(state.downRuns, 2);
  state = applyGroupRun(state, run("fresh", "failure", "failure", "failure"), 1180);
  assert.deepEqual([state.downRuns, state.lastFreshAt], [0, 1180]);
});

test("group state: a run that cannot tell whether any relay is fresh leaves the runs without one as they were, and marks the monitor's failure", () => {
  const relays = (...outcomes) => outcomes.map((outcome, i) => relayRun({ id: HOSTS[i], outcome, round: outcome === "fresh" ? 100 + i : null }));
  let state = applyGroupRun(null, { relays: relays("failure", "failure", "failure", "failure"), commonRound: null }, 1000);
  state = applyGroupRun(state, { relays: relays("failure", "failure", "failure", "failure"), commonRound: null }, 1060);
  assert.deepEqual([state.downRuns, state.fresh], [2, 0]);
  // Every relay unknown, or the ones that failed with one that is unknown: it might have been fresh.
  const unknown = applyGroupRun(state, { relays: relays("unknown", "unknown", "unknown", "unknown"), commonRound: null, internal: true }, 1120);
  assert.deepEqual([unknown.downRuns, unknown.fresh, unknown.checkedAt, unknown.total, unknown.monitor], [2, 0, 1120, 4, { at: 1120, reason: "internal error" }]);
  const some = applyGroupRun(state, { relays: relays("failure", "unknown", "failure", "failure"), commonRound: null }, 1120);
  assert.deepEqual([some.downRuns, some.monitor], [2, null]);
  // A run with a fresh relay is decided whatever the others are.
  const fresh = applyGroupRun(state, { relays: relays("unknown", "fresh", "unknown", "failure"), commonRound: 99, internal: true }, 1120);
  assert.deepEqual([fresh.downRuns, fresh.fresh, fresh.lastFreshAt, fresh.monitor.at], [0, 1, 1120, 1120]);
  // The next run that works clears the mark.
  assert.equal(applyGroupRun(unknown, { relays: relays("fresh", "fresh", "fresh", "fresh"), commonRound: 99 }, 1180).monitor, null);
  // With nothing known yet there are no figures to keep.
  const first = applyGroupRun(null, { relays: relays("unknown", "unknown", "unknown", "unknown"), commonRound: null, internal: true }, 1000);
  assert.deepEqual([first.fresh, first.downRuns, first.lastFreshAt, first.latestRound], [null, 0, null, null]);
});

/** A network's part of a run in which the beacon is registered as configured and the round verified. */
const networkRun = (over = {}) => ({
  name: "arc-mainnet",
  ok: true,
  reason: null,
  recipe: 11,
  registration: "registered",
  registrationReason: null,
  epoch: null,
  catalog: null,
  verifier: VERIFIER,
  slotSigner: "0x" + "11".repeat(20),
  verdict: "ok",
  verdictReason: null,
  verify: { outcome: "ok", round: 49, reason: null },
  negative: { outcome: "rejected", round: 49, reason: null },
  ...over,
});
const notRegisteredRun = (over = {}) =>
  networkRun({
    registration: "unregistered",
    registrationReason: "beaconOf reverted",
    verifier: null,
    slotSigner: null,
    verdict: null,
    verdictReason: null,
    verify: { outcome: "skipped", round: null, reason: "beacon not registered" },
    negative: { outcome: "skipped", round: null, reason: "beacon not registered" },
    ...over,
  });

test("network state keeps what was last known through unread runs, and the streak of rejections until the registry accepts a round", () => {
  const invalid = { outcome: "invalid", round: 50, reason: "verifyBeacon returned false" };
  let state = applyNetworkRun(null, networkRun(), 1000);
  assert.deepEqual(state.verify, { checkedAt: 1000, outcome: "ok", round: 49, reason: null, failures: 0, rejectedRound: null, rejectedReason: null, lastOkAt: 1000 });
  assert.deepEqual([state.registration, state.everRegistered, state.verifier, state.verdict, state.readOk, state.recipe], ["registered", true, VERIFIER, "ok", true, 11]);

  state = applyNetworkRun(state, networkRun({ verify: invalid }), 1060);
  state = applyNetworkRun(state, networkRun({ verify: invalid }), 1120);
  assert.deepEqual([state.verify.failures, state.verify.rejectedRound, state.verify.rejectedReason, state.verify.lastOkAt], [2, 50, "verifyBeacon returned false", 1000]);
  // Runs that verified nothing, could not tell, or found a rejection that only one relay stands behind leave the streak and
  // what it is about.
  state = applyNetworkRun(state, networkRun({ verify: { outcome: "skipped", round: null, reason: "no fresh relay" } }), 1180);
  state = applyNetworkRun(state, networkRun({ verify: { outcome: "unknown", round: 51, reason: "verifyBeacon: rpc error -32000" } }), 1240);
  assert.deepEqual([state.verify.failures, state.verify.rejectedRound, state.verify.outcome, state.verify.reason], [2, 50, "unknown", "verifyBeacon: rpc error -32000"]);
  state = applyNetworkRun(state, networkRun({ verify: { outcome: "uncorroborated", round: 52, reason: "verifyBeacon returned false for a signature only one relay returned" } }), 1300);
  assert.deepEqual([state.verify.failures, state.verify.rejectedRound, state.verify.outcome], [2, 50, "uncorroborated"]);

  // A registry that cannot be read says nothing new: the registration stays, marked as not read.
  const unread = applyNetworkRun(state, { name: "arc-mainnet", ok: false, reason: "http 503" }, 1360);
  assert.deepEqual([unread.readOk, unread.readReason, unread.registration, unread.verify.failures, unread.checkedAt, unread.monitor], [false, "http 503", "registered", 2, 1360, null]);
  const odd = applyNetworkRun(state, { name: "arc-mainnet", ok: true, registration: "unknown", registrationReason: "beaconOf: rpc error -32005", recipe: 11, epoch: null, catalog: null }, 1360);
  assert.deepEqual([odd.readOk, odd.readReason, odd.registration, odd.verifier], [false, "beaconOf: rpc error -32005", "registered", VERIFIER]);

  // Accepting a round ends the streak.
  const ok = applyNetworkRun(state, networkRun({ verify: { outcome: "ok", round: 60, reason: null } }), 1420);
  assert.deepEqual([ok.verify.failures, ok.verify.rejectedRound, ok.verify.lastOkAt], [0, null, 1420]);
  // Never registered: nothing to remember.
  const early = applyNetworkRun(null, notRegisteredRun({ name: "arc-testnet", registrationReason: "beaconOf reverted" }), 1000);
  assert.deepEqual([early.registration, early.everRegistered, early.verify.failures, early.negative], ["unregistered", false, 0, null]);
});

test("a registration is lost only when beaconOf reverts in two runs in a row: one revert is a node that is behind", () => {
  assert.equal(THRESHOLDS.beaconUnregisteredRuns, 2);
  const invalid = { outcome: "invalid", round: 50, reason: "verifyBeacon returned false" };
  let state = applyNetworkRun(null, networkRun({ verify: invalid }), 1000);
  // The first revert changes nothing that was known; the run is counted.
  const first = applyNetworkRun(state, notRegisteredRun(), 1060);
  assert.deepEqual([first.registration, first.registrationReason, first.verifier, first.verdict, first.readOk, first.unregisteredRuns, first.checkedAt], ["registered", null, VERIFIER, "ok", true, 1, 1060]);
  assert.equal(first.verify.failures, 1, "the streak of rejections stays as it was too");
  // Registered again, the count starts over.
  const back = applyNetworkRun(first, networkRun(), 1120);
  assert.deepEqual([back.registration, back.unregisteredRuns], ["registered", 0]);
  assert.equal(applyNetworkRun(back, notRegisteredRun(), 1180).registration, "registered", "one revert again is still not enough");
  // A run that could not tell neither counts nor ends it.
  const between = applyNetworkRun(first, { name: "arc-mainnet", ok: false, reason: "http 503" }, 1120);
  assert.equal(applyNetworkRun(between, notRegisteredRun(), 1180).registration, "unregistered", "the earlier revert still counts");
  // The second in a row is a lost registration: what the registry said goes, the streak ends, and it is remembered as once registered.
  const lost = applyNetworkRun(first, notRegisteredRun(), 1120);
  assert.deepEqual(
    [lost.registration, lost.registrationReason, lost.everRegistered, lost.verifier, lost.slotSigner, lost.verdict, lost.verify.failures, lost.negative, lost.readOk, lost.unregisteredRuns],
    ["unregistered", "beaconOf reverted", true, null, null, null, 0, null, true, 2],
  );
  // A beacon that was never registered is not held: there is nothing lost.
  assert.equal(applyNetworkRun(null, notRegisteredRun(), 1000).unregisteredRuns, 1);
});

test("a recipe that is no beacon is stored at once, however the registration was before", () => {
  let state = applyNetworkRun(null, networkRun(), 1000);
  state = applyNetworkRun(state, networkRun({ registration: "notbeacon", registrationReason: "zero verifier", verifier: null, slotSigner: null, verdict: null, verdictReason: null, verify: { outcome: "skipped", round: null, reason: "recipe is not a beacon" }, negative: { outcome: "skipped", round: null, reason: "recipe is not a beacon" } }), 1060);
  assert.deepEqual([state.registration, state.registrationReason, state.everRegistered, state.verifier, state.negative, state.recipe], ["notbeacon", "zero verifier", true, null, null, 11]);
});

test("the recipes seen to be signed recipes are remembered, sorted, and only added to", () => {
  let state = applyNetworkRun(null, networkRun({ notBeacons: [3, 1] }), 1000);
  assert.deepEqual(state.notBeacons, [1, 3]);
  state = applyNetworkRun(state, networkRun({ notBeacons: [12, 3] }), 1060);
  assert.deepEqual(state.notBeacons, [1, 3, 12]);
  state = applyNetworkRun(state, networkRun({ notBeacons: undefined }), 1120);
  assert.deepEqual(state.notBeacons, [1, 3, 12], "a run that says none keeps them");
  const unread = applyNetworkRun(state, { name: "arc-mainnet", ok: false, reason: "http 503" }, 1180);
  assert.deepEqual(unread.notBeacons, [1, 3, 12]);
  const odd = applyNetworkRun(state, { name: "arc-mainnet", ok: true, registration: "unknown", registrationReason: "beaconOf: rpc error -32005", recipe: 11, notBeacons: [7], epoch: null, catalog: null }, 1240);
  assert.deepEqual(odd.notBeacons, [1, 3, 7, 12], "what a registry could say about others is kept though it could not about the recipe monitored");
});

test("the epoch and the catalog read are kept, and what was read stays through runs that read none", () => {
  const catalog = { epochId: 5, hash: "0x" + "c1".repeat(32), recipes: [0, 1, 2, 3], use: "none" };
  let state = applyNetworkRun(null, notRegisteredRun({ epoch: { id: 6, block: 1234 }, catalog }), 1000);
  assert.deepEqual(state.epoch, { id: 6, block: 1234, checkedAt: 1000 });
  assert.deepEqual(state.catalog, { ...catalog, checkedAt: 1000 });
  // A run that read neither (no head block, no earlier epoch, a revert) keeps them, with the time they were read.
  state = applyNetworkRun(state, notRegisteredRun(), 1060);
  assert.deepEqual([state.epoch.checkedAt, state.catalog.checkedAt, state.catalog.recipes], [1000, 1000, [0, 1, 2, 3]]);
  const unread = applyNetworkRun(state, { name: "arc-mainnet", ok: false, reason: "http 503" }, 1120);
  assert.deepEqual([unread.epoch.id, unread.catalog.use], [6, "none"]);
  // A registry whose beaconOf gave no answer may still have answered these; the recipe followed is not changed by that.
  const odd = applyNetworkRun(state, { name: "arc-mainnet", ok: true, registration: "unknown", registrationReason: "beaconOf: rpc error -32005", recipe: 12, epoch: { id: 7, block: 1300 }, catalog: null }, 1180);
  assert.deepEqual([odd.epoch, odd.recipe, odd.readOk], [{ id: 7, block: 1300, checkedAt: 1180 }, 11, false]);
  // The next read replaces them.
  state = applyNetworkRun(state, networkRun({ epoch: { id: 7, block: 1300 }, catalog: { ...catalog, epochId: 6, recipes: [11], use: "only" } }), 1240);
  assert.deepEqual([state.epoch.id, state.catalog.recipes, state.catalog.use, state.catalog.checkedAt], [7, [11], "only", 1240]);
});

test("the check that a signature with its last byte flipped is rejected keeps its last conclusive verdict", () => {
  let state = applyNetworkRun(null, networkRun(), 1000);
  assert.deepEqual(state.negative, { checkedAt: 1000, outcome: "rejected", round: 49, reason: null, verdict: "ok" });
  const accepted = { outcome: "accepted", round: 50, reason: "verifyBeacon returned true for a signature with its last byte flipped" };
  state = applyNetworkRun(state, networkRun({ negative: accepted }), 1060);
  assert.deepEqual([state.negative.verdict, state.negative.round, state.negative.reason], ["accepts", 50, accepted.reason]);
  // A run that could not tell, or had no signature to flip, leaves it as it is.
  state = applyNetworkRun(state, networkRun({ negative: { outcome: "unknown", round: 51, reason: "verifyBeacon: rpc error -32005" } }), 1120);
  assert.deepEqual([state.negative.verdict, state.negative.outcome], ["accepts", "unknown"]);
  state = applyNetworkRun(state, networkRun({ negative: { outcome: "skipped", round: null, reason: "no fresh relay" } }), 1180);
  assert.equal(state.negative.verdict, "accepts");
  state = applyNetworkRun(state, { name: "arc-mainnet", ok: false, reason: "http 503" }, 1240);
  assert.equal(state.negative.verdict, "accepts");
  // A later check that has it rejected clears it.
  state = applyNetworkRun(state, networkRun(), 1300);
  assert.equal(state.negative.verdict, "ok");
});

test("a failure of the monitor's own is marked in the network's state, and cleared by the next run that works", () => {
  let state = applyNetworkRun(applyNetworkRun(null, networkRun(), 1000), { name: "arc-mainnet", ok: false, reason: "internal error", internal: true }, 1060);
  assert.deepEqual([state.monitor, state.readOk, state.readReason, state.registration], [{ at: 1060, reason: "internal error" }, false, "internal error", "registered"]);
  const unreachable = applyNetworkRun(state, { name: "arc-mainnet", ok: false, reason: "http 503" }, 1120);
  assert.equal(unreachable.monitor, null, "an unreachable registry is no fault of the monitor's");
  state = applyNetworkRun(state, networkRun(), 1120);
  assert.equal(state.monitor, null);
});
