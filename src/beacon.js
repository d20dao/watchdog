// drand beacon monitor: the relays that serve the beacon's rounds, and the registry's registration of the beacon.
//
// The epoch registry (EpochEntropy) takes its randomness from a drand beacon it lists as recipe `beacon.recipe`: a keeper
// reads a round from a relay and the registry verifies it on chain. Once the catalog lists that recipe alone there is no
// fallback source, so a drand outage stops publication. Every run this module
//   1. reads each relay's /public/latest and judges it against the chain's clock,
//   2. reads one earlier round from every fresh relay and compares their signatures,
//   3. makes one JSON-RPC batch per network: beaconOf, slotSigner and verifyBeacon for the round of step 2,
// and once a day reads each relay's /info. No pairing code runs here: a round is verified by the registry's own
// verifyBeacon over eth_call, through the RPC client and batching the chain reads use. Relays are shared by the networks
// that list them, so each is read once per run however many networks there are.
// Replies are reduced to an outcome and a short reason; bodies are never logged or stored.

import {
  AbiError,
  decodeAddress,
  decodeBeaconOf,
  decodeBool,
  encodeBeaconOf,
  encodeSlotSigner,
  encodeVerifyBeacon,
  hexToBigInt,
} from "./abi.js";
import { LIMITS, THRESHOLDS } from "./config.js";
import { FetchTimeoutError, ResponseTooLargeError, fetchText } from "./net.js";
import { RpcSession } from "./rpc.js";

const USER_AGENT = "d20dao-watchdog (+https://watchdog.d20dao.org)";
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const BEACON_DOMAIN = "D20_EPOCH_BEACON"; // keccak256 of this text opens the slot signer's preimage

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const shortHex = (hex) => (hex.length > 16 ? `${hex.slice(0, 10)}...${hex.slice(-4)}` : hex);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// The chain's clock

/** When round `round` is due, in seconds. */
export const roundTime = (preset, round) => preset.genesis + (round - 1) * preset.period;

/** The round due at `nowSec`; 0 before genesis. */
export const currentRound = (preset, nowSec) => (nowSec < preset.genesis ? 0 : Math.floor((nowSec - preset.genesis) / preset.period) + 1);

// ---------------------------------------------------------------------------------------------
// Groups, schedule and state keys

/** A relay's id: its host, lowercase. Stable across runs and readable in alerts. */
export function relayId(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return String(url);
  }
}

/**
 * The beacons to watch, from the network configuration: one group per preset, holding the relays of every network that
 * uses it (each is read once per run, however many networks share it) and those networks.
 *   {preset, relays: [{id, url}], networks: [{name, net, beacon}]}
 * A network without a `beacon` entry is not watched.
 */
export function beaconGroups(nets) {
  const groups = new Map();
  for (const [name, net] of Object.entries(nets)) {
    const beacon = net.beacon;
    if (!beacon) continue;
    let group = groups.get(beacon.preset.id);
    if (!group) groups.set(beacon.preset.id, (group = { preset: beacon.preset, relays: [], networks: [] }));
    for (const url of beacon.relays) {
      const base = url.replace(/\/+$/, "");
      const id = relayId(base);
      if (!group.relays.some((relay) => relay.id === id)) group.relays.push({ id, url: base });
    }
    group.networks.push({ name, net, beacon });
  }
  return [...groups.values()];
}

export const groupStateKey = (preset) => `group:${preset.id}`;
export const networkStateKey = (name) => `network:${name}`;

/** The first time after `now` that is `phase` seconds into an `interval`-long cycle. */
function nextSlot(now, phase, interval) {
  const into = (((now - phase) % interval) + interval) % interval;
  return now - into + interval;
}

const phaseOf = (index, count, interval) => Math.floor((index * interval) / Math.max(1, count));

/** Relay j of m has its /info read at second j x 86400 / m of each day. */
export function infoPhase(group, id) {
  return phaseOf(Math.max(0, group.relays.findIndex((relay) => relay.id === id)), group.relays.length, LIMITS.beaconInfoIntervalSeconds);
}

