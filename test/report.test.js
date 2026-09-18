import assert from "node:assert/strict";
import { test } from "node:test";
import { handleHealthPost, parseBearer, readBodyLimited, tokenMatches, validateReport } from "../src/report.js";
import { BACKUP_STREAM, PRIMARY_STREAM, ingestReport, readBackupReportState, readReportState } from "../src/store.js";
import { MAINNET, TESTNET, bootstrapReport, memoryStorage, sampleReport } from "./helpers.js";

const KEY = "throwaway-testnet-key";
const ENV = { HEALTH_KEY_ARC_TESTNET: KEY, HEALTH_KEY_ARC_MAINNET: "throwaway-mainnet-key" };
const URL_TESTNET = "https://watchdog.d20dao.org/v1/health/arc-testnet";

function post(body, { key = KEY, idempotency, contentType = "application/json", headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const h = { "content-type": contentType, ...headers };
  if (key !== null) h.authorization = `Bearer ${key}`;
  const id = idempotency === undefined ? (typeof body === "object" ? body.reportId : undefined) : idempotency;
  if (id !== null && id !== undefined) h["idempotency-key"] = id;
  return new Request(URL_TESTNET, { method: "POST", headers: h, body: text });
}

function harness(env = ENV) {
  const storage = memoryStorage();
  let clock = 1789420010_000;
  return {
    storage,
    setClock: (ms) => (clock = ms),
    send: (request, net = TESTNET) =>
      handleHealthPost(request, env, net, { ingest: async (rec) => ingestReport(storage, rec), now: () => clock }),
  };
}

test("parseBearer", () => {
  assert.equal(parseBearer("Bearer abc.DEF-123"), "abc.DEF-123");
  assert.equal(parseBearer("bearer abc"), "abc");
  assert.equal(parseBearer("Basic abc"), null);
  assert.equal(parseBearer("Bearer "), null);
  assert.equal(parseBearer("Bearer a b"), null);
  assert.equal(parseBearer(null), null);
});

test("tokenMatches uses timingSafeEqual when the runtime provides it", async () => {
  let calls = 0;
  const subtle = {
    digest: (algo, data) => crypto.subtle.digest(algo, data),
    timingSafeEqual: (a, b) => {
      calls++;
      assert.equal(a.byteLength, 32);
      assert.equal(b.byteLength, 32);
      return Buffer.from(a).equals(Buffer.from(b));
    },
  };
  assert.equal(await tokenMatches("secret", "secret", subtle), true);
  assert.equal(await tokenMatches("secreT", "secret", subtle), false);
  assert.equal(await tokenMatches("short", "a-much-longer-secret", subtle), false);
  assert.equal(calls, 3);
  // Node fallback path and empty secrets.
  assert.equal(await tokenMatches("secret", "secret"), true);
  assert.equal(await tokenMatches("secret", ""), false);
});

test("validateReport accepts the documented example and extracts the summary", () => {
  const report = sampleReport({
    events: {
      completed: [],
      rejected: [],
      failed: [
        { cursor: "5", requestId: "9", kind: "expired", origin: "o", observedAt: 1 },
        { cursor: "6", requestId: null, kind: "node_transaction_rejected", origin: "o", observedAt: 1 },
        { cursor: "7", requestId: "10", kind: "expired", origin: "o", observedAt: 1 },
      ],
      progress: [],
    },
    droppedTotal: 4,
  });
  const summary = validateReport(report, TESTNET, report.reportId);
  assert.equal(summary.healthy, true);
  assert.equal(summary.healthObservedAt, 1789420000);
  assert.equal(summary.sendEnabled, true);
  assert.deepEqual(summary.failedCounts, { expired: 2, node_transaction_rejected: 1 });
  assert.equal(summary.droppedTotal, 4);
  assert.equal(summary.eventCount, 3);
});

test("validateReport accepts the bootstrap shape", () => {
  const report = bootstrapReport();
  const summary = validateReport(report, TESTNET, report.reportId);
  assert.equal(summary.healthy, false);
  assert.equal(summary.healthObservedAt, null);
  assert.equal(summary.sendEnabled, null);
  assert.deepEqual(summary.faults, ["not_observed"]);
});

test("validateReport rejections", () => {
  const cases = [
    [{ version: 2 }, 400, /version/],
    [{ chainId: 5042002 }, 400, /chainId/],
    [{ chainId: "5042" }, 422, /chainId for this network/],
    [{ coordinator: MAINNET.coordinator }, 422, /coordinator for this network/],
    [{ observedAt: -1 }, 400, /observedAt/],
    [{ health: { healthy: "yes", faults: [] } }, 400, /health.healthy/],
    [{ health: { healthy: false, faults: ["<script>"] } }, 400, /health.faults/],
    [{ health: { healthy: true, faults: [], observedAt: "1" } }, 400, /health.observedAt/],
    [{ summary: { completed: 1, rejected: 0, failed: 0 } }, 400, /summary.progress/],
    [{ events: { completed: [], rejected: [], failed: [] } }, 400, /events.progress/],
    [{ nextCursor: 102 }, 400, /nextCursor/],
    [{ droppedTotal: 1.5 }, 400, /droppedTotal/],
  ];
  for (const [override, status, message] of cases) {
    const report = sampleReport(override);
    assert.throws(() => validateReport(report, TESTNET, report.reportId), (err) => {
      assert.equal(err.status, status, JSON.stringify(override));
      assert.match(err.message, message);
      return true;
    });
  }
  const report = sampleReport();
  assert.throws(() => validateReport(report, TESTNET, "other-id"), /Idempotency-Key/);
  assert.throws(() => validateReport(report, TESTNET, null), /Idempotency-Key/);
  // Coordinator comparison is case-insensitive.
  const lower = sampleReport({ coordinator: TESTNET.coordinator.toLowerCase() });
  assert.ok(validateReport(lower, TESTNET, lower.reportId));
});

test("POST: authentication and receiver configuration", async () => {
  const h = harness();
  assert.equal((await h.send(post(sampleReport(), { key: null }))).status, 401);
  const wrong = await h.send(post(sampleReport(), { key: "throwaway-testnet-kez" }));
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get("www-authenticate"), /^Bearer/);
  // The mainnet key is not valid for the testnet endpoint.
  assert.equal((await h.send(post(sampleReport(), { key: ENV.HEALTH_KEY_ARC_MAINNET }))).status, 401);
  // Missing secret: refuse rather than accept unauthenticated reports.
  const unconfigured = harness({ HEALTH_KEY_ARC_MAINNET: "x" });
  assert.equal((await unconfigured.send(post(sampleReport()))).status, 503);
  const get = new Request(URL_TESTNET, { method: "GET" });
  assert.equal((await h.send(get)).status, 405);
  assert.equal(readReportState(h.storage, "arc-testnet"), null);
});

