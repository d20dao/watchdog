# D20DAO keeper watchdog

An external watchdog for the D20DAO VRF keepers, running on Cloudflare Workers (free plan).

Every alert the keepers raise today comes from inside the keeper process, so a dead host alerts nobody.
This Worker runs on Cloudflare instead. It:

1. receives each keeper's outbound health reports (`POST /v1/health/<network>`),
2. reads both chains every minute,
3. posts to the operator Telegram chat with its own bot token.

```
keeper (arc-mainnet) ──POST /v1/health/arc-mainnet──┐
keeper (arc-testnet) ──POST /v1/health/arc-testnet──┤
                                                    ▼
           Worker (validation, auth)  ──RPC──►  Durable Object "Watchdog" (SQLite)
           cron * * * * *            ──RPC──►    ├─ JSON-RPC batches to Arc (Blockdaemon, then public)
           GET / and /status.json    ──RPC──►    ├─ threshold checks and alert lifecycle
                                                 └─ Telegram sendMessage
```

All state lives in one SQLite-backed Durable Object (the account token has no D1 or KV rights).
There are no runtime dependencies: the few ABI encodings and decodings are written by hand in `src/abi.js`.

## Checks

These run every minute for each network. Thresholds live in `src/config.js` (`THRESHOLDS`).

| Check (key) | Warning | Alarm |
| --- | --- | --- |
| `heartbeat`: time since the last report was received (only after the network has reported at least once) | ≥ 150 s | ≥ 240 s |
| `health_age`: age of the keeper's `health.observedAt` in its latest report, measured as report `observedAt` − `health.observedAt` on the keeper's clock | ≥ 120 s | ≥ 240 s |
| `unhealthy`: latest report has `healthy: false` (lists the fault codes) | immediately | continuously for ≥ 5 min |
| `pending`: age of the oldest pending request in chain time (latest block timestamp − (deadline − 60)) | ≥ 25 s | ≥ 45 s |
| `refund`: new `RequestRefundedTo` logs since the last scanned block | — | "refund issued, investigate" with request ids (one-shot) |
| `balance`: keeper wallet native USDC (18 decimals) | < 5 USDC | < 2 USDC |
| `base_fee`: 2 × baseFee + 1 gwei against the fee cap (mainnet 2000 gwei, testnet 100 gwei) | > 60 % | > 85 % |
| `committer`: registry `committer()` ≠ keeper wallet | — | alarm |
| `coordinator_impl`, `registry_impl`: ERC-1967 implementation slot ≠ expected | — | alarm |
| `foreign_submitter`: `RandomnessFulfilled` whose submitter ≠ keeper | one-shot notice | — |
| `rpc`: watchdog chain read failed or was partial for ≥ 3 consecutive runs | "watchdog cannot read chain" | — |
| `dropped_events`: keeper `droppedTotal` increased (the receiver contract asks receivers to alert on dropped counts) | one-shot notice | — |

Chain reading, per network per run:

