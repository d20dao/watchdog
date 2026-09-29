// Static configuration for the D20DAO keeper watchdog. Addresses are public deployment values.

const GWEI = 10n ** 9n;
const USDC = 10n ** 18n; // Arc native USDC uses 18 decimals.

export const WEI_PER_GWEI = GWEI;
export const WEI_PER_USDC = USDC;

// ERC-1967 implementation slot.
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export const SELECTORS = Object.freeze({
  nextRequestId: "0x6a84a985",
  getPendingRequestIds: "0xfdfe72e6",
  getRequest: "0xc58343ef",
  committer: "0x5bc8e8f9",
  // EpochEntropy beacon functions, present once the registry is upgraded for the drand beacon.
  beaconOf: "0x87533a48", // beaconOf(uint8)
  slotSigner: "0xb42be3c1", // slotSigner(uint8)
  verifyBeacon: "0x0ccd9ab2", // verifyBeacon(uint8,uint64,bytes)
});

export const TOPICS = Object.freeze({
  requestRefundedTo: "0x0f6107d218fea62a20553f3700dba7c94dcf653bd2027c0bf1ebe0832f42a506",
  randomnessFulfilled: "0x9c82683ee7932041c254d206bcce4241d66a811d53ee7191799cc120777b2b87",
});

/**
 * A drand beacon the epoch registry can list (EpochEntropy.beaconOf). What the registry holds and what a relay serves
 * must both equal it, and the registry's signer for the slot (slotSigner) is derived from it and the verifier contract.
 *
 *   id, name         stable key for state and alerts (lowercase letters, digits, dashes) and its name on the status page
 *   scheme           drand schemeID: BLS on bn254, unchained, signatures on G1
 *   chainHash        the chain's identity as drand publishes it: 32 bytes, lowercase hex without 0x; the relays' URL path
 *   publicKey        the group public key: 128 bytes, lowercase hex without 0x
 *   genesis, period  the chain's clock in seconds: round r is due at genesis + (r - 1) x period
 *   signatureBytes   size of a round's signature
 */
export const DRAND_EVMNET = Object.freeze({
  id: "drand-evmnet",
  name: "drand evmnet",
  scheme: "bls-bn254-unchained-on-g1",
  chainHash: "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3",
  publicKey:
    "07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b3820557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b",
  genesis: 1727521075,
  period: 3,
  signatureBytes: 64,
});

// Relays serving the chain's public HTTP API: GET /<chainHash>/info, /public/latest and /public/<round>.
export const DRAND_RELAYS = Object.freeze([
  "https://api.drand.sh",
  "https://api2.drand.sh",
  "https://api3.drand.sh",
  "https://drand.cloudflare.com",
]);

