// SQLite persistence for the single watchdog Durable Object.
// `storage` is {sql, transactionSync}: ctx.storage in the Worker, a node:sqlite adapter in tests.
// Every statement is a single SQL statement (Durable Object SQL runs one per exec call here).

import { LIMITS } from "./config.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reports (
     report_id TEXT PRIMARY KEY,
     network TEXT NOT NULL,
     body_sha256 TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     observed_at INTEGER NOT NULL,
     failed_json TEXT
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS reports_by_received_at ON reports (received_at)`,
  `CREATE TABLE IF NOT EXISTS report_state (
     network TEXT PRIMARY KEY,
     first_received_at INTEGER NOT NULL,
     last_received_at INTEGER NOT NULL,
     last_report_id TEXT NOT NULL,
     report_observed_at INTEGER NOT NULL,
     health_observed_at INTEGER,
     healthy INTEGER NOT NULL,
     send_enabled INTEGER,
     faults_json TEXT NOT NULL,
     node_id TEXT NOT NULL,
     dropped_total INTEGER NOT NULL,
     dropped_alerted_total INTEGER NOT NULL,
     failed_last_json TEXT NOT NULL,
     failed_totals_json TEXT NOT NULL,
     unhealthy_since INTEGER,
     reports_stored INTEGER NOT NULL,
     duplicates_seen INTEGER NOT NULL,
     conflicts_seen INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS chain_state (
     network TEXT PRIMARY KEY,
     checked_at INTEGER NOT NULL,
     ok INTEGER NOT NULL,
     complete INTEGER NOT NULL,
     error TEXT,
     rpc TEXT,
     consecutive_failures INTEGER NOT NULL,
     last_success_at INTEGER,
     block_number INTEGER,
     block_timestamp INTEGER,
     base_fee_wei TEXT,
     balance_wei TEXT,
     next_request_id TEXT,
     pending_count INTEGER,
     oldest_pending_id TEXT,
     oldest_pending_age INTEGER,
     committer TEXT,
     coordinator_impl TEXT,
     registry_impl TEXT,
     log_cursor INTEGER,
     log_span INTEGER
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS alerts (
     alert_key TEXT PRIMARY KEY,
     network TEXT NOT NULL,
     check_name TEXT NOT NULL,
     severity TEXT NOT NULL,
     title TEXT NOT NULL,
     detail TEXT NOT NULL,
     since INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_alarm_at INTEGER,
     event INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY,
     created_at INTEGER NOT NULL,
     network TEXT NOT NULL,
     severity TEXT NOT NULL,
     text TEXT NOT NULL,
     status TEXT NOT NULL,
     attempts INTEGER NOT NULL,
     sent_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS messages_pending ON messages (id) WHERE status = 'pending'`,
  // AirnodeHub probe state per recipe id, as JSON (see src/listings.js), so fields can be added without migrations.
  `CREATE TABLE IF NOT EXISTS probe_state (
     recipe_id TEXT PRIMARY KEY,
     updated_at INTEGER NOT NULL,
     state_json TEXT NOT NULL
   ) WITHOUT ROWID`,
];

export function migrate(storage) {
  for (const statement of SCHEMA) storage.sql.exec(statement);
}

const rows = (storage, query, ...bindings) => storage.sql.exec(query, ...bindings).toArray();
const first = (storage, query, ...bindings) => rows(storage, query, ...bindings)[0] ?? null;
const bool = (v) => (v == null ? null : v ? 1 : 0);

function parseJson(text, fallback) {
  try {
    return text == null ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------
// Reports

/**
 * Store a validated report summary. Returns "stored", "duplicate" (same id and bytes) or
 * "conflict" (same id, different bytes). Runs in one transaction.
 */
export function ingestReport(storage, rec) {
  return storage.transactionSync(() => {
    const existing = first(storage, "SELECT body_sha256 FROM reports WHERE report_id = ?", rec.reportId);
    const state = first(storage, "SELECT * FROM report_state WHERE network = ?", rec.network);
    if (existing) {
      const duplicate = existing.body_sha256 === rec.bodySha256;
      if (state && duplicate) {
        // A retry proves the keeper is alive; it never re-applies the report's activity.
        storage.sql.exec(
          "UPDATE report_state SET last_received_at = MAX(last_received_at, ?), duplicates_seen = duplicates_seen + 1 WHERE network = ?",
          rec.receivedAt,
          rec.network,
        );
      } else if (state) {
        storage.sql.exec("UPDATE report_state SET conflicts_seen = conflicts_seen + 1 WHERE network = ?", rec.network);
      }
      return duplicate ? "duplicate" : "conflict";
    }

    const failedJson = Object.keys(rec.failedCounts).length > 0 ? JSON.stringify(rec.failedCounts) : null;
    storage.sql.exec(
      "INSERT INTO reports (report_id, network, body_sha256, received_at, observed_at, failed_json) VALUES (?, ?, ?, ?, ?, ?)",
      rec.reportId,
      rec.network,
      rec.bodySha256,
      rec.receivedAt,
      rec.observedAt,
      failedJson,
    );

    if (!state) {
      storage.sql.exec(
        `INSERT INTO report_state (network, first_received_at, last_received_at, last_report_id, report_observed_at,
           health_observed_at, healthy, send_enabled, faults_json, node_id, dropped_total, dropped_alerted_total,
           failed_last_json, failed_totals_json, unhealthy_since, reports_stored, duplicates_seen, conflicts_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
        rec.network,
        rec.receivedAt,
        rec.receivedAt,
        rec.reportId,
        rec.observedAt,
        rec.healthObservedAt,
        bool(rec.healthy),
        bool(rec.sendEnabled),
        JSON.stringify(rec.faults),
        rec.nodeId,
        rec.droppedTotal,
        rec.droppedTotal, // baseline: only increases after the first report raise a notice
        JSON.stringify(rec.failedCounts),
        JSON.stringify(rec.failedCounts),
        rec.healthy ? null : rec.observedAt,
      );
      return "stored";
    }

    const totals = parseJson(state.failed_totals_json, {});
    for (const [kind, count] of Object.entries(rec.failedCounts)) totals[kind] = (totals[kind] ?? 0) + count;
    const lastReceivedAt = Math.max(state.last_received_at, rec.receivedAt);

    if (rec.observedAt >= state.report_observed_at) {
      const unhealthySince = rec.healthy ? null : (state.healthy ? rec.observedAt : state.unhealthy_since ?? rec.observedAt);
      storage.sql.exec(
        `UPDATE report_state SET last_received_at = ?, last_report_id = ?, report_observed_at = ?, health_observed_at = ?,
           healthy = ?, send_enabled = ?, faults_json = ?, node_id = ?, dropped_total = MAX(dropped_total, ?),
           failed_last_json = ?, failed_totals_json = ?, unhealthy_since = ?, reports_stored = reports_stored + 1
         WHERE network = ?`,
        lastReceivedAt,
        rec.reportId,
        rec.observedAt,
        rec.healthObservedAt,
        bool(rec.healthy),
        bool(rec.sendEnabled),
        JSON.stringify(rec.faults),
        rec.nodeId,
        rec.droppedTotal,
        JSON.stringify(rec.failedCounts),
        JSON.stringify(totals),
        unhealthySince,
        rec.network,
      );
    } else {
      // Older than the stored observation (out-of-order retry): count activity, keep newer health.
      storage.sql.exec(
        `UPDATE report_state SET last_received_at = ?, dropped_total = MAX(dropped_total, ?), failed_totals_json = ?,
           reports_stored = reports_stored + 1 WHERE network = ?`,
        lastReceivedAt,
        rec.droppedTotal,
        JSON.stringify(totals),
        rec.network,
      );
    }
    return "stored";
  });
}

