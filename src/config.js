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
});

export const TOPICS = Object.freeze({
  requestRefundedTo: "0x0f6107d218fea62a20553f3700dba7c94dcf653bd2027c0bf1ebe0832f42a506",
  randomnessFulfilled: "0x9c82683ee7932041c254d206bcce4241d66a811d53ee7191799cc120777b2b87",
});

export const NETWORKS = Object.freeze({
  "arc-mainnet": Object.freeze({
    name: "arc-mainnet",
    chainId: "5042",
    coordinator: "0xd20da057469C45928912d983F45790C41e290571",
    registry: "0xd20Da048C1A68fa3Bc0B5f5Bc454D1530062C82D",
    keeper: "0xA5496Bb35905Bfe0Bac7D23Ca18c008F5E6Eb13e",
    backupKeepers: Object.freeze([]),
    // Expected ERC-1967 implementations; update after each reviewed upgrade.
    implementations: Object.freeze({
      coordinator: "0xd20da0DADa4352A1a9722be43a2D85923443458c",
      registry: "0xd20dA048C969e5aDcC703Dfdf8220cc9dCB2f865",
    }),
    feeCapWei: 2000n * GWEI,
    // Blockdaemon accepts batches from Cloudflare egress; the public endpoint rate-limits them.
    rpcs: Object.freeze(["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.mainnet.arc.io"]),
    explorer: "https://arc.d20dao.org",
    healthKeySecret: "HEALTH_KEY_ARC_MAINNET",
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
      coordinator: "0xd20da0DADa4352A1a9722be43a2D85923443458c",
      registry: "0xd20dA048C969e5aDcC703Dfdf8220cc9dCB2f865",
    }),
    feeCapWei: 100n * GWEI,
    rpcs: Object.freeze(["https://rpc.blockdaemon.testnet.arc.io", "https://rpc.testnet.arc.io"]),
    explorer: "https://arc-testnet.d20dao.org",
    healthKeySecret: "HEALTH_KEY_ARC_TESTNET",
  }),
});

export const NETWORK_NAMES = Object.freeze(Object.keys(NETWORKS));

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
});

export const DURABLE_OBJECT_NAME = "watchdog";

// Alert and message scope of the AirnodeHub probes, shown as "[airnodehub]" in Telegram.
export const AIRNODE_SCOPE = "airnodehub";

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
 *   body    the request, sent as JSON
 *   signer  the airnode address the registry catalog holds for this recipe
 *   shape   the signed data bytes EpochEntropy._validate accepts (at most 128 bytes), as a sequence of:
 *             {literal: "..."}             exactly this text
 *             {number: "decimal"}          unsigned JSON number without exponent
 *             {number: "json"}             unsigned JSON number, fraction and exponent allowed
 *             {integer: {maxDigits: n}}    1 to n digits, no leading zero
 *             {integer: {digits: n}}       exactly n digits, no leading zero
 *             {hex: n}                     exactly n lowercase hex characters
 */
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
    shape: [{ literal: '{"symbol":"BTC","value":"' }, { number: "decimal" }, { literal: '"}' }],
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
    shape: [{ literal: '{"id":null,"jsonrpc":"2.0","result":"0x' }, { hex: 64 }, { literal: '"}' }],
  },
  {
    id: "tickerlayer-btcusd",
    name: "TickerLayer BTCUSD last trade",
    recipe: 2,
    url: "https://airnode-tickerlayer.fly.dev/",
    body: { operation: "lastTrade", parameters: { assetClass: "crypto", symbol: "BTCUSD" } },
    signer: "0x32f5eA20F05fdADfCD50Cb8eD920acE96D5f9f2c",
    shape: [
      { literal: '{"symbol":"BTCUSD","price":' },
      { number: "json" },
      { literal: ',"size":' },
      { number: "json" },
      { literal: ',"timestamp":' },
      { integer: { maxDigits: 16 } },
      { literal: "}" },
    ],
  },
  {
    id: "nodary-eth-usd",
    name: "Nodary ETH/USD",
    recipe: 4,
    url: "https://airnode-nodary.fly.dev/",
    body: { operation: "latestFeeds", parameters: { name: "ETH/USD" } },
    signer: "0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0",
    shape: [
      { literal: '{"ETH/USD":{"value":' },
      { number: "json" },
      { literal: ',"timestamp":' },
      { integer: { digits: 13 } },
      { literal: ',"category":"crypto"}}' },
    ],
  },
  {
    id: "drpc-base-blockhash",
    name: "dRPC Base block hash",
    recipe: 6,
    url: "https://airnode-drpc.fly.dev/",
    body: {
      operation: "jsonRpc",
      parameters: { network: "base", method: "eth_call", params: [MULTICALL3_GET_LAST_BLOCK_HASH, "latest"] },
    },
    signer: "0x511AcE8648D2f64260d50D036F8f8ce622d92137",
    shape: [{ literal: '{"id":null,"jsonrpc":"2.0","result":"0x' }, { hex: 64 }, { literal: '"}' }],
  },
]);