export const NETWORKS = Object.freeze({
  "arc-mainnet": Object.freeze({
    name: "arc-mainnet",
    chainId: "5042",
    coordinator: "0xd20da057469C45928912d983F45790C41e290571",
    registry: "0xd20Da048C1A68fa3Bc0B5f5Bc454D1530062C82D",
    keeper: "0xA5496Bb35905Bfe0Bac7D23Ca18c008F5E6Eb13e",
    // Follower keeper authorized as a backup committer; its fulfillments are ours, not a foreign submitter.
    backupKeepers: Object.freeze(["0x75Af60E2165e8E6d2f6cFD5d9dDDa83446044685"]),
    // Expected ERC-1967 implementations; update after each reviewed upgrade. A list accepts each of its addresses,
    // so a reviewed upgrade can be approved before it executes: the current implementation first, then the next.
    implementations: Object.freeze({
      coordinator: Object.freeze(["0xd20da0DADa4352A1a9722be43a2D85923443458c", "0xD20da000125643B4db5A6A36A3b853c17745DF44"]),
      // NEXT REGISTRY IMPLEMENTATION (the drand beacon upgrade): append its address here as a second entry BEFORE the
      // upgrade executes, or the registry_impl check alarms the moment the proxy points to it. Once the upgrade has
      // run, the old entry can go. The address is not known yet, so none is listed.
      registry: Object.freeze(["0xd20dA048C969e5aDcC703Dfdf8220cc9dCB2f865"]),
    }),
    feeCapWei: 2000n * GWEI,
    // Blockdaemon accepts batches from Cloudflare egress; the public endpoint rate-limits them.
    rpcs: Object.freeze(["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.mainnet.arc.io"]),
    explorer: "https://arc.d20dao.org",
    healthKeySecret: "HEALTH_KEY_ARC_MAINNET",
    backupHealthKeySecret: "HEALTH_KEY_ARC_MAINNET_BACKUP",
    // x402 agent API: its public /health and the balance of its relayer wallet. Unwatched while `enabled` is false:
    // no poll, no balance read, no alerts and no status section.
    agentApi: Object.freeze({
      enabled: true,
      url: "https://api.d20dao.org",
      relayer: "0x8B465645ed88F6d487d279003aD3681e7aF8e8B7",
    }),
    // drand beacon the registry lists as `recipe`: its relays are read every run, its registration on chain every run.
    // `verifier` is the beacon verifier contract the registry calls. It is unknown until that contract is deployed, so
    // it stays null and only the rest of beaconOf() is pinned; slotSigner() is then derived from the verifier the
    // registry reports. Set the address after the deployment to pin it as well.
    beacon: Object.freeze({ recipe: 11, preset: DRAND_EVMNET, relays: DRAND_RELAYS, verifier: null }),
  }),
  "arc-testnet": Object.freeze({
    name: "arc-testnet",
    chainId: "5042002",
    coordinator: "0xd20DA0FF9087d053f0291524Eac12abA1ADBd945",
    registry: "0xD20Da00B47A7cD2211dC4683E306913b05903756",
    keeper: "0x61659d9A9A85dA07C36e7d1B35CF0d96CF199Cac",
    // Follower keepers authorized as backup committers: their fulfillments are ours, not a foreign submitter.
    backupKeepers: Object.freeze(["0xbb2fdE97a5F4855bEf872C71fbb80Be3170127Ee"]),
    // Recipe registry and per-submitter keeper share, upgraded on 2026-09-18.
    implementations: Object.freeze({
      coordinator: Object.freeze(["0xd20da0DADa4352A1a9722be43a2D85923443458c", "0xD20da000125643B4db5A6A36A3b853c17745DF44"]),
      // NEXT REGISTRY IMPLEMENTATION (the drand beacon upgrade): append its address here as a second entry BEFORE the
      // upgrade executes, or the registry_impl check alarms the moment the proxy points to it. Once the upgrade has
      // run, the old entry can go. The address is not known yet, so none is listed.
      registry: Object.freeze(["0xd20dA048C969e5aDcC703Dfdf8220cc9dCB2f865"]),
    }),
    feeCapWei: 100n * GWEI,
    rpcs: Object.freeze(["https://rpc.blockdaemon.testnet.arc.io", "https://rpc.testnet.arc.io"]),
    explorer: "https://arc-testnet.d20dao.org",
    healthKeySecret: "HEALTH_KEY_ARC_TESTNET",
    backupHealthKeySecret: "HEALTH_KEY_ARC_TESTNET_BACKUP",
    agentApi: Object.freeze({
      enabled: true,
      url: "https://api-testnet.d20dao.org",
      relayer: "0xF6b446dC2F30e6A802DFB7bD4c222d84F6cd05C3",
    }),
    // As on arc-mainnet: the verifier address is set after the verifier contract is deployed.
    beacon: Object.freeze({ recipe: 11, preset: DRAND_EVMNET, relays: DRAND_RELAYS, verifier: null }),
  }),
});

export const NETWORK_NAMES = Object.freeze(Object.keys(NETWORKS));

