// AirnodeHub listing probes, network and signature part. src/cron.js loads this module on demand, only in the
// Durable Object and only when a probe is due, so @noble/curves and @noble/hashes never run in the Worker entry.
// Replies are reduced to an outcome and a short reason here; reply bodies are never logged or stored.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { LIMITS, THRESHOLDS } from "./config.js";
import { canonicalRequest, checkListingDocument, describeShape, failedTaskResult, shapeMismatch } from "./listings.js";
import { FetchTimeoutError, ResponseTooLargeError, fetchText } from "./net.js";

const encoder = new TextEncoder();
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;
const ENVELOPE = ["airnode", "requestHash", "timestamp", "data", "signature"];
const ETH_MESSAGE_PREFIX = encoder.encode("\x19Ethereum Signed Message:\n32");
const USER_AGENT = "d20dao-watchdog (+https://watchdog.d20dao.org)";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function bytesToHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** 0x-prefixed, even-length hex (already validated by the caller) to bytes. */
export function hexToBytes(hex) {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

/** keccak256 of the canonical request, lowercase 0x hex: the requestHash a gateway signs and the registry's queryHash. */
export function requestHash(body) {
  return "0x" + bytesToHex(keccak_256(encoder.encode(canonicalRequest(body))));
}

/** The bytes a gateway signs: `data` itself when it is a string, otherwise its compact JSON. */
export function signedDataBytes(data) {
  return encoder.encode(typeof data === "string" ? data : JSON.stringify(data));
}

/** keccak256(abi.encodePacked(bytes32 requestHash, uint256 timestamp, bytes data)). */
export function attestationDigest(requestHashHex, timestamp, data) {
  const packed = new Uint8Array(64 + data.length);
  packed.set(hexToBytes(requestHashHex), 0);
  packed.set(hexToBytes("0x" + BigInt(timestamp).toString(16).padStart(64, "0")), 32);
  packed.set(data, 64);
  return keccak_256(packed);
}

export class SignatureError extends Error {}

/**
 * Recover the EIP-191 personal-sign signer of a 32-byte digest, lowercase. Applies the rules of the registry's
 * OpenZeppelin ECDSA.recover: 65 bytes r || s || v, v of 27 or 28, s in the lower half order.
 * Throws SignatureError with a short reason otherwise.
 */
export function recoverSigner(digest, signature) {
  if (signature.length !== 65) throw new SignatureError("signature is not 65 bytes");
  const v = signature[64];
  if (v !== 27 && v !== 28) throw new SignatureError("signature v is not 27 or 28");
  let sig;
  try {
    sig = secp256k1.Signature.fromBytes(signature.subarray(0, 64), "compact").addRecoveryBit(v - 27);
  } catch {
    throw new SignatureError("signature r or s is out of range");
  }
  if (sig.hasHighS()) throw new SignatureError("signature s is not in the lower half order");
  const message = new Uint8Array(ETH_MESSAGE_PREFIX.length + digest.length);
  message.set(ETH_MESSAGE_PREFIX, 0);
  message.set(digest, ETH_MESSAGE_PREFIX.length);
  let publicKey;
  try {
    publicKey = sig.recoverPublicKey(keccak_256(message)).toBytes(false);
  } catch {
    throw new SignatureError("signature recovers no public key");
  }
  return "0x" + bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12));
}

const shortHash = (hex) => `${hex.slice(0, 10)}...${hex.slice(-4)}`;
const failure = (reason) => ({ outcome: "failure", reason });
const mismatch = (outcome, reason) => ({ outcome, reason });

/**
 * Judge one parsed gateway reply against its recipe, in the order the keeper and the registry would reject it.
 * Returns {outcome: "ok", signedLagSeconds} | {outcome: "failure" | mismatch kind, reason}.
 */
