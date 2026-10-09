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

const ETH = 10n ** 18n;
export const WEI_PER_ETH = ETH;

// Views of the round coordinator (D20VRFCoordinatorRobinhood) the round reader calls. nextRequestId is shared with Arc's.
export const ROUND_SELECTORS = Object.freeze({
  nextRequestId: "0x6a84a985",
  keeper: "0xaced1661",
  owner: "0x8da5cb5b",
  pendingOwner: "0xe30c3978",
  feeRecipient: "0x46904840",
  pricing: "0x7ce91411", // pricing() -> (uint256 minFee, uint16 feeMultiplier, uint32 fulfillGasOverhead)
  keeperFeeBps: "0x0eab7d63",
  refundBps: "0xec8c9a0b",
  isBackupKeeper: "0x4fc12619", // isBackupKeeper(address)
  backupKeeperCount: "0x3b9cbca9",
  beaconSchedule: "0x463116f7", // beaconSchedule() -> (uint8 beaconId, uint64 since, uint8 nextBeaconId, uint64 nextFrom)
  beaconIdentity: "0x78fdf6f2", // beaconIdentity(uint8) -> bytes32
  getRoundRequest: "0x46293dec", // getRoundRequest(uint256) -> static RoundRequest tuple of 17 words
});

/**
 * Round-native networks: Robinhood Chain's D20VRFCoordinatorRobinhood. No epoch registry: each request binds a future drand
 * round and the keeper fulfils it before the request's deadline (60 s). Read by src/round.js, checked by
 * evaluateRoundChainChecks, and alerted in the network's own Telegram group only (`ownTelegramGroup`: never the default chat).
 *
 *   enabled          the one switch: a disabled network is not read, not alerted, has no health endpoint and no status section
 *   statusListed     shown on the public status page and in status.json; alerts work either way
 *   owners           accepted owner() values (the deployer during launch, the Safe later); anything else alarms
 *   feeRecipients    accepted feeRecipient() values
 *   implementations  accepted ERC-1967 implementations, as on Arc: an upgrade's is listed before it executes, the old one after
 *   codeHashes       keccak256 of the runtime code: the proxy's, and each accepted implementation's (its immutable proof verifier and
 *                    linked mapping library are part of that code, so this pins them too). Compared once a day.
 *   beacon           the drand beacon in force (beaconSchedule) and its registration's identity (beaconIdentity), which binds its
 *                    verifier, chain hash, public key, genesis and period
 *   pricing          pricing(), keeperFeeBps() and refundBps() as deployed; a change warns
 *   balances         wallet thresholds in wei (native ETH; one fulfilment costs about 0.0000056 ETH): the keeper's, and each backup's
 *   reports          the keepers' HEALTH_INTERVAL_SECONDS and the report thresholds scaled to it (see reportThresholds); Arc
 *                    networks have none and use THRESHOLDS
 *   rpcs             keyless endpoints for the state reads, in order. Each must take a batch of about 20 calls. Robinhood's own
 *                    endpoints rate-limit by source IP, and Cloudflare's egress IPs are shared with every other Worker, so they
 *                    answer the watchdog with HTTP 429 at random: they come last, as a fallback only.
 *   logRpcs          endpoints for eth_getLogs, in order, with the range (`maxBlocks`) and batch (`maxBatch`) each accepts
 *   keyedRpcSecret   name of an optional secret holding a keyed endpoint URL, tried first for state and logs; unset by default
 *   readIntervalSeconds  how often the coordinator is read: 60 reads it every run, 300 every fifth minute. Report checks run
 *                    every minute either way; between reads the chain checks keep their state.
 */