/** A network's x402 agent API configuration when it is watched, otherwise null. */
export const watchedAgentApi = (net) => (net?.agentApi?.enabled === true ? net.agentApi : null);

export const THRESHOLDS = Object.freeze({
  heartbeatWarnSeconds: 150,
  heartbeatAlarmSeconds: 240,
  healthAgeWarnSeconds: 120,
  healthAgeAlarmSeconds: 240,
  unhealthyAlarmSeconds: 300,
  pendingWarnSeconds: 25,
  pendingAlarmSeconds: 45,
  balanceWarnWei: 5n * USDC,
  balanceAlarmWei: 2n * USDC,
  // A backup keeper spends only while it covers for the primary (about 0.0065 USDC per served request at 20 gwei),
  // so it needs less runway than the primary before anyone has to act.
  backupBalanceWarnWei: 2n * USDC,
  backupBalanceAlarmWei: 1n * USDC,
  // x402 agent API relayer wallet, whose balance the watchdog reads on chain itself: one value per network. The API
  // stops selling by itself (503, nothing charged) once the relayer holds less than 3 calls' cost. To move the point
  // where the team is told to top up, change that network's value in agentApiRelayerWarnWei.
  //   arc-mainnet: about 0.04 USDC a call. Warn below 4 USDC (about 100 calls); alarm below 1 USDC (25 calls, about
  //                eight times the 0.12 USDC where sales stop).
  //   arc-testnet: about 0.09 USDC a call, and the relayer is kept with only a few calls' worth. Warn below 1 USDC
  //                (about 11 calls); alarm below 0.36 USDC (4 calls), while one call is left before sales stop at 0.27.
  agentApiRelayerWarnWei: Object.freeze({ "arc-mainnet": 4n * USDC, "arc-testnet": 1n * USDC }),
  agentApiRelayerAlarmWei: Object.freeze({ "arc-mainnet": 1n * USDC, "arc-testnet": (36n * USDC) / 100n }),
  // Agent API /health polls in a row that failed (unreachable, timed out, or no JSON health reply).
  agentApiDownWarnPolls: 2,
  agentApiDownAlarmPolls: 5,
  // The relayer's Durable Object alarm runs at least every 10 minutes while it stores any call (its housekeeping
  // tick), and not at all while it stores none. Three missed ticks mean the loop has stopped.
  agentApiAlarmLoopSeconds: 30 * 60,
  // Testnet runs at 41 % of its 100 gwei cap on a normal 20 gwei base fee, so warn only well above that.
  feeWarnPercent: 60n,
  feeAlarmPercent: 85n,
  feeHeadroomWei: 1n * GWEI, // checked value is 2 x baseFee + 1 gwei
  rpcFailureRuns: 3,
  // AirnodeHub listing probes: consecutive failed probes (unreachable, HTTP error, unsigned or unparsable reply).
  probeWarnFailures: 2,
  probeAlarmFailures: 4,
  // Signed timestamp window at probe time. EpochEntropy accepts attestations at most 240 s old and never from
  // after the block, so a reply outside this window could not be committed either.
  probeMaxSignedAgeSeconds: 240,
  probeMaxSignedAheadSeconds: 60,
  // drand beacon monitor. A relay serves a fresh round when its /public/latest is at most this many rounds behind the
  // chain's schedule: 3 rounds is 9 s at the evmnet period, and a relay's edge cache can trail by a round or two.
  beaconMaxLagRounds: 3,
  // A relay naming a round further ahead of the schedule than this is not following the configured chain's clock.
  beaconMaxAheadRounds: 2,
  // Consecutive runs (about a minute each) in which a relay is not fresh before it warns.
  beaconRelayWarnRuns: 3,
  // Consecutive runs in which no relay is fresh before the alarm: the registry cannot publish without a round.
  beaconDownAlarmRuns: 2,
  // Consecutive runs in which the registry rejected the round it was asked to verify before the alarm.
  beaconVerifyAlarmRuns: 2,
});

