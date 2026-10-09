// Minimal hand-rolled ABI helpers for the few calls and events the watchdog reads.
// Every decoder validates lengths and word ranges and throws AbiError on malformed data.

import { ROUND_SELECTORS, SELECTORS, TOPICS } from "./config.js";

export class AbiError extends Error {}

const HEX = /^0x[0-9a-fA-F]*$/;
const UINT256_MAX = (1n << 256n) - 1n;
const WORD = 64;

function strip(hex) {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new AbiError("not hex");
  return hex.slice(2);
}

/** Parse a JSON-RPC quantity or data string into a BigInt ("0x" is zero). */
export function hexToBigInt(hex) {
  const body = strip(hex);
  return body.length === 0 ? 0n : BigInt("0x" + body);
}

/** Parse a JSON-RPC quantity that must fit a JavaScript safe integer. */
export function hexToSafeNumber(hex) {
  const value = hexToBigInt(hex);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AbiError("quantity too large");
  return Number(value);
}

export function toQuantity(value) {
  const v = BigInt(value);
  if (v < 0n) throw new AbiError("negative quantity");
  return "0x" + v.toString(16);
}

export function encodeUint256(value) {
  const v = BigInt(value);
  if (v < 0n || v > UINT256_MAX) throw new AbiError("uint256 out of range");
  return v.toString(16).padStart(WORD, "0");
}

export function encodeCall(selector, ...uints) {
  if (!/^0x[0-9a-f]{8}$/.test(selector)) throw new AbiError("bad selector");
  return selector + uints.map(encodeUint256).join("");
}

export function encodeGetPendingRequestIds(fromId, limit) {
  return encodeCall(SELECTORS.getPendingRequestIds, fromId, limit);
}

export function encodeGetRequest(requestId) {
  return encodeCall(SELECTORS.getRequest, requestId);
}

/** Split ABI return data into 64-hex-character words. */
export function toWords(hex) {
  const body = strip(hex);
  if (body.length % WORD !== 0) throw new AbiError("data is not word aligned");
  const words = [];
  for (let i = 0; i < body.length; i += WORD) words.push(body.slice(i, i + WORD));
  return words;
}

function wordToBigInt(word) {
  return BigInt("0x" + word);
}

function wordToAddress(word) {
  if (!/^0{24}/.test(word)) throw new AbiError("address has dirty high bits");
  return "0x" + word.slice(24).toLowerCase();
}

function wordToBool(word) {
  const v = wordToBigInt(word);
  if (v > 1n) throw new AbiError("bool out of range");
  return v === 1n;
}

function wordToUint(word, bits) {
  const v = wordToBigInt(word);
  if (bits < 256 && v >> BigInt(bits) !== 0n) throw new AbiError(`uint${bits} out of range`);
  return v;
}

function wordToSmallNumber(word, bits) {
  const v = wordToUint(word, bits);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new AbiError("value exceeds safe integer");
  return Number(v);
}

/** Decode a single uint256 return value (e.g. nextRequestId()). */
export function decodeUint256(hex) {
  const words = toWords(hex);
  if (words.length !== 1) throw new AbiError("expected one word");
  return wordToBigInt(words[0]);
}

/** Decode a single address return value or storage slot holding an address. */
export function decodeAddress(hex) {
  const words = toWords(hex);
  if (words.length !== 1) throw new AbiError("expected one word");
  return wordToAddress(words[0]);
}

/** Decode a single bool return value (e.g. verifyBeacon). */
export function decodeBool(hex) {
  const words = toWords(hex);
  if (words.length !== 1) throw new AbiError("expected one word");
  return wordToBool(words[0]);
}

/** Decode a single uint64 return value that fits a safe integer (e.g. epochForBlock). */
export function decodeUint64(hex) {
  const words = toWords(hex);
  if (words.length !== 1) throw new AbiError("expected one word");
  return wordToSmallNumber(words[0], 64);
}

// ---------------------------------------------------------------------------------------------
// EpochEntropy beacon functions

/** epochForBlock(uint256 blockNumber) -> uint64 epochId */
export function encodeEpochForBlock(block) {
  return encodeCall(SELECTORS.epochForBlock, block);
}