export const ROUND_NETWORKS = Object.freeze({
  "robinhood-testnet": Object.freeze({
    name: "robinhood-testnet",
    kind: "round",
    enabled: true,
    statusListed: false,
    ownTelegramGroup: true,
    chainId: "46630",
    // deployments/robinhood-testnet.json in the keeper repository.
    coordinator: "0x2f26513DE4Ed388947f5d22FD395D5E06f472f05",
    keeper: "0x61659d9A9A85dA07C36e7d1B35CF0d96CF199Cac",
    backupKeepers: Object.freeze(["0xbb2fdE97a5F4855bEf872C71fbb80Be3170127Ee"]),
    owners: Object.freeze(["0x7ad78fc8097DFEA5c12DBb503D6EB6E60f34B40B"]),
    feeRecipients: Object.freeze(["0x7ad78fc8097DFEA5c12DBb503D6EB6E60f34B40B"]),
    implementations: Object.freeze({ coordinator: Object.freeze(["0xC8Cd79B9092AEA38f3434388F291eb861b148f45"]) }),
    codeHashes: Object.freeze({
      proxy: "0x1e98fe55cc7d87073e415635715100988aad79cbb84e39b18f96f3727d1c716f",
      // Proof verifier 0x1EEBe8B8f7a6A18b966C3fBe3f644B8234f93709 and mapping library 0xA57093a645C1Aed12486da50AfA95F3284826849
      // are fixed in this code.
      implementations: Object.freeze({
        "0xc8cd79b9092aea38f3434388f291eb861b148f45": "0xe692b447c02225cb95c921ed29952edb566f2afdfe28ff929452b4909460e8f6",
      }),
    }),
    // drand evmnet with beacon verifier 0xd20dA01Aa16AeD6b77Cd8DDb869151802599100a.
    beacon: Object.freeze({ id: 0, identity: "0x65794cca839753a679e6274f47c6ae64359df498b1674f40a28f9500c91054a5" }),
    pricing: Object.freeze({ minFeeWei: 25_000_000_000_000n, feeMultiplier: 2, fulfillGasOverhead: 405_000, keeperFeeBps: 8000, refundBps: 10000 }),
    // The keeper's MAX_FEE_PER_GAS_WEI. It pays no priority fee here, so the checked value is 2 x baseFee.
    feeCapWei: 3n * GWEI,
    feeHeadroomWei: 0n,
    // Wallets hold about 0.002 ETH. Keeper: warn below 0.001 ETH (about 180 fulfilments), alarm below 0.0003 ETH (about 50).
    // Backup, which spends only while it covers for the primary: warn below 0.0005 ETH, alarm below 0.0002 ETH.
    balances: Object.freeze({ warnWei: ETH / 1000n, alarmWei: (3n * ETH) / 10000n, backupWarnWei: (5n * ETH) / 10000n, backupAlarmWei: (2n * ETH) / 10000n }),
    // Testnet is thinned to spare the free plan's writes: keepers report every 300 s and the chain is read every 5 minutes, so
    // an expired request may be reported up to 5 minutes late. Silence warns after two missed reports and alarms after three.
    reports: Object.freeze({
      intervalSeconds: 300,
      heartbeatWarnSeconds: 660,
      heartbeatAlarmSeconds: 960,
      healthAgeWarnSeconds: 120,
      healthAgeAlarmSeconds: 240,
      unhealthyAlarmSeconds: 600,
    }),
    readIntervalSeconds: 300,
    // PublicNode keeps about 128 blocks of state and takes large batches; Robinhood's own endpoint keeps about 6,000 blocks. The
    // reader scans requests by id at the head and logs from recent blocks only. dRPC's keyless tier takes at most 3 calls a batch,
    // too few for the state reads, so it serves logs only.
    rpcs: Object.freeze(["https://robinhood-sepolia-rpc.publicnode.com", "https://rpc.testnet.chain.robinhood.com"]),
    logRpcs: Object.freeze([
      Object.freeze({ url: "https://robinhood-testnet.drpc.org", maxBlocks: 100, maxBatch: 3 }),
      Object.freeze({ url: "https://rpc.testnet.chain.robinhood.com", maxBlocks: 5000, maxBatch: 1 }),
    ]),
    keyedRpcSecret: "RPC_URL_ROBINHOOD_TESTNET",
    explorer: null,
    healthKeySecret: "HEALTH_KEY_ROBINHOOD_TESTNET",
    backupHealthKeySecret: "HEALTH_KEY_ROBINHOOD_TESTNET_BACKUP",
  }),
  // deployments/robinhood-mainnet.json in the keeper repository (commit deee1c8), checked against the chain. The implementation,
  // its proof verifier and mapping library, and the beacon verifier are the same CREATE2 deployments as on testnet.
  "robinhood-mainnet": Object.freeze({
    name: "robinhood-mainnet",
    kind: "round",
    enabled: true,
    statusListed: false,
    ownTelegramGroup: true,
    chainId: "4663",
    coordinator: "0xEc8b95B168c87294c45727Bd2ac903d09316D132",
    keeper: "0xA5496Bb35905Bfe0Bac7D23Ca18c008F5E6Eb13e",
    backupKeepers: Object.freeze(["0x75Af60E2165e8E6d2f6cFD5d9dDDa83446044685"]),
    // The deployer during launch (owner and fee recipient), the Safe after ownership moves to it.
    owners: Object.freeze(["0x7ad78fc8097DFEA5c12DBb503D6EB6E60f34B40B", "0xE953671bf063CF21F89BbA3bfdB4AFc5FE71078A"]),
    feeRecipients: Object.freeze(["0x7ad78fc8097DFEA5c12DBb503D6EB6E60f34B40B", "0xE953671bf063CF21F89BbA3bfdB4AFc5FE71078A"]),
    implementations: Object.freeze({ coordinator: Object.freeze(["0xC8Cd79B9092AEA38f3434388F291eb861b148f45"]) }),
    codeHashes: Object.freeze({
      proxy: "0x1e98fe55cc7d87073e415635715100988aad79cbb84e39b18f96f3727d1c716f",
      // Proof verifier 0x1EEBe8B8f7a6A18b966C3fBe3f644B8234f93709 and mapping library 0xA57093a645C1Aed12486da50AfA95F3284826849
      // are fixed in this code.
      implementations: Object.freeze({
        "0xc8cd79b9092aea38f3434388f291eb861b148f45": "0xe692b447c02225cb95c921ed29952edb566f2afdfe28ff929452b4909460e8f6",
      }),
    }),
    // drand evmnet with beacon verifier 0xd20dA01Aa16AeD6b77Cd8DDb869151802599100a.
    beacon: Object.freeze({ id: 0, identity: "0x65794cca839753a679e6274f47c6ae64359df498b1674f40a28f9500c91054a5" }),
    pricing: Object.freeze({ minFeeWei: 25_000_000_000_000n, feeMultiplier: 2, fulfillGasOverhead: 405_000, keeperFeeBps: 8000, refundBps: 10000 }),
    feeCapWei: 3n * GWEI,
    feeHeadroomWei: 0n,
    // Wallets hold only about 0.0005 ETH each (about 20 requests): warn below 0.0002 ETH, alarm below 0.0001 ETH, for both.
    balances: Object.freeze({ warnWei: (2n * ETH) / 10000n, alarmWei: ETH / 10000n, backupWarnWei: (2n * ETH) / 10000n, backupAlarmWei: ETH / 10000n }),
    // Keepers report every 60 s: silence warns after 150 s and alarms after 240 s, as on Arc.
    reports: Object.freeze({
      intervalSeconds: 60,
      heartbeatWarnSeconds: 150,
      heartbeatAlarmSeconds: 240,
      healthAgeWarnSeconds: 120,
      healthAgeAlarmSeconds: 240,
      unhealthyAlarmSeconds: 300,
    }),
    readIntervalSeconds: 60,
    // As on testnet. PublicNode's mainnet nodes keep only about 80 blocks (8 s), enough for the state reads, not for logs.
    rpcs: Object.freeze(["https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com"]),
    logRpcs: Object.freeze([
      Object.freeze({ url: "https://robinhood.drpc.org", maxBlocks: 100, maxBatch: 3 }),
      Object.freeze({ url: "https://rpc.mainnet.chain.robinhood.com", maxBlocks: 5000, maxBatch: 1 }),
    ]),
    keyedRpcSecret: "RPC_URL_ROBINHOOD_MAINNET",
    explorer: null,
    healthKeySecret: "HEALTH_KEY_ROBINHOOD_MAINNET",
    backupHealthKeySecret: "HEALTH_KEY_ROBINHOOD_MAINNET_BACKUP",
  }),
});

