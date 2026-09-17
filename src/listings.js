// AirnodeHub listing probes, pure part: canonical requests, signed data shapes, the probe schedule, probe state
// transitions and listing document checks. No I/O and no dependencies, so it is cheap wherever it is imported.
// The network and signature code lives in src/probe.js, which the Durable Object loads only when a probe is due.

import { LIMITS } from "./config.js";

/** EpochEntropy._validate accepts 1 to 128 data bytes. */
export const MAX_DATA_BYTES = 128;

const encoder = new TextEncoder();
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Canonical request

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.keys(value).sort(compareKeys).map((key) => [key, canonical(value[key])]);
  return value;
}

/**
 * AirnodeHub canonical request, as signed and as returned by EpochEntropy.recipeRequest: the JSON of
 * [operation, parameters, projection?] where every object, at any depth, becomes its [key, value] entries sorted
 * by key and arrays keep their order. The projection is appended only when the request carries one.
 */
export function canonicalRequest(body) {
  const parts = [body.operation, canonical(body.parameters)];
  if (body.responseProjection !== undefined) parts.push(canonical(body.responseProjection));
  return JSON.stringify(parts);
}

// ---------------------------------------------------------------------------------------------
// Signed data shape (a port of EpochEntropy._validate and its _literal, _number and _hex helpers)

class Mismatch {
  constructor(at) {
    this.at = at;
  }
}

const fail = (at) => {
  throw new Mismatch(at);
};
const isDigit = (c) => c >= 0x30 && c <= 0x39;

function matchLiteral(data, p, text) {
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i++) if (p + i >= data.length || data[p + i] !== bytes[i]) fail(p + i);
  return p + bytes.length;
}

/** Unsigned JSON number: an integer without leading zeros, then an optional fraction and exponent when allowed. */
function matchNumber(data, p, fraction, exponent) {
  if (p >= data.length || !isDigit(data[p])) fail(p);
  if (data[p] === 0x30) {
    p++;
    if (p < data.length && isDigit(data[p])) fail(p);
  } else {
    while (p < data.length && isDigit(data[p])) p++;
  }
  if (fraction && p < data.length && data[p] === 0x2e) {
    const first = ++p;
    while (p < data.length && isDigit(data[p])) p++;
    if (p === first) fail(p);
  }
  if (exponent && p < data.length && (data[p] === 0x65 || data[p] === 0x45)) {
    p++;
    if (p < data.length && (data[p] === 0x2b || data[p] === 0x2d)) p++;
    const first = p;
    while (p < data.length && isDigit(data[p])) p++;
    if (p === first) fail(p);
  }
  return p;
}

function matchInteger(data, p, { digits, maxDigits }) {
  const end = matchNumber(data, p, false, false);
  if (data[p] === 0x30) fail(p);
  if (digits !== undefined && end - p !== digits) fail(p);
  if (maxDigits !== undefined && end - p > maxDigits) fail(p);
  return end;
}

function matchHex(data, p, length) {
  const end = p + length;
  for (; p < end; p++) {
    if (p >= data.length) fail(p);
    const c = data[p];
    if (!(isDigit(c) || (c >= 0x61 && c <= 0x66))) fail(p);
  }
  return end;
}

function matchPart(part, data, p) {
  if (typeof part.literal === "string") return matchLiteral(data, p, part.literal);
  if (part.number === "decimal") return matchNumber(data, p, true, false);
  if (part.number === "json") return matchNumber(data, p, true, true);
  if (isObject(part.integer)) return matchInteger(data, p, part.integer);
  if (Number.isInteger(part.hex) && part.hex > 0) return matchHex(data, p, part.hex);
  throw new Error("unknown shape part");
}

/**
 * Check signed data bytes against a recipe shape exactly as EpochEntropy._validate would.
 * Returns null when they match, otherwise the byte offset of the first difference.
 */
export function shapeMismatch(shape, data) {
  if (data.length === 0) return 0;
  if (data.length > MAX_DATA_BYTES) return MAX_DATA_BYTES;
  try {
    let p = 0;
    for (const part of shape) p = matchPart(part, data, p);
    return p === data.length ? null : p;
  } catch (err) {
    if (err instanceof Mismatch) return err.at;
    throw err;
  }
}

