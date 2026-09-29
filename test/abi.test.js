import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbiError,
  decodeAddress,
  decodeBeaconOf,
  decodeBool,
  decodeCoordinatorLog,
  decodePendingRequestIds,
  decodeRequest,
  decodeUint256,
  encodeBeaconOf,
  encodeGetPendingRequestIds,
  encodeGetRequest,
  encodeSlotSigner,
  encodeVerifyBeacon,
  hexToBigInt,
  hexToSafeNumber,
  toQuantity,
} from "../src/abi.js";
import { TOPICS } from "../src/config.js";
import { ZERO_BEACON, encodeBeaconOfResult, registeredBeacon } from "./beacon-helpers.js";
import { addressWord, bytes32, encodePending, encodeRequest, word } from "./helpers.js";

test("calldata encoding matches the verified selectors", () => {
  assert.equal(
    encodeGetPendingRequestIds(717n, 256n),
    "0xfdfe72e6" + word(717) + word(256),
  );
  assert.equal(encodeGetRequest(42n), "0xc58343ef" + word(42));
  assert.throws(() => encodeGetRequest(-1n), AbiError);
  assert.throws(() => encodeGetRequest(1n << 256n), AbiError);
});

test("quantities", () => {
  assert.equal(hexToBigInt("0x"), 0n);
  assert.equal(hexToBigInt("0x4a817c800"), 20n * 10n ** 9n);
  assert.equal(hexToSafeNumber("0x13b2"), 5042);
  assert.equal(toQuantity(62576776), "0x3bad888");
  assert.throws(() => hexToBigInt("12"), AbiError);
  assert.throws(() => hexToSafeNumber("0x" + "f".repeat(20)), AbiError);
});

test("uint256 and address return values", () => {
  assert.equal(decodeUint256("0x" + word(973)), 973n);
  assert.throws(() => decodeUint256("0x" + word(1) + word(2)), AbiError);
  assert.throws(() => decodeUint256("0x1234"), AbiError);

  const keeper = "0xA5496Bb35905Bfe0Bac7D23Ca18c008F5E6Eb13e";
  assert.equal(decodeAddress("0x" + addressWord(keeper)), keeper.toLowerCase());
  // Storage slot holding an implementation address.
  assert.equal(
    decodeAddress("0x000000000000000000000000d20da0c375cefcda65703699a4090237057e9b68"),
    "0xd20da0c375cefcda65703699a4090237057e9b68",
  );
  assert.throws(() => decodeAddress("0x01" + addressWord(keeper).slice(2)), AbiError);
});

test("getPendingRequestIds return data", () => {
  assert.deepEqual(decodePendingRequestIds(encodePending([], 973)), { ids: [], nextCursor: 973n });
  assert.deepEqual(decodePendingRequestIds(encodePending([970, 971, 972], 973)), {
    ids: [970n, 971n, 972n],
    nextCursor: 973n,
  });
  // Live shape observed on mainnet: offset 0x40, cursor 15, empty array.
  assert.deepEqual(
    decodePendingRequestIds("0x" + word(0x40) + word(15) + word(0)),
    { ids: [], nextCursor: 15n },
  );
  assert.throws(() => decodePendingRequestIds("0x" + word(0x41) + word(1) + word(0)), AbiError, "misaligned offset");
  assert.throws(() => decodePendingRequestIds("0x" + word(0x400) + word(1) + word(0)), AbiError, "offset past end");
  assert.throws(() => decodePendingRequestIds("0x" + word(0x40) + word(1) + word(3) + word(1)), AbiError, "truncated array");
  assert.throws(() => decodePendingRequestIds(encodePending([1, 2, 3], 4), 2), AbiError, "too long");
});