/** The networks of `nets` that are switched on (`enabled: true`). */
export const enabledNetworks = (nets) => Object.freeze(Object.fromEntries(Object.entries(nets).filter(([, net]) => net.enabled === true)));
export const WATCHED_ROUND_NETWORKS = enabledNetworks(ROUND_NETWORKS);

export const isRoundNetwork = (net) => net?.kind === "round";

/**
 * The report thresholds of a network: its own `reports` when it has them, THRESHOLDS otherwise (Arc). health_age measures the
 * keeper's health observation against its report, which the keeper refreshes every tick whatever the report interval.
 */
export function reportThresholds(net) {
  const own = net?.reports ?? {};
  const pick = (key) => own[key] ?? THRESHOLDS[key];
  return {
    heartbeatWarnSeconds: pick("heartbeatWarnSeconds"),
    heartbeatAlarmSeconds: pick("heartbeatAlarmSeconds"),
    healthAgeWarnSeconds: pick("healthAgeWarnSeconds"),
    healthAgeAlarmSeconds: pick("healthAgeAlarmSeconds"),
    unhealthyAlarmSeconds: pick("unhealthyAlarmSeconds"),
  };
}

/** A network's configuration by name, among the Arc networks and the enabled round networks; null when there is none. */
export function networkByName(name, nets = NETWORKS, roundNets = WATCHED_ROUND_NETWORKS) {
  if (Object.hasOwn(nets, name)) return nets[name];
  if (Object.hasOwn(roundNets, name)) return roundNets[name];
  return null;
}

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
  // Round networks set their wallet thresholds in `balances` and their report timing in `reports` (ROUND_NETWORKS).
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
  // Round networks (src/round.js). Requests are read by id, from the oldest one not yet settled, at most this many a run.
  roundScanMaxIds: 32,
  // Logs are scanned from the stored cursor, at most this many blocks a run. The public RPC keeps about 6,000 blocks of state,
  // so a cursor further behind than roundLogMaxLagBlocks jumps to the recent blocks instead of reading deep history.
  roundLogScanMaxBlocks: 5000,
  // Fetches one log endpoint may take a run: with dRPC's caps (100 blocks a call, 3 calls a batch) 6 fetches cover 1,800 blocks,
  // three minutes of mainnet (about 10 blocks a second) or five of testnet (about 5.5).
  roundLogMaxFetches: 6,
  // An endpoint that refused a batch for its rate or plan limits is tried only after the others for this long.
  roundRpcCooldownSeconds: 600,
  roundLogMaxLagBlocks: 30_000,
  // Runtime code hashes are compared once a day, and an hour after a read that failed.
  roundCodeCheckIntervalSeconds: 24 * 3600,
  roundCodeRetrySeconds: 3600,
});

export const DURABLE_OBJECT_NAME = "watchdog";

// Alert and message scope of the drand beacon monitor, shown as "[beacon]" in Telegram.
export const BEACON_SCOPE = "beacon";