/** Human-readable template of a shape, e.g. {"symbol":"BTC","value":"<decimal>"}. */
export function describeShape(shape) {
  return shape
    .map((part) => {
      if (typeof part.literal === "string") return part.literal;
      if (part.number === "decimal") return "<decimal>";
      if (part.number === "json") return "<number>";
      if (isObject(part.integer)) return part.integer.digits ? `<${part.integer.digits}-digit integer>` : "<integer>";
      if (Number.isInteger(part.hex)) return `<${part.hex} lowercase hex>`;
      throw new Error("unknown shape part");
    })
    .join("");
}

// ---------------------------------------------------------------------------------------------
// Schedule

/** The first time after `now` that is `phase` seconds into an `interval`-long cycle. */
export function nextSlot(now, phase, interval) {
  const into = (((now - phase) % interval) + interval) % interval;
  return now - into + interval;
}

const phaseOf = (index, count, interval) => Math.floor((index * interval) / Math.max(1, count));

/** Gateway URLs in configuration order, each once. */
export function listingUrls(recipes) {
  return [...new Set(recipes.map((recipe) => recipe.url))];
}

/**
 * Work due in this run, at most `limit` tasks, most overdue first: probe POSTs, or when no probe is due, listing
 * document GETs (one per gateway URL, covering every recipe served there). Keeping the two apart means a
 * document slot that falls on a probe minute moves to the next run instead of adding a slow request to it.
 * A recipe never probed is due at once.
 *   {kind: "probe" | "document", url, recipes, phase, due}
 */
export function planProbeTasks(recipes, states, now, limit = LIMITS.probeMaxPerRun) {
  const byDue = (a, b) => a.due - b.due;
  const cap = Math.max(0, limit);
  const probes = [];
  recipes.forEach((recipe, index) => {
    const due = states.get(recipe.id)?.nextProbeAt ?? 0;
    if (now >= due) {
      const phase = phaseOf(index, recipes.length, LIMITS.probeIntervalSeconds);
      probes.push({ kind: "probe", url: recipe.url, recipes: [recipe], phase, due });
    }
  });
  if (probes.length > 0) return probes.sort(byDue).slice(0, cap);
  const documents = [];
  const urls = listingUrls(recipes);
  urls.forEach((url, index) => {
    const members = recipes.filter((recipe) => recipe.url === url);
    const due = Math.min(...members.map((recipe) => states.get(recipe.id)?.document?.nextCheckAt ?? 0));
    if (now >= due) {
      const phase = phaseOf(index, urls.length, LIMITS.listingDocumentIntervalSeconds);
      documents.push({ kind: "document", url, recipes: members, phase, due });
    }
  });
  return documents.sort(byDue).slice(0, cap);
}

/** Result of a task that could not run at all (every recipe of it counts one failed probe). */
export function failedTaskResult(task, reason) {
  const failure = { outcome: "failure", reason, latencyMs: null };
  return task.kind === "probe" ? failure : { latencyMs: null, results: task.recipes.map(() => ({ outcome: "failure", reason })) };
}

// ---------------------------------------------------------------------------------------------
// Probe state
//
// One JSON state per recipe:
//   probedAt, latencyMs, outcome, reason     the latest probe ("ok", "failure" or a mismatch kind)
//   failures                                 consecutive failed probes (unreachable, HTTP error, unusable reply)
//   verdict, verdictReason, verdictAt        the latest conclusive probe: "ok" or a mismatch kind; a failed probe
//                                            says nothing about whether a changed listing was fixed, so it keeps it
//   lastOkAt, signedLagSeconds, nextProbeAt
//   document: {checkedAt, latencyMs, outcome, reason, verdict, verdictReason, nextCheckAt}

/** Probe outcomes that mean the on-chain recipe fails as configured. */
export const MISMATCH_OUTCOMES = Object.freeze(["request_hash", "signer", "data_shape", "timestamp"]);

