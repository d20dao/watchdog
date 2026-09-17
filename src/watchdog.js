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
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.storage);
    });
  }

  /** Durably store a validated report summary. The RPC reply is held until the write commits. */
  async ingestReport(record) {
    const outcome = ingestReport(this.storage, record);
    await this.ctx.storage.sync();
    return outcome;
  }

  async runCron() {
    const startedAt = Date.now();
    if (startedAt - this.cronStartedAt < LIMITS.cronOverlapGuardMs) return { skipped: "previous run still active" };
    this.cronStartedAt = startedAt;
    try {
      return await runCron({ storage: this.storage, env: this.env, fetch: (url, init) => fetch(url, init) });
    } finally {
      this.cronStartedAt = 0;
    }
  }

  async getStatus() {
    return buildStatus(this.storage, this.env, Math.floor(Date.now() / 1000));
  }
}
