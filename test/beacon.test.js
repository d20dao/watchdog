import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  applyGroupRun,
  applyNetworkRun,
  applyRelayRun,
  beaconGroups,
  beaconWorstSubrequests,
  checkChainInfo,
  compareRegistration,
  currentRound,
  expectedSlotSigner,
  judgeAgreement,
  judgeLatest,
  parseRoundReply,
  planBeacon,
  readBeaconOf,
  readSlotSigner,
  readVerify,
  relayId,
  roundTime,
  runBeacon,
} from "../src/beacon.js";
import { DRAND_EVMNET, DRAND_RELAYS, LIMITS, NETWORKS, SELECTORS, THRESHOLDS } from "../src/config.js";
import {
  FIXTURE,
  LAST_REAL_ROUND,
  NOW,
  PRESET,
  VERIFIER,
  ZERO_BEACON,
  beaconFetch,
  drandWorld,
  encodeBeaconOfResult,
  registeredBeacon,
  registryOf,
  roundRecord,
  slotSignerFor,
} from "./beacon-helpers.js";
import { MAINNET, TESTNET, addressWord } from "./helpers.js";

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

test("beaconOf: a revert or a zero verifier is 'not registered'; anything else unusable says nothing", () => {
  const item = (result) => ({ result });
  assert.deepEqual(readBeaconOf({ error: "rpc error 3", revert: true }), { state: "unregistered", reason: "beaconOf reverted" });
  assert.deepEqual(readBeaconOf(item(encodeBeaconOfResult(ZERO_BEACON))), { state: "unregistered", reason: "zero verifier" });
  const registered = readBeaconOf(item(encodeBeaconOfResult(registeredBeacon())));
  assert.equal(registered.state, "registered");
  assert.deepEqual(registered.tuple, registeredBeacon());
  assert.deepEqual(readBeaconOf({ error: "rpc error -32000" }), { state: "unknown", reason: "beaconOf: rpc error -32000" });
  assert.deepEqual(readBeaconOf(item("0x")), { state: "unknown", reason: "beaconOf: decode error" });
  assert.deepEqual(readBeaconOf(item("0x1234")), { state: "unknown", reason: "beaconOf: decode error" });
  assert.deepEqual(readBeaconOf(item(null)), { state: "unknown", reason: "beaconOf: decode error" });

  assert.deepEqual(readSlotSigner({ result: "0x" + addressWord(VERIFIER) }), { state: "ok", address: VERIFIER });
  assert.deepEqual(readSlotSigner({ error: "rpc error 3", revert: true }), { state: "reverted" });
  assert.deepEqual(readSlotSigner({ error: "rpc error -32000" }), { state: "unknown" });
  assert.deepEqual(readSlotSigner({ result: "0x12" }), { state: "unknown" });
});

