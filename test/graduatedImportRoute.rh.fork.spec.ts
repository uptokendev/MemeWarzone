/**
 * Graduated MemeWarzone coins trade through the import route (founder, 2026-10-09), Robinhood 4663 proof on a local
 * anvil fork. No gen-6 coin has graduated on 4663 (the gen-6 factory 0xc673B116 has one campaign), so the real gen-6
 * coin MWZRH is graduated on the fork exactly as test/RobinhoodV3NativeSwapAdapterV2.rh.fork.spec.ts does
 * (factory impersonated for setRequireAuthorizedTrading(false), one buy to the target, graduate()). Then, with the app's
 * own code:
 *   1. graduatedEvmTradeRoute.mjs: "bonding" before graduation; after it "import" with the split Universal Router terms
 *      (IMPORT_FEE_VAULT_4663 = IMPORT_SWAP_FEE_RECEIVER_4663 = the fork ImportFeeVault) and "direct-pool" without.
 *   2. robinhoodImportSwap.mjs (resolveImportPool, quoteImportSwap4663, executeImportSwap4663: what ImportedTradePanel
 *      runs): the import route picks the coin's own graduated pool; buy and sell each pay exactly 1% to the vault (one
 *      Deposit, from = Universal Router); the quote passes assertGraduatedImportQuote; the pool's Swap log is in the
 *      trader's own transaction (tx.from = trader: what the pool indexer credits).
 * Nothing is sent to Robinhood Chain.
 *
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8646 --accounts 0 --no-rate-limit
 *   npx hardhat test test/graduatedImportRoute.rh.fork.spec.ts --network robinhoodForkRehearsal
 * The public RPC keeps ~5,000 blocks of state, so run it right after starting anvil.
 */
import { expect } from "chai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { assertLocalFork } from "../scripts/lib/forkRehearsal";
import { deployVaultOnFork, freshWallet, gasCost, impersonate, rpc, vaultDeposits } from "./helpers/importFeeVaultFork";

const GEN6_FACTORY = "0xc673B116b4eA8E8923Aad1fa60F0452966F2437F";
const MWZRH_CAMPAIGN = "0x404D723dAbab33F0303d9fD26fA36936a87627F8";
const MWZRH_TOKEN = "0x3765d71619C2ddf1d20fB85827754AfADf359389";
const BPS = 100n;
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const lib = (rel: string) => esmImport(pathToFileURL(path.resolve(__dirname, "..", "frontend", rel)).href);

const CAMPAIGN_ABI = [
  "function setRequireAuthorizedTrading(bool)",
  "function graduationNativeTarget() view returns (uint256)",
  "function netRaisedWei() view returns (uint256)",
  "function buyExactBnb(uint256 minTokensOut) payable returns (uint256,uint256)",
  "function graduationPending() view returns (bool)",
  "function launched() view returns (bool)",
  "function graduate() returns (address)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");

const d = network.name === "robinhoodForkRehearsal" ? describe : describe.skip;