export const LIMITS = Object.freeze({
  maxReportBytes: 64 * 1024,
  reportRetentionSeconds: 3 * 24 * 3600,
  requestTimeoutSeconds: 60, // coordinator RESPONSE_TIMEOUT: creation time = deadline - 60
  pendingScanWindow: 256,
  pendingDetailLimit: 3,
  logScanMaxBlocks: 5000,
  logScanMinBlocks: 250,
  alarmRepeatSeconds: 30 * 60,
  rpcTimeoutMs: 5000,
  telegramTimeoutMs: 5000,
  telegramMaxSendsPerRun: 3,
  telegramMaxChars: 3800,
  messageMaxAttempts: 5,
  messageMaxAgeSeconds: 3600,
  messagesKept: 100,
  maxIdsInMessage: 10,
  statusCacheSeconds: 15,
  cronOverlapGuardMs: 55_000,
  // The Durable Object re-arms its own alarm every minute, so checks continue even when no keeper reports
  // and whether or not the account's Cron Trigger fires. Runs closer together than this are skipped.
  checkIntervalMs: 60_000,
  minRunSpacingMs: 45_000,
  // AirnodeHub listing probes. Recipe i of n is probed at second (i x 3600 / n) of every hour, so five recipes
  // are 12 minutes apart. After a probe that did not pass, the recipe is probed again after probeRetrySeconds.
  probeIntervalSeconds: 3600,
  probeRetrySeconds: 600,
  probeTimeoutMs: 15_000, // fly.dev cold starts take 6-13 s
  probeMaxResponseBytes: 16 * 1024, // the keeper's own limit for a signed reply
  probeConcurrency: 3, // Workers allow 6 open connections per invocation; the two chain readers use 2
  probeMaxPerRun: 5, // probe POSTs plus listing document GETs per run; the rest wait for the next run
  listingDocumentIntervalSeconds: 24 * 3600,
  listingDocumentRetrySeconds: 3600,
  listingDocumentMaxBytes: 1024 * 1024,
  // drand beacon monitor (src/beacon.js). Each run reads every relay's latest round, then one earlier round from every
  // fresh relay, then makes one JSON-RPC batch per network. A relay's /info is read once a day, one relay per run.
  beaconTimeoutMs: 5000,
  beaconMaxResponseBytes: 4 * 1024, // a round record is about 230 bytes and a chain info about 600
  beaconConcurrency: 4, // relay fetches in flight at once, a bound of its own next to the chain readers and probes
  beaconInfoIntervalSeconds: 24 * 3600,
  beaconInfoRetrySeconds: 3600,
  beaconInfoMaxPerRun: 1,
  // Agent API /health reads the relayer's Durable Object and the chain before it answers.
  agentApiTimeoutMs: 10_000,
  agentApiMaxResponseBytes: 16 * 1024,
});

export const DURABLE_OBJECT_NAME = "watchdog";

// Alert and message scope of the AirnodeHub probes, shown as "[airnodehub]" in Telegram.
export const AIRNODE_SCOPE = "airnodehub";

// Alert and message scope of the drand beacon monitor, shown as "[beacon]" in Telegram.
export const BEACON_SCOPE = "beacon";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const MULTICALL3_GET_LAST_BLOCK_HASH = { to: "0xcA11bde05977b3631167028862bE2a173976CA11", data: "0x27e86d6e" };