test("getRequest static tuple of 17 words", () => {
  const decoded = decodeRequest(
    encodeRequest({ deadline: 1789420060, fulfilled: true, delivered: false, refunded: true, epochId: 63 }),
  );
  assert.equal(decoded.consumer, "0x1111111111111111111111111111111111111111");
  assert.equal(decoded.callbackGasLimit, 150000);
  assert.equal(decoded.requestBlock, 100);
  assert.equal(decoded.targetBlock, 102);
  assert.equal(decoded.deadline, 1789420060);
  assert.equal(decoded.refundAddress, "0x2222222222222222222222222222222222222222");
  assert.equal(decoded.clientSeed, "0x" + bytes32("a1"));
  assert.equal(decoded.randomness, "0x" + bytes32("d4"));
  assert.equal(decoded.fulfilled, true);
  assert.equal(decoded.delivered, false);
  assert.equal(decoded.refunded, true);
  assert.equal(decoded.epochId, 63);
  assert.equal(decoded.epochHash, "0x" + bytes32("07"));

  const words = encodeRequest().slice(2);
  assert.throws(() => decodeRequest("0x" + words.slice(64)), AbiError, "16 words");
  const badBool = words.slice(0, 12 * 64) + word(2) + words.slice(13 * 64);
  assert.throws(() => decodeRequest("0x" + badBool), AbiError, "bool out of range");
  const badGas = words.slice(0, 64) + word(1n << 32n) + words.slice(2 * 64);
  assert.throws(() => decodeRequest("0x" + badGas), AbiError, "uint32 out of range");
});

test("RequestRefundedTo and RandomnessFulfilled logs", () => {
  const refund = decodeCoordinatorLog({
    address: "0xd20da0ff9087d053f0291524eac12aba1adbd945",
    topics: [TOPICS.requestRefundedTo, "0x" + word(812), "0x" + addressWord("0x3333333333333333333333333333333333333333")],
    data: "0x" + word(5n * 10n ** 17n) + word(1),
    blockNumber: "0x3b9bbe2",
    transactionHash: "0x" + bytes32("9a"),
  });
  assert.deepEqual(refund, {
    kind: "refund",
    requestId: 812n,
    blockNumber: 0x3b9bbe2,
    transactionHash: "0x" + bytes32("9a"),
    refundAddress: "0x3333333333333333333333333333333333333333",
    amountWei: 5n * 10n ** 17n,
    paid: true,
  });

  const fulfilled = decodeCoordinatorLog({
    topics: [TOPICS.randomnessFulfilled, "0x" + word(813), "0x" + addressWord("0x61659d9A9A85dA07C36e7d1B35CF0d96CF199Cac")],
    data: "0x" + bytes32("d4"),
    blockNumber: "0x10",
  });
  assert.equal(fulfilled.kind, "fulfilled");
  assert.equal(fulfilled.requestId, 813n);
  assert.equal(fulfilled.submitter, "0x61659d9a9a85da07c36e7d1b35cf0d96cf199cac");
  assert.equal(fulfilled.randomness, "0x" + bytes32("d4"));

  assert.equal(decodeCoordinatorLog({ topics: ["0x" + bytes32("00")], data: "0x" }), null);
  assert.throws(
    () => decodeCoordinatorLog({ topics: [TOPICS.requestRefundedTo, "0x" + word(1)], data: "0x" + word(1) + word(0) }),
    AbiError,
  );
  assert.throws(
    () =>
      decodeCoordinatorLog({
        topics: [TOPICS.requestRefundedTo, "0x" + word(1), "0x" + addressWord("0x3333333333333333333333333333333333333333")],
        data: "0x" + word(1) + word(2),
      }),
    AbiError,
  );
});

test("beacon calldata: the recipe and round words, then the signature as a dynamic bytes argument", () => {
  assert.equal(encodeBeaconOf(11), "0x87533a48" + word(11));
  assert.equal(encodeSlotSigner(11), "0xb42be3c1" + word(11));
  const signature = "ab".repeat(64);
  assert.equal(
    encodeVerifyBeacon(11, 21056967, "0x" + signature),
    "0x0ccd9ab2" + word(11) + word(21056967) + word(96) + word(64) + signature,
    "head: recipe, round, offset 3 words on; tail: length and the two words of data",
  );
  assert.equal(
    encodeVerifyBeacon(1, 2, "0x" + "cd".repeat(5)),
    "0x0ccd9ab2" + word(1) + word(2) + word(96) + word(5) + "cd".repeat(5) + "00".repeat(27),
    "bytes are padded on the right to a whole word",
  );
  assert.equal(encodeVerifyBeacon(1, 2, "0x"), "0x0ccd9ab2" + word(1) + word(2) + word(96) + word(0));
  assert.throws(() => encodeBeaconOf(256), AbiError, "a uint8");
  assert.throws(() => encodeSlotSigner(-1), AbiError);
  assert.throws(() => encodeVerifyBeacon(11, 1n << 64n, "0x00"), AbiError, "a uint64");
  assert.throws(() => encodeVerifyBeacon(11, 5, "0xabc"), AbiError, "half a byte");
  assert.throws(() => encodeVerifyBeacon(11, 5, "abcd"), AbiError, "no 0x");
});

