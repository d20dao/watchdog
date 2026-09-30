import assert from "node:assert/strict";
import { test } from "node:test";
import { beaconWorstSubrequests, currentRound, runBeacon } from "../src/beacon.js";
import { DRAND_RELAYS, LIMITS, NETWORKS, THRESHOLDS } from "../src/config.js";
import { runCron } from "../src/cron.js";
import { RpcSession } from "../src/rpc.js";
import { buildStatus, renderHtml } from "../src/status.js";
import { migrate, readAlerts, readBeaconStates, readChainState, writeBeaconState, writeProbeState } from "../src/store.js";
import {
  DRAND_ONLY_CATALOG,
  NOW,
  PRE_SWITCH_CATALOG,
  PRESET,
  UNPINNED,
  VERIFIER,
  ZERO_BEACON,
  acceptsReal,
  beaconFetch,
  drandWorld,
  registeredBeacon,
  registryOf,
  roundRecord,
  slotSignerFor,
  withVerifier,
} from "./beacon-helpers.js";
import { MAINNET, TESTNET, agentApiPoll, healthyRead, memoryStorage, pageText } from "./helpers.js";

// Runs of the whole watchdog with the real drand beacon monitor against a fake drand network and fake registries:
// the alerts it raises, what the status shows and what it costs. Each `run(minutes)` is one run that many minutes after NOW,
// the second after round 21056968 was due; the chain reads, the agent APIs and Telegram are healthy or recorded.
// The catalog in force is the registry's: PRE_SWITCH_CATALOG until a test sets another. How serious an outage is follows it.

const TELEGRAM = { TELEGRAM_BOT_TOKEN: "123456:throwaway-token", TELEGRAM_CHAT_ID: "-1001234567890" };
const HOSTS = DRAND_RELAYS.map((url) => new URL(url).host);
const [API, API2, API3, CLOUDFLARE] = HOSTS;

// An AirnodeHub recipe that is configured but never due, so no probe is made. It is made up here rather than taken from
// AIRNODE_RECIPES: those go when the probes are retired, and these tests stay. The AirnodeHub section of the status is the
// only thing it changes: the alarm's level comes from the registry's catalog, not from this list.
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

/**
 * `catalog` is what both registries' catalogAt answers. The first run of a real watchdog only reads the epoch, and the catalog of
 * that epoch on the next; the epoch of a run before is stored here, so the catalog is read from the first run on
 * (`seedEpoch: false` leaves the states empty). `recipes: [AIRNODE]` configures an AirnodeHub recipe, which the beacon does not
 * look at. `state.cut` is a set of what the watchdog's network cannot reach: "relays" and/or "rpc". `networks` are the networks watched
 * (`state.networks`, changeable between runs): UNPINNED by default, the configured ones with no verifier pinned, since the fake registries
 * report a made-up verifier whatever the configuration pins.
 */
function harness({ recipes = [], env = TELEGRAM, networks, catalog = PRE_SWITCH_CATALOG, seedEpoch = true } = {}) {
  const storage = memoryStorage();
  if (recipes.length > 0) withAirnodeConfigured(storage);
  const world = drandWorld({ now: NOW });
  const registries = Object.fromEntries(Object.values(NETWORKS).map((net) => [net.name, registryOf(net)]));
  for (const registry of Object.values(registries)) registry.catalog = catalog;
  if (seedEpoch) {
    for (const name of Object.keys(NETWORKS)) {
      writeBeaconState(storage, `network:${name}`, NOW - 60, { recipe: 11, epoch: { id: 5, block: 1000, checkedAt: NOW - 60 } });
    }
  }
  const telegram = [];
  const cut = new Set();
  const beacon = beaconFetch(world, registries, {
    telegram: async (url, init) => {
      telegram.push(JSON.parse(init.body));
      return new Response("{}");
    },
  });
  const fetch = async (url, init) => {
    const relay = new URL(url).host in world.relays;
    if (cut.has(relay ? "relays" : "rpc") && !url.startsWith("https://api.telegram.org/")) throw new TypeError("fetch failed");
    return beacon.fetch(url, init);
  };
  const state = { recipes, networks, cut, runBeaconImpl: undefined, readChainImpl: async (net) => healthyRead(net) };
  const run = (minutes) => {
    world.now = NOW + Math.round(minutes * 60);
    return runCron({
      storage,
      env,
      fetch,
      clock: () => world.now * 1000,
      readChainImpl: (net, cursor, deps) => state.readChainImpl(net, cursor, deps),
      readAgentApiImpl: async (net) => agentApiPoll({}, net),
      runBeaconImpl: state.runBeaconImpl,
      networks: state.networks ?? UNPINNED,
      recipes: state.recipes,
    });
  };
  const texts = () => telegram.flatMap((m) => m.text.split("\n\n"));
  const status = (minutes = 0) => buildStatus(storage, env, NOW + minutes * 60, state.recipes, state.networks ?? UNPINNED);
  const setCatalog = (value) => {
    for (const registry of Object.values(registries)) registry.catalog = value;
  };
  const register = () => {
    for (const registry of Object.values(registries)) registry.beaconOf = registeredBeacon();
  };
  return { storage, world, registries, rpcCalls: beacon.rpcCalls, telegram, state, run, texts, status, setCatalog, register };
}

const beaconAlerts = (h) => readAlerts(h.storage, "beacon").map((a) => a.check).sort();
const all = (h, edit) => HOSTS.forEach((host) => Object.assign(h.world.relays[host], edit));
const reasonsOf = (what) => HOSTS.map((host) => `${host}: ${what}`).join(", ");
const short = (hex) => `${hex.slice(0, 10)}...${hex.slice(-4)}`;

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
  assert.deepEqual(status.beacon.networks["arc-mainnet"].verification, {
    status: "not verified",
    lastOutcome: "skipped",
    round: null,
    rejectedRound: null,
    reason: "beacon not registered",
    consecutiveRejections: 0,
    lastOkAt: null,
    lastOkAgeSeconds: null,
  });
  assert.deepEqual(
    [status.beacon.networks["arc-mainnet"].catalog.use, status.beacon.networks["arc-mainnet"].catalog.recipes, status.beacon.catalogDrandOnly],
    ["none", [0, 1, 2, 3], false],
  );
  assert.deepEqual(status.beacon.relays.map((r) => r.status), ["ok", "ok", "ok", "ok"]);
  assert.ok(pageText(renderHtml(status)).includes("Registry · arc-mainnet Not registered yet recipe 11 · catalog: no drand · checked 1m ago"));
});

