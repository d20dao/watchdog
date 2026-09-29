import assert from "node:assert/strict";
import { test } from "node:test";
import { beaconWorstSubrequests, currentRound } from "../src/beacon.js";
import { DRAND_RELAYS, LIMITS, NETWORKS, THRESHOLDS } from "../src/config.js";
import { runCron } from "../src/cron.js";
import { buildStatus, renderHtml } from "../src/status.js";
import { migrate, readAlerts, readBeaconStates, writeProbeState } from "../src/store.js";
import {
  NOW,
  PRESET,
  VERIFIER,
  beaconFetch,
  drandWorld,
  registeredBeacon,
  registryOf,
  roundRecord,
  slotSignerFor,
} from "./beacon-helpers.js";
import { MAINNET, TESTNET, agentApiPoll, healthyRead, memoryStorage, pageText } from "./helpers.js";

// Runs of the whole watchdog with the real drand beacon monitor against a fake drand network and fake registries:
// the alerts it raises, what the status shows and what it costs. Each `run(minutes)` is one run that many minutes after NOW,
// the second after round 21056968 was due; the chain reads, the agent APIs and Telegram are healthy or recorded.

const TELEGRAM = { TELEGRAM_BOT_TOKEN: "123456:throwaway-token", TELEGRAM_CHAT_ID: "-1001234567890" };
const HOSTS = DRAND_RELAYS.map((url) => new URL(url).host);
const [API, API2, API3, CLOUDFLARE] = HOSTS;

// An AirnodeHub recipe that is configured but never due, so the catalog is not drand alone and no probe is made. It is
// made up here rather than taken from AIRNODE_RECIPES: those go when the probes are retired, and these tests stay.
const AIRNODE = {
  id: "alpha-feed",
  name: "Alpha feed",
  recipe: 4,
  url: "https://airnode-alpha.example/",
  body: { operation: "latestFeeds", parameters: { name: "ETH/USD" } },
  signer: "0x" + "22".repeat(20),
  shape: [{ literal: "{}" }],
};
const FAR = 2 ** 40;
const withAirnodeConfigured = (storage) =>
  writeProbeState(storage, AIRNODE.id, NOW, { nextProbeAt: FAR, verdict: "ok", document: { nextCheckAt: FAR, verdict: "ok" } });

/** `recipes: []` (the default) is the catalog after the switch, drand alone; pass [AIRNODE] for the one before. */
function harness({ recipes = [], env = TELEGRAM, networks } = {}) {
  const storage = memoryStorage();
  if (recipes.length > 0) withAirnodeConfigured(storage);
  const world = drandWorld({ now: NOW });
  const registries = Object.fromEntries(Object.values(NETWORKS).map((net) => [net.name, registryOf(net)]));
  const telegram = [];
  const { fetch, rpcCalls } = beaconFetch(world, registries, {
    telegram: async (url, init) => {
      telegram.push(JSON.parse(init.body));
      return new Response("{}");
    },
  });
  const state = { recipes, networks, runBeaconImpl: undefined };
  const run = (minutes) => {
    world.now = NOW + Math.round(minutes * 60);
    return runCron({
      storage,
      env,
      fetch,
      clock: () => world.now * 1000,
      readChainImpl: async (net) => healthyRead(net),
      readAgentApiImpl: async (net) => agentApiPoll({}, net),
      runBeaconImpl: state.runBeaconImpl,
      networks: state.networks,
      recipes: state.recipes,
    });
  };
  const texts = () => telegram.flatMap((m) => m.text.split("\n\n"));
  const status = (minutes = 0) => buildStatus(storage, env, NOW + minutes * 60, state.recipes, state.networks);
  return { storage, world, registries, rpcCalls, telegram, state, run, texts, status };
}

const beaconAlerts = (h) => readAlerts(h.storage, "beacon").map((a) => a.check).sort();
const all = (h, edit) => HOSTS.forEach((host) => Object.assign(h.world.relays[host], edit));

test("before the registry lists a beacon nothing is raised, however long it takes; the status says 'not registered yet'", async () => {
  const h = harness();
  for (let minute = 0; minute < 12; minute++) {
    const summary = await h.run(minute);
    assert.deepEqual(summary.beacon.messages, []);
    assert.deepEqual(summary.beacon.networks.map((n) => [n.network, n.registration, n.verify]), [
      ["arc-mainnet", "unregistered", "skipped"],
      ["arc-testnet", "unregistered", "skipped"],
    ]);
  }
  assert.deepEqual(h.texts(), []);
  assert.deepEqual(beaconAlerts(h), []);
  const status = h.status(12);
  assert.deepEqual(Object.values(status.beacon.networks).map((n) => n.registration), ["not registered yet", "not registered yet"]);
  assert.deepEqual(status.beacon.networks["arc-mainnet"].verification, { status: "not verified", lastOutcome: "skipped", round: null, reason: "beacon not registered", consecutiveRejections: 0, lastOkAt: null, lastOkAgeSeconds: null });
  assert.deepEqual(status.beacon.relays.map((r) => r.status), ["ok", "ok", "ok", "ok"]);
  assert.ok(pageText(renderHtml(status)).includes("Registry · arc-mainnet Not registered yet recipe 11 · checked 1m ago"));
});

