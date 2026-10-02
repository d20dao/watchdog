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
  // EpochEntropy views the drand beacon monitor reads. The beacon ones exist once the registry is upgraded for it.
  beaconOf: "0x87533a48", // beaconOf(uint8)
  slotSigner: "0xb42be3c1", // slotSigner(uint8)
  verifyBeacon: "0x0ccd9ab2", // verifyBeacon(uint8,uint64,bytes)
  epochForBlock: "0x7018ebb1", // epochForBlock(uint256) -> uint64
  catalogAt: "0xec993599", // catalogAt(uint64) -> (bytes32 hash, uint8[] recipes, address[] signers)
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
    // Once the upgrade has run, the old entry goes.
    implementations: Object.freeze({
      // Runtime code hash (keccak256 of the deployed code): 0x3dda400d8360d7e03b8dacd8ba1ffad7ad672e07628bee7de4542d754dd5348c
      coordinator: Object.freeze(["0xD20da000125643B4db5A6A36A3b853c17745DF44"]),
      // Runtime code hash: 0xb5e125e3b0f63ffe516d781266c1cbacebe3d131148b69f8736d3ca78bcddb12
      registry: Object.freeze(["0xD20dA0853a6f894c0cdc9018fD4F8F67Eac15704"]),
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
    // drand beacon the registry lists as `recipe` (the recipe monitored follows the catalog in force if the beacon is
    // registered under another id): its relays are read every run, its registration on chain every run.
    // `verifier` pin: the same CREATE2 address as on Arc Testnet; compared only once the registry reports a registration.
    beacon: Object.freeze({ recipe: 11, preset: DRAND_EVMNET, relays: DRAND_RELAYS, verifier: "0xd20dA01Aa16AeD6b77Cd8DDb869151802599100a" }),
  }),
  "arc-testnet": Object.freeze({
    name: "arc-testnet",
    chainId: "5042002",
    coordinator: "0xd20DA0FF9087d053f0291524Eac12abA1ADBd945",
    registry: "0xD20Da00B47A7cD2211dC4683E306913b05903756",
    keeper: "0x61659d9A9A85dA07C36e7d1B35CF0d96CF199Cac",
    // Follower keepers authorized as backup committers: their fulfillments are ours, not a foreign submitter.
    backupKeepers: Object.freeze(["0xbb2fdE97a5F4855bEf872C71fbb80Be3170127Ee"]),
    // The same rule as on Arc Mainnet: an upgrade's implementation is listed before it executes, the old one dropped after.
    implementations: Object.freeze({
      // Runtime code hash: 0x3dda400d8360d7e03b8dacd8ba1ffad7ad672e07628bee7de4542d754dd5348c
      coordinator: Object.freeze(["0xD20da000125643B4db5A6A36A3b853c17745DF44"]),
      // Runtime code hash: 0xb5e125e3b0f63ffe516d781266c1cbacebe3d131148b69f8736d3ca78bcddb12
      registry: Object.freeze(["0xD20dA0853a6f894c0cdc9018fD4F8F67Eac15704"]),
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
    // The beacon verifier deployed on Arc Testnet (CREATE2; the same address is planned on mainnet).
    beacon: Object.freeze({ recipe: 11, preset: DRAND_EVMNET, relays: DRAND_RELAYS, verifier: "0xd20dA01Aa16AeD6b77Cd8DDb869151802599100a" }),
  }),
});

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
  // drand beacon monitor. A relay serves a fresh round when its /public/latest is at most this many rounds behind the
  // chain's schedule: 3 rounds is 9 s at the evmnet period, and a relay's edge cache can trail by a round or two.
  beaconMaxLagRounds: 3,
  // A relay naming a round further ahead of the schedule than this is not following the configured chain's clock.
  beaconMaxAheadRounds: 2,
  // Consecutive runs (about a minute each) in which a relay is not fresh before it warns. One relay lagging while the
  // others serve delays nothing (the keepers ask every relay at once), and drand.cloudflare.com serves a cached 404
  // for a few minutes at a time, so only a streak of about ten minutes is worth a warning.
  beaconRelayWarnRuns: 10,
  // Consecutive runs in which no relay is fresh before the alarm: the registry cannot publish without a round.
  beaconDownAlarmRuns: 2,
  // Consecutive runs in which the registry rejected the round it was asked to verify before the alarm. Only a rejection
  // of a signature that at least two relays returned, or that another network's registry accepted, counts.
  beaconVerifyAlarmRuns: 2,
  // Consecutive runs in which beaconOf must revert, after the beacon was seen registered, before "no longer registered"
  // warns: one read from an RPC node that is behind, or a rollback that is quickly undone, is not a lost registration.
  beaconUnregisteredRuns: 2,
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
  // drand beacon monitor (src/beacon.js). Each run reads every relay's latest round, then one earlier round from every
  // fresh relay, then makes one JSON-RPC batch per network. A relay's /info is read once a day, one relay per run.
  beaconTimeoutMs: 5000,
  beaconMaxResponseBytes: 4 * 1024, // a round record is about 230 bytes and a chain info about 600
  beaconConcurrency: 4, // relay fetches in flight at once, a bound of its own next to the chain readers
  // A registry batch holds beaconOf for the monitored recipe and the catalog's, slotSigner, verifyBeacon for each distinct
  // signature of the compared round and for one with its last byte flipped, epochForBlock and two catalogAt: 18 calls at
  // the most, and about 10 KB of answers with the catalog's four slots.
  beaconMaxSignatures: 4, // distinct signatures of the compared round that go to verifyBeacon
  beaconMaxRecipes: 8, // recipe ids one batch asks beaconOf about
  beaconRpcMaxResponseBytes: 32 * 1024,
  beaconInfoIntervalSeconds: 24 * 3600,
  // A /info read that failed or differed from the preset is repeated after this long, not a day later.
  beaconInfoRetrySeconds: 3600,
  beaconInfoMaxPerRun: 1,
  // Agent API /health reads the relayer's Durable Object and the chain before it answers.
  agentApiTimeoutMs: 10_000,
  agentApiMaxResponseBytes: 16 * 1024,
});

export const DURABLE_OBJECT_NAME = "watchdog";

// Alert and message scope of the drand beacon monitor, shown as "[beacon]" in Telegram.
export const BEACON_SCOPE = "beacon";
