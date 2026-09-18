import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { handleFetch } from "../src/http.js";
import { ICONS } from "../src/icons.js";
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
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  const page = await html.text();
  assert.match(page, /D20DAO keeper watchdog/);
  // Self-contained: inline CSS and SVG, no script; the only links are the canonical URL and the page's own icons.
  assert.doesNotMatch(page, /<script|<img|<iframe|<object|\ssrc=|url\(|@import/i);
  const links = [...page.matchAll(/<link rel="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.equal(page.match(/<link\b/g).length, links.length);
  assert.deepEqual(links, [
    ["canonical", "https://watchdog.d20dao.org"],
    ["icon", `/icon.svg?v=${ICONS["/icon.svg"].v}`],
    ["icon", `/favicon.ico?v=${ICONS["/favicon.ico"].v}`],
    ["apple-touch-icon", `/apple-touch-icon.png?v=${ICONS["/apple-touch-icon.png"].v}`],
  ]);
  for (const href of ["https://d20dao.org", "https://d20dao.org/explorer", "https://d20dao.org/docs", "/status.json"]) {
    assert.ok(page.includes(`href="${href}"`), href);
  }

  const head = await call(new Request("https://watchdog.d20dao.org/", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal((await call(new Request("https://watchdog.d20dao.org/", { method: "POST" }))).status, 405);
  assert.equal((await call(new Request("https://watchdog.d20dao.org/robots.txt"))).status, 404);
});

test("page head: site-style title, description, canonical, social cards", async () => {
  const { call } = setup();
  const page = await (await call(new Request("https://watchdog.d20dao.org/"))).text();
  const meta = (attr, key) => new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(page)?.[1];
  assert.match(page, /<html lang="en">/);
  assert.match(page, /<title>Arc VRF status \| D20DAO<\/title>/);
  const description = meta("name", "description");
  assert.ok(description?.length > 20);
  assert.equal(meta("name", "robots"), "index, follow");
  assert.equal(meta("property", "og:title"), "Arc VRF status | D20DAO");
  assert.equal(meta("property", "og:description"), description);
  assert.equal(meta("property", "og:url"), "https://watchdog.d20dao.org");
  assert.equal(meta("property", "og:site_name"), "D20DAO");
  assert.equal(meta("property", "og:image"), "https://d20dao.org/opengraph-image.png");
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
  assert.equal(meta("name", "twitter:site"), "@d20dao");
  assert.equal(meta("name", "twitter:description"), description);
  assert.equal(meta("name", "twitter:image"), "https://d20dao.org/opengraph-image.png");
});

test("serves the site's icons with their types and a long cache, without reading status", async () => {
  const { call, counters } = setup();
  for (const [path, icon] of Object.entries(ICONS)) {
    const res = await call(new Request(`https://watchdog.d20dao.org${path}?v=${icon.v}`));
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), icon.type);
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const body = Buffer.from(await res.arrayBuffer());
    // The version in the page's link is the content hash, so a changed icon always gets a new URL.
    assert.ok(createHash("sha256").update(body).digest("hex").startsWith(icon.v), path);
    // A second request returns the same bytes (the embedded body is never consumed).
    assert.ok(Buffer.from(await (await call(new Request(`https://watchdog.d20dao.org${path}`))).arrayBuffer()).equals(body));

    const head = await call(new Request(`https://watchdog.d20dao.org${path}`, { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), icon.type);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await call(new Request(`https://watchdog.d20dao.org${path}`, { method: "POST" }))).status, 405);
  }
  assert.match(ICONS["/icon.svg"].body, /^<svg /);
  assert.deepEqual([...ICONS["/favicon.ico"].body.subarray(0, 4)], [0, 0, 1, 0]);
  assert.deepEqual([...ICONS["/apple-touch-icon.png"].body.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(counters.status, 0);
});
