// Sanitized public read model: status JSON and a small server-rendered HTML page.
// Never includes secrets, raw report bodies or report ids.

import { evaluateListingDocumentCheck, evaluateProbeCheck } from "./checks.js";
import { AIRNODE_RECIPES, AIRNODE_SCOPE, LIMITS, NETWORKS, THRESHOLDS } from "./config.js";
import { formatDuration, formatGwei, formatUsdc, shortAddress } from "./format.js";
import { describeShape } from "./listings.js";
import { readAlerts, readChainState, readProbeStates, readReportState, recentMessages } from "./store.js";
import { notifierConfigured } from "./telegram.js";

const age = (now, t) => (t == null ? null : Math.max(0, now - t));
const same = (a, b) => (a == null ? null : a.toLowerCase() === b.toLowerCase());

const alertView = (now) => (a) => ({
  check: a.check,
  severity: a.severity,
  title: a.title,
  detail: a.detail,
  since: a.since,
  activeSeconds: age(now, a.since),
  event: a.event,
});

/** Probe results per AirnodeHub recipe. Reasons are short texts built by the probe, never reply bodies. */
function listingStatus(storage, now, recipes) {
  const states = readProbeStates(storage);
  return {
    probeIntervalSeconds: LIMITS.probeIntervalSeconds,
    listingDocumentIntervalSeconds: LIMITS.listingDocumentIntervalSeconds,
    recipes: recipes.map((recipe) => {
      const s = states.get(recipe.id) ?? null;
      const probe = evaluateProbeCheck(recipe, s);
      const doc = s?.document ?? null;
      const docAlert = evaluateListingDocumentCheck(recipe, s);
      return {
        id: recipe.id,
        name: recipe.name,
        registryRecipe: recipe.recipe,
        url: recipe.url,
        operation: recipe.body.operation,
        signer: recipe.signer,
        expectedData: describeShape(recipe.shape),
        status: s ? (probe ? probe.severity : "ok") : "not probed",
        lastProbeAt: s?.probedAt ?? null,
        lastProbeAgeSeconds: age(now, s?.probedAt),
        latencyMs: s?.latencyMs ?? null,
        lastOutcome: s?.outcome ?? null,
        reason: s?.reason ?? null,
        consecutiveFailures: s?.failures ?? 0,
        verdict: s?.verdict ?? null,
        verdictReason: s?.verdictReason ?? null,
        lastOkAt: s?.lastOkAt ?? null,
        signedLagSeconds: s?.outcome === "ok" ? s.signedLagSeconds ?? null : null,
        nextProbeAt: s?.nextProbeAt ?? null,
        listingDocument: doc
          ? {
              status: docAlert ? "alarm" : doc.verdict ? "ok" : "unknown",
              checkedAt: doc.checkedAt,
              checkedAgeSeconds: age(now, doc.checkedAt),
              lastOutcome: doc.outcome,
              reason: doc.reason,
              nextCheckAt: doc.nextCheckAt,
            }
          : null,
      };
    }),
    alerts: readAlerts(storage, AIRNODE_SCOPE).map(alertView(now)),
  };
}