/**
 * This run's beacon work: the groups, and in each `info`, the relays whose /info is due (at most beaconInfoMaxPerRun,
 * most overdue first; a relay never read is due at once). `states` is readBeaconStates(): group states hold their
 * relays' states.
 */
export function planBeacon(nets, states, nowSec) {
  const groups = beaconGroups(nets).map((group) => {
    const stored = states.get(groupStateKey(group.preset))?.relays ?? {};
    const due = group.relays
      .map((relay) => ({ id: relay.id, due: stored[relay.id]?.info?.nextCheckAt ?? 0 }))
      .filter((entry) => nowSec >= entry.due)
      .sort((a, b) => a.due - b.due);
    return { ...group, info: due.slice(0, Math.max(0, LIMITS.beaconInfoMaxPerRun)) };
  });
  return { groups };
}

/**
 * The most fetches one run can make for the beacons `nets` configure: two rounds from each relay, the /info reads due
 * in one run and one JSON-RPC batch per endpoint of each network (all of them, when every endpoint has to be tried).
 */
export function beaconWorstSubrequests(nets) {
  return beaconGroups(nets).reduce(
    (sum, group) =>
      sum +
      2 * group.relays.length +
      Math.min(LIMITS.beaconInfoMaxPerRun, group.relays.length) +
      group.networks.reduce((rpc, target) => rpc + target.net.rpcs.length, 0),
    0,
  );
}

// ---------------------------------------------------------------------------------------------
// Relay replies

const transportReason = (err) =>
  err instanceof FetchTimeoutError ? "timeout" : err instanceof ResponseTooLargeError ? "reply too large" : "network error";

/** One bounded GET. {ok: true, text} or {ok: false, reason}, with the latency and the second the answer arrived. */
async function get(url, { fetch, clock, timeoutMs }) {
  const started = clock();
  const done = (extra) => ({ latencyMs: Math.max(0, Math.round(clock() - started)), at: Math.floor(clock() / 1000), ...extra });
  let response;
  try {
    response = await fetchText(
      fetch,
      url,
      { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT } },
      timeoutMs,
      { maxBytes: LIMITS.beaconMaxResponseBytes },
    );
  } catch (err) {
    return done({ ok: false, reason: transportReason(err) });
  }
  // A future round answers 425; a healthy relay is never asked for one, so it is a failure like any other status.
  if (!response.ok) return done({ ok: false, reason: `http ${response.status}` });
  return done({ ok: true, text: response.text });
}

/**
 * A round record: `round` and the beacon's signature (`preset.signatureBytes` of hex). `expectedRound` is the round that
 * was asked for, or null for /public/latest. Returns {ok: true, round, signature (lowercase)} or {ok: false, reason}.
 */
export function parseRoundReply(preset, text, expectedRound = null) {
  const failure = (reason) => ({ ok: false, reason });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return failure("invalid json");
  }
  if (!isObject(body)) return failure("reply is not a round record");
  const { round, signature } = body;
  if (!Number.isSafeInteger(round) || round < 1) return failure("reply has no valid round");
  if (expectedRound !== null && round !== expectedRound) return failure(`asked for round ${expectedRound}, got round ${round}`);
  if (typeof signature !== "string" || !new RegExp(`^[0-9a-fA-F]{${preset.signatureBytes * 2}}$`).test(signature)) {
    return failure(`signature is not ${plural(preset.signatureBytes, "byte")} of hex`);
  }
  return { ok: true, round, signature: signature.toLowerCase() };
}

/** GET /<chainHash>/public/<which>, `which` being "latest" or a round. */
async function fetchRound(relay, preset, which, ctx) {
  const reply = await get(`${relay.url}/${preset.chainHash}/public/${which}`, ctx);
  if (!reply.ok) return reply;
  return { ...parseRoundReply(preset, reply.text, which === "latest" ? null : which), latencyMs: reply.latencyMs, at: reply.at };
}