test("the relays are watched before the registration too: an outage alarms while the registry lists nothing", async () => {
  const h = harness({ recipes: [AIRNODE] });
  await h.run(0);
  all(h, { status: 503 });
  await h.run(1);
  await h.run(2);
  assert.equal(h.texts().length, 1);
  assert.match(h.texts()[0], /^\[beacon\] ALARM drand beacon down: no relay serves a fresh round/);
});

test("no relay serves a fresh round: an alarm after two runs in a row, a service-stopping one when drand is the catalog's only source", async () => {
  const h = harness();
  await h.run(0);
  all(h, { status: 503 });
  await h.run(1);
  assert.deepEqual(h.texts(), [], "one run without a fresh relay is not enough");
  await h.run(2);
  const reasons = HOSTS.map((host) => `${host}: http 503`).join(", ");
  assert.deepEqual(h.texts(), [
    `[beacon] ALARM drand beacon down, service stopping: no relay serves a fresh round (${reasons}); ` +
      "the catalog lists only the drand beacon, so epoch publication stops and requests cannot be served until one does",
  ]);
  assert.equal(readAlerts(h.storage, "beacon")[0].severity, "alarm");

  // While it lasts, the relays' own warnings stay quiet and the alarm repeats every 30 minutes.
  for (let minute = 3; minute < 32; minute++) await h.run(minute);
  assert.equal(h.texts().length, 1);
  await h.run(32);
  assert.equal(h.texts()[1].endsWith("until one does (active 30 min)"), true);
  assert.deepEqual(beaconAlerts(h), ["fresh:drand-evmnet"]);

  // Back: the alarm resolves; a relay that is still down warns for itself.
  all(h, { status: undefined });
  h.world.relays[API3].status = 503;
  await h.run(33);
  assert.deepEqual(h.texts().slice(2), [
    "[beacon] RESOLVED drand beacon down, service stopping after 31 min",
    "[beacon] WARNING drand relay api3.drand.sh not serving fresh rounds: 33 consecutive checks not fresh (last: http 503)",
  ]);
});

test("while AirnodeHub recipes are still configured the same outage is an alarm without the service-stopping name", async () => {
  const h = harness({ recipes: [AIRNODE] });
  all(h, { status: 503 });
  await h.run(0);
  await h.run(1);
  const reasons = HOSTS.map((host) => `${host}: http 503`).join(", ");
  assert.deepEqual(h.texts(), [
    `[beacon] ALARM drand beacon down: no relay serves a fresh round (${reasons}); epochs that select the drand recipe cannot publish until one does`,
  ]);
  // The catalog switching to drand alone renames the alert without a new message; it is the same condition.
  h.state.recipes = [];
  await h.run(2);
  assert.equal(h.texts().length, 1);
  assert.equal(readAlerts(h.storage, "beacon")[0].title, "drand beacon down, service stopping");
});

test("one relay failing or lagging warns after three runs in a row, once, and resolves when it serves again", async () => {
  const h = harness();
  await h.run(0);
  h.world.relays[API2].status = 503;
  await h.run(1);
  h.world.relays[API2].status = undefined;
  await h.run(2);
  assert.deepEqual(h.texts(), [], "a relay that fails now and then is not worth a message");

  h.world.relays[API2].status = 503;
  for (const minute of [3, 4]) await h.run(minute);
  assert.deepEqual(h.texts(), []);
  await h.run(5);
  assert.deepEqual(h.texts(), ["[beacon] WARNING drand relay api2.drand.sh not serving fresh rounds: 3 consecutive checks not fresh (last: http 503)"]);
  for (const minute of [6, 7, 40]) await h.run(minute);
  assert.equal(h.texts().length, 1, "warnings never repeat");
  h.world.relays[API2].status = undefined;
  await h.run(41);
  assert.equal(h.texts()[1], "[beacon] RESOLVED drand relay api2.drand.sh not serving fresh rounds after 36 min");

  // Lagging is the same alert, with the lag as its reason.
  h.world.relays[API3].lag = 4;
  for (const minute of [42, 43, 44]) await h.run(minute);
  const round = currentRound(PRESET, h.world.now) - 4;
  assert.equal(h.texts()[2], `[beacon] WARNING drand relay api3.drand.sh not serving fresh rounds: 3 consecutive checks not fresh (last: latest round ${round} is 4 rounds (12s) behind the schedule)`);
  assert.deepEqual(beaconAlerts(h), ["relay:drand-evmnet:api3.drand.sh"]);
});

