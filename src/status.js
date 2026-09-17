// Sanitized public read model: status JSON and a small server-rendered HTML page.
// Never includes secrets, raw report bodies or report ids.

import { evaluateListingDocumentCheck, evaluateProbeCheck } from "./checks.js";
import { AIRNODE_RECIPES, AIRNODE_SCOPE, LIMITS, NETWORKS, NETWORK_NAMES, THRESHOLDS } from "./config.js";
import { formatDuration, formatGwei, formatUsdc } from "./format.js";
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

export function buildStatus(storage, env, now, recipes = AIRNODE_RECIPES) {
  const networks = {};
  for (const name of NETWORK_NAMES) {
    const net = NETWORKS[name];
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

function row(label, value, tone = "") {
  return `<tr><th>${escapeHtml(label)}</th><td${tone ? ` class="${tone}"` : ""}>${escapeHtml(value)}</td></tr>`;
}

function sectionHeader(title, alerts) {
  const worst = alerts.some((a) => a.severity === "alarm") ? "alarm" : alerts.length ? "warning" : "ok";
  const badge = { alarm: "ALARM", warning: "WARNING", ok: "OK" }[worst];
  const parts = [`<section><h2>${escapeHtml(title)} <span class="badge ${worst}">${badge}</span></h2>`];
  if (alerts.length) {
    parts.push("<ul class=\"alerts\">");
    for (const a of alerts) {
      parts.push(
        `<li class="${escapeHtml(a.severity)}"><strong>${escapeHtml(a.severity.toUpperCase())}</strong> ${escapeHtml(a.title)}` +
          `<br><small>${escapeHtml(a.detail)} &middot; since ${escapeHtml(formatDuration(a.activeSeconds))}</small></li>`,
      );
    }
    parts.push("</ul>");
  }
  return parts;
}

function networkSection(name, n) {
  const r = n.report;
  const c = n.chain;
  const parts = sectionHeader(name, n.alerts);

  parts.push("<h3>Keeper reports</h3><table>");
  if (!r.everReported) {
    parts.push(row("Reports", "none received yet"));
  } else {
    parts.push(row("Last report received", ago(r.lastReceivedAgeSeconds)));
    parts.push(row("Report observed", ago(r.reportObservedAgeSeconds)));
    parts.push(row("Health observed", r.observed ? ago(r.healthObservedAgeSeconds) : "not yet observed"));
    parts.push(row("Healthy", r.healthy ? "yes" : "no", r.healthy ? "good" : "bad"));
    parts.push(row("Faults", r.faults.length ? r.faults.join(", ") : "none"));
    parts.push(row("Sending enabled", r.sendEnabled == null ? "unknown" : r.sendEnabled ? "yes" : "no"));
    parts.push(row("Dropped audit events", r.droppedTotal));
    const failed = Object.entries(r.failedEventsTotal).map(([k, v]) => `${k} ${v}`).join(", ");
    parts.push(row("Failed events (since first report)", failed || "none"));
  }
  parts.push("</table><h3>Chain</h3><table>");
  if (!c) {
    parts.push(row("Checked", "not yet"));
  } else {
    parts.push(row("Checked", `${ago(c.checkedAgeSeconds)}${c.ok ? "" : ` (${c.error ?? "failed"})`}`, c.ok ? "" : "bad"));
    parts.push(row("Block", c.blockNumber ?? "unknown"));
    parts.push(row("Pending requests", c.pendingCount ?? "unknown"));
    parts.push(row("Oldest pending", c.oldestPendingAgeSeconds == null ? "none" : `#${c.oldestPendingId}, ${formatDuration(c.oldestPendingAgeSeconds)}`));
    parts.push(row("Keeper balance", c.keeperBalanceUsdc == null ? "unknown" : `${c.keeperBalanceUsdc} USDC`));
    parts.push(row("Base fee", c.baseFeeGwei == null ? "unknown" : `${c.baseFeeGwei} gwei (${c.feeCapUsagePercent}% of ${c.feeCapGwei} gwei cap)`));
    const wiring = [c.committerIsKeeper, c.coordinatorImplementationExpected, c.registryImplementationExpected];
    parts.push(row("Committer and implementations", wiring.includes(null) ? "unknown" : wiring.every(Boolean) ? "as expected" : "MISMATCH", wiring.includes(false) ? "bad" : ""));
    parts.push(row("RPC", c.rpc ?? "none"));
  }
  parts.push(`</table><p class="links"><a href="${escapeHtml(n.explorer)}">Explorer</a></p></section>`);
  return parts.join("");
}

const PROBE_TONE = { ok: "good", warning: "warning", alarm: "bad" };

function listingsSection(listings) {
  const parts = sectionHeader("AirnodeHub listings", listings.alerts);
  parts.push("<table>");
  for (const r of listings.recipes) {
    let summary = "not probed yet";
    if (r.status !== "not probed") {
      const label = r.status === "ok" ? "OK" : r.status.toUpperCase();
      summary =
        `<span class="${PROBE_TONE[r.status] ?? ""}">${escapeHtml(label)}</span> &middot; probed ${escapeHtml(ago(r.lastProbeAgeSeconds))}` +
        (r.latencyMs == null ? "" : ` &middot; ${escapeHtml(r.latencyMs)} ms`);
    }
    const notes = [];
    if (r.reason) notes.push(r.consecutiveFailures > 0 ? `${r.reason} (${r.consecutiveFailures} failed in a row)` : r.reason);
    if (r.verdict && r.verdict !== "ok" && r.verdictReason && r.verdictReason !== r.reason) notes.push(r.verdictReason);
    const d = r.listingDocument;
    if (d) notes.push(`listing document ${d.status === "alarm" ? "MISMATCH" : d.status}, checked ${ago(d.checkedAgeSeconds)}${d.reason ? `: ${d.reason}` : ""}`);
    parts.push(
      `<tr><th>${escapeHtml(r.name)}<br><small>recipe ${escapeHtml(r.registryRecipe)} &middot; ${escapeHtml(r.operation)}</small></th>` +
        `<td>${summary}${notes.map((note) => `<br><small>${escapeHtml(note)}</small>`).join("")}</td></tr>`,
    );
  }
  parts.push(
    `</table><p class="meta">Each listing is probed every ${escapeHtml(formatDuration(listings.probeIntervalSeconds))} and its listing document read every ${escapeHtml(formatDuration(listings.listingDocumentIntervalSeconds))}.</p></section>`,
  );
  return parts.join("");
}

export function renderHtml(status) {
  const sections =
    Object.entries(status.networks).map(([name, n]) => networkSection(name, n)).join("") +
    (status.airnodehub ? listingsSection(status.airnodehub) : "");
  const messages = status.recentMessages.length
    ? `<section><h2>Recent notices</h2><ul class="notices">${status.recentMessages
        .map((m) => `<li><small>${escapeHtml(new Date(m.at * 1000).toISOString().replace("T", " ").slice(0, 19))} UTC &middot; ${escapeHtml(m.delivery)}</small><br>${escapeHtml(m.text)}</li>`)
        .join("")}</ul></section>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="60">
<title>D20DAO Watchdog</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--card:#fff;--ok:#15803d;--warn:#b45309;--alarm:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--ok:#4ade80;--warn:#fbbf24;--alarm:#f87171}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto}
h1{font-size:1.3rem;margin:0 0 4px}
h2{font-size:1.1rem;margin:0 0 8px;display:flex;align-items:center;gap:8px}
h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 4px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:5px 0;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{font-weight:500;color:var(--muted);width:45%;padding-right:10px}
.badge{font-size:.72rem;padding:2px 8px;border-radius:999px;border:1px solid currentColor}
.ok{color:var(--ok)}.warning{color:var(--warn)}.alarm{color:var(--alarm)}
.good{color:var(--ok)}.bad{color:var(--alarm)}
ul{list-style:none;padding:0;margin:0}
.alerts li,.notices li{padding:6px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.alerts small,td small,th small{color:var(--muted)}
.notices small{color:var(--muted)}
.meta{color:var(--muted);font-size:.85rem;margin:0}
a{color:inherit}
</style>
</head>
<body>
<main>
<h1>D20DAO keeper watchdog</h1>
<p class="meta">Generated ${escapeHtml(new Date(status.generatedAt * 1000).toISOString().replace("T", " ").slice(0, 19))} UTC &middot; notifier ${escapeHtml(status.notifier)} &middot; <a href="/status.json">status.json</a></p>
${sections}${messages}
</main>
</body>
</html>`;
}
