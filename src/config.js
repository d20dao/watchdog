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

// Same implementations on both networks.
export const EXPECTED_IMPLEMENTATIONS = Object.freeze({
  coordinator: "0xD20da0c375cEfCdA65703699A4090237057e9b68",
  registry: "0xD20Da0cf7Ddc6123f9A87c0C210F8ECB934CA7D5",
});

export const NETWORKS = Object.freeze({
  "arc-mainnet": Object.freeze({
    name: "arc-mainnet",
    chainId: "5042",
    coordinator: "0xd20da057469C45928912d983F45790C41e290571",
    registry: "0xd20Da048C1A68fa3Bc0B5f5Bc454D1530062C82D",
    keeper: "0xA5496Bb35905Bfe0Bac7D23Ca18c008F5E6Eb13e",
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
  feeWarnPercent: 25n,
  feeAlarmPercent: 50n,
  feeHeadroomWei: 1n * GWEI, // checked value is 2 x baseFee + 1 gwei
  rpcFailureRuns: 3,
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
});

export const DURABLE_OBJECT_NAME = "watchdog";
