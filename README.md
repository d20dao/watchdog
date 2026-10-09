# D20DAO keeper watchdog

An external watchdog for the D20DAO VRF keepers, running on Cloudflare Workers (free plan).

Every alert the keepers raise today comes from inside the keeper process, so a dead host alerts nobody.
This Worker runs on Cloudflare instead. It:

1. receives each keeper's outbound health reports (`POST /v1/health/<network>`), and its backup's (`POST /v1/health/<network>/backup`),
2. reads both chains every minute,
3. polls the public `/health` of the x402 agent API every minute, on each network where it is enabled,
4. watches the drand beacon the epoch registry publishes epochs from: its relays every minute, and each registry's registration of it,
5. posts to the operator Telegram chat with its own bot token,
6. watches D20DAO on Robinhood Chain the same way (see [Robinhood Chain](#robinhood-chain)): keeper reports, one coordinator read
   a minute, and alerts in the network's own Telegram group.

```
keeper (arc-mainnet) ──POST /v1/health/arc-mainnet─────────┐
backup (arc-mainnet) ──POST /v1/health/arc-mainnet/backup──┤
keeper (arc-testnet) ──POST /v1/health/arc-testnet─────────┤
backup (arc-testnet) ──POST /v1/health/arc-testnet/backup──┤
                                                           ▼
           Worker (validation, auth)  ──RPC──►  Durable Object "Watchdog" (SQLite)
           cron * * * * *            ──RPC──►    ├─ JSON-RPC batches to Arc (Blockdaemon, then public)
           GET / and /status.json    ──RPC──►    ├─ GET /health of the x402 agent API
                                                 ├─ drand beacon: GET on the relays, registration read from each registry
                                                 ├─ threshold checks and alert lifecycle
                                                 └─ Telegram sendMessage
```

All state lives in one SQLite-backed Durable Object (the account token has no D1 or KV rights).
The few ABI encodings and decodings are written by hand in `src/abi.js`. The only runtime dependency is
`@noble/hashes` (pinned exact version): it derives the drand beacon's slot signer. `src/beacon.js` loads the hash code
only once a registry lists a beacon, so it is evaluated only inside the Durable Object, never in the Worker entry. No
pairing code is bundled.

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
| `coordinator_impl`, `registry_impl`: ERC-1967 implementation slot is not an expected one. Each is a list in `src/config.js`: append an upgrade's implementation before it executes, see [Registry upgrade](#registry-upgrade) | — | alarm |
| `foreign_submitter`: `RandomnessFulfilled` whose submitter is neither the keeper nor a configured backup keeper | one-shot notice | — |
| `rpc`: watchdog chain read failed or was partial for ≥ 3 consecutive runs | "watchdog cannot read chain" | — |
| `dropped_events`: keeper `droppedTotal` increased (the receiver contract asks receivers to alert on dropped counts) | one-shot notice | — |

Backup checks apply only to networks with `backupKeepers`. A backup that has never reported raises nothing and shows as not reporting.

Chain reading, per network per run:

* **Round A** (one batch, `latest`): `eth_chainId`, head block (number, timestamp, `baseFeePerGas`), `nextRequestId()`, `committer()`, both implementation slots, the keeper balance, the balance of each backup keeper wallet and, where the agent API is enabled, its relayer's balance.
* **Round B** (one batch, pinned to the head block): `getPendingRequestIds(max(1, next − 256), 256)` and one `eth_getLogs` for both event topics, from the stored cursor + 1 to the head. Each scan covers at most 5,000 blocks (about 42 min at Arc's 0.5 s blocks), and a backlog catches up over later runs. On the first run the cursor starts at the head, with no backfill. If the log query fails, the cursor stays where it is and the next span is halved (never below 250 blocks).
* **Round C** (one batch, only when something is pending): `getRequest` for up to the 3 smallest pending ids.

Endpoints are tried in order: Blockdaemon first, then the public RPC. The public RPC rate-limits batches from Cloudflare. After a failure, the rest of that run stays on the next endpoint. The `eth_chainId` answer is verified, and a wrong chain counts as an endpoint failure. When a read fails, every chain check is "unknown" for that run: existing alerts are neither resolved nor repeated.

Known scan limits:

* `getPendingRequestIds` only sees the last 256 request ids and excludes expired requests, so a request that expired unserved shows up through `refund` (and the keeper's `expired` events) rather than `pending`.
* Keeper report retries keep their original `observedAt`. `health_age` is measured on the keeper clock, so a delivery gap raises `heartbeat` only, not both.

## Robinhood Chain

Robinhood Chain runs the round coordinator (`D20VRFCoordinatorRobinhood`): no epoch registry, and each request binds a future drand
round that the keeper fulfils before the request's 60 s deadline. Its networks are `ROUND_NETWORKS` in `src/config.js`, read by
`src/round.js` and checked by `evaluateRoundChainChecks` in `src/checks.js`. Arc monitoring is unchanged by them.

| Network | Chain | Watched |
| --- | --- | --- |
| `robinhood-testnet` | 46630 | yes |
| `robinhood-mainnet` | 4663 | yes (coordinator `0xEc8b95B168c87294c45727Bd2ac903d09316D132`) |

`enabled` is the one switch. A disabled network is not read, raises nothing, has no health endpoint (404) and no status section.
Each entry's `coordinator`, `implementations`, `codeHashes`, `beacon`, `pricing` and `feeRecipients` come from the keeper repository's
`deployments/robinhood-<network>.json`, checked against the chain.

`statusListed` (default `false`) puts a network on the public page and in `status.json`. Until then nothing of it is public: no
section, no alerts and no recent messages. Alerts work either way.

Checks, every minute (thresholds in `THRESHOLDS`):

| Check (key) | Warning | Alarm |
| --- | --- | --- |
| `heartbeat`, `backup_heartbeat`: time since the last report, scaled to the keepers' report interval (`reports` in the network's configuration). Testnet (300 s) | ≥ 660 s | ≥ 960 s |
| the same on mainnet (60 s) | ≥ 150 s | ≥ 240 s |
| `unhealthy`, `backup_unhealthy`: latest report `healthy: false` | immediately | continuously for ≥ 600 s on testnet, ≥ 300 s on mainnet |
| `health_age`, `dropped_events`, `backup_role` | as on Arc | as on Arc |
| `pending`: age of the oldest open request within its deadline (head timestamp − (deadline − 60)) | ≥ 25 s | ≥ 45 s |
| `expired`: a request whose deadline passed with neither fulfilment nor refund | — | one-shot, with its id and fee |
| `refund`: new `RequestRefundedTo` logs | — | one-shot |
| `foreign_submitter`: `RandomnessFulfilled` by a wallet that is neither keeper | one-shot | — |
| `balance`: keeper wallet ETH (one fulfilment costs about 0.0000056 ETH). Testnet wallets hold about 0.002 ETH | < 0.001 ETH | < 0.0003 ETH |
| `backup_balance:<address>`: backup keeper wallet ETH on testnet | < 0.0005 ETH | < 0.0002 ETH |
| `balance` and `backup_balance:<address>` on mainnet, whose wallets hold about 0.0005 ETH (about 20 requests) | < 0.0002 ETH | < 0.0001 ETH |
| `backup_keepers`: a configured backup with `isBackupKeeper` false, or `backupKeeperCount()` above the configured allowed ones | not allowed | unknown backup allowed |
| `base_fee`: 2 × baseFee against the keeper's 3 gwei cap (no tip is paid there) | > 60 % | > 85 % |
| `keeper`: `keeper()` ≠ configured primary wallet | — | alarm |
| `owner`: `owner()` not in `owners`; `pendingOwner()` set | pending to an accepted owner | otherwise |
| `fee_recipient`: `feeRecipient()` not in `feeRecipients` | — | alarm |
| `pricing`: `pricing()`, `keeperFeeBps()` or `refundBps()` differ from the deployed values | warning | — |
| `beacon`: `beaconIdentity(id)` ≠ the pinned registration; another beacon in force, or a change scheduled | in force or scheduled | identity |
| `coordinator_impl`: ERC-1967 slot not an accepted implementation | — | alarm |
| `code_hash`: keccak256 of the proxy's or an accepted implementation's runtime code ≠ the pinned hash (the implementation's code fixes its proof verifier and mapping library) | — | alarm |
| `rpc`: the read failed or was partial for ≥ 3 runs | warning | — |

Report checks run every minute. The coordinator is read every `readIntervalSeconds`: every minute on mainnet, every 5 minutes on
testnet (at once again after a failed or partial read), so on testnet a pending or expired request can be reported up to 5 minutes
late. Between reads the chain checks keep their state.

Endpoints, in order (`rpcs` for state, `logRpcs` for logs). The optional keyed endpoint from the secret `RPC_URL_ROBINHOOD_MAINNET`
(`RPC_URL_ROBINHOOD_TESTNET`) goes first in both lists when set:

| Network | State reads | Logs |
| --- | --- | --- |
| `robinhood-mainnet` | `robinhood-rpc.publicnode.com`, `robinhood.drpc.org`, `rpc.mainnet.chain.robinhood.com` | `robinhood.drpc.org`, `rpc.mainnet.chain.robinhood.com` |
| `robinhood-testnet` | `robinhood-sepolia-rpc.publicnode.com`, `robinhood-testnet.drpc.org`, `rpc.testnet.chain.robinhood.com` | `robinhood-testnet.drpc.org`, `rpc.testnet.chain.robinhood.com` |

Keyless endpoints limit by source IP, and Cloudflare's egress IPs are shared with every other Worker, so any of them can answer the
watchdog with HTTP 429 at random, whatever its own volume. In production both PublicNode and Robinhood's own mainnet endpoint did.
A keyed endpoint is limited per key instead, which is why it goes first. For dRPC the URL is
`https://lb.drpc.org/robinhood/<key>` (testnet `https://lb.drpc.org/robinhood-testnet/<key>`). Its URL is never stored or logged:
it appears as `keyed`.

Every batch to a dRPC endpoint, keyless or keyed, is split into batches of at most 3 calls, and its `getLogs` into calls of at most
100 blocks. PublicNode takes large batches but keeps only about 80 blocks of state on mainnet and 128 on testnet, too few for logs.

An endpoint that answers HTTP 429, or a batch whose calls come back rate-limited, fails over to the next endpoint in the same run, and
is then tried only after the others for 10 minutes (`cooldowns` in the stored state, per host). A read counts as failed only when
every endpoint failed for some part of it, so `rpc` warns only after 3 such runs in a row. Each run's summary lists the endpoints
that refused it under `rateLimited`.

Each read, in this order, spends at most 9 fetches (`roundMaxSubrequests`), failed ones included. A part the budget cannot pay for
is deferred to the next run (`deferred` in the summary), never counted as a failure:

* **Fast** (every read): `eth_chainId`, head block, `nextRequestId` and each keeper wallet's balance: 5 calls, one fetch, or two on dRPC.
* **Requests**: `getRoundRequest` from the oldest request not yet settled, at most 32 a run (9 on dRPC). Usually none or one.
* **Slow** (every 10 minutes on mainnet, 30 on testnet): `keeper`, `owner`, `pendingOwner`, `feeRecipient`, `pricing`,
  `keeperFeeBps`, `refundBps`, `backupKeeperCount`, `isBackupKeeper` per backup, `beaconSchedule`, `beaconIdentity` and the
  implementation slot: 12 calls. Once a day (an hour after a failed read, at once after the pins change) also `eth_getCode` of
  the proxy and each accepted implementation (about 25 KB). Between slow reads the role, pricing and beacon checks keep their state.
* **Logs**, with what is left: `eth_getLogs` from the stored cursor (at most 5,000 blocks a run). On dRPC a minute of mainnet
  (about 600 blocks) is 2 fetches, five minutes of testnet (about 1,650) 6.
* **History** for the new consumer notice, with what is left after the logs, until the old requests are read.

On keyed dRPC a mainnet minute costs 4 fetches (fast 2, logs 2), and a minute that also reads the slow part 8 or 9.

Public endpoints keep little state (Robinhood's own about 6,000 blocks), so nothing reads deep history. Requests are read by id at the head: a
fulfilled or refunded one is settled, an open one past its deadline is reported once as `expired`, and the cursor stops at the first
open one within its deadline. The first run looks back 32 ids and does not report expiries from before it. A log cursor more than
30,000 blocks behind (the watchdog was down) jumps to the last 5,000 blocks. Contracts see L1 block numbers in `block.number`; the
reader uses only the RPC's own (L2) block numbers and timestamps.

Alerts go only to the network's own Telegram group, `TELEGRAM_CHAT_ID_ROBINHOOD_TESTNET` (`..._MAINNET`), with the bot
`TELEGRAM_BOT_TOKEN_ROBINHOOD_TESTNET` (`..._MAINNET`) when set, else `TELEGRAM_BOT_TOKEN`. Without its own chat id a Robinhood alert
is stored as `not_sent`: it never falls back to the default chat. The drand relays are watched once for all networks by the beacon
monitor below; its alerts stay in the default chat.

## New consumer notice

One Telegram message, severity `info`, the first time a consumer contract makes a request on a network whose
`newConsumerNotice` is on: Arc Mainnet (default chat) and Robinhood Mainnet (its own group). The testnets have it off.

```
[arc-mainnet] NEW CONSUMER 0x… made its first request, 61 https://arc.d20dao.org/request/<coordinator>/61
[robinhood-mainnet] NEW CONSUMER 0x… made its first request, 5 https://d20dao.org/explorer/request/4663/<coordinator>/5
```

Consumers come from the `RandomnessRequested` logs (one more topic in the existing log scan, no extra fetch) and from the requests
the readers already decode. On a network's first run the watchdog notes its `nextRequestId`; the requests before it are then read
by id, 100 a run, to learn the existing consumers without a message (on Arc inside the round B fetch, on Robinhood with what is left
of the network's fetch budget). A consumer seen live while that history is still being read waits, and is announced once history
is read through, unless history shows it requested before. Each consumer is one row (`consumers`), written when first seen, and a
message is never repeated for it. When the network is unlisted, its notices stay off the status page like its other messages.

## x402 agent API

The agent API sells random numbers to AI agents over x402. Each network's `agentApi` block in `src/config.js` holds
its `url`, its relayer wallet and an `enabled` flag:

| Network | API | Relayer | Watched |
| --- | --- | --- | --- |
| `arc-testnet` | `https://api-testnet.d20dao.org` | `0xF6b446dC2F30e6A802DFB7bD4c222d84F6cd05C3` | yes |
| `arc-mainnet` | `https://api.d20dao.org` | `0x8B465645ed88F6d487d279003aD3681e7aF8e8B7` | yes |

While `enabled` is false, the network's agent API is neither polled nor read on chain, raises no alerts and has no status
section. Setting it back to false resolves its open alerts on the next run.

On each watched network, every run does one `GET <url>/health` (no credentials; 10 s timeout, 16 KiB limit). A reply
counts when it is JSON with a boolean `ok` and names this network, whether its status is 200 or 503. Only a fixed set of
figures is kept from it: states, counts, ages, the relayer's balance and whether the reported relayer is the configured
one. Nothing else in the reply is stored, logged or shown. The relayer's balance is also read on chain by the watchdog
itself, in round A, so the balance check keeps working while the API is down.

The checks use the network's scope, so they go to its Telegram group like its other alerts:

| Check (key) | Warning | Alarm |
| --- | --- | --- |
| `agent_api`: `/health` failed in a row (unreachable, timed out, an HTTP error without a health reply, not JSON) | 2 polls | 5 polls |
| `agent_api` also alarms when `/health` names a different relayer, or reports `ok: false` that no check below explains | — | alarm |
| `agent_api_relayer_balance`: relayer native USDC, read on chain (`agentApiRelayerWarnWei`, `agentApiRelayerAlarmWei`) | mainnet < 4, testnet < 1 USDC | mainnet < 1, testnet < 0.36 USDC |
| `agent_api_funded`: `relayer.funded` is false; the API has stopped selling | — | alarm |
| `agent_api_stuck`: `stuck` is true; the API refuses new calls | — | alarm |
| `agent_api_breaker`: the settlement breaker (closes by itself a minute later) or the delivery breaker (paid calls not served) is open | settlement | delivery |
| `agent_api_refund_due`: `counts.refundDue` > 0, paid calls whose payers are owed a refund by hand; clears once they are marked handled | — | alarm |
| `agent_api_in_doubt`: `inDoubt.overdue` > 0, settlements Gateway has confirmed neither way past the API's limit | — | alarm |
| `agent_api_alarm_loop`: the relayer's alarm last ran ≥ 30 min ago while it stores calls. It runs at least every 10 min while any are stored and stops when none are, so an idle relayer never raises it | — | alarm |

After a failed poll the figures from `/health` are unknown: their alerts are neither resolved nor repeated until a poll
succeeds again. The API stops selling by itself once its relayer holds less than 3 calls' cost (about 0.04 USDC a call on
mainnet, 0.09 on testnet). The balance thresholds, one value per network in `THRESHOLDS`, warn well before that.

## drand beacon monitor

The epoch registry (`EpochEntropy`) publishes epochs only from the drand evmnet beacon: one beacon recipe (id 11 on both networks) and no fallback source, so a drand outage stops epoch publication. Epochs before the drand switch came from signed API records; the watchdog no longer probes those sources. Every run the watchdog reads the relays that serve the beacon and each registry's registration of it. It verifies no signature itself: the registry's own `verifyBeacon` does, over `eth_call` through the RPC client and batching the chain reads use.

Each network's `beacon` block in `src/config.js` holds the recipe id, the preset (`DRAND_EVMNET`: chain hash, group public key, scheme, period 3 s, genesis 1727521075), the relays (`api.drand.sh`, `api2.drand.sh`, `api3.drand.sh`, `drand.cloudflare.com`) and `verifier`, the beacon verifier contract's address. Relays are shared: each is read once per run, however many networks list it.

**`verifier` pins the beacon verifier contract** (one address on both networks), compared once the registry reports a registration. Without a pin (null), the rest of `beaconOf` is pinned and the expected slot signer is derived from the verifier the registry itself reports, so the slot signer proves nothing about the verifier: a registry pointed at another contract would still match. Only step 4 below would catch a verifier that accepts what it should not.

Every run, per beacon:

1. **Freshness:** `GET /<chainHash>/public/latest` on each relay. The round must be at most 3 behind the schedule, round `floor((now − genesis) / period) + 1` (about 10 s). A round more than 2 ahead of the schedule fails too.
2. **Agreement:** the round before the lowest fresh latest round is read from every fresh relay, and the signatures are compared.
3. **Validity:** each registry that lists the beacon is asked `verifyBeacon(recipe, round, signature)` for each distinct signature of that round, at most 4 (with a single fresh relay, its latest round). At most one signature is valid, so one that a registry accepts is the round's, however few relays returned it: the relays that returned another are flagged, and a registry that rejects it counts as rejecting a real round. When none is accepted, the signature most relays returned stands for the round if it has a majority, and a registry that rejects it counts only if at least two relays returned it. A signature only one relay returned, which every registry that lists the beacon rejects, is that relay's to answer for: a warning names it, and the registry is not blamed. With no majority nobody is blamed but the relays.
4. **Verifier:** the same batch asks `verifyBeacon` for the first signature with its last byte flipped. It must not be accepted (a revert is a rejection); if it is, the verifier accepts forged rounds.
5. **Registration:** `beaconOf(recipe)` must equal the preset's chain hash, key, genesis and period, and the configured verifier if there is one. `slotSigner(recipe)` must equal `address(uint160(uint256(keccak256(abi.encode(keccak256("D20_EPOCH_BEACON"), verifier, chainHash, keccak256(publicKey), genesis, period)))))`.
6. **Catalog:** `epochForBlock(head)` and `catalogAt(epoch)` give the catalog in force, where `head` is the network's block from the same run's chain read. It says how serious an outage is (see the alerts). If the configured recipe is not a registration of the preset while a recipe the catalog lists is, that recipe is the one monitored (`recipe` in `/status.json`, next to `configuredRecipe`). A batch cannot hand one call's answer to another, so `catalogAt` asks about the epoch the previous run's `epochForBlock` returned and about the next, and this run's `epochForBlock` says which one is in force; `beaconOf` also asks about the recipes the last catalog listed (a signed recipe once, then never again), and `slotSigner` and `verifyBeacon` about the recipe monitored in the last run. A recipe found in the catalog is therefore monitored, and its rounds verified, from the run after; the catalog's use of the beacon is known at once when it lists the configured recipe, and from the run after when it lists a recipe not seen before.
7. **Chain info:** once a day, each relay's `GET /<chainHash>/info` must equal the preset (hash, public key, scheme, period, genesis time). Relay *j* of *m* is read at second *j* × 86400 / *m* of the UTC day, at most one relay per run. A read that failed or differed is repeated within the hour.

Steps 3 to 5 need the upgraded registry. Before the upgrade and the registration, `beaconOf` reverts: the registry shows as "not registered yet" and steps 3 and 4 are skipped without an alert, while the other steps run and alert as usual. A recipe that exists but is no beacon (`beaconOf` returns a zero verifier: a signed recipe) raises a warning of its own, to check the configured id. A registration that was seen and is gone is a warning after 2 runs in a row: one revert is an RPC node that is behind. One JSON-RPC batch per network carries every call.

Alerts use the scope `beacon` (messages read `[beacon] ALARM drand beacon down: ...`):

| Check (key) | Warning | Alarm |
| --- | --- | --- |
| `fresh:<beacon>`: no relay serves a fresh round, 2 runs in a row | while no catalog in force lists the beacon | when one does: `drand beacon down`, and `drand beacon down, service stopping` when one lists it alone |
| `relay:<beacon>:<host>`: a relay fails (unreachable, HTTP error, unusable or oversize reply, wrong round) or lags | 10 runs in a row; unknown while no relay is fresh, the alarm covers it | — |
| `agree:<beacon>:<host>`: a relay's signature differs from the majority's, or from the one a registry accepts, or is the only one and every registry rejects it | at once; stays until a comparison agrees or a registry accepts it (a failed read does not clear it) | — |
| `info:<beacon>:<host>`: a relay's `/info` differs from the preset | at once; stays until a read matches | — |
| `registration:<network>`: `beaconOf` or `slotSigner` differs from the configuration, the recipe is no beacon, or a registration seen before is gone | at once (a lost registration: 2 runs in a row) | — |
| `verify:<network>`: `verifyBeacon` returns false or reverts for the round of step 3, counted as step 3 says | — | 2 runs in a row |
| `verifier:<network>`: `verifyBeacon` accepts the signature with its last byte flipped (step 4) | — | at once; stays until a check rejects it |
| `monitor`: an error in the watchdog's own code while reading the relays or a registry, or recording the run | at once | — |

How serious an outage is comes from the catalog in force on the chain, read every run. It follows the catalog from run to run: a catalog that changes during an outage changes the level of the alert, and a rise is sent (an alarm sent in the last 30 minutes is not repeated). A catalog that has not been read while the beacon is registered counts as listing the beacon among other sources. A registry that cannot be read (every endpoint failing, another chain id, errors that are not reverts) leaves its checks unknown: alerts are neither resolved nor repeated.

Two kinds of run say nothing about the relays and are unknown for them: they add to neither the runs a relay was not fresh nor the runs none was, and no alert is raised on them. One is a run in which the watchdog itself failed (`monitor` warns). The other is a run in which every relay failed with no reply at all (a timeout or a network error) and no registry batch got through either, so the watchdog's own network is not shown to work (the `rpc` check covers that). Reasons are short texts built by the watchdog, such as `http 503`, `timeout`, `latest round 21056964 is 4 rounds (12s) behind the schedule` or `asked for round 21056967, got round 21056968`. Reply bodies are never stored, logged or sent.

Relay fetches have a 5 s timeout and replies are limited to 4 KiB, with at most 4 open at once; the registry batch uses the chain reader's 5 s timeout and its reply is limited to 32 KiB. A run makes 4 `latest` reads, up to 4 earlier-round reads (fresh relays only), 1 JSON-RPC batch per network (a second endpoint is tried only when the first fails) and, when one is due, 1 `/info` read: 10 fetches in the steady state, at most 13. The batch holds 8 calls in the steady state and 18 at the most (a recipe the catalog lists is asked about once, and remembered when it is a signed recipe); they are calls in it, not fetches. A network's registry batch waits for that network's chain read of the same run, which has usually finished by then. State is 3 rows a run: one for the relays and one per network. See the budget below.

A fault in the beacon stays in the beacon: if it cannot be planned, or its run cannot be worked out or recorded, its rows and alerts stay as they were, the rest of the run is committed as usual, and `monitor` warns.

### Registry upgrade

* **Next implementation.** `implementations.coordinator` and `implementations.registry` in `src/config.js` are lists, and every address in one is accepted. Append an upgrade's implementation before it executes; otherwise `coordinator_impl` or `registry_impl` alarms the moment the proxy points to it. Drop the old entry afterwards, so each network accepts only the implementations in use.

## Alert lifecycle

Each (network, check) pair has one alert row in the Durable Object. Each backup keeper wallet has its own check, so it
resolves independently of the keeper and of other backups. A wallet removed from `backupKeepers` resolves its alert on the
next run; an empty `backupKeepers` also resolves the backup health alerts. The drand beacon uses `beacon` in place of a network:

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

### `POST /v1/health/<network>` (`arc-mainnet`, `arc-testnet`, `robinhood-mainnet`, `robinhood-testnet`)

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

### `POST /v1/health/<network>/backup` (`arc-mainnet`, `arc-testnet`, `robinhood-mainnet`, `robinhood-testnet`)

The backup (follower) keeper's reports. Same envelope, checks and replies as above, with its own key and storage:

* **Auth:** `HEALTH_KEY_ARC_MAINNET_BACKUP`, `HEALTH_KEY_ARC_TESTNET_BACKUP` or `HEALTH_KEY_ROBINHOOD_TESTNET_BACKUP`. The primary's key is refused here, and this key on the primary route.
* **Storage:** separate tables (`backup_reports`, `backup_report_state`). Report ids, duplicates and conflicts are counted per stream, so backup reports never touch the keeper's state or alerts.
* **Role:** `health.role` of the latest report is kept for `backup_role`.

### `GET /status.json`

For each network, this returns:

* report ages, `healthy`, faults, `nodeId`, dropped and failed-event counts,
* the same for the backup under `backupReport`, plus its `role` (`{"everReported": false}` until it reports),
* the configured `backupKeepers`,
* the last chain check time and figures: block, pending count, oldest pending age, keeper balance in USDC (`keeperBalanceUsdc`) and each backup keeper's balance (`backupKeeperBalances`: `[{address, balanceUsdc}]`, `null` until read), base fee and fee-cap usage, wiring checks, log cursor,
* active alerts with severity and `since`,
* under `agentApi`, `{"enabled": false}` when the network's agent API is not watched, otherwise: `status` (`ok`, `not ok`,
  `unreachable` or `not checked`), the last poll's time, HTTP status, latency and failure reason, `consecutiveFailures`,
  `lastOkAt`, the relayer balance read on chain (`relayerBalanceUsdc`) with its thresholds, the kept `/health` figures of
  the last successful poll under `health` (ok, funded, stuck, both breakers, calls in progress and stored, refunds owed
  and handled, payments in doubt, last relayer alarm) and the agent API's own alerts, which are not repeated in the
  network's `alerts`.

Under `beacon` (there while a network lists a beacon) it returns `catalogDrandOnly` (the catalog in force on some network lists the beacon alone, read from the chain) and `maxLagRounds`, then:

* `chains`, one per beacon: `status` (`ok`, `warning` when no relay was fresh in the last run, `alarm` when that is an alarm, `unknown` when the only run so far could not tell, or `not checked`), `freshRelays`, `totalRelays`, `latestRound`, `commonRound`, `lastFreshAt`,
* `relays`, one per relay: `status` (`ok`, `warning`, `unknown` after a run that could not tell, or `not checked`), `lastOutcome` (`fresh`, `stale`, `failure` or `unknown`), `reason`, `latestRound`, `lagRounds`, `lagSeconds`, `latencyMs`, `consecutiveNotFresh`, `lastOkAt`, and `agreement` (with its `verdict`: `ok`, `differs` or `rejected`) and `chainInfo` (`status`, check time, `lastOutcome`, `reason`),
* `networks`, one per network: `registration` (`registered`, `mismatch`, `not a beacon`, `not registered yet`, `no longer registered`, `unknown` or `not checked`), `reason`, `recipe` (the one monitored) and `configuredRecipe`, the registry's `verifier` and `slotSigner`, `expectedVerifier`, `catalog` (`use`: `only`, `mixed` or `none`, `epochId`, `recipes`), `verification` (`status`, `lastOutcome`, `round`, `rejectedRound`, `consecutiveRejections`, `lastOkAt`) and `invalidSignatureCheck` (`status`, `lastOutcome`, `round`),
* the active `beacon` alerts.

It also returns `notifier` (`configured` or `not configured`) and the last 10 notices. It never includes secrets, raw reports or report ids. Responses are edge-cached for 15 s, and query strings are ignored. Browsers get `max-age=15` on a cache hit too: the Worker sets it again, because Cloudflare raises a hit's lower `max-age` to the zone's Browser Cache TTL.

### `GET /`

The same information as a small server-rendered HTML page, with backup keeper health under the backup balances, an Agent API section after each network whose agent API is watched (up or down, relayer balance, refunds owed, payments in doubt, breakers), and a drand beacon section (relays fresh, each registry's registration and catalog, one row per relay with its latest round, lag and checks). It uses the d20dao.org dark theme with inline CSS and the inline logo, no script, is readable on a phone and refreshes every 60 s. Its head carries the site's title pattern, description, canonical URL, Open Graph and X cards (with the d20dao.org share image) and the site's icons.

### `GET /icon.svg`, `/favicon.ico`, `/apple-touch-icon.png`

The d20dao.org icon set, embedded in the Worker (`src/icons.js`). The page links each one with `?v=` and a content hash, so they are served with a one-year immutable cache.

## Secrets

Set these on the deployed Worker (never in files):

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put HEALTH_KEY_ARC_MAINNET
npx wrangler secret put HEALTH_KEY_ARC_TESTNET
npx wrangler secret put HEALTH_KEY_ARC_MAINNET_BACKUP
npx wrangler secret put HEALTH_KEY_ARC_TESTNET_BACKUP

# Robinhood Chain testnet: its own Telegram group (and optionally its own bot), and its keepers' report keys
npx wrangler secret put TELEGRAM_CHAT_ID_ROBINHOOD_TESTNET
npx wrangler secret put TELEGRAM_BOT_TOKEN_ROBINHOOD_TESTNET   # optional: TELEGRAM_BOT_TOKEN is used without it
npx wrangler secret put HEALTH_KEY_ROBINHOOD_TESTNET
npx wrangler secret put HEALTH_KEY_ROBINHOOD_TESTNET_BACKUP

# Robinhood Chain mainnet: the same, with _MAINNET
npx wrangler secret put TELEGRAM_CHAT_ID_ROBINHOOD_MAINNET
npx wrangler secret put TELEGRAM_BOT_TOKEN_ROBINHOOD_MAINNET   # optional
npx wrangler secret put HEALTH_KEY_ROBINHOOD_MAINNET
npx wrangler secret put HEALTH_KEY_ROBINHOOD_MAINNET_BACKUP
```

The bot must be a member of each group.

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

# robinhood-testnet keepers: every 300 s, which the testnet heartbeat thresholds expect (see Free-plan budget)
HEALTH_API_URL=https://watchdog.d20dao.org/v1/health/robinhood-testnet
HEALTH_API_KEY=<same value as HEALTH_KEY_ROBINHOOD_TESTNET>
HEALTH_INTERVAL_SECONDS=300

HEALTH_API_URL=https://watchdog.d20dao.org/v1/health/robinhood-testnet/backup
HEALTH_API_KEY=<same value as HEALTH_KEY_ROBINHOOD_TESTNET_BACKUP>
HEALTH_INTERVAL_SECONDS=300

# robinhood-mainnet keepers, once it is enabled: every 60 s
HEALTH_API_URL=https://watchdog.d20dao.org/v1/health/robinhood-mainnet
HEALTH_API_KEY=<same value as HEALTH_KEY_ROBINHOOD_MAINNET>
HEALTH_INTERVAL_SECONDS=60

HEALTH_API_URL=https://watchdog.d20dao.org/v1/health/robinhood-mainnet/backup
HEALTH_API_KEY=<same value as HEALTH_KEY_ROBINHOOD_MAINNET_BACKUP>
HEALTH_INTERVAL_SECONDS=60
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
curl http://127.0.0.1:8787/status.json            # beacon.relays: the first run reads every relay
rm .dev.vars
```

Layout:

| File | Purpose |
| --- | --- |
| `src/index.js` | Worker entry (`fetch`, `scheduled`), exports the Durable Object |
| `src/http.js` | routing, status caching and security headers |
| `src/report.js` | report auth, bounded body read, envelope validation |
| `src/watchdog.js` | the Durable Object: `ingestReport`, `runCron`, `getStatus` |
| `src/cron.js` | one run: read chains, poll agent APIs, evaluate, commit, deliver |
| `src/agentapi.js` | x402 agent API `/health` poll, the figures kept from it, poll state |
| `src/rpc.js`, `src/abi.js`, `src/net.js` | JSON-RPC batches with fallback, hand-rolled ABI, timed fetch |
| `src/checks.js`, `src/alerts.js` | pure threshold evaluation and alert lifecycle |
| `src/round.js` | Robinhood Chain round coordinator reader: batches, request scan, code hashes, stored state |
| `src/beacon.js` | drand beacon monitor: relay reads, registry batch, judgments, state (`fetch` and the RPC session are injected); loads the hash code on first use |
| `test/fixtures/drand-evmnet-2026-09-29.json` | real drand evmnet chain info and rounds 1, 21056714, 21056750 and 21056968, as the four relays served them on 2026-09-29; a byte for byte copy of the keeper repository's fixture of the same name |
| `test/beacon-helpers.js` | a fake drand network and fake registries for the beacon tests |
| `src/store.js` | SQLite schema and queries |
| `src/status.js`, `src/telegram.js`, `src/format.js` | read model and HTML, Telegram delivery, formatting |

## Deploy

Use `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` (Workers Admin) and `CLOUDFLARE_ACCOUNT_ID` in the environment; the account id is not in `wrangler.jsonc`. Then:

```sh
npx wrangler deploy
```

The first deploy creates the `Watchdog` SQLite Durable Object class (migration `v1`), the custom domain `watchdog.d20dao.org` and the `* * * * *` cron trigger. `workers_dev` and preview URLs are disabled.

Schema changes are applied in place when the object starts (`migrate` in `src/store.js`). Missing tables are created (for example `agent_api_state`, `beacon_state` and `round_state`), and columns added since the first deploy are added when missing (for example `chain_state.backup_balances_json`, `chain_state.agent_relayer_balance_wei` and `report_state.role`). Stored rows are kept, and no new migration tag is needed. `migrate` also drops a leftover `probe_state` table, with the alerts of its scope, the first time it finds one.

The migration uses `new_sqlite_classes`. Newer Cloudflare docs also describe an `exports` field for Durable Object classes. The two are mutually exclusive, and moving a deployed Worker to `exports` cannot be reverted.

## Free-plan budget

| Limit (free plan) | Usage |
| --- | --- |
| Worker CPU 10 ms per invocation | The Worker only routes: report validation plus hashing measured ~0.1–0.4 ms (up to ~1.7 ms on a cold isolate) for 0.5–61 KB reports. The cron handler just calls the Durable Object. The hash code is never evaluated here. |
| Durable Object CPU (30 s per request) | A full run for both networks with replayed live RPC responses measured ~0.4 ms warm and ~1.6 ms cold. A worst-case 5,000-block scan returning 1,000 logs measured ~3.5–5 ms. The drand beacon monitor's own work (records, signature comparison, ABI, state) measured ~0.3 ms per run warm before a beacon is registered and ~0.45 ms after (two slot signers included), against local fakes; the first slot signer after the object starts adds ~4 ms of module evaluation. |
| Subrequests 50 per invocation | Each Robinhood network spends at most 9 fetches a run, failed and fallback ones included (`roundMaxSubrequests`; what does not fit waits for the next run), so ≤ 18 for both. With Arc at its worst (30, below) a run makes at most 48. Normally mainnet takes 2 to 4 a minute and testnet 4 to 8 every five minutes. 2 batches per Arc network normally (3 with pending requests), at most 6 with fallback, so ≤ 12 RPC fetches plus ≤ 3 Telegram sends per run. Backup keeper and agent API relayer balances are extra calls inside the round A batch, so they add no fetches. Each watched agent API adds 1 `/health` poll, so ≤ 17 in total. The drand beacon adds 10 in the steady state (4 `latest` reads, 4 earlier-round reads and 1 registry batch per network; the networks share the relays, and the batch holds every call the monitor makes, up to 18, so the catalog and the verifier check add no fetch), 11 in a run that reads a relay's `/info` (the first four runs, then four a day), and ≤ 13 at most (both registries on their second endpoint), so ≤ 30 in total. |
| DO requests 100,000/day | 2 networks × 2 keepers (primary and backup) × 2,880 reports + 1,440 cron runs ≈ 13,000/day, plus status views (edge-cached 15 s). Robinhood testnet's two keepers at 300 s add 576, and mainnet's two at 60 s add 2,880: ≈ 16,500/day. |
| DO rows written 100,000/day | About 2 per report insert and 2 per prune (the `reports_by_received_at` index), plus 1 state update: ≈ 5 × 11,520 ≈ 58,000 for primary and backup reports. Chain state is 2 × 1,440 ≈ 2,900. Agent API poll state is 1 row per watched network per run, ≈ 1,440/day each. Alerts and messages only change on transitions. The drand beacon keeps 3 rows a run (its relays, each network), ≈ 4,300/day. Arc ≈ 68,000/day with both agent APIs watched. Robinhood testnet, thinned: 5 × 576 reports from its two keepers at 300 s plus 288 state writes (one per 5-minute read) ≈ 3,200. Robinhood mainnet at 60 s: 5 × 2,880 reports plus 1,440 state writes ≈ 15,800. Total ≈ 87,000/day with mainnet enabled. The new consumer notice adds one row per consumer, ever, plus one per history batch while the old requests are read. Keepers left at the 30 s default would add ≈ 14,400 more per network, so keep the intervals above. |
| DO rows read 5,000,000/day | Point lookups plus a few rows per run; the beacon's state adds about 6 (≈ 9,000/day). Well under 100,000/day. |
| DO duration 13,000 GB-s/day | Billed only while handling a request (RPC wait included): about 1 s × 1,440 runs + ~20 ms × 11,520 reports at 128 MB ≈ 220 GB-s/day. Agent API polls wait alongside the chain reads and are bounded by their 10 s timeout. The beacon's three steps (relays, earlier round, registry) run one after another next to them, the last one after its network's chain read as well: about 0.3 s when everything answers, at most about 40 s with a slow chain read and every fetch at its 5 s timeout, so ≈ 55 GB-s/day typically and ≤ 7,400 GB-s/day at the worst. Timers are cleared so the object can hibernate. |
| DO storage 5 GB | 3 days of report ids (≈ 35,000 small rows, primary and backup) plus a bounded 100-row message log. |
| Cron triggers (5 per account) | 1 |

The status page is public and unauthenticated. Each uncached view is one DO request, so heavy scraping from many locations could use up the daily DO request quota. If that happens, add a zone rate-limiting rule for `watchdog.d20dao.org/`.
