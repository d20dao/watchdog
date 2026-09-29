// Test helpers for the drand beacon monitor: the real chain data, a fake drand network and a fake registry.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { roundTime } from "../src/beacon.js";
import { DRAND_EVMNET, DRAND_RELAYS, NETWORKS } from "../src/config.js";
import { addressWord, word } from "./helpers.js";

/**
 * Real drand evmnet data fetched on 2026-09-29 from api.drand.sh, api2.drand.sh, api3.drand.sh and drand.cloudflare.com
 * (all four served identical chain info and round records): {source, info, rounds: [{round, randomness, signature}]
 * for rounds 1, 21056714, 21056750 and 21056968, messagePoints}. The file is a byte for byte copy of
 * test/fixtures/drand-evmnet-2026-09-29.json in the keeper repository, where it feeds the protocol library's tests.
 */
export const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/drand-evmnet-2026-09-29.json", import.meta.url), "utf8"));

export const PRESET = DRAND_EVMNET;
export const LAST_REAL_ROUND = FIXTURE.rounds.at(-1).round; // 21056968
/** One second after the last real round was due: it is the round due now. */
export const NOW = roundTime(PRESET, LAST_REAL_ROUND) + 1;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * The record a relay serves for `round`: the real one when the fixture has it, otherwise a made-up one of the right
 * shape (the monitor never verifies a signature itself: the registry does).
 */
export function roundRecord(round, salt = "") {
  const real = FIXTURE.rounds.find((r) => r.round === round);
  if (real && salt === "") return { ...real };
  const signature = sha256(`signature ${round} ${salt}`) + sha256(`signature ${round} ${salt} more`);
  return { round, randomness: sha256(Buffer.from(signature, "hex")), signature };
}

// ---------------------------------------------------------------------------------------------
// A fake drand network

const RELAY_HOSTS = DRAND_RELAYS.map((url) => new URL(url).host);
const HASH = PRESET.chainHash;

/**
 * Every relay of the configuration serving the chain as of `world.now` (seconds). `world.relays[host]` steers one relay:
 *   lag           rounds behind the schedule (default 0)
 *   status        answer every request with this HTTP status; roundStatus and infoStatus do so for one kind only
 *   hang          never answer (until the request is aborted)
 *   salt          serve other signatures than the real ones (a relay that disagrees)
 *   info          fields of /info to replace
 *   body(kind, record)   the reply text for a "latest", "round" or "info" request, instead of the JSON of `record`
 * `world.calls` records every drand request as {host, kind, round?}.
 */
export function drandWorld({ now = NOW } = {}) {
  const world = { now, calls: [], relays: Object.fromEntries(RELAY_HOSTS.map((host) => [host, {}])) };
  world.answer = async (url, init) => {
    const u = new URL(url);
    const r = world.relays[u.host];
    const match = new RegExp(`^/${HASH}/(info|public/(latest|[0-9]+))$`).exec(u.pathname);
    if (!match) return new Response("not found", { status: 404 });
    const kind = match[1] === "info" ? "info" : match[2] === "latest" ? "latest" : "round";
    world.calls.push({ host: u.host, kind, ...(kind === "round" ? { round: Number(match[2]) } : {}) });
    if (r.hang) {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (r.status || (kind === "round" && r.roundStatus) || (kind === "info" && r.infoStatus)) {
      return new Response("", { status: r.status ?? (kind === "round" ? r.roundStatus : r.infoStatus) });
    }
    const latest = Math.floor((world.now - PRESET.genesis) / PRESET.period) + 1 - (r.lag ?? 0);
    let record;
    if (kind === "info") record = { ...FIXTURE.info, ...(r.info ?? {}) };
    else if (kind === "latest") record = roundRecord(latest, r.salt);
    else if (Number(match[2]) > latest) return new Response("Too early", { status: 425 });
    else record = roundRecord(Number(match[2]), r.salt);
    const text = r.body ? r.body(kind, record) : JSON.stringify(record);
    return new Response(typeof text === "string" ? text : JSON.stringify(text));
  };
  return world;
}

// ---------------------------------------------------------------------------------------------
// A fake registry

const ZERO_ADDRESS = "0x" + "0".repeat(40);
export const VERIFIER = "0x" + "ab".repeat(20); // a made-up verifier contract: none is deployed yet

/** The tuple beaconOf returns for a beacon registered as the configuration says. */
export const registeredBeacon = (overrides = {}) => ({
  verifier: VERIFIER,
  genesis: PRESET.genesis,
  period: PRESET.period,
  chainHash: `0x${PRESET.chainHash}`,
  publicKey: `0x${PRESET.publicKey}`,
  ...overrides,
});

/** What beaconOf returns for a recipe that is no beacon. */
export const ZERO_BEACON = Object.freeze({ verifier: ZERO_ADDRESS, genesis: 0, period: 0, chainHash: "0x" + "0".repeat(64), publicKey: "0x" });

/** abi.encode of the beaconOf tuple, as the return data of the call. */
export function encodeBeaconOfResult({ verifier, genesis, period, chainHash, publicKey }) {
  const key = publicKey.replace(/^0x/, "");
  const padded = key.padEnd(Math.ceil(key.length / 64) * 64, "0");
  return "0x" + word(32) + addressWord(verifier) + word(genesis) + word(period) + chainHash.replace(/^0x/, "") + word(160) + word(key.length / 2) + padded;
}

/**
 * The signer the registry derives for a beacon slot, written out here on its own with Buffers:
 * address(uint160(uint256(keccak256(abi.encode(keccak256("D20_EPOCH_BEACON"), verifier, chainHash, keccak256(publicKey),
 * genesis, period))))).
 */
export function slotSignerFor({ verifier, chainHash, publicKey, genesis, period }) {
  const hex = (text) => Buffer.from(text.replace(/^0x/, ""), "hex");
  const padded = (buffer) => Buffer.concat([Buffer.alloc(32 - buffer.length), buffer]);
  const uint64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return padded(b);
  };
  const preimage = Buffer.concat([
    Buffer.from(keccak_256(new TextEncoder().encode("D20_EPOCH_BEACON"))),
    padded(hex(verifier)),
    hex(chainHash),
    Buffer.from(keccak_256(hex(publicKey))),
    uint64(genesis),
    uint64(period),
  ]);
  return "0x" + Buffer.from(keccak_256(preimage)).subarray(12).toString("hex");
}

