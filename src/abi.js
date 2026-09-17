// Minimal hand-rolled ABI helpers for the few calls and events the watchdog reads.
// Every decoder validates lengths and word ranges and throws AbiError on malformed data.

import { SELECTORS, TOPICS } from "./config.js";

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