export function pruneReports(storage, cutoff) {
  storage.sql.exec("DELETE FROM reports WHERE received_at < ?", cutoff);
}

export function readReportState(storage, network) {
  const r = first(storage, "SELECT * FROM report_state WHERE network = ?", network);
  if (!r) return null;
  return {
    firstReceivedAt: r.first_received_at,
    lastReceivedAt: r.last_received_at,
    lastReportId: r.last_report_id,
    reportObservedAt: r.report_observed_at,
    healthObservedAt: r.health_observed_at,
    healthy: r.healthy === 1,
    sendEnabled: r.send_enabled == null ? null : r.send_enabled === 1,
    faults: parseJson(r.faults_json, []),
    nodeId: r.node_id,
    droppedTotal: r.dropped_total,
    droppedAlertedTotal: r.dropped_alerted_total,
    failedLast: parseJson(r.failed_last_json, {}),
    failedTotals: parseJson(r.failed_totals_json, {}),
    unhealthySince: r.unhealthy_since,
    reportsStored: r.reports_stored,
    duplicatesSeen: r.duplicates_seen,
    conflictsSeen: r.conflicts_seen,
  };
}

export function markDroppedAlerted(storage, network, total) {
  storage.sql.exec(
    "UPDATE report_state SET dropped_alerted_total = ? WHERE network = ? AND dropped_alerted_total < ?",
    total,
    network,
    total,
  );
}

