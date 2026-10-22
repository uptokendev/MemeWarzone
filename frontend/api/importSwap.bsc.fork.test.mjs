// Fork proof of the swap widget's BNB Chain import route (api/widgetSwapEvm.js evmWidgetBuildCore -> api/importSwap.js
// bscQuote / bscBuild, KyberSwap) on a LOCAL anvil fork of BNB Chain mainnet. Kyber's public API quotes and builds
// (read-only HTTP, no key); every transaction goes to the local fork only, from a throwaway wallet funded with
// anvil_setBalance. buy -> sell: needsAllowance (approve the Kyber router, exact amount) -> sell.
// Checked per swap: the fee (the API's BNB rate, read off the call trace) goes to the API's fee receiver, the wallet
// gets its tokens / BNB, and evmFingerprint(to, input, value) of the landed transaction equals the recorded one.
// Skips without anvil, the public BNB RPC or the Kyber API.
//   node --test api/importSwap.bsc.fork.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";

import { ANVIL, startAnvilFork } from "./lib/evmGen8LocalChain.testkit.mjs";

// publicnode refuses fork reads of past blocks without a token ("archive requests"); blastapi serves them.
const RPC = process.env.BSC_FORK_RPC || "https://bsc-mainnet.public.blastapi.io";
// A coin with deep PancakeSwap liquidity, standing in for an import (the route and the fee do not depend on the coin).
const TOKEN = (process.env.BSC_FORK_TOKEN || "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82").toLowerCase();
const PORT = Number(process.env.BSC_FORK_PORT || 8803);

async function reachable() {
  try {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(8000) });
    if (Number(BigInt((await res.json()).result)) !== 56) return false;
    const kyber = await fetch("https://aggregator-api.kyberswap.com/bsc/api/v1/routes?tokenIn=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&tokenOut=0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82&amountIn=1000000000000000", { headers: { "x-client-id": "memewarzone" }, signal: AbortSignal.timeout(8000) });
    return kyber.ok;
  } catch {
    return false;
  }
}

const skip = !fs.existsSync(ANVIL) ? "anvil missing" : !(await reachable()) ? "BNB RPC or Kyber API unreachable" : false;

