import assert from "node:assert/strict";
import test from "node:test";
import { evmFeeRoutingRegistry } from "./financeFeeRoutingEvm.js";

const VAULT = "0x1111111111111111111111111111111111111111";
const flowOf = (chainId, env) => evmFeeRoutingRegistry(chainId, env).flows.find((f) => f.id === "evm_import_swaps");

for (const chainId of [56, 4663]) {
  test(`chain ${chainId}: import flow unchanged while the 1% switch is off`, () => {
    for (const env of [{}, { [`IMPORT_FEE_VAULT_${chainId}`]: VAULT }, { [`IMPORT_FEE_VAULT_${chainId}`]: VAULT, [`IMPORT_SWAP_FEE_RECEIVER_${chainId}`]: "0x2222222222222222222222222222222222222222" }]) {
      assert.deepEqual(flowOf(chainId, env), flowOf(chainId, {}));
      assert.match(flowOf(chainId, env).totalFee, /^0\.5%/);
    }
  });

  test(`chain ${chainId}: with the vault switch on the flow says 1% to the vault, half to the creator`, () => {
    const f = flowOf(chainId, { [`IMPORT_FEE_VAULT_${chainId}`]: VAULT, [`IMPORT_SWAP_FEE_RECEIVER_${chainId}`]: VAULT.toUpperCase().replace("0X", "0x") });
    assert.match(f.totalFee, /^1% .*ImportFeeVault 0x1111/);
    assert.match(f.splits[0].share, /^0\.5% of the swap/);
    assert.match(f.notes[0], /creator/);
    assert.doesNotMatch(JSON.stringify(f), /—/);
  });
}