test("POST: content type, JSON and idempotency header", async () => {
  const h = harness();
  assert.equal((await h.send(post(sampleReport(), { contentType: "text/plain" }))).status, 415);
  assert.equal((await h.send(post("{not json", { idempotency: "x" }))).status, 400);
  assert.equal((await h.send(post(sampleReport(), { idempotency: null }))).status, 400);
  assert.equal((await h.send(post(sampleReport(), { idempotency: "mismatch" }))).status, 400);
  const res = await h.send(post(sampleReport(), { contentType: "application/json; charset=utf-8" }));
  assert.equal(res.status, 200);
});

test("POST: 64 KiB size limit, declared and streamed", async () => {
  const h = harness();
  const report = sampleReport();
  const padded = JSON.stringify(report).replace('"version":1', `"padding":"${"x".repeat(64 * 1024)}","version":1`);
  const declared = await h.send(post(padded, { idempotency: report.reportId }));
  assert.equal(declared.status, 413);

  const chunks = [new TextEncoder().encode(padded.slice(0, 40000)), new TextEncoder().encode(padded.slice(40000))];
  const stream = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
  const streamed = new Request(URL_TESTNET, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "idempotency-key": report.reportId },
    body: stream,
    duplex: "half",
  });
  assert.equal(streamed.headers.get("content-length"), null);
  assert.equal((await h.send(streamed)).status, 413);

  // Exactly 64 KiB is accepted by the reader.
  const exact = new Request(URL_TESTNET, { method: "POST", body: "a".repeat(64 * 1024) });
  assert.equal((await readBodyLimited(exact)).byteLength, 64 * 1024);
});

test("POST: store, duplicate and conflicting bytes", async () => {
  const h = harness();
  const report = sampleReport();
  const first = await h.send(post(report));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, duplicate: false });

  h.setClock(1789420040_000);
  const again = await h.send(post(report));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, duplicate: true });

  const conflicting = { ...report, droppedTotal: 1 };
  assert.equal((await h.send(post(conflicting))).status, 409);
  // Same JSON value but different bytes is still a conflict: the hash covers the exact body.
  const reformatted = JSON.stringify(report, null, 1);
  assert.equal((await h.send(post(reformatted, { idempotency: report.reportId }))).status, 409);

  const state = readReportState(h.storage, "arc-testnet");
  assert.equal(state.reportsStored, 1);
  assert.equal(state.duplicatesSeen, 1);
  assert.equal(state.conflictsSeen, 2);
  assert.equal(state.lastReceivedAt, 1789420040, "a duplicate delivery still counts as a heartbeat");
  assert.equal(state.droppedTotal, 0, "conflicting bytes never apply");
});