test("verifyBeacon: true is ok, false or a revert rejects the round, an endpoint's own error says nothing", () => {
  const sample = { round: 21056967, signature: "ab".repeat(64), returnedBy: 3, of: 4 };
  const yes = "0x" + "0".repeat(63) + "1";
  const no = "0x" + "0".repeat(64);
  assert.deepEqual(readVerify({ result: yes }, sample, true), { outcome: "ok", round: 21056967, reason: null });
  assert.deepEqual(readVerify({ result: no }, sample, true), {
    outcome: "invalid",
    round: 21056967,
    reason: "verifyBeacon returned false for the signature 3 of 4 relays returned",
  });
  assert.equal(readVerify({ error: "rpc error 3", revert: true }, sample, true).reason, "verifyBeacon reverted for the signature 3 of 4 relays returned");
  assert.equal(readVerify({ result: no }, { ...sample, of: 1, returnedBy: 1 }, true).reason, "verifyBeacon returned false", "a lone relay needs no count");
  assert.deepEqual(readVerify({ error: "rpc error -32000" }, sample, true), { outcome: "unknown", round: 21056967, reason: "verifyBeacon: rpc error -32000" });
  assert.deepEqual(readVerify({ result: "0x02" }, sample, true), { outcome: "unknown", round: 21056967, reason: "verifyBeacon: decode error" });
  assert.deepEqual(readVerify(undefined, sample, false), { outcome: "skipped", round: null, reason: "beacon not registered" });
  assert.deepEqual(readVerify(undefined, { skip: "no fresh relay" }, true), { outcome: "skipped", round: null, reason: "no fresh relay" });
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
  // The verifier is compared only when the configuration names one, and then case-insensitively.
  assert.deepEqual(compare({}, { beacon: { ...beacon, verifier: VERIFIER.toUpperCase().replace("0X", "0x") } }), []);
  assert.deepEqual(compare({}, { beacon: { ...beacon, verifier: "0x" + "cd".repeat(20) } }), [`verifier ${VERIFIER} (expected 0x${"cd".repeat(20)})`]);
  assert.deepEqual(compare({}, { signer: { state: "ok", address: "0x" + "11".repeat(20) } }), [`slotSigner 0x${"11".repeat(20)} (expected ${expected})`]);
  assert.deepEqual(compare({}, { signer: { state: "ok", address: expected.toUpperCase().replace("0X", "0x") } }), []);
  assert.deepEqual(compare({}, { signer: { state: "reverted" } }), ["slotSigner reverted"]);
  assert.deepEqual(compare({}, { signer: { state: "unknown" } }), [], "an unreadable slot signer is not a mismatch");
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

// ---------------------------------------------------------------------------------------------
// A run against a fake drand network and fake registries

const LATEST = LAST_REAL_ROUND;
const COMMON = LAST_REAL_ROUND - 1; // the round before the lowest latest round: what the relays are compared at

/** The world, one registry per network, and a run of the plan for `nets` at the world's clock. */
function setup({ nets = NETWORKS } = {}) {
  const world = drandWorld();
  const registries = Object.fromEntries(Object.values(nets).map((net) => [net.name, registryOf(net)]));
  const { fetch, rpcCalls } = beaconFetch(world, registries);
  const run = (options = {}) => runBeacon(planBeacon(nets, options.states ?? new Map(), world.now), { fetch, clock: () => world.now * 1000, ...options });
  return { world, registries, rpcCalls, run, fetch };
}

const outcomes = (group) => group.relays.map((r) => [r.id, r.outcome]);
const agreements = (group) => group.relays.map((r) => r.agreement?.outcome ?? null);

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
    ["rpc.blockdaemon.mainnet.arc.io", 4],
    ["rpc.blockdaemon.testnet.arc.io", 4],
  ], "one batch per network: chain id, beaconOf, slotSigner and verifyBeacon");
  assert.equal(result.subrequests, 4 + 4 + 1 + 2, "four latest rounds, four earlier ones, one chain info and two registries");
});

test("every request is a bounded GET of the relay's own path, and the RPC client makes the registry calls", async () => {
  const { world, fetch } = setup();
  const seen = [];
  const spy = async (url, init) => {
    seen.push({ url, init });
    return fetch(url, init);
  };
  await runBeacon(planBeacon(NETWORKS, new Map(), NOW), { fetch: spy, clock: () => NOW * 1000 });
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
    ["eth_chainId", "eth_call", "eth_call", "eth_call"],
    ["eth_chainId", "eth_call", "eth_call", "eth_call"],
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
    registration: "registered",
    registrationReason: null,
    verifier: VERIFIER,
    slotSigner: slotSignerFor(registeredBeacon()),
    verdict: "ok",
    verdictReason: null,
    verify: { outcome: "ok", round: COMMON, reason: null },
  });
  // The other network's registry is asked separately and does not list it yet.
  assert.equal(testnet.registration, "unregistered");
  // The calls: the recipe, then the round the four relays agree on with the signature they returned.
  assert.deepEqual(registries["arc-mainnet"].calls, [
    { method: "beaconOf", recipe: 11 },
    { method: "slotSigner", recipe: 11 },
    { method: "verifyBeacon", recipe: 11, round: COMMON, offset: 96, signature: roundRecord(COMMON).signature },
  ]);
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
  const nets = { "arc-mainnet": { ...MAINNET, beacon: { ...MAINNET.beacon, verifier: pinned } } };
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
  const noConnection = await run({ fetch: async () => { throw new TypeError("fetch failed: SECRET-HOST"); }, timeoutMs: 30 });
  assert.ok(noConnection.groups[0].relays.every((r) => r.outcome === "failure" && r.reason === "network error"));
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
  assert.equal(group.relays[0].agreement.reason, `round ${COMMON}: signature ${forked.slice(0, 10)}...${forked.slice(-4)} differs from ${real.slice(0, 10)}...${real.slice(-4)}, which 3 relays returned`);
  assert.equal(registries["arc-mainnet"].calls.find((c) => c.method === "verifyBeacon").signature, real);
  assert.equal(group.networks[0].verify.outcome, "ok");
  assert.equal(group.relays[0].outcome, "fresh", "a relay that disagrees still serves fresh rounds");
});

