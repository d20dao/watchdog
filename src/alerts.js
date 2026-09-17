// Pure alert lifecycle for one (network, check) key.
//
//   inactive + active condition  -> create; send WARNING or ALARM once
//   warning  + still warning     -> update silently (warnings never repeat)
//   any      + alarm             -> send ALARM when no ALARM was sent for this key in the last 30 min
//                                   (covers first alarm, escalation from warning and the 30-minute repeat)
//   alarm    + warning           -> de-escalate silently
//   active   + clear             -> delete; send "RESOLVED ... after N min"
//   event    + new occurrences   -> send again (each occurrence is new information)
//   event    + clear             -> delete silently (auto-resolves once reported)
//   any      + unknown           -> unchanged

import { LIMITS } from "./config.js";

const LABEL = { warning: "WARNING", alarm: "ALARM" };

export function alertKey(network, check) {
  return `${network}:${check}`;
}

export function formatAlertMessage(network, severity, title, detail, suffix = "") {
  return `[${network}] ${LABEL[severity]} ${title}${detail ? `: ${detail}` : ""}${suffix}`;
}

export function formatResolvedMessage(network, title, since, now) {
  const minutes = Math.max(1, Math.round((now - since) / 60));
  return `[${network}] RESOLVED ${title} after ${minutes} min`;
}

/**
 * @param row existing alert row or null: {network, check, severity, title, detail, since, updatedAt, lastAlarmAt, event}
 * @param condition undefined | null | {severity, title, detail, event?}
 * @returns {{row: object|null, write: boolean, message: null|{severity, text}}}
 */
export function transition(row, condition, now, network, check) {
  if (condition === undefined) return { row, write: false, message: null };

  if (condition === null) {
    if (!row) return { row: null, write: false, message: null };
    return {
      row: null,
      write: true,
      message: row.event ? null : { severity: "resolved", text: formatResolvedMessage(network, row.title, row.since, now) },
    };
  }

  const event = condition.event === true;
  const base = {
    network,
    check,
    severity: condition.severity,
    title: condition.title,
    detail: condition.detail,
    updatedAt: now,
    event,
  };

  if (!row) {
    const created = { ...base, since: now, lastAlarmAt: condition.severity === "alarm" ? now : null };
    return {
      row: created,
      write: true,
      message: { severity: condition.severity, text: formatAlertMessage(network, condition.severity, condition.title, condition.detail) },
    };
  }

  if (event) {
    // New occurrences this run: always report them.
    const next = { ...base, since: row.since, lastAlarmAt: condition.severity === "alarm" ? now : row.lastAlarmAt };
    return {
      row: next,
      write: true,
      message: { severity: condition.severity, text: formatAlertMessage(network, condition.severity, condition.title, condition.detail) },
    };
  }

  if (condition.severity === "alarm") {
    const due = row.lastAlarmAt == null || now - row.lastAlarmAt >= LIMITS.alarmRepeatSeconds;
    const next = { ...base, since: row.since, lastAlarmAt: due ? now : row.lastAlarmAt };
    if (!due) return { row: next, write: changed(row, next), message: null };
    const activeMinutes = Math.max(1, Math.round((now - row.since) / 60));
    const suffix = row.lastAlarmAt == null ? "" : ` (active ${activeMinutes} min)`;
    return {
      row: next,
      write: true,
      message: { severity: "alarm", text: formatAlertMessage(network, "alarm", condition.title, condition.detail, suffix) },
    };
  }

  // Warning while already active (fresh warning, or de-escalated alarm): never repeats.
  const next = { ...base, since: row.since, lastAlarmAt: row.lastAlarmAt };
  return { row: next, write: changed(row, next), message: null };
}

function changed(a, b) {
  return a.severity !== b.severity || a.title !== b.title || a.detail !== b.detail || a.lastAlarmAt !== b.lastAlarmAt;
}