/** catalogAt(uint64 epochId) -> (bytes32 hash, uint8[] recipes, address[] signers) */
export function encodeCatalogAt(epochId) {
  const id = BigInt(epochId);
  if (id < 0n || id >= 1n << 64n) throw new AbiError("epoch is not a uint64");
  return encodeCall(SELECTORS.catalogAt, id);
}

function encodeRecipe(recipe) {
  const id = BigInt(recipe);
  if (id < 0n || id > 255n) throw new AbiError("recipe is not a uint8");
  return id;
}

/** beaconOf(uint8 recipe) */
export function encodeBeaconOf(recipe) {
  return encodeCall(SELECTORS.beaconOf, encodeRecipe(recipe));
}

/** slotSigner(uint8 recipe) */
export function encodeSlotSigner(recipe) {
  return encodeCall(SELECTORS.slotSigner, encodeRecipe(recipe));
}

/** verifyBeacon(uint8 recipe, uint64 round, bytes signature), the signature as 0x-prefixed hex of whole bytes. */
export function encodeVerifyBeacon(recipe, round, signature) {
  const id = encodeRecipe(recipe);
  const r = BigInt(round);
  if (r < 0n || r >= 1n << 64n) throw new AbiError("round is not a uint64");
  const data = strip(signature);
  if (data.length % 2 !== 0) throw new AbiError("signature is not whole bytes");
  // Three head words (recipe, round, offset of the bytes), then the bytes' length and the data padded to whole words.
  const padded = data.padEnd(Math.ceil(data.length / WORD) * WORD, "0");
  return encodeCall(SELECTORS.verifyBeacon, id, r, 3n * 32n, BigInt(data.length / 2)) + padded;
}

/** A byte offset word, relative to word `base`, as an index into `limit` words. */
function offsetToIndex(word, base, limit, what) {
  const offset = wordToBigInt(word);
  if (offset % 32n !== 0n || offset > BigInt(limit) * 32n) throw new AbiError(`${what} is misaligned or out of bounds`);
  const index = base + Number(offset / 32n);
  if (index >= limit) throw new AbiError(`${what} is out of bounds`);
  return index;
}

/**
 * beaconOf(uint8) -> (address verifier, uint64 genesis, uint64 period, bytes32 chainHash, bytes publicKey). The tuple
 * is dynamic, so the return data is its offset, its five head words and the key's length and bytes. A recipe that is
 * not a beacon returns the zero tuple with an empty key.
 */
export function decodeBeaconOf(hex, maxKeyBytes = 256) {
  const w = toWords(hex);
  if (w.length < 7) throw new AbiError("beacon data too short");
  const start = offsetToIndex(w[0], 0, w.length, "tuple offset");
  if (start + 5 > w.length) throw new AbiError("beacon tuple exceeds data");
  const at = offsetToIndex(w[start + 4], start, w.length, "key offset");
  const length = wordToBigInt(w[at]);
  if (length > BigInt(maxKeyBytes)) throw new AbiError("key too long");
  const size = Number(length);
  const end = at + 1 + Math.ceil(size / 32);
  if (end > w.length) throw new AbiError("key exceeds data");
  const body = w.slice(at + 1, end).join("");
  if (/[^0]/.test(body.slice(size * 2))) throw new AbiError("key padding is not zero");
  // Hex as the node wrote it may be upper case: everything is returned lowercase, like the address.
  return {
    verifier: wordToAddress(w[start]),
    genesis: wordToSmallNumber(w[start + 1], 64),
    period: wordToSmallNumber(w[start + 2], 64),
    chainHash: "0x" + w[start + 3].toLowerCase(),
    publicKey: "0x" + body.slice(0, size * 2).toLowerCase(),
  };
}

/**
 * catalogAt(uint64) -> (bytes32 hash, uint8[] recipes, address[] signers): the sources an epoch selects from, one slot per
 * entry. The head is the hash and the offsets of the two arrays; each array is its length and one word per entry.
 */
