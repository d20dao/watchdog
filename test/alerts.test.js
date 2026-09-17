import assert from "node:assert/strict";
import { test } from "node:test";
import { transition } from "../src/alerts.js";

const NET = "arc-mainnet";
const T0 = 1789420000;
const warn = (detail = "last report 2m 40s ago") => ({ severity: "warning", title: "heartbeat missing", detail });
const alarm = (detail = "last report 5m ago") => ({ severity: "alarm", title: "heartbeat missing", detail });

/** Drive a sequence of [minuteOffset, condition] steps and collect messages. */
function drive(steps, check = "heartbeat") {
  let row = null;
  const messages = [];
  for (const [minute, condition] of steps) {
    const step = transition(row, condition, T0 + minute * 60, NET, check);
    row = step.row;
    if (step.message) messages.push([minute, step.message.text]);
  }
  return { row, messages };
}

test("warning activates once and never repeats", () => {
  const { row, messages } = drive([
    [0, warn()],
    [1, warn("last report 3m 40s ago")],
    [45, warn()],
  ]);
  assert.deepEqual(messages, [[0, "[arc-mainnet] WARNING heartbeat missing: last report 2m 40s ago"]]);
  assert.equal(row.severity, "warning");
  assert.equal(row.since, T0);
});

test("alarm activates, re-notifies every 30 minutes, then resolves", () => {
  const { row, messages } = drive([
    [0, alarm()],
    [1, alarm()],
    [29, alarm()],
    [30, alarm("last report 35m ago")],
    [59, alarm()],
    [60, alarm("last report 65m ago")],
    [72, null],
    [73, null],
  ]);
  assert.deepEqual(messages, [
    [0, "[arc-mainnet] ALARM heartbeat missing: last report 5m ago"],
    [30, "[arc-mainnet] ALARM heartbeat missing: last report 35m ago (active 30 min)"],
    [60, "[arc-mainnet] ALARM heartbeat missing: last report 65m ago (active 60 min)"],
    [72, "[arc-mainnet] RESOLVED heartbeat missing after 72 min"],
  ]);
  assert.equal(row, null);
});

test("escalation from warning sends the alarm; flapping does not spam", () => {
  const { messages } = drive([
    [0, warn()],
    [2, alarm()], // escalation: first alarm for this key
    [3, warn()], // de-escalate silently
    [4, alarm()], // re-escalation within 30 min: silent
    [32, alarm()], // 30 min after the last alarm message: repeat
    [33, null],
  ]);
  assert.deepEqual(messages, [
    [0, "[arc-mainnet] WARNING heartbeat missing: last report 2m 40s ago"],
    [2, "[arc-mainnet] ALARM heartbeat missing: last report 5m ago"],
    [32, "[arc-mainnet] ALARM heartbeat missing: last report 5m ago (active 32 min)"],
    [33, "[arc-mainnet] RESOLVED heartbeat missing after 33 min"],
  ]);
});

test("unknown keeps the alert untouched and sends nothing", () => {
  const start = transition(null, alarm(), T0, NET, "pending");
  const unknown = transition(start.row, undefined, T0 + 3600, NET, "pending");
  assert.equal(unknown.row, start.row);
  assert.equal(unknown.write, false);
  assert.equal(unknown.message, null);
  assert.deepEqual(transition(null, undefined, T0, NET, "pending"), { row: null, write: false, message: null });
});

test("resolution rounds to at least one minute", () => {
  const { messages } = drive([
    [0, warn()],
    [0.5, null],
  ]);
  assert.equal(messages[1][1], "[arc-mainnet] RESOLVED heartbeat missing after 1 min");
});

test("event alerts report every occurrence and auto-resolve silently", () => {
  const refund = (ids) => ({ severity: "alarm", title: "refund issued, investigate", detail: `request ${ids}`, event: true });
  const { row, messages } = drive(
    [
      [0, refund("12")],
      [1, null],
      [2, refund("13")],
      [3, refund("14")],
      [4, undefined],
      [5, null],
    ],
    "refund",
  );
  assert.deepEqual(messages, [
    [0, "[arc-mainnet] ALARM refund issued, investigate: request 12"],
    [2, "[arc-mainnet] ALARM refund issued, investigate: request 13"],
    [3, "[arc-mainnet] ALARM refund issued, investigate: request 14"],
  ]);
  assert.equal(row, null);
});

test("writes are skipped when nothing changed", () => {
  const start = transition(null, warn(), T0, NET, "heartbeat");
  assert.equal(transition(start.row, warn(), T0 + 60, NET, "heartbeat").write, false);
  assert.equal(transition(start.row, warn("changed detail"), T0 + 60, NET, "heartbeat").write, true);
});