test("POST: bootstrap report is stored as not yet observed, then a healthy report", async () => {
  const h = harness();
  const boot = bootstrapReport({ observedAt: 1789419990 });
  assert.equal((await h.send(post(boot))).status, 200);
  let state = readReportState(h.storage, "arc-testnet");
  assert.equal(state.healthy, false);
  assert.equal(state.healthObservedAt, null);
  assert.equal(state.sendEnabled, null);
  assert.deepEqual(state.faults, ["not_observed"]);
  assert.equal(state.unhealthySince, 1789419990);

  assert.equal((await h.send(post(sampleReport()))).status, 200);
  state = readReportState(h.storage, "arc-testnet");
  assert.equal(state.healthy, true);
  assert.equal(state.unhealthySince, null);
  assert.equal(state.healthObservedAt, 1789420000);
  assert.equal(state.reportsStored, 2);
});

test("POST: storage failure returns 503, never 2xx", async () => {
  const res = await handleHealthPost(post(sampleReport()), ENV, TESTNET, {
    ingest: async () => {
      throw new Error("write failed");
    },
  });
  assert.equal(res.status, 503);
});

test("validateReport reads health.role; absent in the bootstrap shape", () => {
  const follower = sampleReport({ health: { observedAt: 1789420000, healthy: true, sendEnabled: true, faults: [], role: "follower", primaryAlive: true } });
  assert.equal(validateReport(follower, TESTNET, follower.reportId).role, "follower");
  const primary = sampleReport({ health: { observedAt: 1789420000, healthy: true, sendEnabled: true, faults: [], role: "primary", primaryAlive: null } });
  assert.equal(validateReport(primary, TESTNET, primary.reportId).role, "primary");
  assert.equal(validateReport(bootstrapReport(), TESTNET, bootstrapReport().reportId).role, null);
  for (const role of [1, "<b>", ""]) {
    const bad = sampleReport({ health: { healthy: true, faults: [], role } });
    assert.throws(() => validateReport(bad, TESTNET, bad.reportId), /health.role/);
  }
});

const BACKUP_KEY = "throwaway-testnet-backup-key";
const BACKUP_ENV = { ...ENV, HEALTH_KEY_ARC_TESTNET_BACKUP: BACKUP_KEY };

/** Harness posting to both streams of one storage: the primary's key and ingest, or the backup's. */
function streams(env = BACKUP_ENV) {
  const storage = memoryStorage();
  const send = (request, backup) =>
    handleHealthPost(request, env, TESTNET, {
      ingest: async (rec) => ingestReport(storage, rec, backup ? BACKUP_STREAM : PRIMARY_STREAM),
      now: () => 1789420010_000,
      keySecret: backup ? TESTNET.backupHealthKeySecret : TESTNET.healthKeySecret,
      stream: backup ? "backup" : "primary",
    });
  return { storage, primary: (request) => send(request, false), backup: (request) => send(request, true) };
}

test("backup stream: accepted only with its own key", async () => {
  const s = streams();
  const report = sampleReport({ health: { observedAt: 1789420000, healthy: true, sendEnabled: true, faults: [], role: "follower" } });
  assert.equal((await s.backup(post(report, { key: null }))).status, 401);
  assert.equal((await s.backup(post(report, { key: KEY }))).status, 401, "the primary's key is not valid for the backup");
  assert.equal((await s.backup(post(report, { key: "throwaway-testnet-backup-kez" }))).status, 401);
  assert.equal((await s.primary(post(report, { key: BACKUP_KEY }))).status, 401, "the backup's key is not valid for the primary");
  assert.equal(readBackupReportState(s.storage, "arc-testnet"), null);

  const ok = await s.backup(post(report, { key: BACKUP_KEY }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, duplicate: false });
  const state = readBackupReportState(s.storage, "arc-testnet");
  assert.equal(state.role, "follower");
  assert.equal(state.healthy, true);
  assert.equal(readReportState(s.storage, "arc-testnet"), null, "the primary's state is untouched");

  // Backup secret not set: refuse, as for the primary.
  const unset = streams(ENV);
  assert.equal((await unset.backup(post(report, { key: BACKUP_KEY }))).status, 503);
});

test("backup stream: its report ids, duplicates and conflicts never count against the primary", async () => {
  const s = streams();
  const report = sampleReport();
  assert.equal((await s.primary(post(report))).status, 200);
  // The same report id and bytes on the backup route is a first delivery there, not a duplicate or conflict.
  const first = await s.backup(post(report, { key: BACKUP_KEY }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, duplicate: false });
  // Different bytes under that id conflict only within the backup stream.
  const conflicting = { ...report, droppedTotal: 3 };
  assert.equal((await s.backup(post(conflicting, { key: BACKUP_KEY }))).status, 409);
  assert.deepEqual(await (await s.backup(post(report, { key: BACKUP_KEY }))).json(), { ok: true, duplicate: true });

  const primary = readReportState(s.storage, "arc-testnet");
  const backup = readBackupReportState(s.storage, "arc-testnet");
  assert.deepEqual([primary.reportsStored, primary.duplicatesSeen, primary.conflictsSeen], [1, 0, 0]);
  assert.deepEqual([backup.reportsStored, backup.duplicatesSeen, backup.conflictsSeen], [1, 1, 1]);
});
