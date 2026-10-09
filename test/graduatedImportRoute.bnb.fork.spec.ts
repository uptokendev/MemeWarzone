/**
 * Graduated MemeWarzone coins trade through the import route (founder, 2026-10-09), BNB 56 proof on a local anvil fork.
 * No MemeWarzone coin has graduated on BNB mainnet (gen-6 factory 0x1948411B has one campaign, MWZBNB, still bonding;
 * the gen-3 / legacy factories have one bonding campaign each, read 2026-10-09), so the real gen-6 coin MWZBNB is
 * graduated on the fork: the factory is impersonated to open unsigned trading (setRequireAuthorizedTrading(false), the
 * Safe's exit path), one buy reaches the target, graduate() creates its Topaz V2 pool. Then, with the app's own code:
 *   1. graduatedEvmTradeRoute.mjs: "bonding" before graduation; after it "import" with the vault configured and
 *      "direct-pool" without (switch off = today's behaviour).
 *   2. importSwap.js's own quote handler (1% switch on: IMPORT_FEE_VAULT_56 = IMPORT_SWAP_FEE_RECEIVER_56 = the fork
 *      vault): Kyber quotes live mainnet, where this pool does not exist, so it answers IMPORT_SWAP_NO_ROUTE, the
 *      code ImportedTradePanel falls back on to the Topaz pool through ImportSwapFeeRouter.
 *   3. importSwapFeeRouter.mjs (quoteFeeRouterTrade + executeFeeRouterTrade, what ImportedTradePanel runs) on the
 *      coin's graduated pool, deployed unchanged by scripts/deploy-import-fee-vault.ts: buy and sell each pay exactly
 *      1% to the ImportFeeVault (one Deposit, from = router), the quote passes assertGraduatedImportQuote, and the
 *      pool's Swap log is in the trader's own transaction (tx.from = trader: what the pool indexers credit).
 * Nothing is sent to BNB Chain; Kyber is called read-only over HTTP.
 *
 *   anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id 56 --port 8645 --accounts 0 --no-rate-limit
 *   npx hardhat test test/graduatedImportRoute.bnb.fork.spec.ts --network bscForkRehearsal
 */
import { expect } from "chai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { assertLocalFork } from "../scripts/lib/forkRehearsal";
import { deployVaultOnFork, freshWallet, gasCost, impersonate, rpc, vaultDeposits } from "./helpers/importFeeVaultFork";

const GEN6_FACTORY = "0x1948411B84424f6f67fDf83ce4A9b8ED49c8bF4F";
const MWZBNB_CAMPAIGN = "0x49AC80f9ccb0B4B88c2d98671A04cb146c0c6eb3";
const MWZBNB_TOKEN = "0x5D5Bea013f38B32Fdb2DEeb89F99158b9729F54A";
const TOPAZ_ROUTER = "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3";
const BPS = 100n;
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
const lib = (rel: string, query = "") => esmImport(pathToFileURL(path.resolve(__dirname, "..", "frontend", rel)).href + query);