* **Round A** (one batch, `latest`): `eth_chainId`, head block (number, timestamp, `baseFeePerGas`), `nextRequestId()`, `committer()`, both implementation slots and the keeper balance.
* **Round B** (one batch, pinned to the head block): `getPendingRequestIds(max(1, next − 256), 256)` and one `eth_getLogs` for both event topics, from the stored cursor + 1 to the head. Each scan covers at most 5,000 blocks (about 42 min at Arc's 0.5 s blocks), and a backlog catches up over later runs. On the first run the cursor starts at the head, with no backfill. If the log query fails, the cursor stays where it is and the next span is halved (never below 250 blocks).
* **Round C** (one batch, only when something is pending): `getRequest` for up to the 3 smallest pending ids.

Endpoints are tried in order: Blockdaemon first, then the public RPC. The public RPC rate-limits batches from Cloudflare. After a failure, the rest of that run stays on the next endpoint. The `eth_chainId` answer is verified, and a wrong chain counts as an endpoint failure. When a read fails, every chain check is "unknown" for that run: existing alerts are neither resolved nor repeated.

Known scan limits:

* `getPendingRequestIds` only sees the last 256 request ids and excludes expired requests, so a request that expired unserved shows up through `refund` (and the keeper's `expired` events) rather than `pending`.
* Keeper report retries keep their original `observedAt`. `health_age` is measured on the keeper clock, so a delivery gap raises `heartbeat` only, not both.

## Alert lifecycle

Each (network, check) pair has one alert row in the Durable Object:

* **First activation:** one message, `[arc-mainnet] WARNING ...` or `[arc-mainnet] ALARM ...`.
* **Warnings** never repeat.
* **Alarms** are re-sent at most every 30 minutes while active. Escalating from warning to alarm sends the alarm. Falling back to warning is silent, and if the alarm returns within 30 minutes of the last alarm message it is also silent.
* **Resolution** sends `[arc-mainnet] RESOLVED <title> after N min`.
* **One-shot notices** (`refund`, `foreign_submitter`, `dropped_events`) send a message for every run with new occurrences. They resolve silently on the next run without new ones.

Messages are queued in SQLite in the same transaction as the alert change, then delivered to Telegram (`sendMessage` with `disable_web_page_preview`). Delivery details:

* A run groups its messages into at most 3 Telegram sends of up to 3,800 characters each.
* Failed sends are retried on later runs, giving up after 5 attempts or 1 hour.
* If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is missing, alerts are still evaluated and stored with delivery `not_sent`, and status shows `notifier: not configured`.
* The token is never logged.

## Endpoints

### `POST /v1/health/<network>` (`arc-mainnet`, `arc-testnet`)

This endpoint implements the receiver contract in `d20-keeper-mainnet/docs/keeper-health-receiver.md`.

**Request checks:**

* **Auth:** `Authorization: Bearer <key>` is compared in constant time against `HEALTH_KEY_ARC_MAINNET` or `HEALTH_KEY_ARC_TESTNET`. Both values are SHA-256 hashed, then compared with `crypto.subtle.timingSafeEqual`. A key only works for its own network. Unauthenticated requests never reach the Durable Object. They are only logged.
* **Size and type:** `Content-Type: application/json`, body ≤ 64 KiB. The body read stops as soon as it exceeds the limit.
* **Envelope:** `version: 1` with full type validation. The `Idempotency-Key` header must equal `reportId`. `chainId` must match the network and `coordinator` must match case-insensitively; a mismatch returns 422.
* **Bootstrap shape:** a report whose `health` has no `observedAt` or `sendEnabled` (fault `not_observed`) is accepted and shown as "not yet observed".

**Storage and replies:**

* `reportId` and the SHA-256 of the exact body are stored in one transaction with the per-network state. The 2xx reply is sent only after that write commits.
* Same id with the same bytes returns 200 again and counts as a heartbeat, without re-applying activity. Same id with different bytes returns 409.
* Report ids older than 3 days are pruned.
* Kept per network: last `receivedAt`, report `observedAt`, `health.observedAt`, `healthy`, `sendEnabled`, faults, `nodeId`, `droppedTotal`, and the per-kind counts of `events.failed` (latest report and running total).

| Status | Meaning |
| --- | --- |
| 200 | stored, or duplicate of a stored report (`{"ok":true,"duplicate":bool}`) |
| 400 | invalid JSON, envelope or `Idempotency-Key` |
| 401 | missing or wrong bearer key |
| 404 | unknown network |
| 409 | `reportId` already stored with different bytes |
| 413 | body over 64 KiB |
| 415 | not `application/json` |
| 422 | `chainId` or `coordinator` does not belong to this network |
| 503 | receiver key not configured, or storage unavailable |

### `GET /status.json`

For each network, this returns:

* report ages, `healthy`, faults, `nodeId`, dropped and failed-event counts,
* the last chain check time and figures: block, pending count, oldest pending age, balance in USDC, base fee and fee-cap usage, wiring checks, log cursor,
* active alerts with severity and `since`.

It also returns `notifier` (`configured` or `not configured`) and the last 10 notices. It never includes secrets, raw reports or report ids. Responses are edge-cached for 15 s, and query strings are ignored.

### `GET /`

The same information as a small server-rendered HTML page. It is readable on a phone, follows the system light or dark theme and refreshes every 60 s.

## Secrets

Set these on the deployed Worker (never in files):

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put HEALTH_KEY_ARC_MAINNET
npx wrangler secret put HEALTH_KEY_ARC_TESTNET
```

Generate each health key as a long random value, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Keys must be printable ASCII without spaces (the keeper requires `ascii_graphic`, ≤ 4096 bytes).

## Enabling reporting on a keeper

In the keeper's `keeper.env`, using the same value as the Worker secret for that network:

```sh
# arc-mainnet keeper
HEALTH_API_URL=https://watchdog.d20dao.org/v1/health/arc-mainnet
HEALTH_API_KEY=<same value as HEALTH_KEY_ARC_MAINNET>

# arc-testnet keeper
HEALTH_API_URL=https://watchdog.d20dao.org/v1/health/arc-testnet
HEALTH_API_KEY=<same value as HEALTH_KEY_ARC_TESTNET>
```

Then restart the keeper. It posts every 30 s by default (`HEALTH_INTERVAL_SECONDS`). Within a minute, `/status.json` should show `everReported: true` for that network.

The keeper's HTTP client sends no `User-Agent` header. If the `d20dao.org` zone runs Browser Integrity Check, Bot Fight Mode or a WAF rule that challenges such requests, the keeper's POSTs are blocked before they reach the Worker, and the result is a permanent `heartbeat` alarm. After deploying, test without a User-Agent:

```sh
curl -sS -o /dev/null -w "%{http_code}\n" -A "" -X POST https://watchdog.d20dao.org/v1/health/arc-testnet \
  -H "Authorization: Bearer wrong" -H "Content-Type: application/json" -d '{}'
```

`401` means the request reached the Worker. A `403` challenge page means a zone security feature needs an exception for `watchdog.d20dao.org/v1/health/*`.

## Development

```sh
npm install
npm test                                   # node --test, no network
cp .dev.vars.example .dev.vars             # throwaway values only; git-ignored
npx wrangler dev --test-scheduled
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"   # one live read of both networks
curl http://127.0.0.1:8787/status.json
rm .dev.vars
```

Layout:

| File | Purpose |
| --- | --- |
| `src/index.js` | Worker entry (`fetch`, `scheduled`), exports the Durable Object |
| `src/http.js` | routing, status caching and security headers |
| `src/report.js` | report auth, bounded body read, envelope validation |
| `src/watchdog.js` | the Durable Object: `ingestReport`, `runCron`, `getStatus` |
| `src/cron.js` | one run: read chains, evaluate, commit, deliver |
| `src/rpc.js`, `src/abi.js`, `src/net.js` | JSON-RPC batches with fallback, hand-rolled ABI, timed fetch |
| `src/checks.js`, `src/alerts.js` | pure threshold evaluation and alert lifecycle |
| `src/store.js` | SQLite schema and queries |
| `src/status.js`, `src/telegram.js`, `src/format.js` | read model and HTML, Telegram delivery, formatting |

## Deploy

Use `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` (Workers Admin) and `CLOUDFLARE_ACCOUNT_ID` in the environment; the account id is not in `wrangler.jsonc`. Then:

```sh
npx wrangler deploy
```

The first deploy creates the `Watchdog` SQLite Durable Object class (migration `v1`), the custom domain `watchdog.d20dao.org` and the `* * * * *` cron trigger. `workers_dev` and preview URLs are disabled.

The migration uses `new_sqlite_classes`. Newer Cloudflare docs also describe an `exports` field for Durable Object classes. The two are mutually exclusive, and moving a deployed Worker to `exports` cannot be reverted.

## Free-plan budget

| Limit (free plan) | Usage |
| --- | --- |
| Worker CPU 10 ms per invocation | The Worker only routes: report validation plus hashing measured ~0.1–0.4 ms (up to ~1.7 ms on a cold isolate) for 0.5–61 KB reports. The cron handler just calls the Durable Object. |
| Durable Object CPU (30 s per request) | A full run for both networks with replayed live RPC responses measured ~0.4 ms warm and ~1.6 ms cold. A worst-case 5,000-block scan returning 1,000 logs measured ~3.5–5 ms. |
| Subrequests 50 per invocation | 2 batches per network normally (3 with pending requests), at most 6 with fallback, so ≤ 12 RPC fetches plus ≤ 3 Telegram sends per run. |
| DO requests 100,000/day | 2 networks × 2,880 reports + 1,440 cron runs ≈ 7,200/day, plus status views (edge-cached 15 s). |
| DO rows written 100,000/day | About 2 per report insert and 2 per prune (the `reports_by_received_at` index), plus 1 state update: ≈ 5 × 5,760 ≈ 29,000. Chain state is 2 × 1,440 ≈ 2,900. Alerts and messages only change on transitions. Total ≈ 32,000/day. |
| DO rows read 5,000,000/day | Point lookups plus a few rows per run; well under 100,000/day. |
| DO duration 13,000 GB-s/day | Billed only while handling a request (RPC wait included): about 1 s × 1,440 runs + ~20 ms × 5,760 reports at 128 MB ≈ 200 GB-s/day. Timers are cleared so the object can hibernate. |
| DO storage 5 GB | 3 days of report ids (≈ 17,000 small rows) plus a bounded 100-row message log. |
| Cron triggers (5 per account) | 1 |

The status page is public and unauthenticated. Each uncached view is one DO request, so heavy scraping from many locations could use up the daily DO request quota. If that happens, add a zone rate-limiting rule for `watchdog.d20dao.org/`.