// ---------------------------------------------------------------------------------------------
// Chain state

export function readChainState(storage, network) {
  const r = first(storage, "SELECT * FROM chain_state WHERE network = ?", network);
  if (!r) return null;
  return {
    checkedAt: r.checked_at,
    ok: r.ok === 1,
    complete: r.complete === 1,
    error: r.error,
    rpc: r.rpc,
    consecutiveFailures: r.consecutive_failures,
    lastSuccessAt: r.last_success_at,
    blockNumber: r.block_number,
    blockTimestamp: r.block_timestamp,
    baseFeeWei: r.base_fee_wei,
    balanceWei: r.balance_wei,
    nextRequestId: r.next_request_id,
    pendingCount: r.pending_count,
    oldestPendingId: r.oldest_pending_id,
    oldestPendingAge: r.oldest_pending_age,
    committer: r.committer,
    coordinatorImpl: r.coordinator_impl,
    registryImpl: r.registry_impl,
    logCursor: r.log_cursor,
    logSpan: r.log_span,
  };
}

/** Persist a readChain() result. Unknown figures keep their previous stored values. */
export function writeChainState(storage, network, now, read, previous) {
  const success = read.ok && read.complete;
  const failures = success ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
  const keep = (value, prev) => (value == null ? prev ?? null : value);
  const str = (v) => (v == null ? null : v.toString());
  const pendingKnown = read.ok && read.pending != null;
  storage.sql.exec(
    `INSERT INTO chain_state (network, checked_at, ok, complete, error, rpc, consecutive_failures, last_success_at,
       block_number, block_timestamp, base_fee_wei, balance_wei, next_request_id, pending_count, oldest_pending_id,
       oldest_pending_age, committer, coordinator_impl, registry_impl, log_cursor, log_span)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (network) DO UPDATE SET checked_at = excluded.checked_at, ok = excluded.ok, complete = excluded.complete,
       error = excluded.error, rpc = excluded.rpc, consecutive_failures = excluded.consecutive_failures,
       last_success_at = excluded.last_success_at, block_number = excluded.block_number,
       block_timestamp = excluded.block_timestamp, base_fee_wei = excluded.base_fee_wei,
       balance_wei = excluded.balance_wei, next_request_id = excluded.next_request_id,
       pending_count = excluded.pending_count, oldest_pending_id = excluded.oldest_pending_id,
       oldest_pending_age = excluded.oldest_pending_age, committer = excluded.committer,
       coordinator_impl = excluded.coordinator_impl, registry_impl = excluded.registry_impl,
       log_cursor = excluded.log_cursor, log_span = excluded.log_span`,
    network,
    now,
    read.ok ? 1 : 0,
    success ? 1 : 0,
    success ? null : read.error ?? "failed",
    read.rpc ?? null,
    failures,
    success ? now : previous?.lastSuccessAt ?? null,
    read.ok ? read.block.number : previous?.blockNumber ?? null,
    read.ok ? read.block.timestamp : previous?.blockTimestamp ?? null,
    keep(str(read.block?.baseFeeWei), previous?.baseFeeWei),
    keep(str(read.balanceWei), previous?.balanceWei),
    keep(str(read.nextRequestId), previous?.nextRequestId),
    pendingKnown ? read.pending.count : null,
    pendingKnown && read.pending.oldest ? read.pending.oldest.id.toString() : null,
    pendingKnown && read.pending.oldest ? read.pending.oldest.ageSeconds : null,
    keep(read.committer, previous?.committer),
    keep(read.coordinatorImpl, previous?.coordinatorImpl),
    keep(read.registryImpl, previous?.registryImpl),
    read.ok ? read.logCursor : previous?.logCursor ?? null,
    read.ok ? read.logSpan : previous?.logSpan ?? null,
  );
  return failures;
}