const CAMPAIGN_ABI = [
  "function setRequireAuthorizedTrading(bool)",
  "function graduationNativeTarget() view returns (uint256)",
  "function netRaisedWei() view returns (uint256)",
  "function buyExactBnb(uint256 minTokensOut) payable returns (uint256,uint256)",
  "function graduationPending() view returns (bool)",
  "function launched() view returns (bool)",
  "function graduate() returns (address)",
  "function getGraduationState() view returns (address dexPair,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
];
const TOPAZ_ABI = ["function weth() view returns (address)", "function defaultFactory() view returns (address)"];
const FACTORY_ABI = ["function getPool(address tokenA, address tokenB, bool stable) view returns (address)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];
const SWAP_TOPIC = ethers.id("Swap(address,address,uint256,uint256,uint256,uint256)");

async function callHandler(handler: any, body: unknown) {
  let status = 0;
  let payload = "";
  const res = { statusCode: 0, setHeader() {}, end(s: string) { payload = s; status = this.statusCode; } } as any;
  await handler({ method: "POST", body }, res);
  return { status, body: JSON.parse(payload) };
}

const d = network.name === "bscForkRehearsal" ? describe : describe.skip;

d("Graduated gen-6 BNB coin (MWZBNB, graduated on the fork) trades through the import route: exactly 1% to ImportFeeVault", function () {
  this.timeout(1_800_000);
  let route: any;
  let feeRouterLib: any;
  let vault: any;
  let vaultAddress: string;
  let routerAddress: string;
  let factory: string;
  let wbnb: string;
  let pair: string;
  let trader: any;
  const rows: string[] = [];
  const balance = (a: string) => new ethers.Contract(MWZBNB_TOKEN, ERC20_ABI, ethers.provider).balanceOf(a) as Promise<bigint>;

  before(async function () {
    const fork = await assertLocalFork(56);
    rows.push(`fork of 56 at block ${fork.forkBlock}`);
    route = await lib("src/lib/graduatedEvmTradeRoute.mjs");
    feeRouterLib = await lib("src/lib/importSwapFeeRouter.mjs");
    const out = await deployVaultOnFork(56, { withTopazRouter: true });
    ({ vault, vaultAddress } = out);
    routerAddress = out.record.importSwapFeeRouter.address;
    const topaz = new ethers.Contract(TOPAZ_ROUTER, TOPAZ_ABI, ethers.provider);
    factory = await topaz.defaultFactory();
    wbnb = await topaz.weth();
    rows.push(`ImportFeeVault ${vaultAddress}, ImportSwapFeeRouter ${routerAddress} (Topaz factory ${factory})`);
  });

  after(() => {
    for (const r of rows) console.log(`      ${r}`);
  });

  it("graduates MWZBNB on the fork; the routing decision follows graduation and the switch", async function () {
    const appEnv = { VITE_IMPORT_FEE_VAULT_56: vaultAddress, VITE_IMPORT_SWAP_FEE_ROUTER_56: routerAddress };
    const campaign = new ethers.Contract(MWZBNB_CAMPAIGN, CAMPAIGN_ABI, ethers.provider);
    expect(await campaign.launched()).to.equal(false);
    expect(route.graduatedEvmTradeRoute({ chainId: 56, graduated: await campaign.launched() }, appEnv)).to.equal("bonding");

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
    const [dexPair] = await campaign.getGraduationState();
    pair = await new ethers.Contract(factory, FACTORY_ABI, ethers.provider).getPool(MWZBNB_TOKEN, wbnb, false);
    expect(pair).to.equal(dexPair, "the graduated pool is the Topaz default-factory WBNB pool arenaImportedTopaz.ts resolves");
    rows.push(`MWZBNB graduated (target ${ethers.formatEther(target)} BNB): Topaz pair ${pair}`);

    expect(route.graduatedEvmTradeRoute({ chainId: 56, graduated: true }, appEnv)).to.equal("import");
    expect(route.graduatedEvmTradeRoute({ chainId: 56, graduated: true }, {})).to.equal("direct-pool");
  });

  it("importSwap.js (1% switch on) has no Kyber route for the fork-only pool: IMPORT_SWAP_NO_ROUTE, the fee-router fallback", async function () {
    const saved = { ...process.env };
    try {
      delete process.env.IMPORT_SWAP_FEE_BPS;
      process.env.IMPORT_FEE_VAULT_56 = vaultAddress;
      process.env.IMPORT_SWAP_FEE_RECEIVER_56 = vaultAddress;
      const api = await lib("api/importSwap.js", "?graduated");
      expect(api.importSwapFeeBps(56)).to.equal(100);
      const quote = await callHandler(api.importSwapQuote, { chainId: 56, side: "buy", token: MWZBNB_TOKEN, amountRaw: ethers.parseEther("0.1").toString() });
      rows.push(`Kyber quote for MWZBNB: HTTP ${quote.status} ${quote.body.code} (${quote.body.error})`);
      expect(quote.status).to.equal(422);
      expect(quote.body.code).to.equal("IMPORT_SWAP_NO_ROUTE");
    } finally {
      process.env = saved;
    }
  });

  it("buy and sell through ImportSwapFeeRouter with the app's module: one Deposit of exactly 1% each; tx.from = trader", async function () {
    trader = await freshWallet("2");
    const resolved = { routerAddress: TOPAZ_ROUTER, factoryAddress: factory, wrappedNativeAddress: wbnb, tokenAddress: MWZBNB_TOKEN, pairAddress: pair, route: [{ from: wbnb, to: MWZBNB_TOKEN, stable: false, factory }] };

    // Buy 0.1 BNB
    const value = ethers.parseEther("0.1");
    const qb = route.assertGraduatedImportQuote(await feeRouterLib.quoteFeeRouterTrade({ provider: ethers.provider, routerAddress, resolved, side: "buy", amountIn: value, slippageBps: 100 }));
    expect(qb.feeBps).to.equal(100);
    expect(qb.creatorShareBps).to.equal(50);
    expect(qb.feeWei).to.equal((value * BPS) / 10_000n);
    const t0 = await balance(trader.address);
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const b0 = await ethers.provider.getBalance(trader.address);
    const buyHash = await feeRouterLib.executeFeeRouterTrade({ signer: trader, account: trader.address, quote: qb });
    const rcBuy = (await ethers.provider.getTransactionReceipt(buyHash))!;
    expect(rcBuy.status).to.equal(1);
    const bought = (await balance(trader.address)) - t0;
    expect(bought).to.equal(qb.amountOut);
    const buyDeposits = vaultDeposits(vault, rcBuy);
    expect(buyDeposits.length).to.equal(1);
    expect(buyDeposits[0].from).to.equal(routerAddress);
    expect(buyDeposits[0].amount).to.equal((value * BPS) / 10_000n);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(buyDeposits[0].amount);
    expect(b0 - (await ethers.provider.getBalance(trader.address))).to.equal(value + gasCost(rcBuy));
    expect(rcBuy.from).to.equal(trader.address);
    expect(rcBuy.logs.filter((l: any) => l.address.toLowerCase() === pair.toLowerCase() && l.topics[0] === SWAP_TOPIC).length).to.equal(1);
    rows.push(`buy 0.1 BNB: vault Deposit ${buyDeposits[0].amount} wei (= 1%) from router, ${ethers.formatEther(bought)} MWZBNB, pool Swap in tx from ${rcBuy.from}`);

    // Sell half of it
    const amountIn = bought / 2n;
    const qs = route.assertGraduatedImportQuote(await feeRouterLib.quoteFeeRouterTrade({ provider: ethers.provider, routerAddress, resolved, side: "sell", amountIn, slippageBps: 100 }));
    // Exact approval first (what executeFeeRouterTrade would send itself), so the sell transaction alone moves the wallet.
    await (await new ethers.Contract(MWZBNB_TOKEN, ["function approve(address,uint256) returns (bool)"], trader).approve(routerAddress, amountIn)).wait();
    const s0 = await balance(trader.address);
    const sv0 = await ethers.provider.getBalance(vaultAddress);
    const sb0 = await ethers.provider.getBalance(trader.address);
    const sellHash = await feeRouterLib.executeFeeRouterTrade({ signer: trader, account: trader.address, quote: qs });
    const rcSell = (await ethers.provider.getTransactionReceipt(sellHash))!;
    expect(rcSell.status).to.equal(1);
    expect(s0 - (await balance(trader.address))).to.equal(amountIn);
    const router = await ethers.getContractAt("ImportSwapFeeRouter", routerAddress);
    const swap = rcSell.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "ImportSwap");
    const gross = BigInt(swap!.args.nativeGross);
    expect(gross).to.equal(qs.grossOut);
    const sellDeposits = vaultDeposits(vault, rcSell);
    expect(sellDeposits.length).to.equal(1);
    expect(sellDeposits[0].from).to.equal(routerAddress);
    expect(sellDeposits[0].amount).to.equal((gross * BPS) / 10_000n);
    expect((await ethers.provider.getBalance(vaultAddress)) - sv0).to.equal(sellDeposits[0].amount);
    expect((await ethers.provider.getBalance(trader.address)) - sb0 + gasCost(rcSell)).to.equal(gross - sellDeposits[0].amount);
    expect(rcSell.from).to.equal(trader.address);
    expect(rcSell.logs.filter((l: any) => l.address.toLowerCase() === pair.toLowerCase() && l.topics[0] === SWAP_TOPIC).length).to.equal(1);
    expect(await new ethers.Contract(MWZBNB_TOKEN, ERC20_ABI, ethers.provider).allowance(trader.address, routerAddress)).to.equal(0n);
    rows.push(`sell ${ethers.formatEther(amountIn)} MWZBNB: gross ${gross} wei, vault Deposit ${sellDeposits[0].amount} wei (= 1% of gross) from router, trader gets ${gross - sellDeposits[0].amount}`);
  });
});