export function decodeCatalogAt(hex, maxSlots = 64) {
  const w = toWords(hex);
  if (w.length < 5) throw new AbiError("catalog data too short");
  const array = (offsetWord, what) => {
    const at = offsetToIndex(offsetWord, 0, w.length, `${what} offset`);
    const length = wordToBigInt(w[at]);
    if (length > BigInt(maxSlots)) throw new AbiError(`${what} too long`);
    const size = Number(length);
    if (at + 1 + size > w.length) throw new AbiError(`${what} exceed data`);
    return w.slice(at + 1, at + 1 + size);
  };
  const recipes = array(w[1], "recipes").map((word) => wordToSmallNumber(word, 8));
  const signers = array(w[2], "signers").map(wordToAddress);
  return { hash: "0x" + w[0].toLowerCase(), recipes, signers };
}

/** getPendingRequestIds(uint256,uint256) -> (uint256[] ids, uint256 nextCursor) */
export function decodePendingRequestIds(hex, maxLength = 256) {
  const words = toWords(hex);
  if (words.length < 3) throw new AbiError("pending ids data too short");
  const offset = wordToBigInt(words[0]);
  if (offset % 32n !== 0n) throw new AbiError("array offset not aligned");
  const lengthIndex = Number(offset / 32n);
  if (offset > BigInt(words.length * 32) || lengthIndex < 2 || lengthIndex >= words.length) {
    throw new AbiError("array offset out of bounds");
  }
  const nextCursor = wordToBigInt(words[1]);
  const length = wordToBigInt(words[lengthIndex]);
  if (length > BigInt(maxLength)) throw new AbiError("array too long");
  const count = Number(length);
  if (lengthIndex + 1 + count > words.length) throw new AbiError("array exceeds data");
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(wordToBigInt(words[lengthIndex + 1 + i]));
  return { ids, nextCursor };
}

export const REQUEST_FIELDS = Object.freeze([
  "consumer",
  "callbackGasLimit",
  "requestBlock",
  "targetBlock",
  "deadline",
  "refundAddress",
  "clientSeed",
  "mappingHash",
  "blockHash",
  "randomness",
  "proofHash",
  "transcriptHash",
  "fulfilled",
  "delivered",
  "refunded",
  "epochId",
  "epochHash",
]);

/** getRequest(uint256) -> static Request tuple of 17 words. */
export function decodeRequest(hex) {
  const w = toWords(hex);
  if (w.length !== REQUEST_FIELDS.length) throw new AbiError("request tuple must be 17 words");
  return {
    consumer: wordToAddress(w[0]),
    callbackGasLimit: wordToSmallNumber(w[1], 32),
    requestBlock: wordToSmallNumber(w[2], 64),
    targetBlock: wordToSmallNumber(w[3], 64),
    deadline: wordToSmallNumber(w[4], 64),
    refundAddress: wordToAddress(w[5]),
    clientSeed: "0x" + w[6],
    mappingHash: "0x" + w[7],
    blockHash: "0x" + w[8],
    randomness: "0x" + w[9],
    proofHash: "0x" + w[10],
    transcriptHash: "0x" + w[11],
    fulfilled: wordToBool(w[12]),
    delivered: wordToBool(w[13]),
    refunded: wordToBool(w[14]),
    epochId: wordToSmallNumber(w[15], 64),
    epochHash: "0x" + w[16],
  };
}

function topicWord(topic) {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new AbiError("bad topic");
  return topic.slice(2).toLowerCase();
}

/**
 * Decode a coordinator log into a refund or fulfillment record.
 * Returns null for logs with other topics.
 */