d("Graduated gen-6 Robinhood coin (MWZRH, graduated on the fork) trades through the import route: exactly 1% to ImportFeeVault", function () {
  this.timeout(1_800_000);
  let route: any;
  let m: any;
  let vault: any;
  let vaultAddress: string;
  let appEnv: Record<string, string>;
  let pool: { pool: string; fee: number; liquidity: bigint };
  const rows: string[] = [];
  const balance = (a: string) => new ethers.Contract(MWZRH_TOKEN, ERC20_ABI, ethers.provider).balanceOf(a) as Promise<bigint>;

  before(async function () {
    const fork = await assertLocalFork(4663);
    rows.push(`fork of 4663 at block ${fork.forkBlock}`);
    route = await lib("src/lib/graduatedEvmTradeRoute.mjs");
    m = await lib("src/lib/robinhoodImportSwap.mjs");
    ({ vault, vaultAddress } = await deployVaultOnFork(4663));
    appEnv = { VITE_IMPORT_FEE_VAULT_4663: vaultAddress, VITE_IMPORT_SWAP_FEE_RECEIVER_4663: vaultAddress };
    expect(await ethers.provider.getBalance(m.UNIVERSAL_ROUTER_4663)).to.equal(0n);
    rows.push(`ImportFeeVault ${vaultAddress}`);
  });

  after(() => {
    for (const r of rows) console.log(`      ${r}`);
  });

  it("graduates MWZRH on the fork; the routing decision follows graduation and the switch; the import pool is its own", async function () {
    const campaign = new ethers.Contract(MWZRH_CAMPAIGN, CAMPAIGN_ABI, ethers.provider);
    expect(await campaign.launched()).to.equal(false);
    expect(route.graduatedEvmTradeRoute({ chainId: 4663, graduated: false }, appEnv)).to.equal("bonding");
    expect(await m.resolveImportPool(ethers.provider, MWZRH_TOKEN)).to.equal(null);

    const factorySigner = await impersonate(GEN6_FACTORY, "1");
    await (await (campaign.connect(factorySigner) as any).setRequireAuthorizedTrading(false)).wait();
    await rpc("anvil_stopImpersonatingAccount", [GEN6_FACTORY]);
    const target: bigint = await campaign.graduationNativeTarget();
    const need = target - (await campaign.netRaisedWei());
    const buyer = await freshWallet(ethers.formatEther(need * 2n + ethers.parseEther("1")));
    await (await (campaign.connect(buyer) as any).buyExactBnb(1n, { value: need + need / 10n + (need * 300n) / 10_000n })).wait();
    expect(await campaign.graduationPending()).to.equal(true);
    await (await (campaign.connect(buyer) as any).graduate({ gasLimit: 12_000_000 })).wait();
    expect(await campaign.launched()).to.equal(true);

    pool = await m.resolveImportPool(ethers.provider, MWZRH_TOKEN);
    expect(pool, "the graduated WETH pool").to.not.equal(null);
    rows.push(`MWZRH graduated (target ${ethers.formatEther(target)} ETH): V3 pool ${pool.pool} fee ${pool.fee} liquidity ${pool.liquidity}`);
    expect(route.graduatedEvmTradeRoute({ chainId: 4663, graduated: true }, appEnv)).to.equal("import");
    expect(route.graduatedEvmTradeRoute({ chainId: 4663, graduated: true }, {})).to.equal("direct-pool");
    // Vault named but the receiver still the old ProtocolRevenueVault: the old 0.5% terms, so not for graduates.
    expect(route.graduatedEvmTradeRoute({ chainId: 4663, graduated: true }, { VITE_IMPORT_FEE_VAULT_4663: vaultAddress })).to.equal("direct-pool");
  });

  it("buy and sell through the Universal Router with the app's module: one Deposit of exactly 1% each; tx.from = trader", async function () {
    const terms = m.importSwapFeeTerms4663(appEnv);
    expect(terms).to.deep.equal({ feeBps: 100, feeReceiver: ethers.getAddress(vaultAddress), creatorShareBps: 50, split: true });
    const trader = await freshWallet("2");

    // Buy 0.05 ETH
    const value = ethers.parseEther("0.05");
    const qb = route.assertGraduatedImportQuote(await m.quoteImportSwap4663({ provider: ethers.provider, token: MWZRH_TOKEN, side: "buy", amountIn: value, slippageBps: 100, terms }));
    expect(qb.route.pool).to.equal(pool.pool);
    expect(qb.feeWei).to.equal((value * BPS) / 10_000n);
    const t0 = await balance(trader.address);
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const b0 = await ethers.provider.getBalance(trader.address);
    const rcBuy = await m.executeImportSwap4663({ signer: trader, quote: qb, token: MWZRH_TOKEN });
    const bought = (await balance(trader.address)) - t0;
    expect(bought).to.equal(qb.amountOut);
    const buyDeposits = vaultDeposits(vault, rcBuy);
    expect(buyDeposits.length).to.equal(1);
    expect(buyDeposits[0].from).to.equal(m.UNIVERSAL_ROUTER_4663);
    expect(buyDeposits[0].amount).to.equal((value * BPS) / 10_000n);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(buyDeposits[0].amount);
    expect(b0 - (await ethers.provider.getBalance(trader.address))).to.equal(value + gasCost(rcBuy));
    expect(rcBuy.from).to.equal(trader.address);
    expect(rcBuy.logs.filter((l: any) => l.address.toLowerCase() === pool.pool.toLowerCase() && l.topics[0] === V3_SWAP_TOPIC).length).to.equal(1);
    rows.push(`buy 0.05 ETH: vault Deposit ${buyDeposits[0].amount} wei (= 1%) from Universal Router, ${ethers.formatEther(bought)} MWZRH, pool Swap in tx from ${rcBuy.from}`);

    // Sell half of it (Permit2: the module's exact ERC20 approval to Permit2, then the signed permit inside the swap)
    const amountIn = bought / 2n;
    const qs = route.assertGraduatedImportQuote(await m.quoteImportSwap4663({ provider: ethers.provider, token: MWZRH_TOKEN, side: "sell", amountIn, slippageBps: 100, terms }));
    const s0 = await balance(trader.address);
    const sv0 = await ethers.provider.getBalance(vaultAddress);
    const sb0 = await ethers.provider.getBalance(trader.address);
    const blockBefore = await ethers.provider.getBlockNumber();
    const rcSell = await m.executeImportSwap4663({ signer: trader, quote: qs, token: MWZRH_TOKEN });
    expect(s0 - (await balance(trader.address))).to.equal(amountIn);
    const sellDeposits = vaultDeposits(vault, rcSell);
    expect(sellDeposits.length).to.equal(1);
    expect(sellDeposits[0].from).to.equal(m.UNIVERSAL_ROUTER_4663);
    expect(sellDeposits[0].amount).to.equal((qs.grossOut * BPS) / 10_000n, "1% of the gross ETH out (QuoterV2 on the same state)");
    expect((await ethers.provider.getBalance(vaultAddress)) - sv0).to.equal(sellDeposits[0].amount);
    // Wallet: gross - fee, minus the gas of the Permit2 approval (if one was sent) and of the swap.
    let gas = gasCost(rcSell);
    for (let b = blockBefore + 1; b < rcSell.blockNumber; b++) {
      const block = await ethers.provider.getBlock(b, true);
      for (const hash of block!.transactions) {
        const rc = await ethers.provider.getTransactionReceipt(hash);
        if (rc!.from === trader.address) gas += gasCost(rc);
      }
    }
    expect((await ethers.provider.getBalance(trader.address)) - sb0 + gas).to.equal(qs.grossOut - sellDeposits[0].amount);
    expect(rcSell.from).to.equal(trader.address);
    expect(rcSell.logs.filter((l: any) => l.address.toLowerCase() === pool.pool.toLowerCase() && l.topics[0] === V3_SWAP_TOPIC).length).to.equal(1);
    expect(await ethers.provider.getBalance(m.UNIVERSAL_ROUTER_4663)).to.equal(0n);
    rows.push(`sell ${ethers.formatEther(amountIn)} MWZRH: gross ${qs.grossOut} wei, vault Deposit ${sellDeposits[0].amount} wei (= 1% of gross) from Universal Router, trader gets ${qs.grossOut - sellDeposits[0].amount}`);
  });
});
