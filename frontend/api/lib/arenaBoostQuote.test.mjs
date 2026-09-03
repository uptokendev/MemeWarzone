import assert from "node:assert/strict";
import test from "node:test";
import { verifyTypedData, Wallet } from "ethers";

import {
  BOOST_USD_MICROS,
  buildBoostQuote,
  readBoostPricingConfig,
  serializeSignedBoostQuote,
  signBoostQuote,
  unitPriceNativeRawFromUsdMicros,
} from "./arenaBoostQuote.mjs";

test("one Boost prices to at least one USD with ceiling raw-native rounding", () => {
  const nativeUsdMicros = 600_000_000n; // $600/native
  const raw = unitPriceNativeRawFromUsdMicros({ nativeUsdMicros });
  assert.equal(raw, 1_666_666_666_666_667n);
  assert.ok(raw * nativeUsdMicros >= BOOST_USD_MICROS * 10n ** 18n);
  assert.ok((raw - 1n) * nativeUsdMicros < BOOST_USD_MICROS * 10n ** 18n);
});

test("quote units multiply exactly without floating point", () => {
  const quote = buildBoostQuote({
    chainId: 56,
    treasuryAddress: "0x1111111111111111111111111111111111111111",
    poolId: `0x${"22".repeat(32)}`,
    matchId: `0x${"00".repeat(32)}`,
    roundNumber: 0,
    booster: "0x3333333333333333333333333333333333333333",
    sideToken: "0x4444444444444444444444444444444444444444",
    boostUnits: 7,
    nativeUsdMicros: 600_000_000n,
    pricingVersion: 3,
    oracleTimestamp: 1_800_000_000,
    nonce: 99,
    deadline: 1_800_000_300,
  });
  assert.equal(quote.value.boostUnits, 7n);
  assert.equal(quote.value.grossNativeRaw, quote.value.unitPriceNativeRaw * 7n);
  assert.equal(quote.value.pricingVersion, 3n);
});

test("pricing config fails closed when money-path inputs are absent or signer mismatches", () => {
  assert.throws(() => readBoostPricingConfig(56, {}), /not configured/);

  const wallet = Wallet.createRandom();
  const env = {
    ARENA_BOOST_NATIVE_USD_MICROS_56: "600000000",
    ARENA_BOOST_PRICING_VERSION_56: "2",
    ARENA_WAR_POOL_TREASURY_V2_ADDRESS_56: "0x1111111111111111111111111111111111111111",
    ARENA_BOOST_QUOTE_SIGNER_PRIVATE_KEY: wallet.privateKey,
    ARENA_BOOST_QUOTE_SIGNER_ADDRESS_56: "0x2222222222222222222222222222222222222222",
  };
  assert.throws(() => readBoostPricingConfig(56, env), /key\/address mismatch/);
});

test("signed quote recovers configured signer and serialization preserves integer strings", async () => {
  const wallet = Wallet.createRandom();
  const config = readBoostPricingConfig(56, {
    ARENA_BOOST_NATIVE_USD_MICROS_56: "600000000",
    ARENA_BOOST_PRICING_VERSION_56: "5",
    ARENA_WAR_POOL_TREASURY_V2_ADDRESS_56: "0x1111111111111111111111111111111111111111",
    ARENA_BOOST_QUOTE_SIGNER_PRIVATE_KEY: wallet.privateKey,
    ARENA_BOOST_QUOTE_SIGNER_ADDRESS_56: wallet.address,
  });
  const signed = await signBoostQuote(config, {
    poolId: `0x${"22".repeat(32)}`,
    matchId: `0x${"00".repeat(32)}`,
    roundNumber: 0,
    booster: "0x3333333333333333333333333333333333333333",
    sideToken: "0x4444444444444444444444444444444444444444",
    boostUnits: 12,
    oracleTimestamp: 1_800_000_000,
    nonce: 12345,
    deadline: 1_800_000_300,
  });
  assert.equal(verifyTypedData(signed.domain, signed.types, signed.value, signed.signature), wallet.address);
  const serialized = serializeSignedBoostQuote(signed);
  assert.equal(serialized.value.boostUnits, "12");
  assert.equal(serialized.value.grossNativeRaw, (signed.value.unitPriceNativeRaw * 12n).toString());
  assert.equal(serialized.nativeUsdMicros, "600000000");
});