// ---------------------------------------------------------------------------------------------
// Alerts

export function readAlerts(storage, network) {
  const list = network
    ? rows(storage, "SELECT * FROM alerts WHERE network = ?", network)
    : rows(storage, "SELECT * FROM alerts");
  return list.map((r) => ({
    network: r.network,
    check: r.check_name,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    since: r.since,
    updatedAt: r.updated_at,
    lastAlarmAt: r.last_alarm_at,
    event: r.event === 1,
  }));
}

export function saveAlert(storage, key, row) {
  if (!row) {
    storage.sql.exec("DELETE FROM alerts WHERE alert_key = ?", key);
    return;
  }
  storage.sql.exec(
    `INSERT INTO alerts (alert_key, network, check_name, severity, title, detail, since, updated_at, last_alarm_at, event)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (alert_key) DO UPDATE SET severity = excluded.severity, title = excluded.title, detail = excluded.detail,
       since = excluded.since, updated_at = excluded.updated_at, last_alarm_at = excluded.last_alarm_at, event = excluded.event`,
    key,
    row.network,
    row.check,
    row.severity,
    row.title,
    row.detail,
    row.since,
    row.updatedAt,
    row.lastAlarmAt,
    row.event ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------------------------
// Outgoing messages (Telegram outbox + recent notice log)

export function enqueueMessage(storage, now, network, severity, text, deliverable) {
  storage.sql.exec(
    "INSERT INTO messages (created_at, network, severity, text, status, attempts) VALUES (?, ?, ?, ?, ?, 0)",
    now,
    network,
    severity,
    text,
    deliverable ? "pending" : "not_sent",
  );
}

export function pendingMessages(storage) {
  return rows(storage, "SELECT id, created_at, text, attempts FROM messages WHERE status = 'pending' ORDER BY id");
}

export function markMessages(storage, ids, now, delivered) {
  for (const id of ids) {
    if (delivered) {
      storage.sql.exec("UPDATE messages SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?", now, id);
    } else {
      storage.sql.exec(
        `UPDATE messages SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ? OR created_at < ? THEN 'failed' ELSE status END
         WHERE id = ?`,
        LIMITS.messageMaxAttempts,
        now - LIMITS.messageMaxAgeSeconds,
        id,
      );
    }
  }
}

/** Give up on pending messages older than the maximum age (e.g. notifier removed or Telegram down). */
export function expireMessages(storage, now) {
  storage.sql.exec(
    "UPDATE messages SET status = 'failed' WHERE status = 'pending' AND created_at < ?",
    now - LIMITS.messageMaxAgeSeconds,
  );
}

/** Keep the message log bounded. */
export function pruneMessages(storage) {
  const cutoff = first(storage, "SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?", LIMITS.messagesKept);
  if (cutoff) storage.sql.exec("DELETE FROM messages WHERE id <= ? AND status != 'pending'", cutoff.id);
}

export function recentMessages(storage, limit = 20) {
  return rows(storage, "SELECT created_at, network, severity, text, status FROM messages ORDER BY id DESC LIMIT ?", limit);
}

// ---------------------------------------------------------------------------------------------
// AirnodeHub probe state

/** Map of recipe id -> probe state object. Unreadable rows are skipped (the recipe is then due again). */
export function readProbeStates(storage) {
  const states = new Map();
  for (const r of rows(storage, "SELECT recipe_id, state_json FROM probe_state")) {
    const state = parseJson(r.state_json, null);
    if (state && typeof state === "object") states.set(r.recipe_id, state);
  }
  return states;
}

export function writeProbeState(storage, recipeId, now, state) {
  storage.sql.exec(
    `INSERT INTO probe_state (recipe_id, updated_at, state_json) VALUES (?, ?, ?)
     ON CONFLICT (recipe_id) DO UPDATE SET updated_at = excluded.updated_at, state_json = excluded.state_json`,
    recipeId,
    now,
    JSON.stringify(state),
  );
}

export function deleteProbeState(storage, recipeId) {
  storage.sql.exec("DELETE FROM probe_state WHERE recipe_id = ?", recipeId);
}
