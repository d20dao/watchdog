// The single SQLite-backed Durable Object holding all watchdog state.

import { DurableObject } from "cloudflare:workers";
import { LIMITS } from "./config.js";
import { runCron } from "./cron.js";
import { buildStatus } from "./status.js";
import { ingestReport, migrate } from "./store.js";

export class Watchdog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = {
      sql: ctx.storage.sql,
      transactionSync: (fn) => ctx.storage.transactionSync(fn),
    };
    this.cronStartedAt = 0;
    this.lastRunAt = 0;
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.storage);
    });
  }

  /** Durably store a validated report summary. The RPC reply is held until the write commits. */
  async ingestReport(record) {
    const outcome = ingestReport(this.storage, record);
    await this.ctx.storage.sync();
    await this.ensureAlarm();
    return outcome;
  }

  /** Shared by the Cron Trigger and the self-rearming alarm; either may be late or missing. */
  async runCron() {
    const startedAt = Date.now();
    if (startedAt - this.cronStartedAt < LIMITS.cronOverlapGuardMs) return { skipped: "previous run still active" };
    if (startedAt - this.lastRunAt < LIMITS.minRunSpacingMs) return { skipped: "ran less than a minute ago" };
    this.cronStartedAt = startedAt;
    try {
      return await runCron({ storage: this.storage, env: this.env, fetch: (url, init) => fetch(url, init) });
    } finally {
      this.cronStartedAt = 0;
      this.lastRunAt = startedAt;
      await this.ensureAlarm();
    }
  }

  async alarm() {
    try {
      const summary = await this.runCron();
      console.log(JSON.stringify({ watchdogRun: summary, source: "alarm" }));
    } catch (err) {
      console.error("watchdog alarm run failed:", String(err?.message ?? err).slice(0, 200));
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + LIMITS.checkIntervalMs);
    }
  }

  /** Arms the next check if none is pending, so checks keep running after reports stop. */
  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LIMITS.checkIntervalMs);
  }

  async getStatus() {
    await this.ensureAlarm();
    return buildStatus(this.storage, this.env, Math.floor(Date.now() / 1000));
  }
}
