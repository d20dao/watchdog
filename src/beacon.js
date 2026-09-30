// drand beacon monitor: the relays that serve the beacon's rounds, and the registry's registration of the beacon.
//
// The epoch registry (EpochEntropy) takes its randomness from a drand beacon it lists as a recipe: a keeper reads a round
// from a relay and the registry verifies it on chain. Once the catalog in force lists that recipe alone there is no
// fallback source, so a drand outage stops publication. Every run this module
//   1. reads each relay's /public/latest and judges it against the chain's clock,
//   2. reads one earlier round from every fresh relay and compares their signatures,
//   3. makes one JSON-RPC batch per network: beaconOf for the monitored recipe and the catalog's, slotSigner, verifyBeacon
//      for each distinct signature of the round of step 2 and for one with its last byte flipped, epochForBlock and catalogAt,
//   4. settles the round: a signature some registry accepts is the round's, which says whether a relay or a registry is at fault,
// and once a day reads each relay's /info. No pairing code runs here: a round is verified by the registry's own
// verifyBeacon over eth_call, through the RPC client and batching the chain reads use. Relays are shared by the networks
// that list them, so each is read once per run however many networks there are.
// A batch cannot hand one call's answer to another, so what depends on an answer comes from the previous run's state:
// slotSigner and verifyBeacon ask about the recipe monitored then, and beaconOf also about the recipes the catalog listed.
// catalogAt asks about the epoch epochForBlock returned then and the one after it: the epoch of this run's epochForBlock, which
// is one of the two, says which is the catalog in force now.
// Replies are reduced to an outcome and a short reason; bodies are never logged or stored.

import {
  AbiError,
  decodeAddress,
  decodeBeaconOf,
  decodeBool,
  decodeCatalogAt,
  decodeUint64,
  encodeBeaconOf,
  encodeCatalogAt,
  encodeEpochForBlock,
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
/** "the arc-mainnet registry", "the arc-mainnet and arc-testnet registries" */
const registries = (names) => (names.length === 1 ? `the ${names[0]} registry` : `the ${names.join(" and ")} registries`);
/** "the arc-mainnet registry accepts", "the arc-mainnet and arc-testnet registries accept" */
const accept = (names) => `${registries(names)} ${names.length === 1 ? "accepts" : "accept"}`;
/** A stored recipe id that can be asked about: a uint8. */
const recipeId = (v) => (Number.isInteger(v) && v >= 0 && v <= 255 ? v : null);

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
 * most overdue first; a relay never read is due at once), and for each network the state it was left in (`previous`).
 * `states` is readBeaconStates(): group states hold their relays' states.
 */
export function planBeacon(nets, states, nowSec) {
  const groups = beaconGroups(nets).map((group) => {
    const stored = states.get(groupStateKey(group.preset))?.relays ?? {};
    const due = group.relays
      .map((relay) => ({ id: relay.id, due: stored[relay.id]?.info?.nextCheckAt ?? 0 }))
      .filter((entry) => nowSec >= entry.due)
      .sort((a, b) => a.due - b.due);
    return {
      ...group,
      networks: group.networks.map((target) => ({ ...target, previous: states.get(networkStateKey(target.name)) ?? null })),
      info: due.slice(0, Math.max(0, LIMITS.beaconInfoMaxPerRun)),
    };
  });
  return { groups };
}

/**
 * The most fetches one run can make for the beacons `nets` configure: two rounds from each relay, the /info reads due
 * in one run and one JSON-RPC batch per endpoint of each network (all of them, when every endpoint has to be tried).
 * What a registry batch asks for (beaconOf, slotSigner, verifyBeacon, epochForBlock, catalogAt) is calls in that batch, not fetches.
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

/**
 * One bounded GET. {ok: true, text} or {ok: false, reason}, with the latency and the second the answer arrived.
 * `transport: true` marks a failure with no reply at all (a timeout or a network error): the fault may be the watchdog's own
 * network rather than the relay.
 */
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
    return done({ ok: false, reason: transportReason(err), ...(err instanceof ResponseTooLargeError ? {} : { transport: true }) });
  }
  // A round not produced yet is no answer either: drand.cloudflare.com replies 404 (with a cache max-age of about 54 s) and
  // api.drand.sh, api2 and api3 reply 425. A healthy relay is never asked for one, so it fails like any other status.
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
 *   unknown  the monitor itself failed on this read: it says nothing about the relay
 * Returns {outcome, reason, round, lagRounds}, and `transport: true` for a failure that had no reply at all.
 */