export function decodeCoordinatorLog(log) {
  if (!log || typeof log !== "object" || !Array.isArray(log.topics) || log.topics.length === 0) {
    throw new AbiError("bad log");
  }
  const topic0 = "0x" + topicWord(log.topics[0]);
  const base = () => {
    if (log.topics.length !== 3) throw new AbiError("unexpected topic count");
    return {
      requestId: wordToBigInt(topicWord(log.topics[1])),
      blockNumber: log.blockNumber == null ? null : hexToSafeNumber(log.blockNumber),
      transactionHash: typeof log.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)
        ? log.transactionHash.toLowerCase()
        : null,
    };
  };
  if (topic0 === TOPICS.requestRefundedTo) {
    const record = base();
    const data = toWords(log.data ?? "0x");
    if (data.length !== 2) throw new AbiError("refund data must be 2 words");
    return {
      kind: "refund",
      ...record,
      refundAddress: wordToAddress(topicWord(log.topics[2])),
      amountWei: wordToBigInt(data[0]),
      paid: wordToBool(data[1]),
    };
  }
  if (topic0 === TOPICS.randomnessFulfilled) {
    const record = base();
    const data = toWords(log.data ?? "0x");
    if (data.length !== 1) throw new AbiError("fulfillment data must be 1 word");
    return {
      kind: "fulfilled",
      ...record,
      randomness: "0x" + data[0],
      submitter: wordToAddress(topicWord(log.topics[2])),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Round coordinator (D20VRFCoordinatorRobinhood)

export function encodeGetRoundRequest(requestId) {
  return encodeCall(ROUND_SELECTORS.getRoundRequest, requestId);
}

/** isBackupKeeper(address) */
export function encodeIsBackupKeeper(address) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new AbiError("not an address");
  return ROUND_SELECTORS.isBackupKeeper + address.slice(2).toLowerCase().padStart(WORD, "0");
}

/** beaconIdentity(uint8) */
export function encodeBeaconIdentity(beaconId) {
  return encodeCall(ROUND_SELECTORS.beaconIdentity, encodeRecipe(beaconId));
}

/** A single bytes32 return value, lowercase. */
export function decodeBytes32(hex) {
  const words = toWords(hex);
  if (words.length !== 1) throw new AbiError("expected one word");
  return "0x" + words[0].toLowerCase();
}

/** A single uint16 return value (keeperFeeBps, refundBps). */
export function decodeUint16(hex) {
  const words = toWords(hex);
  if (words.length !== 1) throw new AbiError("expected one word");
  return wordToSmallNumber(words[0], 16);
}

/** pricing() -> (uint256 minFee, uint16 feeMultiplier, uint32 fulfillGasOverhead) */
export function decodePricing(hex) {
  const w = toWords(hex);
  if (w.length !== 3) throw new AbiError("pricing must be 3 words");
  return { minFeeWei: wordToBigInt(w[0]), feeMultiplier: wordToSmallNumber(w[1], 16), fulfillGasOverhead: wordToSmallNumber(w[2], 32) };
}

/** beaconSchedule() -> (uint8 beaconId, uint64 since, uint8 nextBeaconId, uint64 nextFrom); nextFrom 0 is no pending change. */
export function decodeBeaconSchedule(hex) {
  const w = toWords(hex);
  if (w.length !== 4) throw new AbiError("beacon schedule must be 4 words");
  return {
    beaconId: wordToSmallNumber(w[0], 8),
    since: wordToSmallNumber(w[1], 64),
    nextBeaconId: wordToSmallNumber(w[2], 8),
    nextFrom: wordToSmallNumber(w[3], 64),
  };
}

export const ROUND_REQUEST_FIELDS = Object.freeze([
  "consumer",
  "callbackGasLimit",
  "requestBlock",
  "deadline",
  "refundAddress",
  "clientSeed",
  "mappingHash",
  "beaconId",
  "round",
  "roundRandomness",
  "randomness",
  "proofHash",
  "transcriptHash",
  "feePaid",
  "fulfilled",
  "delivered",
  "refunded",
]);

/** getRoundRequest(uint256) -> static RoundRequest tuple of 17 words. Only the fields the watchdog uses are returned. */
export function decodeRoundRequest(hex) {
  const w = toWords(hex);
  if (w.length !== ROUND_REQUEST_FIELDS.length) throw new AbiError("round request tuple must be 17 words");
  return {
    consumer: wordToAddress(w[0]),
    callbackGasLimit: wordToSmallNumber(w[1], 32),
    deadline: wordToSmallNumber(w[3], 64),
    refundAddress: wordToAddress(w[4]),
    beaconId: wordToSmallNumber(w[7], 8),
    round: wordToSmallNumber(w[8], 64),
    feePaidWei: wordToUint(w[13], 256),
    fulfilled: wordToBool(w[14]),
    delivered: wordToBool(w[15]),
    refunded: wordToBool(w[16]),
  };
}