/**
 * AirnodeHub recipes the epoch registry (EpochEntropy) can select, probed the way the keeper calls them.
 *
 *   id      stable key for probe state and alerts (lowercase letters, digits, dashes); renaming it resets both
 *   name    shown in messages and on the status page
 *   recipe  EpochEntropy recipe id: recipeRequest(recipe) must equal the canonical form of `body`
 *   url     the listing's gateway: POST `body` for a signed reply, GET for the listing's OpenAPI document
 *   body    the request, sent as JSON (POST / recipes)
 *   passthrough  instead of body, the provider's own request at the gateway's /api: {operation, method, path, query?,
 *           body? (exact text), projection?, route}; route is the entry the listing document's
 *           x-airnode.passthrough.routes held for the operation when the recipe was built
 *   signer  the airnode address the registry catalog holds for this recipe
 *   shape   the signed data bytes EpochEntropy._validate accepts (at most 128 bytes), as a sequence of:
 *             {literal: "..."}             exactly this text
 *             {number: "decimal"}          unsigned JSON number without exponent
 *             {number: "json"}             unsigned JSON number, fraction and exponent allowed
 *             {integer: {maxDigits: n}}    1 to n digits, no leading zero
 *             {integer: {digits: n}}       exactly n digits, no leading zero
 *             {hex: n}                     exactly n lowercase hex characters
 */
// Signed records EpochEntropy accepts; a listing's POST / and passthrough forms answer with the same record.
const SHAPES = {
  btcDayVolume: [{ literal: '{"symbol":"BTC","value":"' }, { number: "decimal" }, { literal: '"}' }],
  blockHash: [{ literal: '{"id":null,"jsonrpc":"2.0","result":"0x' }, { hex: 64 }, { literal: '"}' }],
  btcUsdTrade: [
    { literal: '{"symbol":"BTCUSD","price":' },
    { number: "json" },
    { literal: ',"size":' },
    { number: "json" },
    { literal: ',"timestamp":' },
    { integer: { maxDigits: 16 } },
    { literal: "}" },
  ],
  ethUsdFeed: [
    { literal: '{"ETH/USD":{"value":' },
    { number: "json" },
    { literal: ',"timestamp":' },
    { integer: { digits: 13 } },
    { literal: ',"category":"crypto"}}' },
  ],
};
const JSON_RPC_BLOCK_HASH_BODY = JSON.stringify({ jsonrpc: "2.0", id: null, method: "eth_call", params: [MULTICALL3_GET_LAST_BLOCK_HASH, "latest"] });
const JSON_RPC_ROUTE = { method: "POST", path: "/ogrpc", parameters: { network: "query", method: "body", params: "body" } };