export function applyProbeResult(previous, result, now, phase) {
  const prev = previous ?? {};
  const failed = result.outcome === "failure";
  const passed = result.outcome === "ok";
  return {
    ...prev,
    probedAt: now,
    latencyMs: result.latencyMs ?? null,
    outcome: result.outcome,
    reason: result.reason ?? null,
    failures: failed ? (prev.failures ?? 0) + 1 : 0,
    verdict: failed ? prev.verdict ?? null : result.outcome,
    verdictReason: failed ? prev.verdictReason ?? null : result.reason ?? null,
    verdictAt: failed ? prev.verdictAt ?? null : now,
    lastOkAt: passed ? now : prev.lastOkAt ?? null,
    signedLagSeconds: passed ? result.signedLagSeconds ?? null : prev.signedLagSeconds ?? null,
    nextProbeAt: passed ? nextSlot(now, phase, LIMITS.probeIntervalSeconds) : now + LIMITS.probeRetrySeconds,
  };
}

export function applyDocumentResult(previous, result, latencyMs, now, phase) {
  const prev = previous?.document ?? {};
  const failed = result.outcome === "failure";
  return {
    ...(previous ?? {}),
    document: {
      checkedAt: now,
      latencyMs: latencyMs ?? null,
      outcome: result.outcome,
      reason: result.reason ?? null,
      verdict: failed ? prev.verdict ?? null : result.outcome,
      verdictReason: failed ? prev.verdictReason ?? null : result.reason ?? null,
      nextCheckAt: failed
        ? now + LIMITS.listingDocumentRetrySeconds
        : nextSlot(now, phase, LIMITS.listingDocumentIntervalSeconds),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Listing document (the gateway's OpenAPI document, GET on the listing URL)

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Check a parsed listing document for one recipe. Outcomes:
 *   ok         x-airnode.address is the signer and the operation still accepts the recipe's request
 *   signer     x-airnode.address is a different address
 *   operation  the operation is gone, or no longer accepts a parameter or projection the recipe sends,
 *              or requires a parameter the recipe does not send
 *   failure    the document is not in the expected format (no alert; the POST probe decides)
 */
export function checkListingDocument(recipe, doc) {
  const failure = (reason) => ({ outcome: "failure", reason });
  const operation = (reason) => ({ outcome: "operation", reason });
  if (!isObject(doc)) return failure("listing document is not a JSON object");

  const address = isObject(doc["x-airnode"]) ? doc["x-airnode"].address : undefined;
  if (typeof address !== "string" || !ADDRESS.test(address)) return failure("listing document has no x-airnode.address");
  if (address.toLowerCase() !== recipe.signer.toLowerCase()) {
    return { outcome: "signer", reason: `x-airnode.address is ${address}, catalog expects ${recipe.signer}` };
  }

  const schema = doc.paths?.["/"]?.post?.requestBody?.content?.["application/json"]?.schema;
  const alternatives = isObject(schema) ? (Array.isArray(schema.oneOf) ? schema.oneOf : [schema]) : [];
  const operations = alternatives.filter(
    (alt) => isObject(alt) && isObject(alt.properties) && typeof alt.properties.operation?.const === "string",
  );
  if (operations.length === 0) return failure("listing document lists no operations");

  const name = recipe.body.operation;
  const op = operations.find((alt) => alt.properties.operation.const === name);
  if (!op) return operation(`${name} is no longer offered`);

  const parameters = op.properties.parameters;
  if (isObject(parameters)) {
    const declared = isObject(parameters.properties) ? parameters.properties : {};
    if (parameters.additionalProperties === false) {
      for (const key of Object.keys(recipe.body.parameters)) {
        if (!Object.hasOwn(declared, key)) return operation(`${name} no longer accepts parameter ${key}`);
      }
    }
    if (Array.isArray(parameters.required)) {
      for (const key of parameters.required) {
        if (typeof key === "string" && !Object.hasOwn(recipe.body.parameters, key)) {
          return operation(`${name} now requires parameter ${NAME.test(key) ? key : "(unnamed)"}`);
        }
      }
    }
  }
  if (
    recipe.body.responseProjection !== undefined &&
    op.additionalProperties === false &&
    !Object.hasOwn(op.properties, "responseProjection")
  ) {
    return operation(`${name} no longer accepts responseProjection`);
  }
  return { outcome: "ok", reason: null };
}