export function judgeLatest(preset, reply, nowSec) {
  if (reply.internal) return { outcome: "unknown", reason: reply.reason, round: null, lagRounds: null };
  if (!reply.ok) return { outcome: "failure", reason: reply.reason, round: null, lagRounds: null, ...(reply.transport ? { transport: true } : {}) };
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
 * `groups` is every distinct signature with the relays that returned it, most relays first (ties: the earliest relay).
 */
export function judgeAgreement(answers, round) {
  const bySignature = new Map();
  for (const { id, signature } of answers) bySignature.set(signature, [...(bySignature.get(signature) ?? []), id]);
  const groups = [...bySignature].map(([signature, ids]) => ({ signature, ids })).sort((a, b) => b.ids.length - a.ids.length);
  const top = groups[0].ids.length;
  const signature = groups[0].signature;
  const majority = groups.length === 1 || groups[1].ids.length < top;
  const differing = new Map();
  if (groups.length > 1 && !majority) {
    for (const { id } of answers) differing.set(id, `round ${round}: no majority, the relays returned ${groups.length} different signatures`);
  } else if (groups.length > 1) {
    for (const { signature: other, ids } of groups.slice(1)) {
      const reason = `round ${round}: signature ${shortHex(other)} differs from ${shortHex(signature)}, which ${plural(top, "relay")} returned`;
      for (const id of ids) differing.set(id, reason);
    }
  }
  return { signature, majority, count: top, differing, groups };
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
 * What beaconOf answered, from its batch item:
 *   {state: "registered", tuple}     a beacon is registered for the recipe
 *   {state: "notbeacon", reason}     the recipe exists but is no beacon (a zero verifier: a signed recipe)
 *   {state: "unregistered", reason}  the call reverted: the recipe does not exist yet, or the registry is not upgraded yet
 *   {state: "unknown", reason}       any other failure says nothing either way
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
  if (tuple.verifier === ZERO_ADDRESS) return { state: "notbeacon", reason: "zero verifier" };
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
 * What one verifyBeacon call answered: {result: "accepted" | "rejected" | "unknown", how}. A call that reverted rejected the
 * signature, like a false; an endpoint's own error says nothing.
 */
export function readCheck(item) {
  if (item.error) return item.revert ? { result: "rejected", how: "reverted" } : { result: "unknown", how: `verifyBeacon: ${item.error}` };
  try {
    return decodeBool(item.result) ? { result: "accepted", how: "returned true" } : { result: "rejected", how: "returned false" };
  } catch {
    return { result: "unknown", how: "verifyBeacon: decode error" };
  }
}

/** What epochForBlock answered: {state: "ok", id} | {state: "reverted"} | {state: "unknown"}. */
export function readEpoch(item) {
  if (item.error) return { state: item.revert ? "reverted" : "unknown" };
  try {
    return { state: "ok", id: decodeUint64(item.result) };
  } catch {
    return { state: "unknown" };
  }
}

/** What catalogAt answered: {state: "ok", hash, recipes} | {state: "reverted"} | {state: "unknown"}. */
export function readCatalog(item) {
  if (item.error) return { state: item.revert ? "reverted" : "unknown" };
  try {
    const { hash, recipes } = decodeCatalogAt(item.result);
    return { state: "ok", hash, recipes };
  } catch {
    return { state: "unknown" };
  }
}

/** Whether a registration is the preset's chain: chain hash, group key, genesis and period (verifier and slot signer aside). */
export function matchesPreset(preset, tuple) {
  return (
    same(tuple.chainHash, `0x${preset.chainHash}`) && same(tuple.publicKey, `0x${preset.publicKey}`) && tuple.genesis === preset.genesis && tuple.period === preset.period
  );
}

/**
 * beaconOf and slotSigner against the configuration: the chain hash, group key, genesis, period and, when the
 * configuration names one, the verifier, and the slot signer derived from the same. Returns the differences.
 * Hex is compared without regard to case.
 */
export function compareRegistration(beacon, preset, tuple, signer, expectedSigner) {
  const problems = [];
  if (beacon.verifier && !same(tuple.verifier, beacon.verifier)) problems.push(`verifier ${tuple.verifier} (expected ${beacon.verifier})`);
  if (tuple.genesis !== preset.genesis) problems.push(`genesis ${tuple.genesis} (expected ${preset.genesis})`);
  if (tuple.period !== preset.period) problems.push(`period ${tuple.period} (expected ${preset.period})`);
  if (!same(tuple.chainHash, `0x${preset.chainHash}`)) problems.push(`chainHash ${shortHex(tuple.chainHash)} (expected ${shortHex(`0x${preset.chainHash}`)})`);
  if (!same(tuple.publicKey, `0x${preset.publicKey}`)) problems.push(`publicKey ${shortHex(tuple.publicKey)} (expected ${shortHex(`0x${preset.publicKey}`)})`);
  if (signer.state === "reverted") problems.push("slotSigner reverted");
  else if (signer.state === "ok" && !same(signer.address, expectedSigner)) problems.push(`slotSigner ${signer.address} (expected ${expectedSigner})`);
  return problems;
}

/**
 * The recipe to monitor: the configured one while it is a registration of the preset's beacon. Otherwise a recipe of the
 * catalog in force (`listed`, in its order) that is one: the beacon is registered under another id than the configured
 * one, and that id is the one epochs will use. Otherwise the configured one, whatever it turns out to be.
 * `beacons` is what beaconOf answered for each recipe asked about (see readBeaconOf). `followed`, the recipe that was
 * followed before when it was not the configured one, stays followed through a read that says nothing about it (a revert from
 * an RPC node that is behind, an error) while the catalog in force still lists it.
 */
export function chooseRecipe(beacon, preset, beacons, listed, followed = null) {
  const matching = (id) => {
    const answer = beacons.get(id);
    return answer?.state === "registered" && matchesPreset(preset, answer.tuple);
  };
  if (matching(beacon.recipe)) return beacon.recipe;
  const found = listed.find((id) => id !== beacon.recipe && matching(id));
  if (found !== undefined) return found;
  const said = beacons.get(followed)?.state;
  if (followed !== null && followed !== beacon.recipe && listed.includes(followed) && (said === "unregistered" || said === "unknown")) return followed;
  return beacon.recipe;
}

/**
 * How the catalog's slots (`recipes`) use the monitored beacon `recipe`: "only" when every slot is it, "mixed" when some
 * slot is, "none" when no slot is. A slot whose recipe was not asked about, or could not be read, might be the beacon under
 * another id: the answer is then `previous`, what the catalog was known to be (or "none").
 */
export function catalogUse(recipes, recipe, beacons, previous = null) {
  if (recipes.length === 0) return "none";
  if (recipes.every((id) => id === recipe)) return "only";
  if (recipes.includes(recipe)) return "mixed";
  const unread = recipes.some((id) => (beacons.get(id)?.state ?? "unknown") === "unknown");
  return unread ? previous ?? "none" : "none";
}

/** The signature with its last byte inverted: not a signature of the round, whichever it was. */
export function flipLastByte(signature) {
  const last = parseInt(signature.slice(-2), 16) ^ 0xff;
  return signature.slice(0, -2) + last.toString(16).padStart(2, "0");
}

/**
 * Settle the compared round once every registry has answered. `sample` is {round, answers: [{id, signature}], verdict
 * (judgeAgreement's), candidates: [{signature, ids}], majority}: `candidates` are the signatures that went to verifyBeacon.
 * `reads` holds one {name, checks, skip} per registry that lists the beacon: `checks` is readCheck() of each candidate, in
 * order, or null when nothing was asked (then `skip` says why).
 *
 * At most one signature is valid for a round, so one a registry accepts is the round's, however few relays returned it:
 *   - a registry that rejects it is at fault (another registry accepts it);
 *   - the relays that returned another signature are at fault, and are flagged whatever their number.
 * When no registry accepts any, the signature most relays returned stands for the round if it has a majority:
 *   - a registry that rejects it is at fault when at least two relays returned it;
 *   - when one relay alone did, that relay is the suspect and the registry is not blamed ("uncorroborated");
 * and with no majority no signature stands for the round and no registry is blamed either.
 *
 * Returns {winner (index into candidates, or null), verify: {network: {outcome, round, reason}}, agreements: Map of
 * relay id -> {outcome: "agree" | "differs" | "rejected", round, reason}}. A verify outcome is "ok", "invalid" (counts
 * against the registry), "uncorroborated", "unknown" or "skipped". Relays without an entry were not compared.
 */
export function settleRound(sample, reads) {
  const { round, answers, candidates, verdict } = sample;
  const answered = answers.length;
  const active = reads.filter((read) => read.checks);
  const acceptedBy = (i) => active.filter((read) => read.checks[i].result === "accepted").map((read) => read.name);
  const returnedBy = (i) => candidates[i].ids.length;
  const ofRelays = (i) => (answered > 1 ? ` for the signature ${returnedBy(i)} of ${answered} relays returned` : "");

  let winner = null;
  for (let i = 0; i < candidates.length; i++) {
    const n = acceptedBy(i).length;
    if (n === 0) continue;
    const best = winner === null ? null : acceptedBy(winner).length;
    if (winner === null || n > best || (n === best && returnedBy(i) > returnedBy(winner))) winner = i;
  }
  const stands = winner ?? (sample.majority ? 0 : null);

  const verifyOf = (read) => {
    if (!read.checks) return { outcome: "skipped", round: null, reason: read.skip };
    if (stands === null) {
      const unread = read.checks.find((check) => check.result === "unknown");
      return unread
        ? { outcome: "unknown", round, reason: unread.how }
        : { outcome: "uncorroborated", round, reason: "verifyBeacon rejected every signature, and the relays split with no majority" };
    }
    const check = read.checks[stands];
    if (check.result === "unknown") return { outcome: "unknown", round, reason: check.how };
    if (check.result === "accepted") return { outcome: "ok", round, reason: null };
    if (winner !== null) return { outcome: "invalid", round, reason: `verifyBeacon ${check.how}${ofRelays(stands)}; ${accept(acceptedBy(stands))} it` };
    return returnedBy(stands) >= 2
      ? { outcome: "invalid", round, reason: `verifyBeacon ${check.how}${ofRelays(stands)}` }
      : { outcome: "uncorroborated", round, reason: `verifyBeacon ${check.how} for a signature only one relay returned` };
  };

  const agreements = new Map();
  if (winner !== null) {
    const right = candidates[winner];
    for (const { id, signature } of answers) {
      agreements.set(
        id,
        signature === right.signature
          ? { outcome: "agree", round, reason: null }
          : {
              outcome: "differs",
              round,
              reason: `round ${round}: signature ${shortHex(signature)} differs from ${shortHex(right.signature)}, which ${plural(right.ids.length, "relay")} returned and ${accept(acceptedBy(winner))}`,
            },
      );
    }
  } else if (answered === 1) {
    // Nothing to compare it with: only every registry rejecting it makes the relay the suspect.
    const [{ id, signature }] = answers;
    if (active.length > 0 && active.every((read) => read.checks[0].result === "rejected")) {
      const reason = `round ${round}: signature ${shortHex(signature)} is rejected by ${registries(active.map((read) => read.name))} and no other relay returned it`;
      agreements.set(id, { outcome: "rejected", round, reason });
    }
  } else {
    for (const { id } of answers) {
      agreements.set(id, verdict.differing.has(id) ? { outcome: "differs", round, reason: verdict.differing.get(id) } : { outcome: "agree", round, reason: null });
    }
  }
  return { winner, verify: Object.fromEntries(reads.map((read) => [read.name, verifyOf(read)])), agreements };
}

const validateChain = (net) => (items) => {
  try {
    return "result" in items[0] && hexToBigInt(items[0].result) === BigInt(net.chainId) ? null : "wrong chain id";
  } catch {
    return "wrong chain id";
  }
};

/** The outcome of the check that a signature with its last byte flipped is rejected: {outcome, round, reason}. */
const negativeOf = (check, round) =>
  check.result === "rejected"
    ? { outcome: "rejected", round, reason: null }
    : check.result === "accepted"
      ? { outcome: "accepted", round, reason: "verifyBeacon returned true for a signature with its last byte flipped" }
      : { outcome: "unknown", round, reason: check.how };

/**
 * One JSON-RPC batch to a network's registry (`head` is the network's head block from this run's chain read, or null):
 *   eth_chainId; beaconOf of the recipe monitored last run, the configured one and those the catalog listed; slotSigner and
 *   verifyBeacon of the recipe monitored last run, for each candidate signature of the compared round and for the first
 *   with its last byte flipped; epochForBlock of the head; catalogAt of the epoch the previous run's epochForBlock returned
 *   and of the one after it, the head's epoch picking the catalog in force.
 * Returns {run, read, subrequests}: `run` is the network's part of the run result, `read` what settleRound needs (null when
 * the beacon is not registered), and
 *   {name, ok: false, reason}                                    the registry could not be read
 *   {name, ok: true, recipe, registration: "registered" | "notbeacon" | "unregistered" | "unknown", registrationReason,
 *    verifier, slotSigner, verdict: "ok" | "mismatch" | null, verdictReason, verify: {outcome, round, reason},
 *    negative: {outcome: "rejected" | "accepted" | "unknown" | "skipped", round, reason},
 *    epoch: {id, block} | null, catalog: {epochId, hash, recipes, use} | null, notBeacons: [recipe ids]}
 * where `recipe` is the recipe monitored this run, `catalog.epochId` the epoch of the catalog read and `notBeacons` the
 * recipes seen to be signed recipes. `verify` is the caller's to fill in once the round is settled.
 */
async function readRegistry(target, preset, sample, session, head) {
  const { name, net, beacon } = target;
  const previous = target.previous ?? null;
  const called = recipeId(previous?.recipe) ?? beacon.recipe;
  const listed = Array.isArray(previous?.catalog?.recipes) ? previous.catalog.recipes.filter((id) => recipeId(id) !== null) : [];
  // A recipe that is a signed recipe stays one (recipes are only ever appended): once seen, it is not asked about again.
  const signed = new Set(Array.isArray(previous?.notBeacons) ? previous.notBeacons.filter((id) => recipeId(id) !== null) : []);
  const ids = [...new Set([called, beacon.recipe, ...listed.filter((id) => !signed.has(id))])].slice(0, LIMITS.beaconMaxRecipes);
  const epochAsked = Number.isSafeInteger(previous?.epoch?.id) && previous.epoch.id >= 0 ? previous.epoch.id : null;

  const calls = [["eth_chainId", []]];
  const call = (data) => calls.push(["eth_call", [{ to: net.registry, data }, "latest"]]) - 1;
  const at = {
    beaconOf: ids.map((id) => call(encodeBeaconOf(id))),
    slotSigner: call(encodeSlotSigner(called)),
    verify: sample.skip ? [] : sample.candidates.map((c) => call(encodeVerifyBeacon(called, sample.round, `0x${c.signature}`))),
    negative: sample.skip ? null : call(encodeVerifyBeacon(called, sample.round, `0x${flipLastByte(sample.candidates[0].signature)}`)),
    epoch: head === null ? null : call(encodeEpochForBlock(head)),
    catalog: epochAsked === null ? [] : [epochAsked, epochAsked + 1].map((id) => call(encodeCatalogAt(id))),
  };
  const items = await session.batch(calls, validateChain(net));
  const subrequests = session.subrequests;
  if (!items) return { run: { name, ok: false, reason: session.lastError ?? "all endpoints failed" }, read: null, subrequests };

  const beacons = new Map(ids.map((id, i) => [id, readBeaconOf(items[at.beaconOf[i]])]));
  for (const id of signed) if (!beacons.has(id)) beacons.set(id, { state: "notbeacon", reason: "zero verifier" });
  const epoch = at.epoch === null ? null : readEpoch(items[at.epoch]);
  // The epoch the head is in is the previous run's or the next one: it says which of the two catalogs is in force now. With no
  // answer it is the earlier one; after missed runs, when the head is further on, the later one is the nearest asked.
  const later = epochAsked !== null && epoch?.state === "ok" && epoch.id > epochAsked ? 1 : 0;
  const catalog = at.catalog.length === 0 ? null : readCatalog(items[at.catalog[later]]);
  const inForce = catalog?.state === "ok" ? catalog.recipes : recipeId(previous?.recipe) !== null ? [previous.recipe] : [];
  const recipe = chooseRecipe(beacon, preset, beacons, inForce, recipeId(previous?.recipe));
  const registration = beacons.get(recipe) ?? { state: "unknown", reason: "beaconOf: not asked" };

  const base = {
    name,
    ok: true,
    reason: null,
    recipe,
    registration: registration.state,
    registrationReason: registration.reason ?? null,
    epoch: epoch?.state === "ok" ? { id: epoch.id, block: head } : null,
    // The recipes that are signed recipes, but the ones being monitored, which are asked about every run whatever they are.
    notBeacons: [...beacons].filter(([id, answer]) => answer.state === "notbeacon" && id !== beacon.recipe && id !== called).map(([id]) => id),
    catalog:
      catalog?.state === "ok"
        ? { epochId: epochAsked + later, hash: catalog.hash, recipes: catalog.recipes, use: catalogUse(catalog.recipes, recipe, beacons, previous?.catalog?.use ?? null) }
        : null,
  };
  if (registration.state !== "registered") {
    const why = { unregistered: "beacon not registered", notbeacon: "recipe is not a beacon", unknown: "registration unknown" }[registration.state];
    const skipped = { outcome: "skipped", round: null, reason: why };
    return { run: { ...base, verifier: null, slotSigner: null, verdict: null, verdictReason: null, verify: skipped, negative: skipped }, read: null, subrequests };
  }

  const { tuple } = registration;
  // What was asked of slotSigner and verifyBeacon was about the recipe monitored last run: it says nothing of a new one.
  const asked = recipe === called;
  const signer = asked ? readSlotSigner(items[at.slotSigner]) : { state: "unknown" };
  const expected = await expectedSlotSigner(preset, beacon.verifier ?? tuple.verifier);
  const problems = compareRegistration(beacon, preset, tuple, signer, expected);
  const skip = sample.skip ?? (asked ? null : "the monitored recipe changed");
  const checks = skip ? null : at.verify.map((i) => readCheck(items[i]));
  return {
    run: {
      ...base,
      verifier: tuple.verifier,
      slotSigner: signer.state === "ok" ? signer.address : null,
      verdict: problems.length === 0 ? "ok" : "mismatch",
      verdictReason: problems.length === 0 ? null : `beaconOf(${recipe}) differs from the configured ${preset.id} beacon: ${problems.join("; ")}`,
      verify: { outcome: "skipped", round: null, reason: skip ?? "round not settled" },
      negative: skip ? { outcome: "skipped", round: null, reason: skip } : negativeOf(readCheck(items[at.negative]), sample.round),
    },
    read: { name, checks, skip },
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

/** The sample a round's answers make: what is compared, what goes to verifyBeacon, and whether one signature has a majority. */
function sampleOf(round, answers) {
  const verdict = judgeAgreement(answers, round);
  return { round, answers, verdict, candidates: verdict.groups.slice(0, LIMITS.beaconMaxSignatures), majority: verdict.majority };
}

/**
 * One group's run, in four steps: every relay's latest round (and the /info of the relays due for it); one earlier round from
 * every fresh relay, compared (or with a single fresh relay, its latest round, with nothing to compare it with); each
 * network's registry, asked to verify every distinct signature of that round; and the settling of the round (see
 * settleRound), which decides who is at fault when a registry and the relays do not agree. Returns {run, subrequests}.
 * A failure of the monitor itself (not of a relay or a registry) marks what it touched unknown: the relay reads make the group's run
 * `internal`, and a registry read a network's own.
 */
async function probeGroup(group, ctx, makeSession) {
  const { preset } = group;
  let subrequests = 0;
  let internal = false;

  // 1. Every relay's latest round, then the /info of those due for it, all under one bound.
  const due = new Set(group.info.map((entry) => entry.id));
  const tasks = [
    ...group.relays.map((relay) => ({ relay, kind: "latest" })),
    ...group.relays.filter((relay) => due.has(relay.id)).map((relay) => ({ relay, kind: "info" })),
  ];
  const failed = () => ({ ok: false, reason: "internal error", internal: true, latencyMs: null, at: Math.floor(ctx.clock() / 1000), outcome: "failure" });
  const replies = await mapBounded(
    tasks,
    LIMITS.beaconConcurrency,
    (task) => (task.kind === "latest" ? fetchRound(task.relay, preset, "latest", ctx) : fetchInfo(task.relay, preset, ctx)),
    failed,
  );
  subrequests += tasks.length;
  if (replies.some((reply) => reply.internal)) internal = true;
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
    const [only] = fresh;
    sample = sampleOf(only.round, [{ id: only.id, signature: latest.get(only.id).signature }]);
  } else if (fresh.length >= 2 && Math.min(...fresh.map((run) => run.round)) > 1) {
    const round = Math.min(...fresh.map((run) => run.round)) - 1;
    commonRound = round;
    const byId = new Map(group.relays.map((relay) => [relay.id, relay]));
    const second = await mapBounded(fresh, LIMITS.beaconConcurrency, (run) => fetchRound(byId.get(run.id), preset, round, ctx), failed);
    subrequests += fresh.length;
    if (second.some((reply) => reply.internal)) internal = true;
    const answers = [];
    fresh.forEach((run, i) => {
      if (second[i].ok) answers.push({ id: run.id, signature: second[i].signature });
      else run.agreement = { outcome: "failure", round, reason: second[i].reason };
    });
    sample = answers.length > 0 ? sampleOf(round, answers) : { skip: "no relay returned the common round" };
  }

  // 3. Each network's registry: its registration of the beacon, the round's signatures, the epoch and the catalog.
  const reads = await Promise.all(
    group.networks.map(async (target) => {
      let session;
      try {
        const head = await Promise.resolve(ctx.headOf?.(target.name)).catch(() => null);
        session = makeSession(target.net);
        return await readRegistry(target, preset, sample, session, Number.isSafeInteger(head) && head >= 0 ? head : null);
      } catch {
        return { run: { name: target.name, ok: false, reason: "internal error", internal: true }, read: null, subrequests: session?.subrequests ?? 0 };
      }
    }),
  );
  subrequests += reads.reduce((sum, r) => sum + r.subrequests, 0);

  // 4. Settle the round: which signature is the round's, and so whose fault a rejection is.
  const settled = sample.skip ? null : settleRound(sample, reads.map((r) => r.read).filter(Boolean));
  for (const { run, read } of reads) if (read) run.verify = settled ? settled.verify[read.name] : { outcome: "skipped", round: null, reason: sample.skip };
  if (settled) {
    for (const run of runs) {
      const agreement = settled.agreements.get(run.id);
      if (agreement) run.agreement = agreement;
    }
  }

  // Every relay unreachable while no registry answered either may be the watchdog's own network: it says nothing about the relays.
  if (!reads.some((r) => r.run.ok) && runs.every((run) => run.outcome === "failure" && run.transport)) {
    for (const run of runs) {
      run.outcome = "unknown";
      run.reason = `${run.reason}, and no registry answered either`;
    }
  }

  return {
    subrequests,
    run: {
      preset: preset.id,
      commonRound,
      sampleRound: sample.round ?? null,
      internal,
      relays: runs.map(({ transport, ...run }) => run),
      networks: reads.map((r) => r.run),
    },
  };
}

/** A group's part of a run that produced nothing (the monitor itself failed): every relay unknown, no registry read. */
function failedGroupRun(group, reason) {
  return {
    preset: group.preset.id,
    commonRound: null,
    sampleRound: null,
    internal: true,
    relays: group.relays.map((relay) => ({ id: relay.id, outcome: "unknown", reason, round: null, lagRounds: null, latencyMs: null, agreement: null, info: null })),
    networks: group.networks.map((target) => ({ name: target.name, ok: false, reason, internal: true })),
  };
}

export const failedBeaconRun = (plan, reason = "internal error") => ({ subrequests: 0, groups: plan.groups.map((group) => failedGroupRun(group, reason)) });

/**
 * Run a plan (see planBeacon): {subrequests, groups: [{preset, commonRound, sampleRound, internal, relays: [...], networks:
 * [...]}]}, aligned with plan.groups, and in each with the group's relays and networks. Never throws.
 * `createSession(net)` makes the JSON-RPC session for a network; the default is the chain reader's RpcSession, with its reply
 * size bounded. `headOf(name)` gives a network's head block, or null: it is this run's chain read of the network.
 */
export async function runBeacon(plan, { fetch, clock = () => Date.now(), timeoutMs = LIMITS.beaconTimeoutMs, createSession, headOf } = {}) {
  const ctx = { fetch, clock, timeoutMs, headOf };
  const makeSession =
    createSession ?? ((net) => new RpcSession(net.rpcs, { fetch, timeoutMs: LIMITS.rpcTimeoutMs, maxBytes: LIMITS.beaconRpcMaxResponseBytes }));
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
//   group    {checkedAt, fresh, total, downRuns, lastFreshAt, latestRound, commonRound, monitor, relays: {id: relay}}
//   relay    {checkedAt, latencyMs, outcome, reason, round, lagRounds, badRuns, lastOkAt,
//             agreement: {checkedAt, round, outcome, reason, verdict, verdictReason},
//             info: {checkedAt, latencyMs, outcome, reason, verdict, verdictReason, nextCheckAt}}
//   network  {checkedAt, readOk, readReason, recipe, registration, registrationReason, everRegistered, unregisteredRuns,
//             verifier, slotSigner, verdict, verdictReason,
//             verify: {checkedAt, outcome, round, reason, failures, rejectedRound, rejectedReason, lastOkAt},
//             negative: {checkedAt, outcome, round, reason, verdict}, epoch: {id, block, checkedAt},
//             catalog: {epochId, hash, recipes, use, checkedAt}, notBeacons: [recipe ids], monitor}
// `badRuns` counts consecutive runs in which a relay was not fresh, `downRuns` those in which no relay was. A run in which the
// monitor itself failed, or every relay was unreachable and the watchdog's own network is unproven, is "unknown": it adds to
// neither. `monitor` ({at, reason}) is set in a run in which the monitor itself failed. A verdict is the latest conclusive
// result: an unusable answer says nothing about whether a difference was fixed, so it keeps it.

const kept = (failed, verdict, previous) => (failed ? previous ?? null : verdict);

export function applyRelayRun(previous, run, now, phase) {
  const prev = previous ?? {};
  const fresh = run.outcome === "fresh";
  const next =
    run.outcome === "unknown"
      ? // Nothing was learned: the streak of runs it was not fresh in, and what it last served, stay.
        { ...prev, checkedAt: now, outcome: "unknown", reason: run.reason ?? null }
      : {
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
      verdict: kept(failed, a.outcome === "agree" ? "ok" : a.outcome === "rejected" ? "rejected" : "differs", prev.agreement?.verdict),
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
      // A read that failed, or found a difference, is repeated within the hour: one stale answer should not stand for a day.
      nextCheckAt: i.outcome === "ok" ? nextSlot(now, phase, LIMITS.beaconInfoIntervalSeconds) : now + LIMITS.beaconInfoRetrySeconds,
    };
  }
  return next;
}

/** The group's own figures; the caller adds the relays' states. */
export function applyGroupRun(previous, run, now) {
  const fresh = run.relays.filter((relay) => relay.outcome === "fresh");
  const monitor = run.internal ? { at: now, reason: "internal error" } : null;
  if (fresh.length === 0 && run.relays.some((relay) => relay.outcome === "unknown")) {
    // Whether any relay is fresh is not known: the streak without one, and the figures of the last known run, stay.
    return {
      checkedAt: now,
      fresh: previous?.fresh ?? null,
      total: run.relays.length,
      downRuns: previous?.downRuns ?? 0,
      lastFreshAt: previous?.lastFreshAt ?? null,
      latestRound: previous?.latestRound ?? null,
      commonRound: previous?.commonRound ?? null,
      monitor,
    };
  }
  return {
    checkedAt: now,
    fresh: fresh.length,
    total: run.relays.length,
    downRuns: fresh.length === 0 ? (previous?.downRuns ?? 0) + 1 : 0,
    lastFreshAt: fresh.length > 0 ? now : previous?.lastFreshAt ?? null,
    latestRound: fresh.length > 0 ? Math.max(...fresh.map((relay) => relay.round)) : null,
    commonRound: run.commonRound ?? null,
    monitor,
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
      // "uncorroborated" (a rejection of a signature no other relay or registry backs: the relay is the suspect), "unknown" and
      // "skipped" add no evidence either way: the streak of rejections, and what it is about, stay.
      return { ...prev, ...latest };
  }
}

/** The check that a signature with its last byte flipped is rejected: its verdict is the latest conclusive result. */
function applyNegative(previous, negative, now) {
  const latest = { checkedAt: now, outcome: negative.outcome, round: negative.round ?? null, reason: negative.reason ?? null };
  if (negative.outcome === "rejected") return { ...latest, verdict: "ok" };
  if (negative.outcome === "accepted") return { ...latest, verdict: "accepts" };
  return { ...(previous ?? {}), ...latest };
}

export function applyNetworkRun(previous, run, now) {
  const prev = previous ?? {};
  const monitor = run.internal ? { at: now, reason: run.reason ?? "internal error" } : null;
  // A registry that could not be read says nothing new: what was last known stays, marked as not read this run.
  if (!run.ok) return { ...prev, checkedAt: now, readOk: false, readReason: run.reason ?? "unknown", monitor };
  // What was read of the epoch and the catalog stands whatever beaconOf said, and a recipe seen to be a signed recipe stays one.
  const chain = {
    epoch: run.epoch ? { ...run.epoch, checkedAt: now } : prev.epoch ?? null,
    catalog: run.catalog ? { ...run.catalog, checkedAt: now } : prev.catalog ?? null,
    notBeacons: [...new Set([...(prev.notBeacons ?? []), ...(run.notBeacons ?? [])])].sort((a, b) => a - b),
  };
  // An answer to beaconOf that is no answer says nothing either.
  if (run.registration === "unknown") {
    return { ...prev, ...chain, recipe: prev.recipe ?? run.recipe, checkedAt: now, readOk: false, readReason: run.registrationReason ?? "unknown", monitor };
  }
  const registered = run.registration === "registered";
  if (run.registration === "unregistered" && prev.registration === "registered") {
    const runs = (prev.unregisteredRuns ?? 0) + 1;
    // One revert is not a lost registration (a node that is behind, a rollback quickly undone): what was known stands until
    // the next run says the same.
    if (runs < THRESHOLDS.beaconUnregisteredRuns) {
      return { ...prev, ...chain, recipe: run.recipe, checkedAt: now, readOk: true, readReason: null, unregisteredRuns: runs, monitor };
    }
  }
  const verify = applyVerify(prev.verify, run.verify, now);
  return {
    ...prev,
    ...chain,
    recipe: run.recipe,
    checkedAt: now,
    readOk: true,
    readReason: null,
    registration: run.registration,
    registrationReason: run.registrationReason ?? null,
    everRegistered: prev.everRegistered === true || registered,
    unregisteredRuns: run.registration === "unregistered" ? (prev.unregisteredRuns ?? 0) + 1 : 0,
    verifier: registered ? run.verifier : null,
    slotSigner: registered ? run.slotSigner : null,
    verdict: registered ? run.verdict : null,
    verdictReason: registered ? run.verdictReason : null,
    // Nothing to verify against a beacon that is not registered: its streak of rejections ends.
    verify: registered ? verify : { ...verify, failures: 0 },
    negative: registered ? applyNegative(prev.negative, run.negative ?? { outcome: "skipped", round: null, reason: null }, now) : null,
    monitor,
  };
}