// A value of the reply is shown only when it is plain hex, a plain number or a plain word: nothing else it says gets further.
const shownHex = (v) => (typeof v === "string" && /^[0-9a-fA-F]{8,}$/.test(v) ? shortHex(v.toLowerCase()) : "invalid");
const shownNumber = (v) => (Number.isSafeInteger(v) ? String(v) : "invalid");
const shownWord = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : "invalid");

/**
 * A relay's /info against the preset: chain hash, group public key, scheme, period and genesis time.
 * Returns {outcome: "ok" | "drift" | "failure", reason}; a reply that is not a chain info at all is a failure.
 */
export function checkChainInfo(preset, text) {
  let info;
  try {
    info = JSON.parse(text);
  } catch {
    return { outcome: "failure", reason: "invalid json" };
  }
  if (!isObject(info) || !["hash", "public_key", "period", "genesis_time"].some((key) => key in info)) {
    return { outcome: "failure", reason: "reply is not a chain info" };
  }
  const differs = [];
  const hex = (name, got, expected) => {
    if (typeof got !== "string" || got.toLowerCase() !== expected) differs.push(`${name} ${shownHex(got)} (expected ${shortHex(expected)})`);
  };
  hex("hash", info.hash, preset.chainHash);
  hex("public_key", info.public_key, preset.publicKey);
  if (info.schemeID !== preset.scheme) differs.push(`schemeID ${shownWord(info.schemeID)} (expected ${preset.scheme})`);
  if (info.period !== preset.period) differs.push(`period ${shownNumber(info.period)} (expected ${preset.period})`);
  if (info.genesis_time !== preset.genesis) differs.push(`genesis_time ${shownNumber(info.genesis_time)} (expected ${preset.genesis})`);
  if (differs.length === 0) return { outcome: "ok", reason: null };
  return { outcome: "drift", reason: `chain info differs from the ${preset.id} preset: ${differs.join("; ")}` };
}

/** GET /<chainHash>/info against the preset. */
async function fetchInfo(relay, preset, ctx) {
  const reply = await get(`${relay.url}/${preset.chainHash}/info`, ctx);
  if (!reply.ok) return { outcome: "failure", reason: reply.reason, latencyMs: reply.latencyMs };
  return { ...checkChainInfo(preset, reply.text), latencyMs: reply.latencyMs };
}

// ---------------------------------------------------------------------------------------------
// Judgments

/**
 * A relay's /public/latest answer against the chain's clock at `nowSec` (the second the answer arrived):
 *   fresh    the round is at most beaconMaxLagRounds behind the schedule
 *   stale    it is further behind
 *   failure  no usable answer, or a round further ahead of the schedule than the chain can be
 * Returns {outcome, reason, round, lagRounds}.
 */
export function judgeLatest(preset, reply, nowSec) {
  if (!reply.ok) return { outcome: "failure", reason: reply.reason, round: null, lagRounds: null };
  const due = currentRound(preset, nowSec);
  const lag = due - reply.round;
  if (lag < -THRESHOLDS.beaconMaxAheadRounds) {
    return { outcome: "failure", reason: `round ${reply.round} is ahead of the schedule (round ${due} is due)`, round: null, lagRounds: null };
  }
  const lagRounds = Math.max(0, lag);
  if (lagRounds > THRESHOLDS.beaconMaxLagRounds) {
    const reason = `latest round ${reply.round} is ${plural(lagRounds, "round")} (${lagRounds * preset.period}s) behind the schedule`;
    return { outcome: "stale", reason, round: reply.round, lagRounds };
  }
  return { outcome: "fresh", reason: null, round: reply.round, lagRounds };
}

/**
 * Compare the signatures relays returned for one round; `answers` is [{id, signature}] in relay order, at least one.
 * The signature most relays returned (`count` of them) is the round's when it has more relays than any other
 * (`majority`). Relays that returned another one are `differing` ({id => reason}), all of them when none does.
 */