test("before the switch an outage is a warning, whatever else is configured: no catalog in force lists the beacon, so nothing depends on it", async () => {
  const h = harness({ recipes: [AIRNODE] });
  await h.run(0);
  all(h, { status: 503 });
  await h.run(1);
  assert.deepEqual(h.texts(), [], "one run without a fresh relay is not enough");
  await h.run(2);
  assert.deepEqual(h.texts(), [
    `[beacon] WARNING drand beacon down: no relay serves a fresh round (${reasonsOf("http 503")}); no catalog in force lists the drand beacon yet, so nothing depends on it`,
  ]);
  assert.equal(readAlerts(h.storage, "beacon")[0].severity, "warning");
  for (const minute of [3, 40, 90]) await h.run(minute);
  assert.equal(h.texts().length, 1, "a warning is not repeated");
  assert.equal(h.status(90).beacon.chains[0].status, "warning");
  all(h, { status: undefined });
  await h.run(91);
  assert.match(h.texts()[1], /^\[beacon\] RESOLVED drand beacon down after 89 min$/);
});

test("no relay serves a fresh round: an alarm after two runs in a row, a service-stopping one when the catalog in force is the beacon alone", async () => {
  const h = harness({ catalog: DRAND_ONLY_CATALOG });
  h.register();
  await h.run(0);
  all(h, { status: 503 });
  await h.run(1);
  assert.deepEqual(h.texts(), [], "one run without a fresh relay is not enough");
  await h.run(2);
  assert.deepEqual(h.texts(), [
    `[beacon] ALARM drand beacon down, service stopping: no relay serves a fresh round (${reasonsOf("http 503")}); ` +
      "the catalog in force on arc-mainnet and arc-testnet lists only the drand beacon, so epoch publication stops there and requests cannot be served until one does",
  ]);
  assert.equal(readAlerts(h.storage, "beacon")[0].severity, "alarm");
  assert.equal(h.status(2).beacon.catalogDrandOnly, true);
  assert.equal(h.status(2).beacon.chains[0].status, "alarm");

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

test("how serious an outage is comes from the catalog in force on the chain, not from what the watchdog has configured", async () => {
  // A catalog that lists the beacon among other sources: the epochs that select it cannot publish.
  const mixed = harness({ catalog: { recipes: [0, 1, 11] } });
  mixed.register();
  await mixed.run(0);
  all(mixed, { status: 503 });
  await mixed.run(1);
  await mixed.run(2);
  assert.deepEqual(mixed.texts(), [
    `[beacon] ALARM drand beacon down: no relay serves a fresh round (${reasonsOf("http 503")}); ` +
      "epochs on arc-mainnet and arc-testnet that select the drand recipe cannot publish until one does",
  ]);

  // Only one network's catalog lists the beacon alone: the alarm names that network, and a catalog without it is no reason for one.
  const one = harness();
  one.registries["arc-testnet"].catalog = DRAND_ONLY_CATALOG;
  await one.run(0);
  all(one, { status: 503 });
  await one.run(1);
  await one.run(2);
  assert.deepEqual(one.texts(), [
    `[beacon] ALARM drand beacon down, service stopping: no relay serves a fresh round (${reasonsOf("http 503")}); ` +
      "the catalog in force on arc-testnet lists only the drand beacon, so epoch publication stops there and requests cannot be served until one does",
  ]);

  // The AirnodeHub recipes the watchdog still probes do not decide it: the chain's catalog does, in both directions.
  const stillProbed = harness({ recipes: [AIRNODE], catalog: DRAND_ONLY_CATALOG });
  await stillProbed.run(0);
  all(stillProbed, { status: 503 });
  await stillProbed.run(1);
  await stillProbed.run(2);
  assert.match(stillProbed.texts()[0], /^\[beacon\] ALARM drand beacon down, service stopping: /);
  const retired = harness({ recipes: [] });
  await retired.run(0);
  all(retired, { status: 503 });
  await retired.run(1);
  await retired.run(2);
  assert.match(retired.texts()[0], /^\[beacon\] WARNING drand beacon down: /);
});

test("a catalog that changes during an outage changes the alert's level: a rise is notified, a fall is silent", async () => {
  const h = harness();
  await h.run(0);
  all(h, { status: 503 });
  await h.run(1);
  await h.run(2);
  assert.match(h.texts()[0], /^\[beacon\] WARNING drand beacon down: no relay serves a fresh round/);
  assert.equal(readAlerts(h.storage, "beacon")[0].severity, "warning");

  // The catalog in force now lists the beacon alone: the same condition is an alarm, and it is sent.
  h.setCatalog(DRAND_ONLY_CATALOG);
  await h.run(3);
  assert.equal(h.texts().length, 2);
  assert.match(h.texts()[1], /^\[beacon\] ALARM drand beacon down, service stopping: no relay serves a fresh round/);
  const [row] = readAlerts(h.storage, "beacon");
  assert.deepEqual([row.severity, row.title, row.since], ["alarm", "drand beacon down, service stopping", NOW + 2 * 60], "the same alert, since the outage was raised");
  assert.equal(h.status(3).beacon.chains[0].status, "alarm");

  // Among other sources it is an alarm of its own kind, without another message inside the 30 minutes of the last one.
  h.setCatalog({ recipes: [0, 11] });
  await h.run(4);
  assert.equal(h.texts().length, 2);
  assert.equal(readAlerts(h.storage, "beacon")[0].title, "drand beacon down");
  // A catalog without it again: the level falls to a warning, silently. The recipes it lists have all been seen to be signed.
  h.setCatalog(PRE_SWITCH_CATALOG);
  await h.run(5);
  assert.equal(h.texts().length, 2, "a fall in level is not news");
  assert.equal(readAlerts(h.storage, "beacon")[0].severity, "warning");
  // And rises again: an alarm was sent 3 minutes ago, so not another inside 30 minutes; after that it repeats, as any alarm does.
  h.setCatalog(DRAND_ONLY_CATALOG);
  await h.run(6);
  assert.equal(readAlerts(h.storage, "beacon")[0].severity, "alarm");
  assert.equal(h.texts().length, 2);
  await h.run(40);
  assert.match(h.texts()[2], /^\[beacon\] ALARM drand beacon down, service stopping: .* \(active 38 min\)$/);
});

test("a catalog that cannot be read leaves an outage as serious as the beacon being registered makes it; before that it is a warning", async () => {
  const unread = harness({ catalog: "revert" });
  await unread.run(0);
  all(unread, { status: 503 });
  await unread.run(1);
  await unread.run(2);
  assert.match(unread.texts()[0], /^\[beacon\] WARNING drand beacon down: /, "the beacon is not registered: nothing can depend on it yet");
  assert.equal(unread.status(2).beacon.networks["arc-mainnet"].catalog, null);

  const registered = harness({ catalog: "revert" });
  registered.register();
  await registered.run(0);
  all(registered, { status: 503 });
  await registered.run(1);
  await registered.run(2);
  assert.match(registered.texts()[0], /^\[beacon\] ALARM drand beacon down: no relay serves a fresh round .*; epochs on arc-mainnet and arc-testnet that select the drand recipe cannot publish/);
  // Read at last, the catalog says it is not used: the alarm falls to a warning.
  registered.setCatalog(PRE_SWITCH_CATALOG);
  await registered.run(3);
  assert.equal(readAlerts(registered.storage, "beacon")[0].severity, "warning");
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

// The registry tells the relays apart: who is at fault when a signature is rejected. Both networks list the beacon.

test("three relays fail and the one fresh relay serves a wrong signature: it is warned about, and the registries are not blamed", async () => {
  const h = harness();
  h.register();
  await h.run(0);
  for (const host of [API, API2, API3]) h.world.relays[host].status = 503;
  h.world.relays[CLOUDFLARE].salt = "wrong";
  for (const minute of [1, 2, 3, 4]) await h.run(minute);
  const round = currentRound(PRESET, NOW + 60); // the warning is raised in the first run, and names what that run compared
  const wrong = roundRecord(round, "wrong").signature;
  const texts = h.texts();
  assert.ok(
    texts.includes(
      `[beacon] WARNING drand relay drand.cloudflare.com serves a signature the registry rejects: round ${round}: signature ${short(wrong)} is rejected by the arc-mainnet and arc-testnet registries and no other relay returned it`,
    ),
    texts.join("\n"),
  );
  assert.deepEqual(texts.filter((t) => t.includes("registry rejects drand rounds")), [], "no registry alarm, however long it lasts");
  assert.ok(!beaconAlerts(h).some((check) => check.startsWith("verify:")));
  assert.equal(h.status(4).beacon.relays[3].agreement.verdict, "rejected");
  // It serves the real signature again: the warning resolves.
  h.world.relays[CLOUDFLARE].salt = undefined;
  await h.run(5);
  assert.match(h.texts().at(-1), /^\[beacon\] RESOLVED drand relay drand\.cloudflare\.com serves a signature the registry rejects after 4 min$/);
});

test("two fresh relays and the honest one fails the earlier round: the registry is not blamed for the other's signature", async () => {
  const h = harness();
  h.register();
  await h.run(0);
  h.world.relays[API2].status = 503;
  h.world.relays[API3].status = 503;
  h.world.relays[API].roundStatus = 503;
  h.world.relays[CLOUDFLARE].salt = "wrong";
  for (const minute of [1, 2, 3]) await h.run(minute);
  assert.ok(h.texts().some((t) => t.startsWith("[beacon] WARNING drand relay drand.cloudflare.com serves a signature the registry rejects")));
  assert.ok(!h.texts().some((t) => t.includes("registry rejects drand rounds")));
  assert.deepEqual(beaconAlerts(h).filter((c) => c.startsWith("verify:")), []);
});

test("three relays agree on a bad signature and one honest relay serves the real one: the three are flagged, the registry is not blamed", async () => {
  const h = harness();
  h.register();
  await h.run(0);
  for (const host of [API, API2, API3]) h.world.relays[host].salt = "bad";
  await h.run(1);
  const round = currentRound(PRESET, h.world.now) - 1;
  const [bad, real] = [roundRecord(round, "bad").signature, roundRecord(round).signature];
  assert.deepEqual(
    h.texts(),
    HOSTS.slice(0, 3).map(
      (host) =>
        `[beacon] WARNING drand relay ${host} disagrees with the other relays: round ${round}: signature ${short(bad)} differs from ${short(real)}, ` +
        "which 1 relay returned and the arc-mainnet and arc-testnet registries accept",
    ),
  );
  for (const minute of [2, 3]) await h.run(minute);
  assert.equal(h.texts().length, 3, "warnings never repeat");
  assert.deepEqual(beaconAlerts(h), HOSTS.slice(0, 3).map((host) => `agree:drand-evmnet:${host}`).sort());
  assert.ok(!h.texts().some((t) => t.includes("registry rejects drand rounds")));
  assert.equal(h.status(3).beacon.networks["arc-mainnet"].verification.status, "ok", "the registry accepted the round's signature");
});

test("a registry that rejects what the other network's registry accepts is alarmed after two runs, whoever returned the signature", async () => {
  const h = harness();
  h.register();
  h.registries["arc-mainnet"].verify = () => false; // rejects the real signature too
  await h.run(0);
  assert.deepEqual(h.texts(), [], "one rejection is not enough");
  await h.run(1);
  const round = currentRound(PRESET, h.world.now) - 1;
  assert.deepEqual(h.texts(), [
    `[beacon] ALARM arc-mainnet registry rejects drand rounds: verifyBeacon(11) rejected round ${round} in 2 consecutive runs ` +
      "(verifyBeacon returned false for the signature 4 of 4 relays returned; the arc-testnet registry accepts it): the registry cannot verify a real round",
  ]);
  assert.deepEqual(beaconAlerts(h), ["verify:arc-mainnet"]);
});

// The recipe monitored, from the chain.

test("a recipe that exists but is no beacon raises a distinct warning; one that reverts stays silent as it did", async () => {
  const h = harness();
  const mainnet = h.registries["arc-mainnet"];
  mainnet.beaconOf = ZERO_BEACON; // recipe 11 exists on this registry, as a signed recipe; the testnet one reverts
  await h.run(0);
  assert.deepEqual(h.texts(), ["[beacon] WARNING arc-mainnet registry beacon recipe misconfigured: recipe 11 exists but is not a beacon; check the configured id"]);
  assert.equal(h.status(0).beacon.networks["arc-mainnet"].registration, "not a beacon");
  assert.equal(h.status(0).beacon.networks["arc-testnet"].registration, "not registered yet");
  assert.ok(pageText(renderHtml(h.status(0))).includes("Registry · arc-mainnet Not a beacon"));
  await h.run(1);
  assert.equal(h.texts().length, 1, "a warning is not repeated");
  mainnet.beaconOf = registeredBeacon(); // registered as 11 after all
  await h.run(2);
  assert.equal(h.texts()[1], "[beacon] RESOLVED arc-mainnet registry beacon recipe misconfigured after 2 min");
  assert.deepEqual(beaconAlerts(h), []);
});

test("the beacon registered under another recipe than the configured one is followed once the catalog in force lists it", async () => {
  const h = harness({ catalog: { recipes: [12] } });
  const mainnet = h.registries["arc-mainnet"];
  mainnet.beaconOf = ZERO_BEACON; // the configured recipe 11 is a signed recipe
  mainnet.beacons[12] = registeredBeacon(); // the beacon is recipe 12, and the catalog in force lists it
  await h.run(0);
  assert.equal(h.texts().length, 1, "the configured id is not the beacon, as far as the first run knows");
  assert.match(h.texts()[0], /^\[beacon\] WARNING arc-mainnet registry beacon recipe misconfigured: recipe 11 exists but is not a beacon/);
  await h.run(1);
  assert.equal(h.texts()[1], "[beacon] RESOLVED arc-mainnet registry beacon recipe misconfigured after 1 min", "the next run has asked about 12, which is the beacon");
  await h.run(2);
  const network = h.status(2).beacon.networks["arc-mainnet"];
  assert.deepEqual([network.recipe, network.configuredRecipe, network.registration, network.catalog.use, network.verification.status], [12, 11, "registered", "only", "ok"]);
  assert.equal(network.slotSigner, slotSignerFor(registeredBeacon()), "read from the recipe followed");
  assert.equal(h.status(2).beacon.catalogDrandOnly, true);
  assert.ok(mainnet.calls.slice(-6).every((c) => c.recipe === undefined || c.recipe === 12 || (c.method === "beaconOf" && c.recipe === 11)));

  // Its outage is the service-stopping one on the network whose catalog lists it alone.
  all(h, { status: 503 });
  await h.run(3);
  await h.run(4);
  assert.match(h.texts().at(-1), /^\[beacon\] ALARM drand beacon down, service stopping: .*the catalog in force on arc-mainnet lists only the drand beacon/);
  // And a registry rejecting its rounds is named with that recipe.
  all(h, { status: undefined });
  mainnet.verify = () => false;
  await h.run(5);
  await h.run(6);
  assert.match(h.texts().at(-1), /^\[beacon\] ALARM arc-mainnet registry rejects drand rounds: verifyBeacon\(12\) rejected round /);
});

test("a followed recipe whose beaconOf reverts in one run only is still followed: one revert is a node that is behind", async () => {
  const h = harness({ catalog: { recipes: [12] } });
  const mainnet = h.registries["arc-mainnet"];
  mainnet.beaconOf = ZERO_BEACON;
  mainnet.beacons[12] = registeredBeacon();
  for (const minute of [0, 1, 2]) await h.run(minute); // followed from the second run
  const sent = h.texts().length;
  const network = (minute) => h.status(minute).beacon.networks["arc-mainnet"];
  mainnet.beacons[12] = "revert";
  await h.run(3);
  assert.equal(h.texts().length, sent, "no warning about recipe 11, which is a signed recipe, and none about a lost registration");
  assert.deepEqual([network(3).recipe, network(3).registration], [12, "registered"]);
  mainnet.beacons[12] = registeredBeacon();
  await h.run(4);
  assert.equal(h.texts().length, sent);
  // Two in a row is a lost registration, of the recipe followed.
  mainnet.beacons[12] = "revert";
  await h.run(5);
  assert.equal(h.texts().length, sent);
  await h.run(6);
  assert.equal(h.texts().at(-1), "[beacon] WARNING arc-mainnet registry beacon no longer registered: beaconOf reverted; the beacon was registered before");
  assert.equal(network(6).recipe, 12);
});

test("the catalog in force is read from the run in which its epoch starts: a switch is no later than that run", async () => {
  const h = harness();
  h.register();
  h.registries["arc-mainnet"].catalog = (epoch) => (epoch >= 6 ? DRAND_ONLY_CATALOG : PRE_SWITCH_CATALOG);
  h.registries["arc-testnet"].catalog = DRAND_ONLY_CATALOG;
  const at = (number) => async (net) => healthyRead(net, { block: { number, timestamp: 1789420000, baseFeeWei: 10n ** 9n } });
  h.state.readChainImpl = at(1000); // epoch 5: the head's block / 200
  await h.run(0);
  all(h, { status: 503 });
  await h.run(1);
  await h.run(2);
  assert.match(h.texts().at(-1), /^\[beacon\] ALARM drand beacon down, service stopping: .*the catalog in force on arc-testnet lists only/, "mainnet is still on the old catalog");
  const sent = h.texts().length;
  h.state.readChainImpl = at(1200); // epoch 6 starts here
  await h.run(3);
  assert.equal(h.status(3).beacon.networks["arc-mainnet"].catalog.epochId, 6);
  assert.equal(readAlerts(h.storage, "beacon")[0].title, "drand beacon down, service stopping");
  assert.match(readAlerts(h.storage, "beacon")[0].detail, /the catalog in force on arc-mainnet and arc-testnet lists only/);
  assert.equal(h.texts().length, sent, "an alarm of the same level inside 30 minutes is not sent again, whichever networks it names");
});

// The registered verifier must reject a signature that is not one.

test("a registered verifier that accepts a signature it should not raises an alarm at once, and resolves when it rejects it again", async () => {
  const h = harness();
  const mainnet = h.registries["arc-mainnet"];
  mainnet.beaconOf = registeredBeacon();
  await h.run(0);
  assert.deepEqual(h.texts(), []);
  mainnet.verify = true; // accepts everything, the real round's signature and a forged one alike
  await h.run(1);
  const round = currentRound(PRESET, h.world.now) - 1;
  assert.deepEqual(h.texts(), [
    `[beacon] ALARM arc-mainnet registered verifier accepts an invalid signature: verifyBeacon(11) returned true for round ${round} with the last byte of its signature flipped: verifier ${VERIFIER} would accept a forged round`,
  ]);
  const check = h.status(1).beacon.networks["arc-mainnet"].invalidSignatureCheck;
  assert.deepEqual([check.status, check.lastOutcome, check.round], ["alarm", "accepted", round]);
  assert.match(pageText(renderHtml(h.status(1))), /Registry · arc-mainnet Registered recipe 11 · .*verifier accepts an invalid signature/);
  // A run that cannot check leaves it; one that has the flipped signature rejected clears it.
  all(h, { status: 503 });
  await h.run(2);
  assert.deepEqual(beaconAlerts(h).filter((c) => c.startsWith("verifier:")), ["verifier:arc-mainnet"]);
  all(h, { status: undefined });
  mainnet.verify = acceptsReal;
  await h.run(3);
  assert.equal(h.texts().at(-1), "[beacon] RESOLVED arc-mainnet registered verifier accepts an invalid signature after 2 min");
  assert.deepEqual(beaconAlerts(h), []);
});

// The registration lost, one run or two.

test("chain info that differs from the configured beacon warns when read, is read again within the hour, and resolves at the next matching read", async () => {
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
  const infoReads = () => h.world.calls.filter((c) => c.kind === "info").map((c) => c.host);
  assert.deepEqual(HOSTS.map((host) => info(host).outcome), ["ok", "ok", "drift", "ok"]);
  assert.deepEqual(infoReads(), HOSTS);

  // The relay whose chain info differed is read again within the hour, not a day later; the others each at their own hour of
  // the day (relay j of 4 at second j x 21600 of the UTC day).
  const drifted = NOW + 2 * 60;
  assert.equal(info(API3).nextCheckAt, drifted + LIMITS.beaconInfoRetrySeconds);
  assert.equal(info(CLOUDFLARE).nextCheckAt % 86400, 3 * 21600);
  assert.ok(info(CLOUDFLARE).nextCheckAt > NOW + 3 * 3600, "hours away");
  await h.run(61);
  assert.deepEqual(infoReads(), HOSTS, "not before the hour is up");
  // Still different: read again, and again an hour later. A failed read keeps the finding and is repeated within the hour.
  await h.run(62);
  assert.deepEqual(infoReads().slice(4), [API3]);
  assert.equal(info(API3).nextCheckAt, NOW + 62 * 60 + LIMITS.beaconInfoRetrySeconds);
  h.world.relays[API3].infoStatus = 500;
  await h.run(122);
  assert.equal(info(API3).outcome, "failure");
  assert.equal(info(API3).verdict, "drift");
  assert.equal(info(API3).nextCheckAt, NOW + 122 * 60 + LIMITS.beaconInfoRetrySeconds);
  assert.equal(h.texts().length, 1, "a difference that lasts, or a failed read, neither repeats nor resolves");
  // Fixed: the next read matches, and the relay goes back to its own hour of the day.
  h.world.relays[API3].infoStatus = undefined;
  h.world.relays[API3].info = undefined;
  await h.run(182);
  assert.match(h.texts()[1], /^\[beacon\] RESOLVED drand relay api3\.drand\.sh chain info differs from the configured beacon after 180 min$/);
  assert.equal(info(API3).nextCheckAt % 86400, 2 * 21600);
  assert.deepEqual(beaconAlerts(h), []);
});

test("registration: as configured raises nothing, a mismatch warns until it is fixed, losing it warns after two runs, an unreadable registry changes nothing", async () => {
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

  // One revert is a node that is behind, or a rollback undone: what was known stands, and nothing is raised.
  mainnet.beaconOf = "revert";
  await h.run(5);
  assert.equal(h.texts().length, 2);
  assert.equal(h.status(5).beacon.networks["arc-mainnet"].registration, "registered");
  mainnet.beaconOf = registeredBeacon();
  await h.run(6);
  mainnet.beaconOf = "revert";
  await h.run(7);
  assert.equal(h.texts().length, 2, "and the count starts over when it is registered in between");

  // Two runs in a row is a rollback of the registry: it no longer lists the beacon it once listed.
  await h.run(8);
  assert.equal(h.texts()[2], "[beacon] WARNING arc-mainnet registry beacon no longer registered: beaconOf reverted; the beacon was registered before");
  assert.equal(h.status(8).beacon.networks["arc-mainnet"].registration, "no longer registered");

  // An answer that is no answer changes nothing, neither resolving nor repeating.
  mainnet.error = { code: -32005, message: "rate limit" };
  await h.run(9);
  assert.equal(h.texts().length, 3);
  assert.deepEqual(beaconAlerts(h), ["registration:arc-mainnet"]);
  const unread = h.status(9).beacon.networks["arc-mainnet"];
  assert.deepEqual([unread.registration, unread.reason], ["no longer registered", "not read: beaconOf: rpc error -32005"]);
  delete mainnet.error;
  mainnet.beaconOf = registeredBeacon({ verifier: "0x" + "cd".repeat(20) });
  mainnet.slotSigner = slotSignerFor(registeredBeacon({ verifier: "0x" + "cd".repeat(20) }));
  await h.run(10);
  assert.deepEqual(h.texts().slice(3), ["[beacon] RESOLVED arc-mainnet registry beacon no longer registered after 2 min"], "any verifier is accepted while the configuration names none");
  assert.deepEqual(beaconAlerts(h), []);
});

test("a verifier the configuration pins and the registry does not report is a registration mismatch on that network alone, warned until it is fixed", async () => {
  // Both registries report VERIFIER. arc-testnet pins another verifier, as a network does once its verifier is deployed; arc-mainnet pins none.
  const pinned = "0x" + "12".repeat(20);
  const h = harness({ networks: { ...UNPINNED, "arc-testnet": withVerifier(TESTNET, pinned) } });
  h.register();
  await h.run(0);
  assert.deepEqual(h.texts(), [
    "[beacon] WARNING arc-testnet registry beacon registration mismatch: beaconOf(11) differs from the configured drand-evmnet beacon: " +
      `verifier ${VERIFIER} (expected ${pinned}); slotSigner ${slotSignerFor(registeredBeacon())} (expected ${slotSignerFor(registeredBeacon({ verifier: pinned }))})`,
  ]);
  await h.run(1);
  assert.equal(h.texts().length, 1, "warnings never repeat");
  assert.deepEqual(beaconAlerts(h), ["registration:arc-testnet"]);
  const { "arc-mainnet": mainnet, "arc-testnet": testnet } = h.status(1).beacon.networks;
  assert.deepEqual([testnet.registration, testnet.verifier, testnet.expectedVerifier], ["mismatch", VERIFIER, pinned]);
  assert.deepEqual([mainnet.registration, mainnet.verifier, mainnet.expectedVerifier], ["registered", VERIFIER, null], "the same verifier where none is pinned is no finding");
  assert.equal(testnet.verification.status, "ok", "the round still verifies: a mismatch is a finding of its own");

  // The registry reports the pinned verifier, and the slot signer derived from it: the warning resolves.
  h.registries["arc-testnet"].beaconOf = registeredBeacon({ verifier: pinned });
  await h.run(2);
  assert.equal(h.texts()[1], "[beacon] RESOLVED arc-testnet registry beacon registration mismatch after 2 min");
  assert.equal(h.status(2).beacon.networks["arc-testnet"].registration, "registered");
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

  // The relays fail for a run: nothing is verified, the alarm neither resolves nor changes. The status still says which round
  // was rejected, though the last run rejected none.
  all(h, { status: 503 });
  await h.run(3);
  assert.equal(h.texts().length, 1);
  assert.equal(readAlerts(h.storage, "beacon").find((a) => a.check === "verify:arc-mainnet").detail.includes(`round ${round} in 2`), true);
  const idle = h.status(3).beacon.networks["arc-mainnet"].verification;
  assert.deepEqual([idle.status, idle.round, idle.rejectedRound, idle.lastOutcome], ["alarm", null, round, "skipped"]);
  const caption = pageText(renderHtml(h.status(3)));
  assert.ok(caption.includes(`round #${round} rejected`), "the caption names the round that was rejected");
  assert.ok(!caption.includes("round #null"));
  all(h, { status: undefined });
  h.registries["arc-mainnet"].verify = acceptsReal;
  await h.run(4);
  assert.equal(h.texts().at(-1), "[beacon] RESOLVED arc-mainnet registry rejects drand rounds after 2 min");
  assert.deepEqual(beaconAlerts(h), []);

  // The registry is fine while the relays are split: it is asked which is right, and when it rejects both nothing is blamed on it.
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
  h.state.networks = Object.fromEntries(Object.entries(UNPINNED).map(([name, net]) => [name, { ...net, beacon: { ...net.beacon, relays: net.beacon.relays.filter(fewer) } }]));
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
    "[beacon] RESOLVED drand beacon down after 1 min",
  ]);
  assert.deepEqual([...readBeaconStates(h.storage).keys()], []);
  assert.deepEqual([summary.beacon.relays, summary.beacon.networks], [[], []]);
  assert.equal("beacon" in h.status(5), false);
  assert.equal(pageText(renderHtml(h.status(5))).includes("drand beacon"), false);
});

// The monitor failing, and the watchdog's own network: neither reads as a drand outage.

test("a monitor that fails as a whole leaves every relay unknown, not down, raises its own warning and never stops the run", async () => {
  const h = harness({ catalog: DRAND_ONLY_CATALOG });
  await h.run(0);
  h.state.runBeaconImpl = async () => {
    throw new Error("boom: SECRET-DETAIL");
  };
  for (const minute of [1, 2, 3]) {
    const summary = await h.run(minute);
    assert.deepEqual(summary.beacon.networks.map((n) => n.read), [false, false]);
  }
  // No outage is raised, however many runs: nothing was learned about the relays.
  assert.deepEqual(h.texts(), [
    "[beacon] WARNING drand monitor failed internally: the drand-evmnet relay reads, the arc-mainnet registry read and the arc-testnet registry read failed on an " +
      "error in the watchdog itself, not in a relay or a registry; what it could not check is unknown until it runs again",
  ]);
  assert.ok(!JSON.stringify(h.telegram).includes("SECRET"), "an error's text never reaches a message");
  assert.deepEqual(beaconAlerts(h), ["monitor"]);
  const group = readBeaconStates(h.storage).get("group:drand-evmnet");
  assert.deepEqual([group.downRuns, group.fresh, group.monitor.reason], [0, 4, "internal error"]);
  assert.ok(Object.values(group.relays).every((r) => r.badRuns === 0 && r.outcome === "unknown"));
  const status = h.status(3);
  assert.deepEqual(status.beacon.relays.map((r) => r.status), ["unknown", "unknown", "unknown", "unknown"]);
  assert.equal(status.beacon.chains[0].status, "ok", "what was last known stands");
  assert.equal((await h.run(4)).subrequests, 4 + 2, "no relay or registry was reached: only the chain reads and the agent API polls");

  // Working again: the warning resolves.
  h.state.runBeaconImpl = undefined;
  await h.run(5);
  assert.equal(h.texts()[1], "[beacon] RESOLVED drand monitor failed internally after 4 min");
  assert.deepEqual(beaconAlerts(h), []);
});

test("a registry read that fails on an error of the monitor's own names that registry, and leaves the relays and the other registry alone", async () => {
  const h = harness({ catalog: DRAND_ONLY_CATALOG });
  h.register();
  h.state.runBeaconImpl = (plan, deps) =>
    runBeacon(plan, {
      ...deps,
      createSession: (net) => {
        if (net.name === "arc-testnet") throw new Error("boom");
        return new RpcSession(net.rpcs, { fetch: deps.fetch });
      },
    });
  for (const minute of [0, 1, 2]) await h.run(minute);
  assert.deepEqual(h.texts(), [
    "[beacon] WARNING drand monitor failed internally: the arc-testnet registry read failed on an error in the watchdog itself, not in a relay or a registry; " +
      "what it could not check is unknown until it runs again",
  ]);
  const group = readBeaconStates(h.storage).get("group:drand-evmnet");
  assert.deepEqual([group.monitor, group.fresh, group.downRuns], [null, 4, 0], "the relay reads were fine");
  assert.equal(readBeaconStates(h.storage).get("network:arc-mainnet").monitor, null);
  assert.equal(readBeaconStates(h.storage).get("network:arc-mainnet").verify.outcome, "ok", "the other registry was read and verified");
  // The registry that failed is unknown, not down or unregistered: nothing is said about it until it can be read.
  assert.equal(h.status(2).beacon.networks["arc-testnet"].registration, "unknown");
  h.state.runBeaconImpl = undefined;
  await h.run(3);
  assert.equal(h.texts()[1], "[beacon] RESOLVED drand monitor failed internally after 3 min");
});

test("a monitor that has never run to the end shows its beacon as unknown on the status, not as fresh or down", async () => {
  const h = harness({ seedEpoch: false });
  h.state.runBeaconImpl = async () => {
    throw new Error("boom");
  };
  await h.run(0);
  const status = h.status(0);
  assert.deepEqual([status.beacon.chains[0].status, status.beacon.chains[0].freshRelays, status.beacon.chains[0].consecutiveRunsWithoutFreshRelay], ["unknown", null, 0]);
  assert.deepEqual(status.beacon.relays.map((r) => [r.status, r.lastOutcome, r.reason]), HOSTS.map(() => ["unknown", "unknown", "internal error"]));
  assert.deepEqual(Object.values(status.beacon.networks).map((n) => n.registration), ["unknown", "unknown"]);
  const text = pageText(renderHtml(status));
  assert.ok(text.includes("Relays fresh — not known: the monitor failed"));
  assert.ok(text.includes("api.drand.sh drand-evmnet UNKNOWN — — never — · info — internal error"));
  assert.ok(!text.includes("null"));
  assert.deepEqual(beaconAlerts(h), ["monitor"]);
});

test("every relay unreachable is the relays' outage only when the watchdog's own network is shown to work", async () => {
  const h = harness({ catalog: DRAND_ONLY_CATALOG });
  h.register();
  await h.run(0);
  // Nothing at all can be reached: the relays, and the registries the run reads too. That may be the watchdog's own network.
  h.state.cut.add("relays");
  h.state.cut.add("rpc");
  for (const minute of [1, 2, 3, 4, 5]) await h.run(minute);
  assert.deepEqual(h.texts(), []);
  assert.deepEqual(beaconAlerts(h), []);
  let group = readBeaconStates(h.storage).get("group:drand-evmnet");
  assert.deepEqual([group.downRuns, group.fresh, group.relays[API].badRuns, group.relays[API].outcome], [0, 4, 0, "unknown"]);
  assert.equal(group.relays[API].reason, "network error, and no registry answered either");
  assert.equal(group.monitor, null, "no fault of the monitor's own");
  assert.equal(h.status(5).beacon.relays[0].status, "unknown");
  assert.ok(pageText(renderHtml(h.status(5))).includes("network error, and no registry answered either"));

  // The registries answer: the watchdog's network works, so the relays are down, and that alarms after two runs.
  h.state.cut.delete("rpc");
  await h.run(6);
  assert.deepEqual(h.texts(), [], "one run without a fresh relay is not enough");
  await h.run(7);
  assert.deepEqual(h.texts(), [
    `[beacon] ALARM drand beacon down, service stopping: no relay serves a fresh round (${reasonsOf("network error")}); ` +
      "the catalog in force on arc-mainnet and arc-testnet lists only the drand beacon, so epoch publication stops there and requests cannot be served until one does",
  ]);
  group = readBeaconStates(h.storage).get("group:drand-evmnet");
  assert.deepEqual([group.downRuns, group.fresh], [2, 0]);
});

// A fault in the beacon stays in the beacon.

test("a beacon run that cannot be recorded raises the monitor's warning and leaves the rest of the run, and the beacon's rows, as they were", async () => {
  const h = harness({ catalog: DRAND_ONLY_CATALOG });
  await h.run(0);
  all(h, { status: 503 });
  await h.run(1);
  await h.run(2);
  assert.equal(h.texts().length, 1, "the outage alarm");
  const before = JSON.stringify([...readBeaconStates(h.storage)]);

  // The monitor answers with something that does not match the plan: recording it throws inside the run's transaction. The chain
  // reads of the same run must still be stored, and their alerts raised.
  h.state.runBeaconImpl = async () => ({ subrequests: 0, groups: [] });
  h.state.readChainImpl = async (net) => healthyRead(net, { balanceWei: 10n ** 18n });
  const summary = await h.run(3);
  assert.equal(summary.beacon.error, "internal error");
  assert.ok(summary.networks["arc-mainnet"].activeAlerts.includes("balance"), "the chain alerts of the run are committed");
  assert.notEqual(readChainState(h.storage, "arc-mainnet"), null);
  assert.equal(readChainState(h.storage, "arc-mainnet").checkedAt, NOW + 3 * 60);
  const texts = h.texts();
  assert.ok(texts.some((t) => t.startsWith("[arc-mainnet] ALARM keeper balance low")));
  assert.ok(
    texts.includes("[beacon] WARNING drand monitor failed internally: the beacon's results could not be worked out or recorded this run; what it could not check is unknown until it runs again"),
  );
  assert.equal(JSON.stringify([...readBeaconStates(h.storage)]), before, "nothing of the beacon was rewritten");
  assert.deepEqual(beaconAlerts(h), ["fresh:drand-evmnet", "monitor"], "the outage alarm is neither resolved nor lost");
  await h.run(4);
  assert.equal(h.texts().length, texts.length + 0, "warnings are not repeated");

  // Recorded again: its own warning resolves, and the outage carries on.
  h.state.runBeaconImpl = undefined;
  await h.run(5);
  assert.match(h.texts().at(-1), /^\[beacon\] RESOLVED drand monitor failed internally after 2 min$/);
  assert.deepEqual(beaconAlerts(h), ["fresh:drand-evmnet"]);
});

test("a beacon that cannot be planned leaves the run without the beacon, not without the rest: nothing is deleted and nothing resolved", async () => {
  const h = harness({ catalog: DRAND_ONLY_CATALOG });
  await h.run(0);
  all(h, { status: 503 });
  await h.run(1);
  await h.run(2);
  const before = JSON.stringify([...readBeaconStates(h.storage)]);
  // A beacon block that cannot be read (its relays are no list): planning throws before anything is fetched.
  h.state.networks = { ...UNPINNED, "arc-mainnet": { ...UNPINNED["arc-mainnet"], beacon: { ...UNPINNED["arc-mainnet"].beacon, relays: 5 } } };
  h.state.readChainImpl = async (net) => healthyRead(net, { balanceWei: 10n ** 18n });
  const calls = h.world.calls.length;
  const summary = await h.run(3);
  assert.equal(h.world.calls.length, calls, "no relay was read");
  assert.equal(summary.beacon.error, "internal error");
  assert.ok(summary.networks["arc-mainnet"].activeAlerts.includes("balance"));
  assert.ok(h.texts().some((t) => t.startsWith("[arc-mainnet] ALARM keeper balance low")));
  assert.match(h.texts().at(-1), /^\[beacon\] WARNING drand monitor failed internally: the beacon's results could not be worked out or recorded this run/);
  assert.equal(JSON.stringify([...readBeaconStates(h.storage)]), before);
  assert.deepEqual(beaconAlerts(h), ["fresh:drand-evmnet", "monitor"], "the alarm of the outage stays: a plan that failed is not a beacon that was removed");
  assert.equal(h.texts().filter((t) => t.includes("RESOLVED")).length, 0);
});

test("the registry batch of each network gets that network's head block from the run's own chain read", async () => {
  const h = harness();
  h.state.readChainImpl = async (net) => healthyRead(net, { block: { number: net.name === "arc-mainnet" ? 2400 : 1000, timestamp: 1789420000, baseFeeWei: 10n ** 9n } });
  await h.run(0);
  const blocks = (name) => h.registries[name].calls.filter((c) => c.method === "epochForBlock").map((c) => c.block);
  assert.deepEqual([blocks("arc-mainnet"), blocks("arc-testnet")], [[2400], [1000]]);
  // A network whose chain read failed has no head: the epoch is not read for it, and the rest of its batch is.
  h.state.readChainImpl = async (net) => (net.name === "arc-mainnet" ? { ok: false, complete: false, error: "http 503", errors: [], subrequests: 2 } : healthyRead(net));
  const before = blocks("arc-mainnet").length;
  const summary = await h.run(1);
  assert.equal(blocks("arc-mainnet").length, before);
  assert.equal(blocks("arc-testnet").length, 2);
  assert.deepEqual(summary.beacon.networks.map((n) => n.read), [true, true]);
  // The state kept the epoch of the run before: the catalog is asked about it.
  assert.equal(h.registries["arc-mainnet"].calls.at(-1).method, "catalogAt");
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
  const h = harness({ catalog: DRAND_ONLY_CATALOG });
  h.registries["arc-mainnet"].beaconOf = registeredBeacon({ period: 9 });
  h.world.relays[API2].status = 503;
  h.world.relays[API3].salt = "forked";
  for (let minute = 0; minute < 5; minute++) await h.run(minute);
  return h;
}

test("status JSON: the chain, each relay's last check, each network's registration and catalog, and the beacon's own alerts", async () => {
  const h = await troubled();
  const round = currentRound(PRESET, NOW + 4 * 60);
  const status = h.status(4);
  const beacon = status.beacon;
  assert.equal(beacon.catalogDrandOnly, true, "read from the chain's catalog");
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
  assert.equal(api3.agreement.verdict, "differs");
  assert.equal(api3.agreement.round, round - 1);
  assert.equal(cloudflare.agreement.status, "ok");
  assert.deepEqual([api.chainInfo.status, api.chainInfo.lastOutcome, api2.chainInfo.status, cloudflare.chainInfo.status], ["ok", "ok", "unknown", "ok"]);
  assert.equal(api2.chainInfo.lastOutcome, "failure", "its /info answered 503 as well");
  assert.equal(api.chainInfo.nextCheckAt % 86400, 0, "relay 1 of 4 is read at the start of the day");

  const mainnet = beacon.networks["arc-mainnet"];
  assert.deepEqual([mainnet.registration, mainnet.recipe, mainnet.configuredRecipe, mainnet.registry, mainnet.verifier, mainnet.expectedVerifier], ["mismatch", 11, 11, MAINNET.registry, VERIFIER, null]);
  assert.match(mainnet.reason, /^beaconOf\(11\) differs from the configured drand-evmnet beacon: period 9 \(expected 3\); slotSigner /);
  assert.equal(mainnet.slotSigner, slotSignerFor(registeredBeacon({ period: 9 })));
  assert.deepEqual([mainnet.verification.status, mainnet.verification.round, mainnet.verification.rejectedRound, mainnet.verification.consecutiveRejections], ["ok", round - 1, null, 0]);
  assert.deepEqual([mainnet.invalidSignatureCheck.status, mainnet.invalidSignatureCheck.lastOutcome, mainnet.invalidSignatureCheck.round], ["ok", "rejected", round - 1]);
  assert.deepEqual([mainnet.catalog.use, mainnet.catalog.recipes, mainnet.catalog.epochId, mainnet.catalog.checkedAgeSeconds], ["only", [11], 5, 0]);
  const testnet = beacon.networks["arc-testnet"];
  assert.deepEqual([testnet.registration, testnet.verifier, testnet.slotSigner, testnet.reason], ["not registered yet", null, null, "beaconOf reverted"]);
  assert.equal(testnet.invalidSignatureCheck, null, "nothing to check while nothing is registered");
  assert.equal(testnet.catalog.use, "only");

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
  assert.ok(text.includes("Registry · arc-mainnet MISMATCH recipe 11 · catalog: drand only · round #" + (round - 1) + " verified · checked 0s ago"));
  assert.ok(text.includes("Registry · arc-testnet Not registered yet recipe 11 · catalog: drand only · checked 0s ago"));
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
  assert.ok(!text.includes("AirnodeHub + drand"), "the catalog is each registry's own caption now");
});

test("status HTML: an alarm shows as one, a beacon not yet checked as such, and nothing a store holds reaches the page unescaped", async () => {
  const h = harness({ catalog: DRAND_ONLY_CATALOG, seedEpoch: false });
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

  // With no recipe configured the AirnodeHub section is gone; what the catalog is comes from the chain, not from that list.
  const drandOnly = buildStatus(h.storage, TELEGRAM, NOW + 60, [], undefined);
  assert.deepEqual(Object.keys(drandOnly), ["service", "generatedAt", "notifier", "networks", "beacon", "recentMessages"]);
  assert.equal(drandOnly.beacon.catalogDrandOnly, false, "the catalog in force still lists sources other than the beacon");
  h.setCatalog(DRAND_ONLY_CATALOG);
  await h.run(1);
  assert.equal(buildStatus(h.storage, TELEGRAM, NOW + 120, [], undefined).beacon.catalogDrandOnly, true);
  assert.equal(buildStatus(h.storage, TELEGRAM, NOW + 120, [AIRNODE], undefined).beacon.catalogDrandOnly, true, "and a recipe still configured does not change it");
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
  // The epoch, the catalog, every signature and the flipped one are calls in those batches, not fetches: two a run.
  assert.equal(h.rpcCalls.length, 2 * 24 * 60);
  assert.deepEqual([...new Set(h.rpcCalls.slice(0, 2).map((c) => c.count))], [8], "the first run: chain id, beaconOf, slotSigner, two verifyBeacon, epochForBlock and two catalogAt");
  assert.deepEqual([...new Set(h.rpcCalls.slice(2, 4).map((c) => c.count))], [12], "the second also asks beaconOf of the 4 recipes the catalog lists, once");
  assert.deepEqual([...new Set(h.rpcCalls.slice(4).map((c) => c.count))], [8], "and never again: they are signed recipes");

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