test("verifyBeacon return value is a bool", () => {
  assert.equal(decodeBool("0x" + word(1)), true);
  assert.equal(decodeBool("0x" + word(0)), false);
  assert.throws(() => decodeBool("0x" + word(2)), AbiError);
  assert.throws(() => decodeBool("0x"), AbiError);
  assert.throws(() => decodeBool("0x" + word(1) + word(1)), AbiError);
});

test("beaconOf return data: a dynamic tuple, and the zero tuple for a recipe that is no beacon", () => {
  const registered = registeredBeacon();
  const data = encodeBeaconOfResult(registered);
  assert.equal((data.length - 2) / 64, 1 + 5 + 1 + 4, "offset, five head words, the key's length and its four words");
  assert.deepEqual(decodeBeaconOf(data), registered);
  assert.deepEqual(decodeBeaconOf(encodeBeaconOfResult(ZERO_BEACON)), ZERO_BEACON);
  assert.equal(decodeBeaconOf(encodeBeaconOfResult(ZERO_BEACON)).publicKey, "0x", "an empty key");
  // The verifier comes back lowercase like every address.
  assert.equal(decodeBeaconOf(encodeBeaconOfResult(registeredBeacon({ verifier: "0xABABABABABABABABABABABABABABABABABABABAB" }))).verifier, "0x" + "ab".repeat(20));

  const words = data.slice(2).match(/.{64}/g);
  const build = (edit) => "0x" + edit([...words]).join("");
  assert.throws(() => decodeBeaconOf("0x"), AbiError, "no data");
  assert.throws(() => decodeBeaconOf("0x" + words.slice(0, 6).join("")), AbiError, "too short");
  assert.throws(() => decodeBeaconOf("0x" + words.slice(0, -1).join("")), AbiError, "the key is cut short");
  assert.throws(() => decodeBeaconOf(build((w) => ((w[0] = word(33)), w))), AbiError, "misaligned tuple offset");
  assert.throws(() => decodeBeaconOf(build((w) => ((w[0] = word(0x2000)), w))), AbiError, "tuple offset past the data");
  assert.throws(() => decodeBeaconOf(build((w) => ((w[5] = word(0x2000)), w))), AbiError, "key offset past the data");
  assert.throws(() => decodeBeaconOf(build((w) => ((w[5] = word(161)), w))), AbiError, "misaligned key offset");
  assert.throws(() => decodeBeaconOf(build((w) => ((w[6] = word(129)), w))), AbiError, "a length that runs past the data");
  assert.throws(() => decodeBeaconOf(data, 64), AbiError, "a key longer than the limit");
  assert.throws(() => decodeBeaconOf(build((w) => ((w[1] = "01" + w[1].slice(2)), w))), AbiError, "an address with dirty high bits");
  assert.throws(() => decodeBeaconOf(build((w) => ((w[2] = word(1n << 64n)), w))), AbiError, "genesis is a uint64");
  assert.throws(() => decodeBeaconOf(build((w) => ((w[3] = word(2n ** 60n)), w))), AbiError, "period beyond a safe integer");
  // Padding after the key's last byte must be zero.
  const short = encodeBeaconOfResult(registeredBeacon({ publicKey: "0x" + "ab".repeat(5) }));
  assert.equal(decodeBeaconOf(short).publicKey, "0x" + "ab".repeat(5));
  assert.throws(() => decodeBeaconOf(short.slice(0, -2) + "01"), AbiError, "padding is not zero");
});