export function evaluateResponse(recipe, payload, nowSec) {
  if (!isObject(payload)) return failure("reply is not a JSON object");
  if (ENVELOPE.every((key) => !Object.hasOwn(payload, key))) {
    return failure(Object.hasOwn(payload, "error") ? "unsigned gateway error" : "reply is not a signed response");
  }

  const expected = requestHash(recipe.body);
  const got = payload.requestHash;
  if (typeof got !== "string" || got.toLowerCase() !== expected) {
    const shown = typeof got === "string" && HASH.test(got) ? shortHash(got.toLowerCase()) : "no valid requestHash";
    return mismatch("request_hash", `gateway signed ${shown}, recipe expects ${shortHash(expected)}`);
  }
  const signer = recipe.signer.toLowerCase();
  if (typeof payload.airnode !== "string" || payload.airnode.toLowerCase() !== signer) {
    const shown = typeof payload.airnode === "string" && ADDRESS.test(payload.airnode) ? payload.airnode : "no valid address";
    return mismatch("signer", `reply names airnode ${shown}, catalog expects ${recipe.signer}`);
  }
  if (typeof payload.timestamp !== "string" || !DECIMAL.test(payload.timestamp) || BigInt(payload.timestamp) > UINT256_MAX) {
    return mismatch("timestamp", "timestamp is not a uint256 decimal string");
  }
  if (typeof payload.signature !== "string" || !SIGNATURE.test(payload.signature)) {
    return mismatch("signer", "signature is not 65 bytes of hex");
  }
  if (payload.data === undefined) return mismatch("data_shape", "reply has no data");

  const timestamp = BigInt(payload.timestamp);
  const data = signedDataBytes(payload.data);
  let recovered;
  try {
    recovered = recoverSigner(attestationDigest(expected, timestamp, data), hexToBytes(payload.signature));
  } catch (err) {
    if (err instanceof SignatureError) return mismatch("signer", err.message);
    throw err;
  }
  if (recovered !== signer) return mismatch("signer", `signature recovers ${recovered}, catalog expects ${recipe.signer}`);

  const at = shapeMismatch(recipe.shape, data);
  if (at !== null) {
    return mismatch("data_shape", `${data.length} data bytes differ at byte ${at} from ${describeShape(recipe.shape)}`);
  }

  const lag = BigInt(nowSec) - timestamp;
  if (lag > BigInt(THRESHOLDS.probeMaxSignedAgeSeconds)) {
    return mismatch("timestamp", `signed ${lag}s before the probe (limit ${THRESHOLDS.probeMaxSignedAgeSeconds}s)`);
  }
  if (-lag > BigInt(THRESHOLDS.probeMaxSignedAheadSeconds)) {
    return mismatch("timestamp", `signed ${-lag}s after the probe (limit ${THRESHOLDS.probeMaxSignedAheadSeconds}s)`);
  }
  return { outcome: "ok", reason: null, signedLagSeconds: Number(lag) };
}

const transportReason = (err) =>
  err instanceof FetchTimeoutError ? "timeout" : err instanceof ResponseTooLargeError ? "reply too large" : "network error";

/** POST a recipe to its gateway and judge the reply. Never throws. */
export async function probeRecipe(recipe, { fetch, clock = () => Date.now(), timeoutMs = LIMITS.probeTimeoutMs }) {
  const started = clock();
  const elapsed = () => Math.max(0, Math.round(clock() - started));
  let response;
  try {
    response = await fetchText(
      fetch,
      recipe.url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify(recipe.body),
      },
      timeoutMs,
      { maxBytes: LIMITS.probeMaxResponseBytes },
    );
  } catch (err) {
    return { ...failure(transportReason(err)), latencyMs: elapsed() };
  }
  const latencyMs = elapsed();
  if (!response.ok) return { ...failure(`http ${response.status}`), latencyMs };
  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    return { ...failure("invalid json"), latencyMs };
  }
  return { ...evaluateResponse(recipe, payload, Math.floor(clock() / 1000)), latencyMs };
}

/** GET a listing's OpenAPI document and check it for each recipe served there. Never throws. */
export async function readListingDocument(url, recipes, { fetch, clock = () => Date.now(), timeoutMs = LIMITS.probeTimeoutMs }) {
  const started = clock();
  const elapsed = () => Math.max(0, Math.round(clock() - started));
  const all = (reason) => ({ latencyMs: elapsed(), results: recipes.map(() => failure(reason)) });
  let response;
  try {
    response = await fetchText(
      fetch,
      url,
      { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT } },
      timeoutMs,
      { maxBytes: LIMITS.listingDocumentMaxBytes },
    );
  } catch (err) {
    return all(`listing document: ${transportReason(err)}`);
  }
  if (!response.ok) return all(`listing document: http ${response.status}`);
  let doc;
  try {
    doc = JSON.parse(response.text);
  } catch {
    return all("listing document: invalid json");
  }
  return { latencyMs: elapsed(), results: recipes.map((recipe) => checkListingDocument(recipe, doc)) };
}

/** Run planned tasks (see planProbeTasks) with bounded concurrency. Results are in task order; never throws. */
export async function runProbeTasks(tasks, { fetch, clock = () => Date.now(), concurrency = LIMITS.probeConcurrency, timeoutMs } = {}) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      try {
        results[i] = task.kind === "probe"
          ? await probeRecipe(task.recipes[0], { fetch, clock, timeoutMs })
          : await readListingDocument(task.url, task.recipes, { fetch, clock, timeoutMs });
      } catch {
        results[i] = failedTaskResult(task, "internal error");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length) }, worker));
  return results;
}
