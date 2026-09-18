import assert from "node:assert/strict";
import { test } from "node:test";
import { handleFetch } from "../src/http.js";
import { buildStatus } from "../src/status.js";
import { BACKUP_STREAM, ingestReport, readBackupReportState, readReportState } from "../src/store.js";
import { memoryStorage, sampleReport } from "./helpers.js";

const ENV = {
  HEALTH_KEY_ARC_TESTNET: "throwaway-testnet-key",
  HEALTH_KEY_ARC_MAINNET: "throwaway-mainnet-key",
  HEALTH_KEY_ARC_TESTNET_BACKUP: "throwaway-testnet-backup-key",
  HEALTH_KEY_ARC_MAINNET_BACKUP: "throwaway-mainnet-backup-key",
};

function setup() {
  const storage = memoryStorage();
  const counters = { status: 0, ingest: 0, backup: 0 };
  const stub = {
    ingestReport: async (rec) => {
      counters.ingest++;
      return ingestReport(storage, rec);
    },
    ingestBackupReport: async (rec) => {
      counters.backup++;
      return ingestReport(storage, rec, BACKUP_STREAM);
    },
    getStatus: async () => {
      counters.status++;
      return buildStatus(storage, ENV, 1789420100);
    },
  };
  const store = new Map();
  const cache = {
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => void store.set(req.url, res),
  };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (request) => {
    const res = await handleFetch(request, ENV, ctx, { stub: () => stub, cache, now: () => 1789420010_000 });
    await Promise.all(waits);
    return res;
  };
  return { call, counters, storage };
}

test("routes the health receiver per network", async () => {
  const { call, counters } = setup();
  const report = sampleReport();
  const request = (path, key = ENV.HEALTH_KEY_ARC_TESTNET) =>
    new Request(`https://watchdog.d20dao.org${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": report.reportId },
      body: JSON.stringify(report),
    });
  assert.equal((await call(request("/v1/health/arc-testnet"))).status, 200);
  // Right key for mainnet, but the envelope is for testnet.
  assert.equal((await call(request("/v1/health/arc-mainnet", ENV.HEALTH_KEY_ARC_MAINNET))).status, 422);
  // Unauthenticated requests never reach the Durable Object.
  assert.equal((await call(request("/v1/health/arc-mainnet", "nope"))).status, 401);
  assert.equal((await call(request("/v1/health/constructor"))).status, 404);
  assert.equal((await call(request("/v1/health/arc-devnet"))).status, 404);
  assert.equal(counters.ingest, 1);
});

test("routes backup reports to their own stream and key", async () => {
  const { call, counters, storage } = setup();
  const report = sampleReport({ health: { observedAt: 1789420000, healthy: false, sendEnabled: true, faults: ["preparation_stalled"], role: "follower" } });
  const request = (path, key) =>
    new Request(`https://watchdog.d20dao.org${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": report.reportId },
      body: JSON.stringify(report),
    });
  assert.equal((await call(request("/v1/health/arc-testnet/backup", ENV.HEALTH_KEY_ARC_TESTNET))).status, 401);
  assert.equal((await call(request("/v1/health/arc-testnet", ENV.HEALTH_KEY_ARC_TESTNET_BACKUP))).status, 401);
  assert.equal((await call(request("/v1/health/arc-mainnet/backup", ENV.HEALTH_KEY_ARC_TESTNET_BACKUP))).status, 401);
  assert.equal((await call(request("/v1/health/arc-testnet/backup", ENV.HEALTH_KEY_ARC_TESTNET_BACKUP))).status, 200);
  // Right key for the mainnet backup, but the envelope is for testnet.
  assert.equal((await call(request("/v1/health/arc-mainnet/backup", ENV.HEALTH_KEY_ARC_MAINNET_BACKUP))).status, 422);
  for (const path of ["/v1/health/arc-devnet/backup", "/v1/health/constructor/backup", "/v1/health/arc-testnet/primary", "/v1/health/arc-testnet/backup/x"]) {
    assert.equal((await call(request(path, ENV.HEALTH_KEY_ARC_TESTNET_BACKUP))).status, 404, path);
  }
  assert.deepEqual(counters, { status: 0, ingest: 0, backup: 1 });
  assert.deepEqual(readBackupReportState(storage, "arc-testnet").faults, ["preparation_stalled"]);
  assert.equal(readReportState(storage, "arc-testnet"), null);
});

test("status endpoints: JSON, HTML, short edge cache, headers", async () => {
  const { call, counters } = setup();
  const json = await call(new Request("https://watchdog.d20dao.org/status.json"));
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type"), /^application\/json/);
  const body = await json.json();
  assert.equal(body.notifier, "not configured");
  assert.deepEqual(Object.keys(body.networks), ["arc-mainnet", "arc-testnet"]);

  const again = await call(new Request("https://watchdog.d20dao.org/status.json?bust=1"));
  assert.equal(again.status, 200);
  assert.equal(counters.status, 1, "query strings share the cached entry");

  const html = await call(new Request("https://watchdog.d20dao.org/"));
  assert.match(html.headers.get("content-type"), /^text\/html/);
  assert.equal(
    html.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  const page = await html.text();
  assert.match(page, /D20DAO keeper watchdog/);
  // Self-contained: inline CSS and SVG only, nothing fetched and no script.
  assert.doesNotMatch(page, /<script|<link|<img|<iframe|<object|\ssrc=|url\(|@import/i);
  for (const href of ["https://d20dao.org", "https://d20dao.org/explorer", "https://d20dao.org/docs", "/status.json"]) {
    assert.ok(page.includes(`href="${href}"`), href);
  }

  const head = await call(new Request("https://watchdog.d20dao.org/", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal((await call(new Request("https://watchdog.d20dao.org/", { method: "POST" }))).status, 405);
  assert.equal((await call(new Request("https://watchdog.d20dao.org/favicon.ico"))).status, 404);
});