test("relays split with no majority are all flagged and nothing is verified", async () => {
  const { world, registries, run } = setup();
  registries["arc-mainnet"].beaconOf = registeredBeacon();
  world.relays[API].salt = "x";
  world.relays[API2].salt = "x";
  const [group] = (await run()).groups;
  assert.deepEqual(agreements(group), ["differs", "differs", "differs", "differs"]);
  assert.equal(group.relays[0].agreement.reason, `round ${COMMON}: no majority, the relays returned 2 different signatures`);
  assert.deepEqual(group.networks[0].verify, { outcome: "skipped", round: null, reason: "relays disagree with no majority" });
  assert.ok(!registries["arc-mainnet"].calls.some((c) => c.method === "verifyBeacon"));
  assert.equal(group.sampleRound, null);
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
  await runBeacon(planBeacon(NETWORKS, new Map(), NOW), { fetch: slow, clock: () => NOW * 1000 });
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
  const result = await runBeacon(planBeacon(NETWORKS, new Map(), NOW), { fetch: world.answer, clock: () => NOW * 1000, createSession });
  assert.deepEqual(seen.map((s) => s.network), ["arc-mainnet", "arc-testnet"]);
  assert.deepEqual(seen[0].methods, ["eth_chainId", "eth_call", "eth_call", "eth_call"]);
  assert.deepEqual(seen[0].data, [SELECTORS.beaconOf, SELECTORS.slotSigner, SELECTORS.verifyBeacon]);
  assert.equal(result.subrequests, 4 + 4 + 1 + 2 + 2);
  assert.ok(result.groups[0].networks.every((n) => n.registration === "unregistered"));

  // A session that cannot be made, or that throws, fails that network's read only.
  const broken = await runBeacon(planBeacon(NETWORKS, new Map(), NOW), {
    fetch: world.answer,
    clock: () => NOW * 1000,
    createSession: (net) => {
      if (net.name === "arc-mainnet") throw new Error("boom");
      return { subrequests: 0, batch: async () => { throw new Error("boom"); } };
    },
  });
  assert.deepEqual(broken.groups[0].networks, [
    { name: "arc-mainnet", ok: false, reason: "internal error" },
    { name: "arc-testnet", ok: false, reason: "internal error" },
  ]);
  assert.equal(broken.groups[0].relays[0].outcome, "fresh", "the relays are unaffected");
});

test("a plan without groups is an empty run, and a monitor that fails as a whole never throws", async () => {
  const empty = await runBeacon({ groups: [] }, { fetch: async () => assert.fail("nothing to fetch") });
  assert.deepEqual(empty, { subrequests: 0, groups: [] });
  const plan = planBeacon(NETWORKS, new Map(), NOW);
  // A clock that throws is a bug in the run itself.
  const result = await runBeacon(plan, { fetch: async () => new Response("{}"), clock: () => { throw new Error("boom"); } });
  assert.ok(result.groups[0].relays.every((r) => r.outcome === "failure" && r.reason === "internal error"));
  assert.ok(result.groups[0].networks.every((n) => n.ok === false && n.reason === "internal error"));
  assert.equal(result.subrequests, 0);
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
  assert.ok(22 + result.subrequests <= 50, "on top of the chain reads, agent API polls, Telegram sends and AirnodeHub probes of a worst-case run");
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

  const info = (outcome, reason = null) => relayRun({ info: { outcome, reason, latencyMs: 40 } });
  // Relay 2 of 4 (phase 43200): after a read the next one is at its hour of the day, after a failed one within the hour.
  state = applyRelayRun(state, info("drift", "period 5"), 50000, 43200);
  assert.deepEqual(state.info, { checkedAt: 50000, latencyMs: 40, outcome: "drift", reason: "period 5", verdict: "drift", verdictReason: "period 5", nextCheckAt: 86400 + 43200 });
  state = applyRelayRun(state, info("failure", "http 500"), 130000, 43200);
  assert.deepEqual([state.info.verdict, state.info.verdictReason, state.info.nextCheckAt], ["drift", "period 5", 130000 + LIMITS.beaconInfoRetrySeconds]);
  state = applyRelayRun(state, info("ok"), 140000, 43200);
  assert.deepEqual([state.info.verdict, state.info.nextCheckAt], ["ok", 172800 + 43200]);
});

