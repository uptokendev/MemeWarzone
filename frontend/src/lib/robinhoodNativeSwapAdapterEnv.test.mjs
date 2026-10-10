import assert from "node:assert/strict";
import test from "node:test";
import { robinhoodNativeSwapAdapterAddress } from "./robinhoodNativeSwapAdapterEnv.mjs";

const OLD_4663 = "0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296";
const OLD_46630 = "0x116f9Bfe4D6B40AdA206acf31B8067bAda137069";
const V2 = "0x00000000000000000000000000000000000000A2";

test("unset V2: today's lookup, chain-suffixed first, then the bare name", () => {
  const env = { VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_4663: OLD_4663, VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS: OLD_46630 };
  assert.equal(robinhoodNativeSwapAdapterAddress(env, 4663), OLD_4663);
  assert.equal(robinhoodNativeSwapAdapterAddress(env, 46630), OLD_46630);
  assert.equal(robinhoodNativeSwapAdapterAddress({}, 4663), "");
  assert.equal(robinhoodNativeSwapAdapterAddress(undefined, 4663), "");
});

test("V2 set for a chain: it wins on that chain only", () => {
  const env = {
    VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_4663: OLD_4663,
    VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_46630: OLD_46630,
    VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_4663: ` ${V2} `,
  };
  assert.equal(robinhoodNativeSwapAdapterAddress(env, 4663), V2);
  assert.equal(robinhoodNativeSwapAdapterAddress(env, 46630), OLD_46630);
});

test("empty V2 value and a bare V2 name are ignored", () => {
  const env = {
    VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_4663: OLD_4663,
    VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_4663: "  ",
    VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS: V2,
  };
  assert.equal(robinhoodNativeSwapAdapterAddress(env, 4663), OLD_4663);
});

test("DogeOS 6281971 reads only its own suffixed names, never Robinhood's unsuffixed adapter", () => {
  const DOGEOS_V2 = "0x00000000000000000000000000000000000000D2";
  const DOGEOS_OLD = "0x00000000000000000000000000000000000000D1";
  const robinhoodOnly = { VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS: OLD_46630 };
  assert.equal(robinhoodNativeSwapAdapterAddress(robinhoodOnly, 6281971), "");
  assert.equal(robinhoodNativeSwapAdapterAddress(robinhoodOnly, "6281971"), "");
  assert.equal(
    robinhoodNativeSwapAdapterAddress({ ...robinhoodOnly, VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_6281971: DOGEOS_OLD }, 6281971),
    DOGEOS_OLD,
  );
  assert.equal(
    robinhoodNativeSwapAdapterAddress(
      { ...robinhoodOnly, VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_6281971: DOGEOS_OLD, VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_6281971: DOGEOS_V2 },
      6281971,
    ),
    DOGEOS_V2,
  );
  // Robinhood keeps the bare-name fallback.
  assert.equal(robinhoodNativeSwapAdapterAddress(robinhoodOnly, 46630), OLD_46630);
});
