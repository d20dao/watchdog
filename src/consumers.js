// New consumer notice: one Telegram message the first time a consumer contract makes a request on a network that has
// `newConsumerNotice` on. Consumers are learnt from two sources:
//   live     RandomnessRequested logs (the existing log scan, one more topic) and the requests the readers already decode
//   history  the requests made before the watchdog first ran here, read by id a batch a run (`seed` below), silently
// A consumer seen live while history is still being read waits: it is announced once history is read through, unless history
// shows it requested before. Each consumer is written once, when first seen.

import { LIMITS } from "./config.js";
import { requestLink } from "./format.js";

const rows = (storage, query, ...bindings) => storage.sql.exec(query, ...bindings).toArray();

/** Whether a network announces new consumers. */
export const watchesConsumers = (net) => net?.newConsumerNotice === true;

function readState(storage, network) {
  const r = rows(storage, "SELECT live_from, seeded_to FROM consumer_state WHERE network = ?", network)[0];
  return r ? { liveFrom: BigInt(r.live_from), seededTo: BigInt(r.seeded_to) } : null;
}

function writeState(storage, network, now, state) {
  storage.sql.exec(
    `INSERT INTO consumer_state (network, live_from, seeded_to, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (network) DO UPDATE SET seeded_to = excluded.seeded_to, updated_at = excluded.updated_at`,
    network,
    state.liveFrom.toString(),
    state.seededTo.toString(),
    now,
  );
}

/**
 * The history this run should read for `network`: {fromId, toId} (toId exclusive), or null when there is none to read. Before the
 * first run nothing is known; afterwards it is the next `max` ids from where the last batch ended, up to the first live id.
 */
export function seedRange(storage, net, max = LIMITS.consumerSeedBatch) {
  if (!watchesConsumers(net)) return null;
  const state = readState(storage, net.name);
  if (!state || state.seededTo >= state.liveFrom) return null;
  const toId = state.seededTo + BigInt(max) < state.liveFrom ? state.seededTo + BigInt(max) : state.liveFrom;
  return { fromId: state.seededTo, toId };
}

/** The site's or block explorer's page for a request: the network's own link when it has one. */
function link(net, requestId) {
  if (net.requestExplorer) return `${net.requestExplorer}/${net.chainId}/${net.coordinator}/${requestId}`;
  return net.explorer ? requestLink(net, requestId) : "";
}

export const consumerMessage = (net, consumer, requestId) =>
  `[${net.name}] NEW CONSUMER ${consumer} made its first request, ${requestId}${link(net, requestId) ? ` ${link(net, requestId)}` : ""}`;

/**
 * Record this run's consumers and return the notices to send ([{text}]). Runs inside the run's transaction.
 *   nextRequestId  this run's nextRequestId (the first run starts live tracking there), or null when unknown
 *   seed           {fromId, toId, consumers: [{id, consumer}]} when this run read a history batch, else null
 *   live           [{id, consumer}] seen this run in logs or request reads; ids before live tracking are history and ignored
 */
export function applyConsumers(storage, net, now, { nextRequestId = null, seed = null, live = [] }) {
  if (!watchesConsumers(net)) return [];
  const network = net.name;
  let state = readState(storage, network);
  if (!state) {
    if (nextRequestId == null) return [];
    state = { liveFrom: BigInt(nextRequestId), seededTo: 1n };
    writeState(storage, network, now, state);
  }
  const wasDone = state.seededTo >= state.liveFrom;

  // History: silent. A consumer already waiting as live turns out to be an old one: it is never announced.
  if (seed && seed.fromId === state.seededTo && seed.toId > state.seededTo) {
    for (const { id, consumer } of seed.consumers) {
      storage.sql.exec(
        `INSERT INTO consumers (network, consumer, first_request_id, first_seen_at, notified) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (network, consumer) DO UPDATE SET notified = 1 WHERE notified = 0`,
        network,
        consumer.toLowerCase(),
        id.toString(),
        now,
      );
    }
    state = { ...state, seededTo: seed.toId < state.liveFrom ? seed.toId : state.liveFrom };
    writeState(storage, network, now, state);
  }
  const done = state.seededTo >= state.liveFrom;

  const notices = [];
  const seen = new Map();
  for (const { id, consumer } of live) {
    if (BigInt(id) < state.liveFrom) continue;
    const key = consumer.toLowerCase();
    const earlier = seen.get(key);
    if (earlier == null || BigInt(id) < earlier) seen.set(key, BigInt(id));
  }
  for (const [consumer, id] of seen) {
    if (rows(storage, "SELECT 1 AS x FROM consumers WHERE network = ? AND consumer = ?", network, consumer).length > 0) continue;
    storage.sql.exec(
      "INSERT INTO consumers (network, consumer, first_request_id, first_seen_at, notified) VALUES (?, ?, ?, ?, ?)",
      network,
      consumer,
      id.toString(),
      now,
      done ? 1 : 0,
    );
    if (done) notices.push({ text: consumerMessage(net, consumer, id) });
  }

  // History just read through: the consumers that waited are new.
  if (done && !wasDone) {
    for (const r of rows(storage, "SELECT consumer, first_request_id FROM consumers WHERE network = ? AND notified = 0 ORDER BY consumer", network)) {
      notices.push({ text: consumerMessage(net, r.consumer, r.first_request_id) });
    }
    storage.sql.exec("UPDATE consumers SET notified = 1 WHERE network = ? AND notified = 0", network);
  }
  return notices;
}
