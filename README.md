# D20DAO keeper watchdog

An external watchdog for the D20DAO VRF keepers, running on Cloudflare Workers (free plan).

Every alert the keepers raise today comes from inside the keeper process, so a dead host alerts nobody.
This Worker runs on Cloudflare instead. It:

1. receives each keeper's outbound health reports (`POST /v1/health/<network>`), and its backup's (`POST /v1/health/<network>/backup`),
2. reads both chains every minute,
3. probes the AirnodeHub listings the epoch registry depends on, once an hour each,
4. posts to the operator Telegram chat with its own bot token.

```
keeper (arc-mainnet) ──POST /v1/health/arc-mainnet─────────┐
backup (arc-mainnet) ──POST /v1/health/arc-mainnet/backup──┤
keeper (arc-testnet) ──POST /v1/health/arc-testnet─────────┤
backup (arc-testnet) ──POST /v1/health/arc-testnet/backup──┤
                                                           ▼
           Worker (validation, auth)  ──RPC──►  Durable Object "Watchdog" (SQLite)
           cron * * * * *            ──RPC──►    ├─ JSON-RPC batches to Arc (Blockdaemon, then public)
           GET / and /status.json    ──RPC──►    ├─ AirnodeHub listing probes (signed POST, OpenAPI GET)
                                                 ├─ threshold checks and alert lifecycle
                                                 └─ Telegram sendMessage
```

All state lives in one SQLite-backed Durable Object (the account token has no D1 or KV rights).
The few ABI encodings and decodings are written by hand in `src/abi.js`. The only runtime dependencies are
`@noble/curves` and `@noble/hashes` (pinned exact versions), used to verify AirnodeHub signatures. `src/cron.js`
imports the module that uses them (`src/probe.js`) lazily, so their code is evaluated only inside the Durable
Object and only once a probe is due, never in the Worker entry.

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
| `backup_balance:<address>`: native USDC of each backup keeper wallet (`backupKeepers`), one alert per wallet. Lower than the keeper's: a backup spends only while it covers for the primary | < 2 USDC | < 1 USDC |
| `backup_heartbeat`: time since the backup's last report (once it has reported) | ≥ 150 s | ≥ 240 s |
| `backup_unhealthy`: backup's latest report has `healthy: false` (lists the fault codes) | immediately | continuously for ≥ 5 min |
| `backup_role`: backup's latest report has a `health.role` other than `follower` | — | alarm |
| `base_fee`: 2 × baseFee + 1 gwei against the fee cap (mainnet 2000 gwei, testnet 100 gwei) | > 60 % | > 85 % |
| `committer`: registry `committer()` ≠ keeper wallet | — | alarm |
| `coordinator_impl`, `registry_impl`: ERC-1967 implementation slot ≠ expected | — | alarm |
| `foreign_submitter`: `RandomnessFulfilled` whose submitter is neither the keeper nor a configured backup keeper | one-shot notice | — |
| `rpc`: watchdog chain read failed or was partial for ≥ 3 consecutive runs | "watchdog cannot read chain" | — |
| `dropped_events`: keeper `droppedTotal` increased (the receiver contract asks receivers to alert on dropped counts) | one-shot notice | — |

Backup checks apply only to networks with `backupKeepers`. A backup that has never reported raises nothing and shows as not reporting.

Chain reading, per network per run:

