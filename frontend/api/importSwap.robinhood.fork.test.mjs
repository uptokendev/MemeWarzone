// Fork proof of the swap widget's Robinhood import route (api/widgetSwapEvm.js evmWidgetBuildCore ->
// api/importSwap.js robinhoodBuildCore) on a LOCAL anvil fork of Robinhood Chain mainnet. Nothing is sent to any real
// chain: a throwaway wallet is funded with anvil_setBalance on the fork only.
//   buy 0.01 ETH -> sell: needsAllowance (approve Permit2, Permit2.approve router) -> sell half
// Checked per swap: exactly the fee (1% of the ETH in, or of the gross ETH out) lands in the ImportFeeVault, the wallet
// gets its tokens / ETH, and evmFingerprint(to, input, value) of the landed transaction equals the fingerprint the
// build recorded for the partner. Skips without anvil or the public Robinhood RPC.
//   node --test api/importSwap.robinhood.fork.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";

import { ANVIL, startAnvilFork } from "./lib/evmGen8LocalChain.testkit.mjs";

const RPC = process.env.ROBINHOOD_FORK_RPC || "https://rpc.mainnet.chain.robinhood.com";
const VAULT = "0x41076e191509D4E307a8F8B40d432b9AaA36F953";
const ENV = { IMPORT_FEE_VAULT_4663: VAULT, IMPORT_SWAP_FEE_RECEIVER_4663: VAULT };
const CANDIDATES = ["0xe7dec18b0b29c8e02fb90a5dce413b3bc66e8251", "0x1a95c10e4839033686225eaad3ac348f0d8edc4f"];
const PORT = Number(process.env.ROBINHOOD_FORK_PORT || 8802);

async function rpcUp() {
  try {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(8000) });
    return Number(BigInt((await res.json()).result)) === 4663;
  } catch {
    return false;
  }
}

const skip = !fs.existsSync(ANVIL) ? "anvil missing" : !(await rpcUp()) ? "Robinhood RPC unreachable" : false;