/**
 * The registry of `net` answering JSON-RPC batches. `registry` steers it:
 *   beaconOf    "revert" | a tuple (see registeredBeacon, ZERO_BEACON) | "0x" for empty return data
 *   slotSigner  "revert" | an address; by default the signer derived from beaconOf's tuple
 *   verify      true | false | "revert"
 *   error       a JSON-RPC error object answered for every call but eth_chainId, instead
 *   chainId     the chain id to answer with, when not the network's
 *   down        answer every request with this HTTP status
 * `registry.calls` records the calls as {method, recipe?, round?, signature?}.
 */
export function registryOf(net) {
  const registry = { beaconOf: "revert", verify: true, calls: [] };
  registry.answer = (item) => {
    if (item.method === "eth_chainId") return { result: "0x" + BigInt(registry.chainId ?? net.chainId).toString(16) };
    if (registry.error) return { error: registry.error };
    const { to, data } = item.params[0];
    if (to.toLowerCase() !== net.registry.toLowerCase()) throw new Error(`call to ${to}, not the registry`);
    // What both Arc RPC endpoints answered for beaconOf on the registry before the upgrade, 2026-09-29.
    const revert = { error: { code: 3, message: "execution reverted" } };
    const selector = data.slice(0, 10);
    if (selector === "0x87533a48") {
      registry.calls.push({ method: "beaconOf", recipe: Number(BigInt("0x" + data.slice(10))) });
      return registry.beaconOf === "revert" ? revert : { result: registry.beaconOf === "0x" ? "0x" : encodeBeaconOfResult(registry.beaconOf) };
    }
    if (selector === "0xb42be3c1") {
      registry.calls.push({ method: "slotSigner", recipe: Number(BigInt("0x" + data.slice(10))) });
      if (registry.slotSigner === "revert" || registry.beaconOf === "revert" || registry.beaconOf === "0x") return revert;
      return { result: "0x" + addressWord(registry.slotSigner ?? slotSignerFor(registry.beaconOf)) };
    }
    if (selector === "0x0ccd9ab2") {
      const args = data.slice(10);
      const length = Number(BigInt("0x" + args.slice(192, 256)));
      registry.calls.push({
        method: "verifyBeacon",
        recipe: Number(BigInt("0x" + args.slice(0, 64))),
        round: Number(BigInt("0x" + args.slice(64, 128))),
        offset: Number(BigInt("0x" + args.slice(128, 192))),
        signature: args.slice(256, 256 + length * 2),
      });
      return registry.verify === "revert" ? revert : { result: "0x" + word(registry.verify ? 1 : 0) };
    }
    throw new Error("unexpected call " + data);
  };
  return registry;
}

/**
 * One fetch for the whole beacon monitor: the drand relays of `world` and the registries of `networks` (a map name ->
 * registryOf()) behind the networks' RPC endpoints. `rpcCalls` records the endpoints' requests as {url, count}.
 */
export function beaconFetch(world, registries, { telegram } = {}) {
  const endpoints = new Map();
  for (const net of Object.values(NETWORKS)) for (const url of net.rpcs) endpoints.set(url, net.name);
  const rpcCalls = [];
  const fetch = async (url, init) => {
    if (new URL(url).host in world.relays) return world.answer(url, init);
    if (endpoints.has(url)) {
      const registry = registries[endpoints.get(url)];
      const batch = JSON.parse(init.body);
      rpcCalls.push({ url, count: batch.length });
      if (registry.down) return new Response("", { status: registry.down });
      return Response.json(
        batch.map((item) => {
          const answer = registry.answer(item);
          return { jsonrpc: "2.0", id: item.id, ...answer };
        }),
      );
    }
    if (url.startsWith("https://api.telegram.org/") && telegram) return telegram(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, rpcCalls };
}