export const AIRNODE_RECIPES = deepFreeze([
  {
    id: "hyperliquid-btc-day-volume",
    name: "Hyperliquid BTC day volume",
    recipe: 0,
    url: "https://airnode-hyperliquid.fly.dev/",
    body: {
      operation: "metaAndAssetCtxs",
      parameters: { dex: "" },
      responseProjection: { symbol: "/0/universe/0/name", value: "/1/0/dayNtlVlm" },
    },
    signer: "0x509F4275Cbe2E2201cc5444bAc8948E3cc7c665B",
    shape: SHAPES.btcDayVolume,
  },
  {
    id: "drpc-ethereum-blockhash",
    name: "dRPC Ethereum block hash",
    recipe: 1,
    url: "https://airnode-drpc.fly.dev/",
    body: {
      operation: "jsonRpc",
      parameters: { network: "ethereum", method: "eth_call", params: [MULTICALL3_GET_LAST_BLOCK_HASH, "latest"] },
    },
    signer: "0x511AcE8648D2f64260d50D036F8f8ce622d92137",
    shape: SHAPES.blockHash,
  },
  {
    id: "tickerlayer-btcusd",
    name: "TickerLayer BTCUSD last trade",
    recipe: 2,
    url: "https://airnode-tickerlayer.fly.dev/",
    body: { operation: "lastTrade", parameters: { assetClass: "crypto", symbol: "BTCUSD" } },
    signer: "0x32f5eA20F05fdADfCD50Cb8eD920acE96D5f9f2c",
    shape: SHAPES.btcUsdTrade,
  },
  {
    id: "nodary-eth-usd",
    name: "Nodary ETH/USD",
    recipe: 4,
    url: "https://airnode-nodary.fly.dev/",
    body: { operation: "latestFeeds", parameters: { name: "ETH/USD" } },
    signer: "0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0",
    shape: SHAPES.ethUsdFeed,
  },
  {
    id: "drpc-base-blockhash",
    name: "dRPC Base block hash",
    recipe: 5,
    url: "https://airnode-drpc.fly.dev/",
    body: {
      operation: "jsonRpc",
      parameters: { network: "base", method: "eth_call", params: [MULTICALL3_GET_LAST_BLOCK_HASH, "latest"] },
    },
    signer: "0x511AcE8648D2f64260d50D036F8f8ce622d92137",
    shape: SHAPES.blockHash,
  },
  // The same listings through the gateways' passthrough (/api), registered as recipes 6 to 10 in the same slot order.
  {
    id: "hyperliquid-btc-day-volume-api",
    name: "Hyperliquid BTC day volume (/api)",
    recipe: 6,
    url: "https://airnode-hyperliquid.fly.dev/",
    passthrough: {
      operation: "metaAndAssetCtxs",
      method: "POST",
      path: "/info",
      body: '{"type":"metaAndAssetCtxs","dex":""}',
      projection: { symbol: "/0/universe/0/name", value: "/1/0/dayNtlVlm" },
      route: { method: "POST", path: "/info", body: { type: "metaAndAssetCtxs" }, parameters: { dex: "body" } },
    },
    signer: "0x509F4275Cbe2E2201cc5444bAc8948E3cc7c665B",
    shape: SHAPES.btcDayVolume,
  },
  {
    id: "drpc-ethereum-blockhash-api",
    name: "dRPC Ethereum block hash (/api)",
    recipe: 7,
    url: "https://airnode-drpc.fly.dev/",
    passthrough: { operation: "jsonRpc", method: "POST", path: "/ogrpc", query: { network: "ethereum" }, body: JSON_RPC_BLOCK_HASH_BODY, route: JSON_RPC_ROUTE },
    signer: "0x511AcE8648D2f64260d50D036F8f8ce622d92137",
    shape: SHAPES.blockHash,
  },
  {
    id: "tickerlayer-btcusd-api",
    name: "TickerLayer BTCUSD last trade (/api)",
    recipe: 8,
    url: "https://airnode-tickerlayer.fly.dev/",
    passthrough: {
      operation: "lastTrade",
      method: "GET",
      path: "/crypto/trade/last/BTCUSD",
      route: { method: "GET", path: "/{assetClass}/trade/last/{symbol}", parameters: { assetClass: "path", symbol: "path" } },
    },
    signer: "0x32f5eA20F05fdADfCD50Cb8eD920acE96D5f9f2c",
    shape: SHAPES.btcUsdTrade,
  },
  {
    id: "nodary-eth-usd-api",
    name: "Nodary ETH/USD (/api)",
    recipe: 9,
    url: "https://airnode-nodary.fly.dev/",
    passthrough: {
      operation: "latestFeeds",
      method: "GET",
      path: "/feed/latest",
      query: { name: "ETH/USD" },
      route: { method: "GET", path: "/feed/latest", parameters: { name: "query" } },
    },
    signer: "0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0",
    shape: SHAPES.ethUsdFeed,
  },
  {
    id: "drpc-base-blockhash-api",
    name: "dRPC Base block hash (/api)",
    recipe: 10,
    url: "https://airnode-drpc.fly.dev/",
    passthrough: { operation: "jsonRpc", method: "POST", path: "/ogrpc", query: { network: "base" }, body: JSON_RPC_BLOCK_HASH_BODY, route: JSON_RPC_ROUTE },
    signer: "0x511AcE8648D2f64260d50D036F8f8ce622d92137",
    shape: SHAPES.blockHash,
  },
]);