export function buildStatus(storage, env, now, recipes = AIRNODE_RECIPES, nets = NETWORKS) {
  const networks = {};
  for (const name of Object.keys(nets)) {
    const net = nets[name];
    const backups = net.backupKeepers ?? [];
    const r = readReportState(storage, name);
    const c = readChainState(storage, name);
    let feeCapUsagePercent = null;
    if (c?.baseFeeWei != null) {
      const needed = 2n * BigInt(c.baseFeeWei) + THRESHOLDS.feeHeadroomWei;
      feeCapUsagePercent = Number((needed * 10000n) / net.feeCapWei) / 100;
    }
    networks[name] = {
      chainId: net.chainId,
      coordinator: net.coordinator,
      registry: net.registry,
      keeper: net.keeper,
      backupKeepers: [...backups],
      explorer: net.explorer,
      report: r
        ? {
            everReported: true,
            lastReceivedAt: r.lastReceivedAt,
            lastReceivedAgeSeconds: age(now, r.lastReceivedAt),
            reportObservedAt: r.reportObservedAt,
            reportObservedAgeSeconds: age(now, r.reportObservedAt),
            healthObservedAt: r.healthObservedAt,
            healthObservedAgeSeconds: age(now, r.healthObservedAt),
            healthObservationLagSeconds: r.healthObservedAt == null ? null : Math.max(0, r.reportObservedAt - r.healthObservedAt),
            observed: r.healthObservedAt != null,
            healthy: r.healthy,
            sendEnabled: r.sendEnabled,
            faults: r.faults,
            unhealthySince: r.unhealthySince,
            nodeId: r.nodeId,
            droppedTotal: r.droppedTotal,
            failedEventsLastReport: r.failedLast,
            failedEventsTotal: r.failedTotals,
            reportsStored: r.reportsStored,
            duplicateDeliveries: r.duplicatesSeen,
            conflictingDeliveries: r.conflictsSeen,
          }
        : { everReported: false },
      chain: c
        ? {
            checkedAt: c.checkedAt,
            checkedAgeSeconds: age(now, c.checkedAt),
            ok: c.ok && c.complete,
            error: c.error,
            rpc: c.rpc,
            consecutiveFailures: c.consecutiveFailures,
            lastSuccessAt: c.lastSuccessAt,
            blockNumber: c.blockNumber,
            blockTimestamp: c.blockTimestamp,
            nextRequestId: c.nextRequestId,
            pendingCount: c.pendingCount,
            oldestPendingId: c.oldestPendingId,
            oldestPendingAgeSeconds: c.oldestPendingAge,
            keeperBalanceUsdc: c.balanceWei == null ? null : formatUsdc(BigInt(c.balanceWei)),
            backupKeeperBalances: backups.map((address) => {
              const wei = c.backupBalances[address.toLowerCase()];
              return { address, balanceUsdc: wei == null ? null : formatUsdc(BigInt(wei)) };
            }),
            baseFeeGwei: c.baseFeeWei == null ? null : formatGwei(BigInt(c.baseFeeWei)),
            feeCapGwei: formatGwei(net.feeCapWei),
            feeCapUsagePercent,
            committerIsKeeper: same(c.committer, net.keeper),
            coordinatorImplementationExpected: same(c.coordinatorImpl, net.implementations.coordinator),
            registryImplementationExpected: same(c.registryImpl, net.implementations.registry),
            refundScanCursorBlock: c.logCursor,
          }
        : null,
      alerts: readAlerts(storage, name).map(alertView(now)),
    };
  }
  return {
    service: "d20dao-watchdog",
    generatedAt: now,
    notifier: notifierConfigured(env) ? "configured" : "not configured",
    networks,
    airnodehub: listingStatus(storage, now, recipes),
    recentMessages: recentMessages(storage, 10).map((m) => ({
      at: m.created_at,
      network: m.network,
      severity: m.severity,
      text: m.text,
      delivery: m.status,
    })),
  };
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const ago = (seconds) => (seconds == null ? "never" : `${formatDuration(seconds)} ago`);
const utc = (t) => `${new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`;

// Tones are fixed class names; stored values only ever select one of them and never reach markup themselves.
const TONES = { ok: "ok", warning: "warning", alarm: "alarm", muted: "muted" };
const LABELS = { ok: "OK", warning: "WARNING", alarm: "ALARM" };
const DELIVERY_TONES = { sent: "ok", pending: "warning", failed: "alarm", not_sent: "muted" };
const DOCUMENT_VIEW = { ok: ["ok", "ok"], alarm: ["MISMATCH", "alarm"] };

const pick = (map, key) => (typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined);
const cls = (...names) => {
  const list = names.filter(Boolean);
  return list.length ? ` class="${list.join(" ")}"` : "";
};
const worstOf = (alerts) => (alerts.some((a) => a.severity === "alarm") ? "alarm" : alerts.length ? "warning" : "ok");
const label = (severity) => pick(LABELS, severity) ?? String(severity ?? "").toUpperCase();
const state = (tone, text = label(tone)) => `<span${cls("state", pick(TONES, tone))}>${escapeHtml(text)}</span>`;

function row(name, value, tone = "") {
  return `<tr><th scope="row">${escapeHtml(name)}</th><td${cls(pick(TONES, tone))}>${escapeHtml(value)}</td></tr>`;
}

function stat(name, figure, caption, tone = "") {
  return `<div><dt>${escapeHtml(name)}</dt><dd${cls("fig", pick(TONES, tone))}>${escapeHtml(figure)}</dd><dd class="sub">${escapeHtml(caption)}</dd></div>`;
}

function alertItem(a) {
  const tone = a.severity === "alarm" ? "alarm" : "warning";
  const caption = [a.detail, `since ${formatDuration(a.activeSeconds)}`].filter(Boolean).join(" · ");
  return `<li${cls(tone)}><strong${cls(tone)}>${escapeHtml(label(a.severity))}</strong>${escapeHtml(a.title)}<small>${escapeHtml(caption)}</small></li>`;
}

function sectionHead(title, alerts, { link = "", caption = "" } = {}) {
  const parts = [`<div class="head"><h2>${escapeHtml(title)}</h2>${state(worstOf(alerts))}${link}</div>`];
  if (caption) parts.push(`<p class="cap">${escapeHtml(caption)}</p>`);
  if (alerts.length) parts.push(`<ul class="alerts">${alerts.map(alertItem).join("")}</ul>`);
  return parts.join("");
}

function networkSection(name, n) {
  const r = n.report;
  const c = n.chain;

  const stats = [
    r.everReported
      ? stat("Keeper", r.healthy ? "Healthy" : "Unhealthy", `report ${ago(r.lastReceivedAgeSeconds)}`, r.healthy ? "ok" : "alarm")
      : stat("Keeper", "No reports", "none received yet", "muted"),
  ];
  if (!c) {
    stats.push(stat("Pending requests", "—", "not checked yet"), stat("Keeper balance", "—", "not checked yet"), stat("Base fee", "—", "not checked yet"));
  } else {
    const oldest = c.oldestPendingAgeSeconds == null ? "none" : `#${c.oldestPendingId}, ${formatDuration(c.oldestPendingAgeSeconds)}`;
    stats.push(
      stat("Pending requests", c.pendingCount ?? "unknown", `oldest ${oldest}`),
      stat("Keeper balance", c.keeperBalanceUsdc == null ? "unknown" : `${c.keeperBalanceUsdc} USDC`, `at block ${c.blockNumber == null ? "unknown" : `#${c.blockNumber}`}`),
      stat(
        "Base fee",
        c.baseFeeGwei == null ? "unknown" : `${c.baseFeeGwei} gwei`,
        c.baseFeeGwei == null ? `${c.feeCapGwei} gwei cap` : `${c.feeCapUsagePercent}% of ${c.feeCapGwei} gwei cap`,
      ),
    );
  }

  const reports = [];
  if (!r.everReported) {
    reports.push(row("Reports", "none received yet"));
  } else {
    const failed = Object.entries(r.failedEventsTotal).map(([k, v]) => `${k} ${v}`).join(", ");
    reports.push(
      row("Report observed", ago(r.reportObservedAgeSeconds)),
      row("Health observed", r.observed ? ago(r.healthObservedAgeSeconds) : "not yet observed"),
      row("Faults", r.faults.length ? r.faults.join(", ") : "none"),
      row("Sending enabled", r.sendEnabled == null ? "unknown" : r.sendEnabled ? "yes" : "no"),
      row("Dropped audit events", r.droppedTotal),
      row("Failed events (since first report)", failed || "none"),
    );
  }

  const chain = [];
  let backups = "";
  if (!c) {
    chain.push(row("Checked", "not yet"));
  } else {
    const wiring = [c.committerIsKeeper, c.coordinatorImplementationExpected, c.registryImplementationExpected];
    chain.push(
      row("Checked", `${ago(c.checkedAgeSeconds)}${c.ok ? "" : ` (${c.error ?? "failed"})`}`, c.ok ? "" : "alarm"),
      row("Committer and implementations", wiring.includes(null) ? "unknown" : wiring.every(Boolean) ? "as expected" : "MISMATCH", wiring.includes(false) ? "alarm" : ""),
      row("RPC", c.rpc ?? "none"),
    );
    const wallets = c.backupKeeperBalances ?? [];
    if (wallets.length) {
      backups =
        `<h3>Backup keepers</h3><table class="kv wallets">` +
        wallets
          .map((b) => `<tr><th scope="row">${escapeHtml(shortAddress(b.address))}</th><td>${escapeHtml(b.balanceUsdc == null ? "unknown" : `${b.balanceUsdc} USDC`)}</td></tr>`)
          .join("") +
        `</table>`;
    }
  }

  return (
    `<section class="section">` +
    sectionHead(name, n.alerts, { link: `<a href="${escapeHtml(n.explorer)}">Explorer</a>` }) +
    `<dl class="stats">${stats.join("")}</dl>` +
    `<div class="cols"><div><h3>Keeper reports</h3><table class="kv">${reports.join("")}</table></div>` +
    `<div><h3>Chain</h3><table class="kv">${chain.join("")}</table>${backups}</div></div>` +
    `</section>`
  );
}

function listingRow(r) {
  const probed = r.status !== "not probed";
  const status = probed ? state(r.status, label(r.status)) : `<span class="muted">not probed yet</span>`;
  const d = r.listingDocument;
  let doc = "—";
  if (d) {
    const [text, tone] = pick(DOCUMENT_VIEW, d.status) ?? [String(d.status), "muted"];
    doc = `<span class="${tone}">${escapeHtml(text)}</span> · ${escapeHtml(ago(d.checkedAgeSeconds))}`;
  }
  const notes = [];
  if (r.reason) notes.push(r.consecutiveFailures > 0 ? `${r.reason} (${r.consecutiveFailures} failed in a row)` : r.reason);
  if (r.verdict && r.verdict !== "ok" && r.verdictReason && r.verdictReason !== r.reason) notes.push(r.verdictReason);
  if (d?.reason) notes.push(String(d.reason).startsWith("listing document") ? d.reason : `listing document: ${d.reason}`);
  return (
    `<tbody><tr><th scope="row">${escapeHtml(r.name)}<small>recipe ${escapeHtml(r.registryRecipe)} · ${escapeHtml(r.operation)}</small></th>` +
    `<td>${status}</td><td>${probed ? escapeHtml(ago(r.lastProbeAgeSeconds)) : "—"}</td>` +
    `<td>${r.latencyMs == null ? "—" : `${escapeHtml(r.latencyMs)} ms`}</td><td>${doc}</td></tr>` +
    (notes.length ? `<tr class="note"><td colspan="5">${notes.map(escapeHtml).join("<br>")}</td></tr>` : "") +
    `</tbody>`
  );
}

function listingsSection(listings) {
  const caption = `Probed every ${formatDuration(listings.probeIntervalSeconds)} · listing documents every ${formatDuration(listings.listingDocumentIntervalSeconds)}`;
  return (
    `<section class="section">` +
    sectionHead("AirnodeHub listings", listings.alerts, { caption }) +
    `<div class="scroll" tabindex="0" role="region" aria-label="AirnodeHub listings"><table class="table">` +
    `<thead><tr><th scope="col">Listing</th><th scope="col">Status</th><th scope="col">Probed</th><th scope="col">Latency</th><th scope="col">Document</th></tr></thead>` +
    listings.recipes.map(listingRow).join("") +
    `</table></div></section>`
  );
}

function noticesSection(messages) {
  if (!messages.length) return "";
  const items = messages.map((m) => {
    const tone = pick(DELIVERY_TONES, m.delivery) ?? "muted";
    return `<li><span class="when">${escapeHtml(utc(m.at))}</span>${state(tone, String(m.delivery ?? "").replace(/_/g, " "))}<p>${escapeHtml(m.text)}</p></li>`;
  });
  return `<section class="section"><div class="head"><h2>Recent notices</h2></div><ul class="notices">${items.join("")}</ul></section>`;
}

// D20DAO lockup from the site's brand mark (src/components/brand-mark.tsx in the web repo).
const BRAND_MARK =
  `<svg role="img" aria-label="D20DAO" height="26" width="137.7" viewBox="0 -5 1112.29 210" xmlns="http://www.w3.org/2000/svg"><title>D20DAO</title>` +
  `<g fill="#FF2C61"><path d="M0 8L38 38L38 162L0 192Z"/><path d="M0 0L101 0L169 49L132 76L89 40L48 40Z"/><path d="M174 58L174 149L101 200L0 200L48 160L89 160L134 127L134 86Z"/></g>` +
  `<g fill="#F5F2EE"><path d="M211.0 199.75 211.02 168.73 295.72 93.38Q305.44 84.78 309.32 77.15Q313.2 69.51 313.2 62.62Q313.2 53.06 309.19 45.55Q305.19 38.04 298.0 33.72Q290.81 29.4 281.25 29.4Q271.28 29.4 263.64 33.99Q256.01 38.58 251.77 46.09Q247.53 53.6 247.78 62.36H211.16Q211.16 42.09 220.14 27.17Q229.11 12.25 245.05 4.04Q260.99 -4.17 282.02 -4.17Q301.43 -4.17 316.79 4.37Q332.16 12.92 340.99 28.1Q349.82 43.28 349.82 63.13Q349.82 77.7 345.8 87.45Q341.78 97.2 333.82 105.45Q325.86 113.69 314.19 123.89L256.76 174.51L253.69 166.18H349.82V199.75Z"/>` +
  `<path d="M447.88 204.17Q426.12 204.17 409.69 194.95Q393.26 185.73 384.04 169.3Q374.82 152.87 374.82 131.11V68.89Q374.82 47.13 384.04 30.7Q393.26 14.27 409.69 5.05Q426.12 -4.17 447.88 -4.17Q469.63 -4.17 486.06 5.05Q502.49 14.27 511.71 30.7Q520.93 47.13 520.93 68.89V131.11Q520.93 152.87 511.71 169.3Q502.49 185.73 486.06 194.95Q469.63 204.17 447.88 204.17ZM447.88 170.35Q458.16 170.35 466.48 165.46Q474.8 160.58 479.68 152.26Q484.57 143.95 484.57 133.66V66.09Q484.57 55.8 479.68 47.48Q474.8 39.17 466.48 34.28Q458.16 29.4 447.88 29.4Q437.59 29.4 429.27 34.28Q420.95 39.17 416.07 47.48Q411.19 55.8 411.19 66.09V133.66Q411.19 143.95 416.07 152.26Q420.95 160.58 429.27 165.46Q437.59 170.35 447.88 170.35Z"/>` +
  `<path d="M546.93 200.0V0.0H611.14Q613.61 0.0 621.02 0.14Q628.42 0.28 635.26 1.13Q659.26 4.07 675.87 17.95Q692.49 31.83 701.1 53.2Q709.71 74.57 709.71 100.0Q709.71 125.44 701.1 146.81Q692.49 168.18 675.87 182.05Q659.26 195.93 635.26 198.87Q628.44 199.71 621.01 199.86Q613.59 200.0 611.14 200.0ZM583.11 166.43H611.14Q615.14 166.43 621.56 166.21Q627.97 165.98 633.07 165.02Q646.68 162.33 655.25 152.55Q663.83 142.78 667.91 128.89Q672.0 115.01 672.0 100.0Q672.0 84.35 667.79 70.47Q663.57 56.59 654.93 47.07Q646.29 37.55 633.07 34.98Q627.97 33.89 621.54 33.73Q615.1 33.57 611.14 33.57H583.11Z"/>` +
  `<path d="M729.71 200.0 791.79 0.0H844.52L906.61 200.0H869.92L814.11 22.08H821.42L766.4 200.0ZM765.64 157.48V124.21H870.91V157.48Z"/>` +
  `<path d="M1015.95 204.17Q985.96 204.17 964.38 191.09Q942.79 178.01 931.2 154.54Q919.61 131.06 919.61 100.0Q919.61 68.94 931.2 45.46Q942.79 21.99 964.38 8.91Q985.96 -4.17 1015.95 -4.17Q1045.94 -4.17 1067.52 8.91Q1089.11 21.99 1100.7 45.46Q1112.29 68.94 1112.29 100.0Q1112.29 131.06 1100.7 154.54Q1089.11 178.01 1067.52 191.09Q1045.94 204.17 1015.95 204.17ZM1015.95 170.6Q1035.53 170.86 1048.55 162.1Q1061.56 153.34 1068.07 137.35Q1074.58 121.35 1074.58 100.0Q1074.58 78.65 1068.07 62.9Q1061.56 47.15 1048.55 38.4Q1035.53 29.65 1015.95 29.4Q996.37 29.14 983.36 37.89Q970.36 46.64 963.85 62.64Q957.34 78.65 957.32 100.0Q957.29 121.35 963.8 137.09Q970.31 152.84 983.34 161.59Q996.37 170.35 1015.95 170.6Z"/></g></svg>`;

// Site tokens from d20dao.org (app/globals.css): muted text is white mixed 68% into black, hairlines are white at
// 16% (strong 30%). Written out as plain colors so the page needs no color-mix() support.
const STYLE = `
:root{color-scheme:dark;--bg:#000;--fg:#fff;--muted:#adadad;--line:rgba(255,255,255,.16);--line-strong:rgba(255,255,255,.3);--pink:#ff3366;--orange:#ff9f1c;--yellow:#ffd447;--green:#3ddc84;--ink:#030018;--radius:4px;--mono:"Courier New",monospace;--caption:.875rem}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
a{color:inherit;text-decoration:none;transition:color 160ms cubic-bezier(.2,.7,.2,1)}
a:hover{color:var(--yellow)}
:focus-visible{outline:2px solid var(--yellow);outline-offset:6px}
[tabindex="-1"]:focus{outline:none}
::selection{background:var(--pink);color:var(--ink)}
.skip{position:absolute;left:12px;top:8px;transform:translateY(-200%);background:var(--pink);color:var(--ink);padding:12px;border-radius:var(--radius);z-index:10}
.skip:focus{transform:none}
.shell{width:min(1280px,calc(100% - 48px));margin:auto;padding-bottom:80px}
.header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:24px 0;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px}
.brand svg{display:block;flex-shrink:0;height:26px;width:auto}
.brand span{padding-left:16px;margin-left:8px;border-left:1px solid var(--line);font:var(--caption)/1.6 var(--mono);color:var(--muted)}
.header nav{display:flex;flex-wrap:wrap;gap:8px 24px;font:var(--caption)/1.6 var(--mono)}
main{display:block;padding-top:48px;min-width:0}
.top{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px 24px}
h1{font-size:clamp(28px,4vw,40px);font-weight:400;line-height:1.15;letter-spacing:-.03em;margin:0 0 6px;overflow-wrap:anywhere}
.tagline{margin:0;color:var(--muted);font:var(--caption)/1.6 var(--mono);font-variant-numeric:tabular-nums}
.pill{display:inline-flex;align-items:center;gap:10px;margin:4px 0 0;padding:8px 14px;border:1px solid var(--line-strong);border-radius:999px;font:var(--caption)/1.4 var(--mono);letter-spacing:.06em;white-space:nowrap}
.pill i{width:8px;height:8px;border-radius:50%;flex:none;background:currentColor}
.section{border-top:1px solid var(--line);padding-top:28px;margin-top:40px}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin:0 0 18px}
h2{font-size:24px;font-weight:400;letter-spacing:-.025em;line-height:1.2;margin:0;overflow-wrap:anywhere}
.head a{margin-left:auto;font:var(--caption)/1.6 var(--mono);color:var(--yellow);text-decoration:underline;text-underline-offset:4px}
.cap{margin:-6px 0 18px;color:var(--muted);font-size:12px}
.state{display:inline-block;padding:3px 10px;border:1px solid var(--line-strong);border-radius:999px;font:12px/1.4 var(--mono);letter-spacing:.06em;white-space:nowrap;color:var(--muted)}
.alerts{list-style:none;margin:0 0 24px;padding:0;display:grid;gap:8px}
.alerts li{padding:10px 16px;border-left:2px solid var(--orange);color:var(--fg);font-size:var(--caption);line-height:1.6;overflow-wrap:anywhere}
.alerts li.alarm{border-left-color:var(--pink)}
.alerts strong{margin-right:10px;font:12px/1.4 var(--mono);letter-spacing:.06em}
.alerts small{display:block;color:var(--muted);font-size:12px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0 0 32px;border:1px solid var(--line);border-radius:calc(var(--radius) * 2)}
.stats>div{padding:16px 18px;min-width:0}
.stats>div+div{border-left:1px solid var(--line)}
.stats dt,.kv th,.table thead th,h3{font:12px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:400}
.stats dd{margin:0}
.stats .fig{margin:8px 0 4px;font:500 20px/1.3 var(--mono);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.stats .sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px 48px}
h3{margin:0 0 4px;color:var(--fg);letter-spacing:.08em}
.kv{width:100%;border-collapse:collapse;font-size:var(--caption)}
.kv th,.kv td{padding:12px 0;border-bottom:1px solid var(--line);text-align:left;vertical-align:baseline;overflow-wrap:anywhere}
.kv th{width:45%;padding-right:16px}
.kv td{font-family:var(--mono);font-variant-numeric:tabular-nums}
.kv+h3{margin-top:28px}
.wallets th{font-size:var(--caption);letter-spacing:0;text-transform:none}
.scroll{overflow-x:auto}
.scroll:focus-visible{outline-offset:2px}
.table{width:100%;border-collapse:collapse;text-align:left;font-size:var(--caption)}
.table th,.table td{padding:14px 12px;white-space:nowrap;vertical-align:baseline;font-variant-numeric:tabular-nums}
.table th:first-child,.table td:first-child{padding-left:0}
.table thead th{border-bottom:1px solid var(--line)}
.table tbody{border-bottom:1px solid var(--line)}
.table tbody th{min-width:12em;font-weight:400;white-space:normal}
.table small{display:block;margin-top:4px;font:12px/1.4 var(--mono);color:var(--muted)}
.table .note td{padding-top:0;white-space:normal;overflow-wrap:anywhere;font:12px/1.6 var(--mono);color:var(--muted)}
.notices{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.notices li{display:grid;grid-template-columns:14em 8em minmax(0,1fr);gap:6px 16px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--line);font-size:var(--caption);line-height:1.6}
.notices .state{justify-self:start}
.notices p{margin:0;overflow-wrap:anywhere}
.when{font:12px/1.6 var(--mono);color:var(--muted);font-variant-numeric:tabular-nums}
.ok{color:var(--green)}.warning{color:var(--orange)}.alarm{color:var(--pink)}.muted{color:var(--muted)}
.pill.ok,.state.ok{border-color:rgba(61,220,132,.45)}
.pill.warning,.state.warning{border-color:rgba(255,159,28,.45)}
.pill.alarm,.state.alarm{border-color:rgba(255,51,102,.45)}
.pill.ok i{box-shadow:0 0 0 3px rgba(61,220,132,.22)}
@media (prefers-reduced-motion:reduce){a{transition:none}}
@media (max-width:900px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stats>div:nth-child(3){border-left:0}.stats>div:nth-child(n+3){border-top:1px solid var(--line)}.cols{grid-template-columns:minmax(0,1fr)}.header nav{gap:8px 16px}}
@media (max-width:600px){.shell{width:calc(100% - 32px)}main{padding-top:28px}.header{flex-wrap:wrap;gap:16px}.header nav{width:100%}.brand svg{height:22px}.brand span{padding-left:12px;margin-left:0}.section{margin-top:32px;padding-top:24px}.table th,.table td{padding:12px 10px}.notices li{grid-template-columns:auto minmax(0,1fr)}.notices p{grid-column:1/-1}}
@media (max-width:420px){.stats>div{padding:14px}.stats .fig{font-size:17px}}
`;

export function renderHtml(status) {
  const sections =
    Object.entries(status.networks).map(([name, n]) => networkSection(name, n)).join("") +
    (status.airnodehub ? listingsSection(status.airnodehub) : "");
  const alerts = [...Object.values(status.networks).flatMap((n) => n.alerts), ...(status.airnodehub?.alerts ?? [])];
  const overall = worstOf(alerts);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta http-equiv="refresh" content="60">
<title>D20DAO Watchdog</title>
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#status">Skip to status</a>
<div class="shell">
<header class="header"><a class="brand" href="https://d20dao.org">${BRAND_MARK}<span>Status</span></a><nav aria-label="D20DAO"><a href="https://d20dao.org/explorer">Explorer</a><a href="https://d20dao.org/docs">Docs</a><a href="/status.json">status.json</a></nav></header>
<main id="status" tabindex="-1">
<div class="top"><div><h1>D20DAO keeper watchdog</h1><p class="tagline">Generated ${escapeHtml(utc(status.generatedAt))} · notifier ${escapeHtml(status.notifier)}</p></div><p${cls("pill", overall)}><i aria-hidden="true"></i>${label(overall)}</p></div>
${sections}${noticesSection(status.recentMessages)}
</main>
</div>
</body>
</html>`;
}
