// Health report receiver: authentication, bounded body reading and envelope validation.
// Follows d20-keeper docs/keeper-health-receiver.md (version 1).

import { LIMITS } from "./config.js";

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REPORT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE = /^[a-z0-9_]{1,64}$/;
const EVENT_GROUPS = ["completed", "rejected", "failed", "progress"];
const MAX_FAULTS = 64;
const MAX_EVENTS = 1024;
const MAX_ORIGIN_LENGTH = 512;

const encoder = new TextEncoder();

/** Extract the token from `Authorization: Bearer <token>`, or null. */
export function parseBearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+([\x21-\x7e]{1,4096})[ ]*$/i.exec(header);
  return match ? match[1] : null;
}

function constantTimeBytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Compare a presented token with the configured secret in constant time.
 * Both sides are hashed first so the comparison never depends on the secret length.
 * Uses crypto.subtle.timingSafeEqual (Workers runtime); the loop fallback only exists for Node tests.
 */
export async function tokenMatches(presented, secret, subtle = crypto.subtle) {
  if (typeof presented !== "string" || typeof secret !== "string" || secret.length === 0) return false;
  const [a, b] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(presented)),
    subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  return constantTimeBytesEqual(new Uint8Array(a), new Uint8Array(b));
}

export async function sha256Hex(bytes, subtle = crypto.subtle) {
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Read a request body, stopping as soon as it exceeds `maxBytes`. Returns Uint8Array or null if too large. */
export async function readBodyLimited(request, maxBytes = LIMITS.maxReportBytes) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

function need(condition, field, status = 400) {
  if (!condition) throw new ReportError(status, `invalid ${field}`);
}

/**
 * Validate a parsed version-1 envelope for `net` and return the summary the watchdog keeps.
 * Throws ReportError with an HTTP status on rejection.
 */
export function validateReport(body, net, idempotencyKey) {
  need(isObject(body), "report");
  need(body.version === 1, "version");
  need(typeof body.reportId === "string" && REPORT_ID.test(body.reportId), "reportId");
  need(typeof idempotencyKey === "string" && idempotencyKey === body.reportId, "Idempotency-Key");
  need(typeof body.nodeId === "string" && HEX32.test(body.nodeId), "nodeId");
  need(typeof body.chainId === "string" && DECIMAL.test(body.chainId), "chainId");
  need(typeof body.coordinator === "string" && ADDRESS.test(body.coordinator), "coordinator");
  need(body.chainId === net.chainId, "chainId for this network", 422);
  need(body.coordinator.toLowerCase() === net.coordinator.toLowerCase(), "coordinator for this network", 422);
  need(isCount(body.observedAt), "observedAt");

  const health = body.health;
  need(isObject(health), "health");
  need(typeof health.healthy === "boolean", "health.healthy");
  need(Array.isArray(health.faults) && health.faults.length <= MAX_FAULTS, "health.faults");
  for (const fault of health.faults) need(typeof fault === "string" && CODE.test(fault), "health.faults");
  // Bootstrap shape: observedAt and sendEnabled are absent until the keeper's first observation.
  need(health.observedAt === undefined || isCount(health.observedAt), "health.observedAt");
  need(health.sendEnabled === undefined || typeof health.sendEnabled === "boolean", "health.sendEnabled");

  need(isObject(body.summary), "summary");
  for (const group of EVENT_GROUPS) need(isCount(body.summary[group]), `summary.${group}`);

  need(isObject(body.events), "events");
  const failedCounts = {};
  let eventCount = 0;
  for (const group of EVENT_GROUPS) {
    const list = body.events[group];
    need(Array.isArray(list), `events.${group}`);
    eventCount += list.length;
    need(eventCount <= MAX_EVENTS, "events");
    for (const event of list) {
      need(isObject(event), `events.${group}`);
      need(typeof event.cursor === "string" && DECIMAL.test(event.cursor), `events.${group}.cursor`);
      need(event.requestId === null || event.requestId === undefined || (typeof event.requestId === "string" && DECIMAL.test(event.requestId)), `events.${group}.requestId`);
      need(typeof event.kind === "string" && CODE.test(event.kind), `events.${group}.kind`);
      need(typeof event.origin === "string" && event.origin.length <= MAX_ORIGIN_LENGTH, `events.${group}.origin`);
      need(isCount(event.observedAt), `events.${group}.observedAt`);
      if (group === "failed") failedCounts[event.kind] = (failedCounts[event.kind] ?? 0) + 1;
    }
  }

  need(typeof body.nextCursor === "string" && DECIMAL.test(body.nextCursor), "nextCursor");
  need(isCount(body.droppedCount), "droppedCount");
  need(isCount(body.droppedTotal), "droppedTotal");
  need(isCount(body.rejectionHistoryPrunedTotal), "rejectionHistoryPrunedTotal");

  return {
    reportId: body.reportId,
    nodeId: body.nodeId.toLowerCase(),
    observedAt: body.observedAt,
    healthy: health.healthy,
    healthObservedAt: health.observedAt ?? null,
    sendEnabled: health.sendEnabled ?? null,
    faults: [...health.faults],
    droppedTotal: body.droppedTotal,
    droppedCount: body.droppedCount,
    failedCounts,
    eventCount,
  };
}

function json(status, payload, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/**
 * Handle POST /v1/health/<network>. `ingest(record)` must durably store the record and resolve to
 * "stored" | "duplicate" | "conflict"; 2xx is only returned after it resolves.
 */
export async function handleHealthPost(request, env, net, { ingest, now = () => Date.now(), subtle = crypto.subtle }) {
  if (request.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
  const secret = env[net.healthKeySecret];
  if (typeof secret !== "string" || secret.trim() === "") return json(503, { error: "receiver not configured" });

  const token = parseBearer(request.headers.get("authorization"));
  if (!token || !(await tokenMatches(token, secret, subtle))) {
    // Logged only (Workers Logs), never stored: unauthenticated traffic must not consume Durable Object quota.
    console.warn(JSON.stringify({ healthAuthFailure: net.name, bearer: token ? "mismatch" : "missing" }));
    return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="d20dao-watchdog"' });
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return json(415, { error: "content-type must be application/json" });

  const bytes = await readBodyLimited(request, LIMITS.maxReportBytes);
  if (!bytes) return json(413, { error: "report exceeds 64 KiB" });

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return json(400, { error: "invalid json" });
  }

  let summary;
  try {
    summary = validateReport(parsed, net, request.headers.get("idempotency-key"));
  } catch (err) {
    if (err instanceof ReportError) return json(err.status, { error: err.message });
    throw err;
  }

  const record = {
    network: net.name,
    receivedAt: Math.floor(now() / 1000),
    bodySha256: await sha256Hex(bytes, subtle),
    ...summary,
  };

  let outcome;
  try {
    outcome = await ingest(record);
  } catch {
    return json(503, { error: "storage unavailable" });
  }
  if (outcome === "conflict") return json(409, { error: "reportId already stored with different bytes" });
  if (outcome === "stored" || outcome === "duplicate") return json(200, { ok: true, duplicate: outcome === "duplicate" });
  return json(500, { error: "unexpected storage outcome" });
}