test("group state counts the runs in a row without a fresh relay", () => {
  const relays = (...outcomes) => outcomes.map((outcome, i) => relayRun({ id: HOSTS[i], outcome, round: outcome === "fresh" ? 100 + i : null }));
  const run = (...outcomes) => ({ relays: relays(...outcomes), commonRound: 99 });
  let state = applyGroupRun(null, run("fresh", "failure", "stale", "fresh"), 1000);
  assert.deepEqual(state, { checkedAt: 1000, fresh: 2, total: 4, downRuns: 0, lastFreshAt: 1000, latestRound: 103, commonRound: 99 });
  state = applyGroupRun(state, run("failure", "failure", "stale", "failure"), 1060);
  assert.deepEqual([state.fresh, state.downRuns, state.lastFreshAt, state.latestRound], [0, 1, 1000, null]);
  state = applyGroupRun(state, run("failure", "failure", "stale", "failure"), 1120);
  assert.equal(state.downRuns, 2);
  state = applyGroupRun(state, run("fresh", "failure", "failure", "failure"), 1180);
  assert.deepEqual([state.downRuns, state.lastFreshAt], [0, 1180]);
});

test("network state keeps what was last known through unread runs, and the streak of rejections until the registry accepts a round", () => {
  const registered = (verify, over = {}) => ({
    name: "arc-mainnet",
    ok: true,
    reason: null,
    registration: "registered",
    registrationReason: null,
    verifier: VERIFIER,
    slotSigner: "0x" + "11".repeat(20),
    verdict: "ok",
    verdictReason: null,
    verify,
    ...over,
  });
  const invalid = { outcome: "invalid", round: 50, reason: "verifyBeacon returned false" };
  let state = applyNetworkRun(null, registered({ outcome: "ok", round: 49, reason: null }), 1000);
  assert.deepEqual(state.verify, { checkedAt: 1000, outcome: "ok", round: 49, reason: null, failures: 0, rejectedRound: null, rejectedReason: null, lastOkAt: 1000 });
  assert.deepEqual([state.registration, state.everRegistered, state.verifier, state.verdict, state.readOk], ["registered", true, VERIFIER, "ok", true]);

  state = applyNetworkRun(state, registered(invalid), 1060);
  state = applyNetworkRun(state, registered(invalid), 1120);
  assert.deepEqual([state.verify.failures, state.verify.rejectedRound, state.verify.rejectedReason, state.verify.lastOkAt], [2, 50, "verifyBeacon returned false", 1000]);
  // Runs that verified nothing, or could not tell, leave the streak and what it is about.
  state = applyNetworkRun(state, registered({ outcome: "skipped", round: null, reason: "no fresh relay" }), 1180);
  state = applyNetworkRun(state, registered({ outcome: "unknown", round: 51, reason: "verifyBeacon: rpc error -32000" }), 1240);
  assert.deepEqual([state.verify.failures, state.verify.rejectedRound, state.verify.outcome, state.verify.reason], [2, 50, "unknown", "verifyBeacon: rpc error -32000"]);

  // A registry that cannot be read says nothing new: the registration stays, marked as not read.
  const unread = applyNetworkRun(state, { name: "arc-mainnet", ok: false, reason: "http 503" }, 1300);
  assert.deepEqual([unread.readOk, unread.readReason, unread.registration, unread.verify.failures, unread.checkedAt], [false, "http 503", "registered", 2, 1300]);
  const odd = applyNetworkRun(state, { name: "arc-mainnet", ok: true, registration: "unknown", registrationReason: "beaconOf: rpc error -32005" }, 1300);
  assert.deepEqual([odd.readOk, odd.readReason, odd.registration, odd.verifier], [false, "beaconOf: rpc error -32005", "registered", VERIFIER]);

  // Not registered any more: what the registry said goes, the streak ends, and it is remembered as once registered.
  const lost = applyNetworkRun(state, { name: "arc-mainnet", ok: true, registration: "unregistered", registrationReason: "beaconOf reverted", verify: { outcome: "skipped", round: null, reason: "beacon not registered" } }, 1360);
  assert.deepEqual(
    [lost.registration, lost.registrationReason, lost.everRegistered, lost.verifier, lost.slotSigner, lost.verdict, lost.verify.failures, lost.readOk],
    ["unregistered", "beaconOf reverted", true, null, null, null, 0, true],
  );
  // Accepting a round ends the streak.
  const ok = applyNetworkRun(state, registered({ outcome: "ok", round: 60, reason: null }), 1420);
  assert.deepEqual([ok.verify.failures, ok.verify.rejectedRound, ok.verify.lastOkAt], [0, null, 1420]);
  // Never registered: nothing to remember.
  const early = applyNetworkRun(null, { name: "arc-testnet", ok: true, registration: "unregistered", registrationReason: "zero verifier", verify: { outcome: "skipped", round: null, reason: "beacon not registered" } }, 1000);
  assert.deepEqual([early.registration, early.everRegistered, early.verify.failures], ["unregistered", false, 0]);
});