* **Round A** (one batch, `latest`): `eth_chainId`, head block (number, timestamp, `baseFeePerGas`), `nextRequestId()`, `committer()`, both implementation slots, the keeper balance and the balance of each backup keeper wallet.
* **Round B** (one batch, pinned to the head block): `getPendingRequestIds(max(1, next − 256), 256)` and one `eth_getLogs` for both event topics, from the stored cursor + 1 to the head. Each scan covers at most 5,000 blocks (about 42 min at Arc's 0.5 s blocks), and a backlog catches up over later runs. On the first run the cursor starts at the head, with no backfill. If the log query fails, the cursor stays where it is and the next span is halved (never below 250 blocks).
* **Round C** (one batch, only when something is pending): `getRequest` for up to the 3 smallest pending ids.

Endpoints are tried in order: Blockdaemon first, then the public RPC. The public RPC rate-limits batches from Cloudflare. After a failure, the rest of that run stays on the next endpoint. The `eth_chainId` answer is verified, and a wrong chain counts as an endpoint failure. When a read fails, every chain check is "unknown" for that run: existing alerts are neither resolved nor repeated.

Known scan limits:

* `getPendingRequestIds` only sees the last 256 request ids and excludes expired requests, so a request that expired unserved shows up through `refund` (and the keeper's `expired` events) rather than `pending`.
* Keeper report retries keep their original `observedAt`. `health_age` is measured on the keeper clock, so a delivery gap raises `heartbeat` only, not both.

## AirnodeHub listing probes

The epoch registry (`EpochEntropy`) accepts an AirnodeHub reply only if its canonical request hash, its signed data
bytes and its signer match the recipe exactly; otherwise the epoch falls back to the next source. A listing that
changes or disappears therefore fails silently on chain. The watchdog calls each recipe the way the keeper does
and alerts before an epoch selects the broken source.

Probed recipes (`AIRNODE_RECIPES` in `src/config.js`):

| Recipe id (registry recipe) | Gateway, operation | Signer | Signed data |
| --- | --- | --- | --- |
| `hyperliquid-btc-day-volume` (0) | `airnode-hyperliquid.fly.dev`, `metaAndAssetCtxs` with a projection | `0x509F…665B` | `{"symbol":"BTC","value":"<decimal>"}` |
| `drpc-ethereum-blockhash` (1) | `airnode-drpc.fly.dev`, `jsonRpc` `eth_call` Multicall3 `getLastBlockHash()` on `ethereum` | `0x511A…2137` | `{"id":null,"jsonrpc":"2.0","result":"0x<64 lowercase hex>"}` |
| `tickerlayer-btcusd` (2) | `airnode-tickerlayer.fly.dev`, `lastTrade` crypto `BTCUSD` | `0x32f5…9f2c` | `{"symbol":"BTCUSD","price":<number>,"size":<number>,"timestamp":<integer>}` |
| `nodary-eth-usd` (4) | `airnode-nodary.fly.dev`, `latestFeeds` `ETH/USD` | `0xE70f…E4c0` | `{"ETH/USD":{"value":<number>,"timestamp":<13-digit integer>,"category":"crypto"}}` |
| `drpc-base-blockhash` (6) | `airnode-drpc.fly.dev`, as recipe 1 on `base` | `0x511A…2137` | as recipe 1 |

Each probe POSTs the configured body to the gateway (15 s timeout, reply at most 16 KiB) and checks, in order:

1. **Reply:** HTTP 200 with a JSON object carrying the signed envelope (`airnode`, `requestHash`, `timestamp`, `data`, `signature`). A timeout, network error, other HTTP status, invalid JSON, an oversized reply or an unsigned `{"error": ...}` counts as a *failed probe*.
2. **Request hash:** `requestHash` = keccak256 of the AirnodeHub canonical request of the configured body. Every object, at any depth, becomes its `[key, value]` entries sorted by key, arrays keep their order, and a `responseProjection` is appended as a third element. The tests pin each canonical string to `EpochEntropy.recipeRequest`.
3. **Signer:** `airnode` is the configured signer, and the EIP-191 personal-sign signer of keccak256(abi.encodePacked(bytes32 requestHash, uint256 timestamp, bytes data)) is the configured signer. The data bytes are `data` itself when it is a string, otherwise `JSON.stringify(data)`. Signatures follow OpenZeppelin `ECDSA.recover`: 65 bytes, v 27 or 28, low s.
4. **Data shape:** the data bytes pass a port of `EpochEntropy._validate` for the recipe: 1 to 128 bytes, exact literals and key order, the same number grammar.
5. **Signed timestamp:** at most 240 s before the probe (the registry's `MAX_ATTESTATION_AGE`) and at most 60 s after it.

Once a day the watchdog also GETs each gateway's OpenAPI document (one request per gateway URL, covering all its
recipes). It checks that `x-airnode.address` is the configured signer and that the operation is still offered, still
accepts every parameter and the projection the recipe sends, and requires no parameter the recipe omits. A document
that cannot be read or is in an unrecognized format raises nothing, because the POST probe covers reachability. The
read is retried an hour later.

Alerts use the scope `airnodehub` (messages read `[airnodehub] ALARM Hyperliquid BTC day volume request hash mismatch: ...`):

| Check (key) | Warning | Alarm |
| --- | --- | --- |
| `probe:<id>` failed probes in a row (unreachable, HTTP error, unusable reply) | 2 | 4 |
| `probe:<id>` request hash, signer, data shape or signed timestamp mismatch | — | immediately; stays active until a probe passes (a failed probe does not clear it) |
| `listing:<id>` listing document signer mismatch, or operation missing | — | immediately; stays active until a document read shows it fixed |

Reasons are short texts built by the watchdog, such as `http 503`, `gateway signed 0xd5ded974...2e3d, recipe expects
0xabe6d1ad...abda` or `signature recovers 0x..., catalog expects 0x...`. Reply bodies are never stored, logged or
sent.

Schedule:

* Recipe *i* of *n* is probed at second *i* × 3600 / *n* of every hour (five recipes: minutes 0, 12, 24, 36 and 48). After a probe that did not pass, the recipe is probed again 10 minutes later. An unreachable listing therefore warns within about 1 h 10 min and alarms within about 1 h 30 min, and a changed listing alarms within the hour.
* Listing documents are read once a day, gateway *j* of *m* at second *j* × 86400 / *m*. They are read only in runs where no probe is due, so a slot that falls on a probe minute moves to the next run.
* A recipe that was never probed (new deployment, new recipe) is due at once. A run starts at most 5 probe or document requests, with at most 3 open at a time; the rest wait for the next run.
* The probes run concurrently with the chain reads, and their results are committed in the same transaction.

Adding a recipe:

1. Add an entry to `AIRNODE_RECIPES` in `src/config.js`: `id` (stable key for state and alerts), `name`, `recipe` (the registry recipe id), `url`, `body` (the request exactly as the keeper sends it), `signer` (the catalog's signer for this recipe) and `shape` (the data grammar of `EpochEntropy._validate` for the recipe; the part types are listed above the array).
2. Record a real signed reply: POST the body to the gateway and add the line to a fixture in `test/fixtures/`. `test/probe.test.js` shows the pattern: recipes 3, 5 and 7 are configured in `EXTRA_RECIPES` and their real replies pass `evaluateResponse`.
3. If the registry recipe is new, add its `recipeRequest` literal to `EPOCH_RECIPE_REQUESTS` in `test/helpers.js`, then run `npm test`. The configuration test checks that every configured body canonicalizes to that literal.

The hourly phases of later entries shift when a recipe is inserted, which is harmless. Removing a recipe resolves its
alerts and deletes its state on the next run.

Known probe limits:

* The signer and the recipe list come from `src/config.js`, not from the registry's on-chain `catalogAt(epoch)`. After `scheduleCatalog` changes the catalog, update the configuration too.
* A gateway may answer the probe and still fail a keeper call seconds later. The probe shows that the listing and its signing format are intact; it does not measure availability between probes.

## Alert lifecycle

Each (network, check) pair has one alert row in the Durable Object. Each backup keeper wallet has its own check, so it
resolves independently of the keeper and of other backups. A wallet removed from `backupKeepers` resolves its alert on the
next run; an empty `backupKeepers` also resolves the backup health alerts. AirnodeHub probes use `airnodehub` in place of a network:

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
* Kept per network: last `receivedAt`, report `observedAt`, `health.observedAt`, `healthy`, `sendEnabled`, faults, `health.role`, `nodeId`, `droppedTotal`, and the per-kind counts of `events.failed` (latest report and running total).

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

### `POST /v1/health/<network>/backup` (`arc-mainnet`, `arc-testnet`)

The backup (follower) keeper's reports. Same envelope, checks and replies as above, with its own key and storage:

* **Auth:** `HEALTH_KEY_ARC_MAINNET_BACKUP` or `HEALTH_KEY_ARC_TESTNET_BACKUP`. The primary's key is refused here, and this key on the primary route.
* **Storage:** separate tables (`backup_reports`, `backup_report_state`). Report ids, duplicates and conflicts are counted per stream, so backup reports never touch the keeper's state or alerts.
* **Role:** `health.role` of the latest report is kept for `backup_role`.

### `GET /status.json`

For each network, this returns:

* report ages, `healthy`, faults, `nodeId`, dropped and failed-event counts,
* the same for the backup under `backupReport`, plus its `role` (`{"everReported": false}` until it reports),
* the configured `backupKeepers`,
* the last chain check time and figures: block, pending count, oldest pending age, keeper balance in USDC (`keeperBalanceUsdc`) and each backup keeper's balance (`backupKeeperBalances`: `[{address, balanceUsdc}]`, `null` until read), base fee and fee-cap usage, wiring checks, log cursor,
* active alerts with severity and `since`.

Under `airnodehub` it returns, for each recipe: `status` (`ok`, `warning`, `alarm` or `not probed`), `lastProbeAt`,
`lastProbeAgeSeconds`, `latencyMs`, `lastOutcome` (`ok`, `failure`, `request_hash`, `signer`, `data_shape` or
`timestamp`), `reason`, `consecutiveFailures`, the last conclusive `verdict` and `verdictReason`, `lastOkAt`,
`signedLagSeconds`, `nextProbeAt`, the expected data and `listingDocument` (`status`, `checkedAt`, `lastOutcome`,
`reason`). It also returns the active `airnodehub` alerts.

It also returns `notifier` (`configured` or `not configured`) and the last 10 notices. It never includes secrets, raw reports or report ids. Responses are edge-cached for 15 s, and query strings are ignored.

### `GET /`

The same information as a small server-rendered HTML page, with backup keeper health under the backup balances and one row per AirnodeHub recipe (status, last probe, latency, reason and listing document). It uses the d20dao.org dark theme with inline CSS and the inline logo only, is readable on a phone and refreshes every 60 s.

## Secrets

Set these on the deployed Worker (never in files):

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put HEALTH_KEY_ARC_MAINNET
npx wrangler secret put HEALTH_KEY_ARC_TESTNET
npx wrangler secret put HEALTH_KEY_ARC_MAINNET_BACKUP
npx wrangler secret put HEALTH_KEY_ARC_TESTNET_BACKUP
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

# backup (follower) keepers
HEALTH_API_URL=https://watchdog.d20dao.org/v1/health/arc-mainnet/backup
HEALTH_API_KEY=<same value as HEALTH_KEY_ARC_MAINNET_BACKUP>

HEALTH_API_URL=https://watchdog.d20dao.org/v1/health/arc-testnet/backup
HEALTH_API_KEY=<same value as HEALTH_KEY_ARC_TESTNET_BACKUP>
```

Then restart the keeper. It posts every 30 s by default (`HEALTH_INTERVAL_SECONDS`). Within a minute, `/status.json` should show `everReported: true` for that network (`backupReport` for a backup).

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
curl http://127.0.0.1:8787/status.json            # airnodehub.recipes: the first run probes all five listings
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
| `src/listings.js` | AirnodeHub canonical requests, data shapes, probe schedule and state, listing document check (pure, no dependencies) |
| `src/probe.js` | AirnodeHub probe requests, request hash and signature recovery (`@noble/*`), loaded lazily by `src/cron.js` |
| `test/fixtures/airnodehub-samples-2026-09-17.jsonl` | real signed gateway replies, two per catalog recipe |
| `src/store.js` | SQLite schema and queries |
| `src/status.js`, `src/telegram.js`, `src/format.js` | read model and HTML, Telegram delivery, formatting |

## Deploy

Use `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` (Workers Admin) and `CLOUDFLARE_ACCOUNT_ID` in the environment; the account id is not in `wrangler.jsonc`. Then:

```sh
npx wrangler deploy
```

The first deploy creates the `Watchdog` SQLite Durable Object class (migration `v1`), the custom domain `watchdog.d20dao.org` and the `* * * * *` cron trigger. `workers_dev` and preview URLs are disabled.

Schema changes are applied in place when the object starts (`migrate` in `src/store.js`). Missing tables are created, and columns added since the first deploy are added when missing (for example `chain_state.backup_balances_json` and `report_state.role`). Stored rows are kept, and no new migration tag is needed.

The migration uses `new_sqlite_classes`. Newer Cloudflare docs also describe an `exports` field for Durable Object classes. The two are mutually exclusive, and moving a deployed Worker to `exports` cannot be reverted.

## Free-plan budget

| Limit (free plan) | Usage |
| --- | --- |
| Worker CPU 10 ms per invocation | The Worker only routes: report validation plus hashing measured ~0.1–0.4 ms (up to ~1.7 ms on a cold isolate) for 0.5–61 KB reports. The cron handler just calls the Durable Object. The signature code is never evaluated here. Loading the whole 204 KB bundle (parse plus top-level evaluation, Node 24) went from 3.3 ms to 5.9 ms with the probe; this is isolate startup, not per-request work. |
| Durable Object CPU (30 s per request) | A full run for both networks with replayed live RPC responses measured ~0.4 ms warm and ~1.6 ms cold. A worst-case 5,000-block scan returning 1,000 logs measured ~3.5–5 ms. One AirnodeHub probe (reply parse, request hash, secp256k1 recovery, shape) measured 1.1–2 ms warm. The first probe after the object starts adds ~11 ms of module evaluation and ~7 ms of first verification. A run with all five probes due measured ~9 ms warm and ~39 ms cold; a run with none due adds ~0.06 ms. Parsing and checking the 60 KB Hyperliquid listing document takes ~0.1 ms. |
| Subrequests 50 per invocation | 2 batches per network normally (3 with pending requests), at most 6 with fallback, so ≤ 12 RPC fetches plus ≤ 3 Telegram sends per run. Backup keeper balances are extra calls inside the round A batch, so they add no fetches. AirnodeHub adds ≤ 5 per run (5 at the first run, then 1 in each of 5 runs an hour, plus retries and 4 document reads a day), so ≤ 20 in total. |
| DO requests 100,000/day | 2 networks × 2 keepers (primary and backup) × 2,880 reports + 1,440 cron runs ≈ 13,000/day, plus status views (edge-cached 15 s). |
| DO rows written 100,000/day | About 2 per report insert and 2 per prune (the `reports_by_received_at` index), plus 1 state update: ≈ 5 × 11,520 ≈ 58,000 for primary and backup reports. Chain state is 2 × 1,440 ≈ 2,900. AirnodeHub probe state is 1 row per probe or document read, ≈ 130/day (more while a listing is retried every 10 min). Alerts and messages only change on transitions. Total ≈ 61,000/day. |
| DO rows read 5,000,000/day | Point lookups plus a few rows per run; probe state and AirnodeHub alerts add about 11 per run (≈ 16,000/day). Well under 100,000/day. |
| DO duration 13,000 GB-s/day | Billed only while handling a request (RPC wait included): about 1 s × 1,440 runs + ~20 ms × 11,520 reports at 128 MB ≈ 220 GB-s/day. AirnodeHub probes wait alongside the chain reads: 0.1–9 s each (fly.dev cold starts), at most 15 s, so ≤ 120 × 15 s × 0.128 GB ≈ 230 GB-s/day more in the worst case. Timers are cleared so the object can hibernate. |
| DO storage 5 GB | 3 days of report ids (≈ 35,000 small rows, primary and backup) plus a bounded 100-row message log. |
| Cron triggers (5 per account) | 1 |

The status page is public and unauthenticated. Each uncached view is one DO request, so heavy scraping from many locations could use up the daily DO request quota. If that happens, add a zone rate-limiting rule for `watchdog.d20dao.org/`.