test("a relay serving another signature warns at once, and keeps warning through failed reads until an agreeing one", async () => {
  const h = harness();
  await h.run(0);
  h.world.relays[API3].salt = "forked";
  await h.run(1);
  const round = currentRound(PRESET, h.world.now) - 1;
  const forked = roundRecord(round, "forked").signature;
  const real = roundRecord(round).signature;
  const short = (hex) => `${hex.slice(0, 10)}...${hex.slice(-4)}`;
  assert.deepEqual(h.texts(), [
    `[beacon] WARNING drand relay api3.drand.sh disagrees with the other relays: round ${round}: signature ${short(forked)} differs from ${short(real)}, which 3 relays returned`,
  ]);
  // Its answers stop: that says nothing about whether it was fixed.
  h.world.relays[API3].status = 503;
  await h.run(2);
  await h.run(3);
  assert.deepEqual(beaconAlerts(h), ["agree:drand-evmnet:api3.drand.sh"]);
  // It answers again, in agreement.
  h.world.relays[API3] = {};
  await h.run(4);
  assert.equal(h.texts()[1], "[beacon] RESOLVED drand relay api3.drand.sh disagrees with the other relays after 3 min");
  assert.deepEqual(beaconAlerts(h), []);
});

test("chain info that differs from the configured beacon warns when read and resolves at the next matching read", async () => {
  const h = harness();
  // One relay's /info is read per run, in configuration order, on the first four runs.
  await h.run(0);
  await h.run(1);
  h.world.relays[API3].info = { period: 5 };
  await h.run(2);
  assert.deepEqual(h.texts(), [
    "[beacon] WARNING drand relay api3.drand.sh chain info differs from the configured beacon: chain info differs from the drand-evmnet preset: period 5 (expected 3)",
  ]);
  await h.run(3);
  const info = (host) => readBeaconStates(h.storage).get("group:drand-evmnet").relays[host].info;
  assert.deepEqual(HOSTS.map((host) => info(host).outcome), ["ok", "ok", "drift", "ok"]);
  assert.deepEqual(h.world.calls.filter((c) => c.kind === "info").map((c) => c.host), HOSTS);

  // After that each relay is read once a day, at its own hour: relay j of 4 at second j x 21600 of the day (UTC).
  // The next four reads, in the order of those hours, each in the first run after the hour.
  const minutesTo = (at) => Math.ceil((at - NOW) / 60);
  const nextReads = HOSTS.map((host) => [info(host).nextCheckAt, host]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(nextReads.map(([, host]) => host), [CLOUDFLARE, API, API2, API3]);
  for (const [at, host] of nextReads.slice(0, 3)) {
    assert.equal(at % 86400, HOSTS.indexOf(host) * 21600, `${host} has its own hour`);
    const before = h.world.calls.filter((c) => c.kind === "info").length;
    await h.run(minutesTo(at) - 1);
    assert.equal(h.world.calls.filter((c) => c.kind === "info").length, before, "not before its hour");
    await h.run(minutesTo(at));
    assert.deepEqual(h.world.calls.filter((c) => c.kind === "info").slice(before).map((c) => c.host), [host]);
  }

  // The relay with the finding is read last. A failed read keeps the finding and is retried within the hour.
  const [due] = nextReads.at(-1);
  h.world.relays[API3].infoStatus = 500;
  await h.run(minutesTo(due));
  assert.equal(info(API3).outcome, "failure");
  assert.equal(info(API3).verdict, "drift");
  assert.equal(info(API3).nextCheckAt, NOW + minutesTo(due) * 60 + LIMITS.beaconInfoRetrySeconds);
  assert.equal(h.texts().length, 1, "a failed read neither repeats nor resolves");
  h.world.relays[API3].infoStatus = undefined;
  h.world.relays[API3].info = undefined;
  await h.run(minutesTo(info(API3).nextCheckAt));
  assert.match(h.texts()[1], /^\[beacon\] RESOLVED drand relay api3\.drand\.sh chain info differs from the configured beacon after \d+ min$/);
  assert.deepEqual(beaconAlerts(h), []);
});

test("registration: as configured raises nothing, a mismatch warns until it is fixed, losing it warns, an unreadable registry changes nothing", async () => {
  const h = harness();
  const mainnet = h.registries["arc-mainnet"];
  await h.run(0);
  assert.deepEqual(h.texts(), [], "not registered yet: nothing to compare");

  mainnet.beaconOf = registeredBeacon();
  await h.run(1);
  assert.deepEqual(h.texts(), []);
  assert.equal(h.status(1).beacon.networks["arc-mainnet"].registration, "registered");
  assert.equal(h.status(1).beacon.networks["arc-testnet"].registration, "not registered yet", "each registry on its own");

  const wrong = registeredBeacon({ chainHash: "0x" + "11".repeat(32) });
  mainnet.beaconOf = wrong;
  await h.run(2);
  assert.deepEqual(h.texts(), [
    "[beacon] WARNING arc-mainnet registry beacon registration mismatch: beaconOf(11) differs from the configured drand-evmnet beacon: " +
      `chainHash 0x11111111...1111 (expected 0x04f1e906...c8c3); slotSigner ${slotSignerFor(wrong)} (expected ${slotSignerFor(registeredBeacon())})`,
  ]);
  await h.run(3);
  assert.equal(h.texts().length, 1, "warnings never repeat");
  assert.equal(h.status(3).beacon.networks["arc-mainnet"].registration, "mismatch");

  mainnet.beaconOf = registeredBeacon();
  await h.run(4);
  assert.equal(h.texts()[1], "[beacon] RESOLVED arc-mainnet registry beacon registration mismatch after 2 min");

  // A rollback of the registry leaves it without the beacon it once listed.
  mainnet.beaconOf = "revert";
  await h.run(5);
  assert.equal(h.texts()[2], "[beacon] WARNING arc-mainnet registry beacon no longer registered: beaconOf reverted; the beacon was registered before");
  assert.equal(h.status(5).beacon.networks["arc-mainnet"].registration, "no longer registered");

  // An answer that is no answer changes nothing, neither resolving nor repeating.
  mainnet.error = { code: -32005, message: "rate limit" };
  await h.run(6);
  assert.equal(h.texts().length, 3);
  assert.deepEqual(beaconAlerts(h), ["registration:arc-mainnet"]);
  const unread = h.status(6).beacon.networks["arc-mainnet"];
  assert.deepEqual([unread.registration, unread.reason], ["no longer registered", "not read: beaconOf: rpc error -32005"]);
  delete mainnet.error;
  mainnet.beaconOf = registeredBeacon({ verifier: "0x" + "cd".repeat(20) });
  mainnet.slotSigner = slotSignerFor(registeredBeacon({ verifier: "0x" + "cd".repeat(20) }));
  await h.run(7);
  assert.deepEqual(h.texts().slice(3), ["[beacon] RESOLVED arc-mainnet registry beacon no longer registered after 2 min"], "any verifier is accepted while the configuration names none");
  assert.deepEqual(beaconAlerts(h), []);
});

test("a registry that rejects the round alarms after two runs in a row, and a run with no round to verify leaves it as it is", async () => {
  const h = harness();
  h.registries["arc-mainnet"].beaconOf = registeredBeacon();
  await h.run(0);
  h.registries["arc-mainnet"].verify = false;
  await h.run(1);
  assert.deepEqual(h.texts(), [], "one rejection is not enough");
  await h.run(2);
  const round = currentRound(PRESET, h.world.now) - 1;
  assert.deepEqual(h.texts(), [
    `[beacon] ALARM arc-mainnet registry rejects drand rounds: verifyBeacon(11) rejected round ${round} in 2 consecutive runs ` +
      "(verifyBeacon returned false for the signature 4 of 4 relays returned): the registry cannot verify a real round",
  ]);
  const verification = h.status(2).beacon.networks["arc-mainnet"].verification;
  assert.deepEqual([verification.status, verification.consecutiveRejections, verification.round], ["alarm", 2, round]);

  // The relays fail for a run: nothing is verified, the alarm neither resolves nor changes.
  all(h, { status: 503 });
  await h.run(3);
  assert.equal(h.texts().length, 1);
  assert.equal(readAlerts(h.storage, "beacon").find((a) => a.check === "verify:arc-mainnet").detail.includes(`round ${round} in 2`), true);
  all(h, { status: undefined });
  h.registries["arc-mainnet"].verify = true;
  await h.run(4);
  assert.equal(h.texts().at(-1), "[beacon] RESOLVED arc-mainnet registry rejects drand rounds after 2 min");
  assert.deepEqual(beaconAlerts(h), []);

  // The registry is fine while the relays are split: nothing is verified, so nothing is rejected.
  h.registries["arc-mainnet"].verify = false;
  h.world.relays[API].salt = "x";
  h.world.relays[API2].salt = "x";
  for (const minute of [5, 6, 7]) await h.run(minute);
  assert.deepEqual(beaconAlerts(h).filter((c) => c.startsWith("verify")), []);
});

test("a beacon, a network or a relay removed from the configuration resolves its alerts and drops its state", async () => {
  const h = harness();
  h.registries["arc-mainnet"].beaconOf = registeredBeacon({ period: 9 });
  h.world.relays[API3].salt = "forked";
  await h.run(0);
  assert.deepEqual(beaconAlerts(h), ["agree:drand-evmnet:api3.drand.sh", "registration:arc-mainnet"]);

  // One relay less: its alert goes with it.
  const fewer = (url) => !url.includes("api3");
  h.state.networks = Object.fromEntries(Object.entries(NETWORKS).map(([name, net]) => [name, { ...net, beacon: { ...net.beacon, relays: net.beacon.relays.filter(fewer) } }]));
  await h.run(1);
  assert.equal(h.texts().at(-1), "[beacon] RESOLVED drand relay api3.drand.sh disagrees with the other relays after 1 min");
  assert.deepEqual(Object.keys(readBeaconStates(h.storage).get("group:drand-evmnet").relays), [API, API2, CLOUDFLARE]);

  // One network less: its registration alert and state go.
  const { beacon, ...bare } = MAINNET;
  h.state.networks = { "arc-mainnet": bare, "arc-testnet": h.state.networks["arc-testnet"] };
  await h.run(2);
  assert.equal(h.texts().at(-1), "[beacon] RESOLVED arc-mainnet registry beacon registration mismatch after 2 min");
  assert.deepEqual([...readBeaconStates(h.storage).keys()].sort(), ["group:drand-evmnet", "network:arc-testnet"]);

  // No beacon at all: nothing is fetched, nothing is kept, no section is shown.
  all(h, { status: 503 });
  h.state.networks = undefined;
  await h.run(3);
  await h.run(4);
  assert.deepEqual(beaconAlerts(h), ["fresh:drand-evmnet", "registration:arc-mainnet"]);
  const { beacon: t, ...bareTestnet } = TESTNET;
  h.state.networks = { "arc-mainnet": bare, "arc-testnet": bareTestnet };
  const calls = h.world.calls.length;
  const summary = await h.run(5);
  assert.equal(h.world.calls.length, calls);
  assert.deepEqual(h.texts().slice(-2).sort(), [
    "[beacon] RESOLVED arc-mainnet registry beacon registration mismatch after 2 min",
    "[beacon] RESOLVED drand beacon down, service stopping after 1 min",
  ]);
  assert.deepEqual([...readBeaconStates(h.storage).keys()], []);
  assert.deepEqual([summary.beacon.relays, summary.beacon.networks], [[], []]);
  assert.equal("beacon" in h.status(5), false);
  assert.equal(pageText(renderHtml(h.status(5))).includes("drand beacon"), false);
});

test("a monitor that fails as a whole counts every relay as failed and reads no registry; it never stops the run", async () => {
  const h = harness();
  h.state.runBeaconImpl = async () => {
    throw new Error("boom: SECRET-DETAIL");
  };
  await h.run(0);
  const summary = await h.run(1);
  assert.equal(summary.messagesQueued, 1);
  assert.match(h.texts()[0], /^\[beacon\] ALARM drand beacon down, service stopping: no relay serves a fresh round \(api\.drand\.sh: internal error, api2\.drand\.sh: internal error,/);
  assert.ok(!JSON.stringify(h.telegram).includes("SECRET"), "an error's text never reaches a message");
  assert.deepEqual(summary.beacon.networks.map((n) => n.read), [false, false]);
  assert.equal(summary.subrequests, 4 + 2 + 1, "the chain reads, the agent API polls and the Telegram send: no relay or registry was reached");
  assert.deepEqual(beaconAlerts(h), ["fresh:drand-evmnet"]);
});

test("stored beacon state and run summaries keep figures and short reasons, never signatures or reply bodies", async () => {
  const h = harness();
  h.registries["arc-mainnet"].beaconOf = registeredBeacon();
  h.world.relays[API2].body = (kind, record) => JSON.stringify({ ...record, note: "SECRET-BODY" });
  h.world.relays[API3].status = 503;
  const summary = await h.run(0);
  const stored = JSON.stringify([...readBeaconStates(h.storage)]);
  for (const text of [stored, JSON.stringify(summary.beacon), JSON.stringify(h.status())]) {
    assert.ok(!text.includes("SECRET"));
    assert.ok(!/[0-9a-f]{100}/.test(text.replace(new RegExp(PRESET.publicKey, "g"), "").replace(PRESET.chainHash, "")), "no signature");
  }
  assert.equal(readBeaconStates(h.storage).size, 3, "one row per group and per network");
});

// ---------------------------------------------------------------------------------------------
// Status

/** A watchdog with a relay down for a while, another one on a fork, and a registry that lists the beacon wrongly. */
async function troubled() {
  const h = harness();
  h.registries["arc-mainnet"].beaconOf = registeredBeacon({ period: 9 });
  h.world.relays[API2].status = 503;
  h.world.relays[API3].salt = "forked";
  for (let minute = 0; minute < 5; minute++) await h.run(minute);
  return h;
}

test("status JSON: the chain, each relay's last check, each network's registration and the beacon's own alerts", async () => {
  const h = await troubled();
  const round = currentRound(PRESET, NOW + 4 * 60);
  const status = h.status(4);
  const beacon = status.beacon;
  assert.equal(beacon.catalogDrandOnly, true);
  assert.equal(beacon.maxLagRounds, 3);
  assert.deepEqual(beacon.chains, [
    {
      preset: "drand-evmnet",
      name: "drand evmnet",
      scheme: "bls-bn254-unchained-on-g1",
      chainHash: PRESET.chainHash,
      periodSeconds: 3,
      genesis: 1727521075,
      status: "ok",
      checkedAt: NOW + 240,
      checkedAgeSeconds: 0,
      freshRelays: 3,
      totalRelays: 4,
      latestRound: round,
      commonRound: round - 1,
      consecutiveRunsWithoutFreshRelay: 0,
      lastFreshAt: NOW + 240,
      lastFreshAgeSeconds: 0,
    },
  ]);

  const [api, api2, api3, cloudflare] = beacon.relays;
  assert.deepEqual(
    beacon.relays.map((r) => [r.id, r.status, r.lastOutcome, r.latestRound, r.lagRounds, r.consecutiveNotFresh]),
    [
      [API, "ok", "fresh", round, 0, 0],
      [API2, "warning", "failure", null, null, 5],
      [API3, "warning", "fresh", round, 0, 0],
      [CLOUDFLARE, "ok", "fresh", round, 0, 0],
    ],
  );
  assert.deepEqual([api.preset, api.url, api.lagSeconds, api.latencyMs, api.lastOkAgeSeconds], ["drand-evmnet", "https://api.drand.sh", 0, 0, 0]);
  assert.deepEqual([api2.reason, api2.lastOkAt, api2.lastOkAgeSeconds, api2.agreement], ["http 503", null, null, null], "it was never fresh");
  assert.equal(api3.agreement.status, "warning");
  assert.equal(api3.agreement.lastOutcome, "differs");
  assert.equal(api3.agreement.round, round - 1);
  assert.equal(cloudflare.agreement.status, "ok");
  assert.deepEqual([api.chainInfo.status, api.chainInfo.lastOutcome, api2.chainInfo.status, cloudflare.chainInfo.status], ["ok", "ok", "unknown", "ok"]);
  assert.equal(api2.chainInfo.lastOutcome, "failure", "its /info answered 503 as well");
  assert.equal(api.chainInfo.nextCheckAt % 86400, 0, "relay 1 of 4 is read at the start of the day");

  const mainnet = beacon.networks["arc-mainnet"];
  assert.deepEqual([mainnet.registration, mainnet.recipe, mainnet.registry, mainnet.verifier, mainnet.expectedVerifier], ["mismatch", 11, MAINNET.registry, VERIFIER, null]);
  assert.match(mainnet.reason, /^beaconOf\(11\) differs from the configured drand-evmnet beacon: period 9 \(expected 3\); slotSigner /);
  assert.equal(mainnet.slotSigner, slotSignerFor(registeredBeacon({ period: 9 })));
  assert.deepEqual([mainnet.verification.status, mainnet.verification.round, mainnet.verification.consecutiveRejections], ["ok", round - 1, 0]);
  const testnet = beacon.networks["arc-testnet"];
  assert.deepEqual([testnet.registration, testnet.verifier, testnet.slotSigner, testnet.reason], ["not registered yet", null, null, "beaconOf reverted"]);

  assert.deepEqual(beacon.alerts.map((a) => [a.check, a.severity]).sort(), [
    ["agree:drand-evmnet:api3.drand.sh", "warning"],
    ["registration:arc-mainnet", "warning"],
    ["relay:drand-evmnet:api2.drand.sh", "warning"],
  ]);
  assert.ok(status.networks["arc-mainnet"].alerts.every((a) => !a.check.startsWith("relay:") && !a.check.startsWith("registration:")), "the beacon's alerts are listed under beacon");
  assert.deepEqual(Object.keys(status), ["service", "generatedAt", "notifier", "networks", "beacon", "recentMessages"]);
});

test("status HTML: a drand beacon section with the relays, the registries and the alerts; the tone follows the severity", async () => {
  const h = await troubled();
  const html = renderHtml(h.status(4));
  const text = pageText(html);
  assert.ok(text.includes("drand beacon WARNING Read every minute · fresh means within 3 rounds (9s) of the schedule"));
  const round = currentRound(PRESET, NOW + 4 * 60);
  assert.ok(text.includes(`Relays fresh 3 of 4 latest round #${round}`));
  assert.ok(text.includes("Registry · arc-mainnet MISMATCH recipe 11 · round #" + (round - 1) + " verified · checked 0s ago"));
  assert.ok(text.includes("Registry · arc-testnet Not registered yet recipe 11 · checked 0s ago"));
  assert.ok(text.includes("WARNING drand relay api2.drand.sh not serving fresh rounds 5 consecutive checks not fresh (last: http 503)"));
  assert.ok(text.includes("WARNING arc-mainnet registry beacon registration mismatch"));
  assert.ok(text.includes("Relay Status Latest round Lag Last fresh Checks"));
  assert.ok(text.includes(`api.drand.sh drand-evmnet OK #${round} 0 rounds (0s) 0s ago agree · info ok`));
  assert.ok(text.includes("api2.drand.sh drand-evmnet WARNING — — never — · info — http 503 (5 not fresh in a row) chain info: http 503"));
  assert.ok(text.includes(`api3.drand.sh drand-evmnet WARNING #${round} 0 rounds (0s) 0s ago differs · info ok`));
  assert.ok(text.includes(`round ${round - 1}: signature `));
  assert.match(html, /<p class="pill warning">/);
  // The section sits between the networks and the AirnodeHub listings, and each tone is a class, not just a word.
  assert.ok(html.indexOf("Agent API · arc-testnet") < html.indexOf(">drand beacon<"));
  assert.match(html, /<span class="warning">differs<\/span>/);
  assert.match(html, /<dd class="fig ok">3 of 4<\/dd>/);
  assert.match(html, /<dd class="fig warning">MISMATCH<\/dd>/);
  assert.match(html, /<dd class="fig muted">Not registered yet<\/dd>/);
});

test("status HTML: an alarm shows as one, a beacon not yet checked as such, and nothing a store holds reaches the page unescaped", async () => {
  const h = harness();
  const fresh = renderHtml(h.status());
  const freshText = pageText(fresh);
  assert.ok(freshText.includes("Relays fresh — not checked yet"));
  assert.ok(freshText.includes("Registry · arc-mainnet — recipe 11"));
  assert.ok(freshText.includes("api.drand.sh drand-evmnet not checked yet — — — — · info —"));
  assert.equal(h.status().beacon.chains[0].status, "not checked");
  assert.ok(h.status().beacon.relays.every((r) => r.status === "not checked" && r.agreement === null && r.chainInfo === null));

  all(h, { status: 503 });
  await h.run(0);
  await h.run(1);
  const down = renderHtml(h.status(1));
  assert.match(down, /<p class="pill alarm">/);
  assert.ok(pageText(down).includes("drand beacon ALARM"));
  assert.ok(pageText(down).includes("ALARM drand beacon down, service stopping no relay serves a fresh round"));
  assert.match(down, /<dd class="fig alarm">0 of 4<\/dd>/);
  assert.equal(h.status(1).beacon.chains[0].status, "alarm");

  // Text a store holds is escaped like any other.
  const rows = memoryStorage();
  const hostile = "<b>x</b> \"&'";
  const group = { checkedAt: NOW, fresh: 0, total: 1, downRuns: 0, relays: { [API]: { checkedAt: NOW, outcome: "failure", reason: hostile, badRuns: 1, agreement: { checkedAt: NOW, round: 5, outcome: "differs", reason: hostile, verdict: "differs", verdictReason: hostile }, info: { checkedAt: NOW, outcome: "drift", reason: hostile, verdict: "drift", verdictReason: hostile, nextCheckAt: NOW } } } };
  const network = { checkedAt: NOW, readOk: true, registration: "registered", verdict: "mismatch", verdictReason: hostile, everRegistered: true, verify: { outcome: "invalid", failures: 2, round: 5, reason: hostile, rejectedRound: 5, rejectedReason: hostile } };
  const { writeBeaconState } = await import("../src/store.js");
  writeBeaconState(rows, "group:drand-evmnet", NOW, group);
  writeBeaconState(rows, "network:arc-mainnet", NOW, network);
  const hostileHtml = renderHtml(buildStatus(rows, {}, NOW + 10, [], NETWORKS));
  assert.ok(hostileHtml.includes("&lt;b&gt;x&lt;/b&gt; &quot;&amp;&#39;"));
  assert.ok(!hostileHtml.includes("<b>x</b>"));
});

test("the AirnodeHub section and key stay while recipes are configured and go with the last of them; the page description follows", async () => {
  const h = harness({ recipes: [AIRNODE] });
  await h.run(0);
  const both = h.status();
  assert.deepEqual(Object.keys(both), ["service", "generatedAt", "notifier", "networks", "beacon", "airnodehub", "recentMessages"]);
  assert.equal(both.beacon.catalogDrandOnly, false);
  const bothHtml = renderHtml(both);
  assert.ok(pageText(bothHtml).includes("AirnodeHub listings"));
  assert.ok(bothHtml.includes('content="Live health of the D20DAO VRF keepers, agent API, drand beacon and AirnodeHub listings on Arc."'));
  assert.ok(bothHtml.indexOf(">drand beacon<") < bothHtml.indexOf(">AirnodeHub listings<"));

  const drandOnly = buildStatus(h.storage, TELEGRAM, NOW + 60, [], undefined);
  assert.deepEqual(Object.keys(drandOnly), ["service", "generatedAt", "notifier", "networks", "beacon", "recentMessages"]);
  assert.equal(drandOnly.beacon.catalogDrandOnly, true);
  const html = renderHtml(drandOnly);
  assert.ok(!pageText(html).includes("AirnodeHub"));
  assert.ok(html.includes('content="Live health of the D20DAO VRF keepers, agent API and drand beacon on Arc."'));
  assert.equal((html.match(/Live health of the D20DAO/g) ?? []).length, 3, "description, og:description and twitter:description");

  // No beacon and no AirnodeHub recipe: the keepers and the agent API only.
  const { beacon: a, ...bareMainnet } = MAINNET;
  const { beacon: b, ...bareTestnet } = TESTNET;
  const bare = buildStatus(memoryStorage(), {}, NOW, [], { "arc-mainnet": bareMainnet, "arc-testnet": bareTestnet });
  assert.deepEqual(Object.keys(bare), ["service", "generatedAt", "notifier", "networks", "recentMessages"]);
  assert.ok(renderHtml(bare).includes('content="Live health of the D20DAO VRF keepers and agent API on Arc."'));
});

// ---------------------------------------------------------------------------------------------
// Budget and storage

test("subrequest budget: the beacon adds at most 13 to a run and 10 in the steady state, and a day of runs stays inside it", async () => {
  // Static worst case of one run: every RPC round falls back on both networks (3 rounds x 2 endpoints), a /health poll per
  // network, 3 Telegram sends, a full set of AirnodeHub probe tasks, and the beacon's worst case (see beaconWorstSubrequests).
  const chainAndAgent = Object.keys(NETWORKS).length * (3 * 2 + 1);
  const worst = chainAndAgent + LIMITS.telegramMaxSendsPerRun + LIMITS.probeMaxPerRun + beaconWorstSubrequests(NETWORKS);
  assert.equal(beaconWorstSubrequests(NETWORKS), 13);
  assert.equal(worst, 14 + 3 + 5 + 13);
  assert.ok(worst <= 50, `worst case ${worst}`);
  assert.equal(worst - LIMITS.probeMaxPerRun, 30, "once the AirnodeHub probes are retired");

  // A healthy day, one run a minute, for both networks: the two chain reads and two agent API polls the harness stands
  // in with make 6; the beacon adds 4 latest rounds, 4 earlier rounds and 2 registry batches, and one chain info a few times a day.
  const h = harness();
  const counts = [];
  for (let minute = 0; minute < 24 * 60; minute++) {
    const summary = await h.run(minute);
    counts.push(summary.subrequests);
    assert.equal(summary.messagesQueued, 0, `minute ${minute}`);
  }
  const info = h.world.calls.filter((c) => c.kind === "info").length;
  assert.equal(info, 4 + 4, "four chain infos at the start, then each relay once a day at its hour");
  assert.equal(Math.min(...counts), 4 + 2 + 10);
  assert.equal(Math.max(...counts), 4 + 2 + 10 + 1);
  assert.equal(counts.filter((c) => c === 4 + 2 + 10 + 1).length, info, "a chain info is the only variation");
  assert.equal(h.world.calls.filter((c) => c.kind === "latest").length, 4 * 24 * 60, "each relay is read once a run however many networks list it");
  assert.equal(h.world.calls.filter((c) => c.kind === "round").length, 4 * 24 * 60);
  assert.ok(Math.max(...counts) + 3 <= 50, "with three Telegram sends on top");

  // A beacon that is down costs less: no relay is fresh, so no earlier round is read.
  all(h, { status: 503 });
  const outage = await h.run(24 * 60);
  assert.equal(outage.subrequests, 4 + 2 + (4 + 2), "four latest reads and two registry batches");
  // Relays up and every registry endpoint failing: two more batches, and the earlier rounds are read again.
  all(h, { status: undefined });
  for (const registry of Object.values(h.registries)) registry.down = 503;
  const failing = await h.run(24 * 60 + 1);
  assert.equal(failing.subrequests, 4 + 2 + (4 + 4 + 2 * 2));
});

test("migrate creates the beacon state table on an existing database", () => {
  const storage = memoryStorage();
  storage.db.exec("DROP TABLE beacon_state");
  migrate(storage);
  migrate(storage); // idempotent
  const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  assert.ok(tables.includes("beacon_state"));
  assert.deepEqual(storage.db.prepare("SELECT name FROM pragma_table_info('beacon_state') ORDER BY cid").all().map((c) => c.name), ["state_key", "updated_at", "state_json"]);
});

test("the beacon keeps three rows a run: one for its relays and one for each network", async () => {
  const h = harness();
  await h.run(0);
  const before = h.storage.db.prepare("SELECT COUNT(*) AS n FROM beacon_state").get().n;
  assert.equal(before, 3);
  assert.equal(THRESHOLDS.beaconRelayWarnRuns, 3);
  await h.run(1);
  assert.equal(h.storage.db.prepare("SELECT COUNT(*) AS n FROM beacon_state").get().n, 3, "rewritten, not added to");
});