test("BNB import route in the widget: API-built Kyber buy and sell on a fork pay the fee to the receiver, fingerprints match", { skip, timeout: 600_000 }, async (t) => {
  const fork = await startAnvilFork({ rpc: RPC, port: PORT, chainId: 56 });
  try {
    const provider = fork.provider();
    assert.ok(await provider.send("anvil_nodeInfo", []), "a local anvil node, never a real chain");
    const { evmWidgetBuildCore } = await import("./widgetSwapEvm.js");
    const { bscQuote, importSwapFeeBps, KYBER_ROUTER } = await import("./importSwap.js");
    const { evmFingerprint } = await import("./lib/importSwapFingerprint.js");
    const feeBps = BigInt(importSwapFeeBps(56));
    const receiver = String(process.env.IMPORT_SWAP_FEE_RECEIVER_56 || "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c").toLowerCase();

    const recorded = [];
    const deps = {
      getProvider: async () => provider,
      gen8Refusal: async () => null,
      readPartner: async (id) => (id === "testpartner" ? { id } : null),
      rememberPartnerSwap: async (row) => recorded.push(row),
    };
    const wallet = ethers.Wallet.createRandom().connect(provider);
    await provider.send("anvil_setBalance", [wallet.address, ethers.toBeHex(ethers.parseEther("1"))]);
    const coin = new ethers.Contract(TOKEN, ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"], provider);

    const send = async (tx) => {
      const estimate = await provider.estimateGas({ from: wallet.address, to: tx.to, data: tx.data, value: BigInt(tx.value || "0") });
      const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || "0"), gasLimit: (estimate * 13n) / 10n });
      const receipt = await sent.wait();
      assert.equal(receipt.status, 1);
      return receipt;
    };
    // Every native call into the fee receiver inside the transaction (the receiver may forward part, so not its balance).
    const feePaid = async (hash) => {
      const trace = await provider.send("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
      let total = 0n;
      const walk = (call) => {
        if (String(call.to || "").toLowerCase() === receiver && call.value) total += BigInt(call.value);
        for (const child of call.calls || []) walk(child);
      };
      walk(trace);
      return total;
    };

    // BUY 0.01 BNB
    const buyIn = ethers.parseEther("0.01");
    const buyQuote = await bscQuote({ token: TOKEN, side: "buy", amountRaw: buyIn });
    const built = await evmWidgetBuildCore({ chainId: 56, token: TOKEN, side: "buy", wallet: wallet.address, quote: buyQuote.quote, slippageBps: 300, partner: "testpartner" }, deps);
    assert.equal(built.to, KYBER_ROUTER);
    const t0 = await coin.balanceOf(wallet.address);
    const buyReceipt = await send(built);
    const t1 = await coin.balanceOf(wallet.address);
    const buyFee = await feePaid(buyReceipt.hash);
    assert.equal(buyFee, (buyIn * feeBps) / 10_000n, "the fee receiver got exactly the API's rate of the BNB in");
    assert.ok(t1 > t0, "tokens received");
    const landedBuy = await provider.getTransaction(buyReceipt.hash);
    assert.equal(evmFingerprint(landedBuy.to, landedBuy.data, landedBuy.value), recorded[0]?.fingerprint, "landed buy = recorded fingerprint");

    // SELL half: the API first asks for the exact approval to the Kyber router
    const sellIn = (t1 - t0) / 2n;
    const sellQuote = await bscQuote({ token: TOKEN, side: "sell", amountRaw: sellIn });
    const setup = await evmWidgetBuildCore({ chainId: 56, token: TOKEN, side: "sell", wallet: wallet.address, quote: sellQuote.quote, slippageBps: 300, partner: "testpartner" }, deps);
    assert.equal(setup.needsAllowance, true);
    assert.equal(setup.permit2Approval, null);
    assert.equal(recorded.length, 1, "the allowance answer records nothing");
    await send(setup.approval);
    const sellQuote2 = await bscQuote({ token: TOKEN, side: "sell", amountRaw: sellIn });
    const sellBuilt = await evmWidgetBuildCore({ chainId: 56, token: TOKEN, side: "sell", wallet: wallet.address, quote: sellQuote2.quote, slippageBps: 300, partner: "testpartner" }, deps);
    assert.equal(sellBuilt.needsAllowance, undefined);
    const e2 = await provider.getBalance(wallet.address);
    const sellReceipt = await send(sellBuilt);
    const e3 = await provider.getBalance(wallet.address);
    const received = e3 - e2 + sellReceipt.gasUsed * sellReceipt.gasPrice;
    const sellFee = await feePaid(sellReceipt.hash);
    const gross = received + sellFee;
    const expected = (gross * feeBps) / 10_000n;
    assert.ok(sellFee > 0n && (sellFee - expected <= 1n && expected - sellFee <= 1n), `sell fee ${sellFee} = the API's rate of the gross ${gross} (+-1 wei)`);
    const landedSell = await provider.getTransaction(sellReceipt.hash);
    assert.equal(evmFingerprint(landedSell.to, landedSell.data, landedSell.value), recorded[1]?.fingerprint, "landed sell = recorded fingerprint");

    t.diagnostic(`fork of 56 at ${fork.forkBlock}, ${await coin.symbol().catch(() => "?")} ${TOKEN}, fee ${feeBps} bps to ${receiver}`);
    t.diagnostic(`buy  ${buyReceipt.hash} fee ${ethers.formatEther(buyFee)} BNB`);
    t.diagnostic(`sell ${sellReceipt.hash} fee ${ethers.formatEther(sellFee)} BNB of ${ethers.formatEther(gross)} gross`);
  } finally {
    await fork.stop();
  }
});