export function judgeAgreement(answers, round) {
  const groups = new Map();
  for (const { id, signature } of answers) groups.set(signature, [...(groups.get(signature) ?? []), id]);
  const top = Math.max(...[...groups.values()].map((ids) => ids.length));
  const leaders = [...groups].filter(([, ids]) => ids.length === top);
  const signature = leaders[0][0];
  const majority = leaders.length === 1;
  const differing = new Map();
  if (groups.size > 1 && !majority) {
    for (const { id } of answers) differing.set(id, `round ${round}: no majority, the relays returned ${groups.size} different signatures`);
  } else if (groups.size > 1) {
    for (const [other, ids] of groups) {
      if (other === signature) continue;
      const reason = `round ${round}: signature ${shortHex(other)} differs from ${shortHex(signature)}, which ${plural(top, "relay")} returned`;
      for (const id of ids) differing.set(id, reason);
    }
  }
  return { signature, majority, count: top, differing };
}

// ---------------------------------------------------------------------------------------------
// The registry

const toBytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The signer the registry derives for a beacon slot:
 * address(uint160(uint256(keccak256(abi.encode(keccak256("D20_EPOCH_BEACON"), verifier, chainHash,
 * keccak256(publicKey), genesis, period))))). `verifier` is 0x-prefixed.
 */
export async function expectedSlotSigner(preset, verifier) {
  // Loaded here, not at the top: the hash code is evaluated only once a registry lists a beacon, never in the Worker entry.
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const words = new Uint8Array(6 * 32);
  const view = new DataView(words.buffer);
  words.set(keccak_256(new TextEncoder().encode(BEACON_DOMAIN)), 0);
  words.set(toBytes(verifier.slice(2)), 32 + 12);
  words.set(toBytes(preset.chainHash), 64);
  words.set(keccak_256(toBytes(preset.publicKey)), 96);
  view.setBigUint64(128 + 24, BigInt(preset.genesis));
  view.setBigUint64(160 + 24, BigInt(preset.period));
  return "0x" + toHex(keccak_256(words).subarray(12));
}

/**
 * What beaconOf answered, from its batch item: {state: "registered", tuple} | {state: "unregistered", reason} |
 * {state: "unknown", reason}. A recipe that is no beacon, or a registry that does not have the function yet, reverts
 * or returns a zero verifier: both mean "not registered". Any other failure says nothing either way.
 */
export function readBeaconOf(item) {
  if (item.error) {
    return item.revert ? { state: "unregistered", reason: "beaconOf reverted" } : { state: "unknown", reason: `beaconOf: ${item.error}` };
  }
  let tuple;
  try {
    tuple = decodeBeaconOf(item.result);
  } catch (err) {
    return { state: "unknown", reason: `beaconOf: ${err instanceof AbiError ? "decode error" : "invalid result"}` };
  }
  if (tuple.verifier === ZERO_ADDRESS) return { state: "unregistered", reason: "zero verifier" };
  return { state: "registered", tuple };
}