test("Robinhood import route in the widget: API-built buy and sell on a fork pay exactly the fee to the ImportFeeVault, fingerprints match", { skip, timeout: 600_000 }, async (t) => {
  const fork = await startAnvilFork({ rpc: RPC, port: PORT, chainId: 4663 });
  try {
    const provider = fork.provider();
    assert.ok(await provider.send("anvil_nodeInfo", []), "a local anvil node, never a real chain");
    const { evmWidgetBuildCore } = await import("./widgetSwapEvm.js");
    const { robinhoodQuoteCore } = await import("./importSwap.js");
    const { evmFingerprint } = await import("./lib/importSwapFingerprint.js");
    const { VAULT_DEPOSIT_TOPIC } = await import("./lib/financeImportSwapFees.js");
    const { resolveImportPool, importSwapFee } = await import("../src/lib/robinhoodImportSwap.mjs");
    assert.notEqual(await provider.getCode(VAULT), "0x", "the ImportFeeVault exists on the fork");

    let token = null;
    for (const candidate of CANDIDATES) {
      if (await resolveImportPool(provider, candidate)) { token = candidate; break; }
    }
    if (!token) return t.skip("no candidate import has a WETH V3 pool at this block");

    const recorded = [];
    const deps = {
      env: ENV,
      getProvider: async () => provider,
      gen8Refusal: async () => null,
      readPartner: async (id) => (id === "testpartner" ? { id } : null),
      rememberPartnerSwap: async (row) => recorded.push(row),
    };
    const wallet = ethers.Wallet.createRandom().connect(provider);
    await provider.send("anvil_setBalance", [wallet.address, ethers.toBeHex(ethers.parseEther("1"))]);
    const coin = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"], provider);
    const symbol = await coin.symbol().catch(() => "?");

    const send = async (tx) => {
      const estimate = await provider.estimateGas({ from: wallet.address, to: tx.to, data: tx.data, value: BigInt(tx.value || "0") });
      const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || "0"), gasLimit: (estimate * 12n) / 10n });
      const receipt = await sent.wait();
      assert.equal(receipt.status, 1);
      return receipt;
    };
    const vaultDeposits = (receipt) => receipt.logs.filter((log) => log.address.toLowerCase() === VAULT.toLowerCase());

    // BUY 0.01 ETH
    const buyIn = ethers.parseEther("0.01");
    const quote = await robinhoodQuoteCore({ token, side: "buy", amountRaw: buyIn, slippage: 100 }, deps);
    const built = await evmWidgetBuildCore({ chainId: 4663, token, side: "buy", wallet: wallet.address, amountRaw: buyIn.toString(), slippageBps: 100, partner: "testpartner" }, deps);
    assert.equal(built.needsAllowance, undefined);
    const v0 = await provider.getBalance(VAULT);
    const t0 = await coin.balanceOf(wallet.address);
    const buyReceipt = await send(built);
    const v1 = await provider.getBalance(VAULT);
    const t1 = await coin.balanceOf(wallet.address);
    const buyFee = importSwapFee(buyIn, 100);
    assert.equal(v1 - v0, buyFee, "vault got exactly 1% of the ETH in");
    assert.ok(t1 - t0 >= BigInt(quote.minAmountOut), "tokens >= the quoted minimum");
    const landedBuy = await provider.getTransaction(buyReceipt.hash);
    assert.equal(recorded.length, 1);
    assert.equal(evmFingerprint(landedBuy.to, landedBuy.data, landedBuy.value), recorded[0].fingerprint, "landed buy = recorded fingerprint");
    const buyLogs = vaultDeposits(buyReceipt);

    // SELL half: first the API asks for the two one-time approvals, then builds the swap
    const sellIn = (t1 - t0) / 2n;
    const setup = await evmWidgetBuildCore({ chainId: 4663, token, side: "sell", wallet: wallet.address, amountRaw: sellIn.toString(), slippageBps: 100, partner: "testpartner" }, deps);
    assert.equal(setup.needsAllowance, true);
    assert.ok(setup.approval && setup.permit2Approval);
    assert.equal(recorded.length, 1, "the allowance answer records nothing");
    await send(setup.approval);
    await send(setup.permit2Approval);
    const sellBuilt = await evmWidgetBuildCore({ chainId: 4663, token, side: "sell", wallet: wallet.address, amountRaw: sellIn.toString(), slippageBps: 100, partner: "testpartner" }, deps);
    assert.equal(sellBuilt.needsAllowance, undefined);
    const v2 = await provider.getBalance(VAULT);
    const e2 = await provider.getBalance(wallet.address);
    const t2 = await coin.balanceOf(wallet.address);
    const sellReceipt = await send(sellBuilt);
    const v3 = await provider.getBalance(VAULT);
    const e3 = await provider.getBalance(wallet.address);
    const t3 = await coin.balanceOf(wallet.address);
    const sellFee = v3 - v2;
    const received = e3 - e2 + sellReceipt.gasUsed * sellReceipt.gasPrice;
    assert.equal(t2 - t3, sellIn, "exactly the sold tokens left the wallet");
    assert.equal(sellFee, importSwapFee(received + sellFee, 100), "vault got exactly 1% of the gross ETH out");
    assert.ok(received >= BigInt(sellBuilt.quote.minAmountOut), "ETH received >= the quoted minimum after the fee");
    const landedSell = await provider.getTransaction(sellReceipt.hash);
    assert.equal(recorded.length, 2);
    assert.equal(evmFingerprint(landedSell.to, landedSell.data, landedSell.value), recorded[1].fingerprint, "landed sell = recorded fingerprint");
    const sellLogs = vaultDeposits(sellReceipt);

    // The vault's Deposit(from, amount, balance): from = the Universal Router, amount = the fee (what the scanner reads).
    const depositOf = (logs) => logs.filter((log) => log.topics[0] === VAULT_DEPOSIT_TOPIC).map((log) => ({ from: ethers.getAddress(ethers.dataSlice(log.topics[1], 12)), amount: BigInt(ethers.dataSlice(log.data, 0, 32)) }));
    const ur = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
    assert.deepEqual(depositOf(buyLogs), [{ from: ur, amount: buyFee }]);
    assert.deepEqual(depositOf(sellLogs), [{ from: ur, amount: sellFee }]);
    const describe = (logs) => logs.map((log) => (log.topics[0] === VAULT_DEPOSIT_TOPIC ? `Deposit(from ${ethers.getAddress(ethers.dataSlice(log.topics[1] || ethers.ZeroHash, 12))})` : log.topics[0])).join(", ") || "no vault event";
    t.diagnostic(`fork of 4663 at ${fork.forkBlock}, coin ${symbol} ${token}`);
    t.diagnostic(`buy  ${buyReceipt.hash} gas ${buyReceipt.gasUsed} fee ${ethers.formatEther(buyFee)} ETH, tokens ${t1 - t0}, vault: ${describe(buyLogs)}`);
    t.diagnostic(`sell ${sellReceipt.hash} gas ${sellReceipt.gasUsed} fee ${ethers.formatEther(sellFee)} ETH of ${ethers.formatEther(received + sellFee)} gross, vault: ${describe(sellLogs)}`);
    t.diagnostic(`fingerprints ${recorded.map((r) => r.fingerprint).join(" ")}`);
  } finally {
    await fork.stop();
  }
});