/** What slotSigner answered: {state: "ok", address} | {state: "reverted"} | {state: "unknown"}. */
export function readSlotSigner(item) {
  if (item.error) return { state: item.revert ? "reverted" : "unknown" };
  try {
    return { state: "ok", address: decodeAddress(item.result) };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * What verifyBeacon answered for `sample`: {round, signature, returnedBy, of} (the signature `returnedBy` of `of` relays
 * returned) or {skip: reason} when there was no round to verify. Returns {outcome: "ok" | "invalid" | "unknown" |
 * "skipped", round, reason}. Nothing is verified against a beacon that is not registered; a call that reverts rejected
 * the round, an endpoint's own error says nothing.
 */
export function readVerify(item, sample, registered) {
  if (!registered) return { outcome: "skipped", round: null, reason: "beacon not registered" };
  if (sample.skip) return { outcome: "skipped", round: null, reason: sample.skip };
  const round = sample.round;
  const returned = sample.of > 1 ? ` for the signature ${sample.returnedBy} of ${sample.of} relays returned` : "";
  if (item.error) {
    return item.revert
      ? { outcome: "invalid", round, reason: `verifyBeacon reverted${returned}` }
      : { outcome: "unknown", round, reason: `verifyBeacon: ${item.error}` };
  }
  try {
    return decodeBool(item.result)
      ? { outcome: "ok", round, reason: null }
      : { outcome: "invalid", round, reason: `verifyBeacon returned false${returned}` };
  } catch {
    return { outcome: "unknown", round, reason: "verifyBeacon: decode error" };
  }
}

/**
 * beaconOf and slotSigner against the configuration: the chain hash, group key, genesis, period and, when the
 * configuration names one, the verifier, and the slot signer derived from the same. Returns the differences.
 */
export function compareRegistration(beacon, preset, tuple, signer, expectedSigner) {
  const problems = [];
  if (beacon.verifier && !same(tuple.verifier, beacon.verifier)) problems.push(`verifier ${tuple.verifier} (expected ${beacon.verifier})`);
  if (tuple.genesis !== preset.genesis) problems.push(`genesis ${tuple.genesis} (expected ${preset.genesis})`);
  if (tuple.period !== preset.period) problems.push(`period ${tuple.period} (expected ${preset.period})`);
  if (tuple.chainHash !== `0x${preset.chainHash}`) problems.push(`chainHash ${shortHex(tuple.chainHash)} (expected ${shortHex(`0x${preset.chainHash}`)})`);
  if (tuple.publicKey !== `0x${preset.publicKey}`) problems.push(`publicKey ${shortHex(tuple.publicKey)} (expected ${shortHex(`0x${preset.publicKey}`)})`);
  if (signer.state === "reverted") problems.push("slotSigner reverted");
  else if (signer.state === "ok" && !same(signer.address, expectedSigner)) problems.push(`slotSigner ${signer.address} (expected ${expectedSigner})`);
  return problems;
}

const validateChain = (net) => (items) => {
  try {
    return "result" in items[0] && hexToBigInt(items[0].result) === BigInt(net.chainId) ? null : "wrong chain id";
  } catch {
    return "wrong chain id";
  }
};

/**
 * One JSON-RPC batch to a network's registry: chain id, beaconOf, slotSigner and, when there is a round to verify,
 * verifyBeacon. Returns {run, subrequests}; `run` is the network's part of the run result:
 *   {name, ok: false, reason}                                    the registry could not be read
 *   {name, ok: true, registration: "registered" | "unregistered" | "unknown", registrationReason, verifier, slotSigner,
 *    verdict: "ok" | "mismatch" | null, verdictReason, verify: {outcome, round, reason}}
 */
async function readRegistry(target, preset, sample, session) {
  const { name, net, beacon } = target;
  const calls = [
    ["eth_chainId", []],
    ["eth_call", [{ to: net.registry, data: encodeBeaconOf(beacon.recipe) }, "latest"]],
    ["eth_call", [{ to: net.registry, data: encodeSlotSigner(beacon.recipe) }, "latest"]],
  ];
  if (!sample.skip) {
    calls.push(["eth_call", [{ to: net.registry, data: encodeVerifyBeacon(beacon.recipe, sample.round, `0x${sample.signature}`) }, "latest"]]);
  }
  const items = await session.batch(calls, validateChain(net));
  const subrequests = session.subrequests;
  if (!items) return { run: { name, ok: false, reason: session.lastError ?? "all endpoints failed" }, subrequests };

  const registration = readBeaconOf(items[1]);
  const base = { name, ok: true, reason: null, registration: registration.state, registrationReason: registration.reason ?? null };
  if (registration.state !== "registered") {
    const empty = { verifier: null, slotSigner: null, verdict: null, verdictReason: null };
    const verify = { outcome: "skipped", round: null, reason: registration.state === "unregistered" ? "beacon not registered" : "registration unknown" };
    return { run: { ...base, ...empty, verify }, subrequests };
  }
  const { tuple } = registration;
  const signer = readSlotSigner(items[2]);
  const expected = await expectedSlotSigner(preset, beacon.verifier ?? tuple.verifier);
  const problems = compareRegistration(beacon, preset, tuple, signer, expected);
  return {
    run: {
      ...base,
      verifier: tuple.verifier,
      slotSigner: signer.state === "ok" ? signer.address : null,
      verdict: problems.length === 0 ? "ok" : "mismatch",
      verdictReason: problems.length === 0 ? null : `beaconOf(${beacon.recipe}) differs from the configured ${preset.id} beacon: ${problems.join("; ")}`,
      verify: readVerify(items[3], sample, true),
    },
    subrequests,
  };
}

// ---------------------------------------------------------------------------------------------
// A run

/** Run `fn` over `items` with at most `limit` in flight; results are in item order and a throw becomes `onError`'s value. */
async function mapBounded(items, limit, fn, onError) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = onError(items[i], i);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/**
 * One group's run, in three steps: every relay's latest round (and the /info of the relays due for it); one earlier
 * round from every fresh relay, compared; each network's registry. The round that goes to verifyBeacon is that common
 * round with the signature most relays returned for it (none when they are split with no majority, or none answered),
 * or with a single fresh relay, the latest round it served. Returns {run, subrequests}.
 */
async function probeGroup(group, ctx, makeSession) {
  const { preset } = group;
  let subrequests = 0;

  // 1. Every relay's latest round, then the /info of those due for it, all under one bound.
  const due = new Set(group.info.map((entry) => entry.id));
  const tasks = [
    ...group.relays.map((relay) => ({ relay, kind: "latest" })),
    ...group.relays.filter((relay) => due.has(relay.id)).map((relay) => ({ relay, kind: "info" })),
  ];
  const failed = () => ({ ok: false, reason: "internal error", latencyMs: null, at: Math.floor(ctx.clock() / 1000), outcome: "failure" });
  const replies = await mapBounded(
    tasks,
    LIMITS.beaconConcurrency,
    (task) => (task.kind === "latest" ? fetchRound(task.relay, preset, "latest", ctx) : fetchInfo(task.relay, preset, ctx)),
    failed,
  );
  subrequests += tasks.length;
  const latest = new Map();
  const info = new Map();
  tasks.forEach((task, i) => (task.kind === "latest" ? latest : info).set(task.relay.id, replies[i]));

  const runs = group.relays.map((relay) => {
    const reply = latest.get(relay.id);
    const checked = info.get(relay.id);
    return {
      id: relay.id,
      ...judgeLatest(preset, reply, reply.at),
      latencyMs: reply.latencyMs ?? null,
      agreement: null,
      info: checked ? { outcome: checked.outcome, reason: checked.reason ?? null, latencyMs: checked.latencyMs ?? null } : null,
    };
  });

  // 2. One round every fresh relay has: the one before the lowest of their latest rounds.
  const fresh = runs.filter((run) => run.outcome === "fresh");
  let commonRound = null;
  let sample = { skip: fresh.length === 0 ? "no fresh relay" : "no common round to read" };
  if (fresh.length === 1) {
    // Nothing to compare it with: verify the latest round it served.
    sample = { round: fresh[0].round, signature: latest.get(fresh[0].id).signature, returnedBy: 1, of: 1 };
  } else if (fresh.length >= 2 && Math.min(...fresh.map((run) => run.round)) > 1) {
    const round = Math.min(...fresh.map((run) => run.round)) - 1;
    commonRound = round;
    const byId = new Map(group.relays.map((relay) => [relay.id, relay]));
    const second = await mapBounded(fresh, LIMITS.beaconConcurrency, (run) => fetchRound(byId.get(run.id), preset, round, ctx), failed);
    subrequests += fresh.length;
    const answers = [];
    fresh.forEach((run, i) => {
      if (second[i].ok) answers.push({ id: run.id, signature: second[i].signature });
      else run.agreement = { outcome: "failure", round, reason: second[i].reason };
    });
    sample = { skip: "no relay returned the common round" };
    if (answers.length > 0) {
      const verdict = judgeAgreement(answers, round);
      // With no majority no signature stands for the round: it is not verified, and the relays' warnings say why.
      sample = verdict.majority
        ? { round, signature: verdict.signature, returnedBy: verdict.count, of: answers.length }
        : { skip: "relays disagree with no majority" };
      // A lone answer has nothing to be compared with.
      if (answers.length >= 2) {
        for (const { id } of answers) {
          const run = runs.find((r) => r.id === id);
          run.agreement = verdict.differing.has(id)
            ? { outcome: "differs", round, reason: verdict.differing.get(id) }
            : { outcome: "agree", round, reason: null };
        }
      }
    }
  }

  // 3. Each network's registry: its registration of the beacon, and that it accepts the round.
  const registries = await Promise.all(
    group.networks.map(async (target) => {
      let session;
      try {
        session = makeSession(target.net);
        return await readRegistry(target, preset, sample, session);
      } catch {
        return { run: { name: target.name, ok: false, reason: "internal error" }, subrequests: session?.subrequests ?? 0 };
      }
    }),
  );
  subrequests += registries.reduce((sum, r) => sum + r.subrequests, 0);

  return {
    subrequests,
    run: {
      preset: preset.id,
      commonRound,
      sampleRound: sample.round ?? null,
      relays: runs,
      networks: registries.map((r) => r.run),
    },
  };
}

/** A group's part of a run that produced nothing (the monitor itself failed): every relay failed, no registry was read. */
function failedGroupRun(group, reason) {
  return {
    preset: group.preset.id,
    commonRound: null,
    sampleRound: null,
    relays: group.relays.map((relay) => ({ id: relay.id, outcome: "failure", reason, round: null, lagRounds: null, latencyMs: null, agreement: null, info: null })),
    networks: group.networks.map((target) => ({ name: target.name, ok: false, reason })),
  };
}

export const failedBeaconRun = (plan, reason) => ({ subrequests: 0, groups: plan.groups.map((group) => failedGroupRun(group, reason)) });

/**
 * Run a plan (see planBeacon): {subrequests, groups: [{preset, commonRound, sampleRound, relays: [...], networks: [...]}]},
 * aligned with plan.groups, and in each with the group's relays and networks. Never throws.
 * `createSession(net)` makes the JSON-RPC session for a network; the default is the chain reader's RpcSession.
 */
export async function runBeacon(plan, { fetch, clock = () => Date.now(), timeoutMs = LIMITS.beaconTimeoutMs, createSession } = {}) {
  const ctx = { fetch, clock, timeoutMs };
  const makeSession = createSession ?? ((net) => new RpcSession(net.rpcs, { fetch, timeoutMs: LIMITS.rpcTimeoutMs }));
  const outcomes = await Promise.all(
    plan.groups.map(async (group) => {
      try {
        return await probeGroup(group, ctx, makeSession);
      } catch {
        return { run: failedGroupRun(group, "internal error"), subrequests: 0 };
      }
    }),
  );
  return { subrequests: outcomes.reduce((sum, o) => sum + o.subrequests, 0), groups: outcomes.map((o) => o.run) };
}

// ---------------------------------------------------------------------------------------------
// State
//
// One JSON state per group, holding the group's own figures and one state per relay, and one per network:
//   group    {checkedAt, fresh, total, downRuns, lastFreshAt, latestRound, commonRound, relays: {id: relay}}
//   relay    {checkedAt, latencyMs, outcome, reason, round, lagRounds, badRuns, lastOkAt,
//             agreement: {checkedAt, round, outcome, reason, verdict, verdictReason},
//             info: {checkedAt, latencyMs, outcome, reason, verdict, verdictReason, nextCheckAt}}
//   network  {checkedAt, readOk, readReason, registration, registrationReason, everRegistered, verifier, slotSigner,
//             verdict, verdictReason, verify: {checkedAt, outcome, round, reason, failures, rejectedRound, rejectedReason,
//             lastOkAt}}
// `badRuns` counts consecutive runs in which a relay was not fresh, `downRuns` those in which no relay was. A verdict
// is the latest conclusive result: an unusable answer says nothing about whether a difference was fixed, so it keeps it.

const kept = (failed, verdict, previous) => (failed ? previous ?? null : verdict);

export function applyRelayRun(previous, run, now, phase) {
  const prev = previous ?? {};
  const fresh = run.outcome === "fresh";
  const next = {
    ...prev,
    checkedAt: now,
    latencyMs: run.latencyMs ?? null,
    outcome: run.outcome,
    reason: run.reason ?? null,
    round: run.round ?? null,
    lagRounds: run.lagRounds ?? null,
    badRuns: fresh ? 0 : (prev.badRuns ?? 0) + 1,
    lastOkAt: fresh ? now : prev.lastOkAt ?? null,
  };
  if (run.agreement) {
    const a = run.agreement;
    const failed = a.outcome === "failure";
    next.agreement = {
      checkedAt: now,
      round: a.round,
      outcome: a.outcome,
      reason: a.reason ?? null,
      verdict: kept(failed, a.outcome === "agree" ? "ok" : "differs", prev.agreement?.verdict),
      verdictReason: kept(failed, a.reason ?? null, prev.agreement?.verdictReason),
    };
  }
  if (run.info) {
    const i = run.info;
    const failed = i.outcome === "failure";
    next.info = {
      checkedAt: now,
      latencyMs: i.latencyMs ?? null,
      outcome: i.outcome,
      reason: i.reason ?? null,
      verdict: kept(failed, i.outcome === "ok" ? "ok" : "drift", prev.info?.verdict),
      verdictReason: kept(failed, i.reason ?? null, prev.info?.verdictReason),
      nextCheckAt: failed ? now + LIMITS.beaconInfoRetrySeconds : nextSlot(now, phase, LIMITS.beaconInfoIntervalSeconds),
    };
  }
  return next;
}

/** The group's own figures; the caller adds the relays' states. */
export function applyGroupRun(previous, run, now) {
  const fresh = run.relays.filter((relay) => relay.outcome === "fresh");
  return {
    checkedAt: now,
    fresh: fresh.length,
    total: run.relays.length,
    downRuns: fresh.length === 0 ? (previous?.downRuns ?? 0) + 1 : 0,
    lastFreshAt: fresh.length > 0 ? now : previous?.lastFreshAt ?? null,
    latestRound: fresh.length > 0 ? Math.max(...fresh.map((relay) => relay.round)) : null,
    commonRound: run.commonRound ?? null,
  };
}

function applyVerify(previous, verify, now) {
  const prev = previous ?? {};
  const latest = { checkedAt: now, outcome: verify.outcome, round: verify.round ?? null, reason: verify.reason ?? null };
  switch (verify.outcome) {
    case "ok":
      return { ...latest, failures: 0, rejectedRound: null, rejectedReason: null, lastOkAt: now };
    case "invalid":
      return { ...prev, ...latest, failures: (prev.failures ?? 0) + 1, rejectedRound: verify.round, rejectedReason: verify.reason };
    default:
      // "unknown" and "skipped" add no evidence either way: the streak of rejections, and what it is about, stay.
      return { ...prev, ...latest };
  }
}

export function applyNetworkRun(previous, run, now) {
  const prev = previous ?? {};
  // A registry that could not be read, or answered beaconOf with something unusable, says nothing new: what was last
  // known stays, marked as not read this run.
  if (!run.ok || run.registration === "unknown") {
    return { ...prev, checkedAt: now, readOk: false, readReason: (run.ok ? run.registrationReason : run.reason) ?? "unknown" };
  }
  const registered = run.registration === "registered";
  const verify = applyVerify(prev.verify, run.verify, now);
  return {
    ...prev,
    checkedAt: now,
    readOk: true,
    readReason: null,
    registration: run.registration,
    registrationReason: run.registrationReason ?? null,
    everRegistered: prev.everRegistered === true || registered,
    verifier: registered ? run.verifier : null,
    slotSigner: registered ? run.slotSigner : null,
    verdict: registered ? run.verdict : null,
    verdictReason: registered ? run.verdictReason : null,
    // Nothing to verify against a beacon that is not registered: its streak of rejections ends.
    verify: registered ? verify : { ...verify, failures: 0 },
  };
}
