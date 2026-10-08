/**
 * CO-IMP rev 2 CI4 proof on a local anvil fork of BNB 56: the audited ImportSwapFeeRouter deployed UNCHANGED by
 * scripts/deploy-import-fee-vault.ts (IMPORT_FEE_DEPLOY_TOPAZ_ROUTER=1) with protocolBps 100, creatorBps 0,
 * protocolReceiver = creatorReceiver = ImportFeeVault, v3Router 0, v2Router = Topaz 0x1E98c822, trading a REAL Topaz
 * volatile WBNB pool (the deepest one the Topaz factory lists, as arenaImportedTopaz.ts resolves it with
 * getPool(token, WBNB, false)). Proven to the wei, each against the same state (EVM snapshot):
 *   buyV2:  ONE vault Deposit (from = router) of value * 100 / 10_000; the recipient's tokens == a direct Topaz
 *           swapExactETHForTokens of (value - fee); minTokensOut = that amount passes, + 1 reverts InsufficientOutput
 *   sellV2: ONE vault Deposit (from = router) of gross * 100 / 10_000 where gross == a direct Topaz
 *           swapExactTokensForETH of the same tokens; the recipient gets gross - fee; minNativeOut = that passes, + 1 reverts
 *   ImportSwap(trader, token, 2, isBuy, nativeGross, feeProtocol, 0, tokenAmount, recipient); the router holds no
 *   native, token or WBNB afterwards.
 *
 *   anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id 56 --port 8645 --accounts 0 --no-rate-limit
 *   npx hardhat test test/ImportSwapFeeRouter.bnb-topaz.fork.spec.ts --network bscForkRehearsal
 * IMPORT_FEE_TOPAZ_TOKEN pins the coin (default: the Topaz volatile WBNB pool with the most WBNB).
 */
import { expect } from "chai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { assertLocalFork } from "../scripts/lib/forkRehearsal";
import { deployVaultOnFork, freshWallet, rpc, vaultDeposits } from "./helpers/importFeeVaultFork";

const TOPAZ_ROUTER = "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3";
const BPS = 100n;
const TOPAZ_ABI = [
  "function weth() view returns (address)",
  "function defaultFactory() view returns (address)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline)",
];
const FACTORY_ABI = [
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
];
const POOL_ABI = ["function token0() view returns (address)", "function token1() view returns (address)", "function stable() view returns (bool)", "function getReserves() view returns (uint256,uint256,uint256)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)"];

const d = network.name === "bscForkRehearsal" ? describe : describe.skip;

d("CI4: ImportSwapFeeRouter (100/0 bps, both receivers = ImportFeeVault) on a real Topaz pool (BSC fork)", function () {
  this.timeout(900_000);
  let vault: any;
  let vaultAddress: string;
  let router: any;
  let routerAddress: string;
  let topaz: any;
  let factory: string;
  let wbnb: string;
  let token: string;
  let trader: any;
  const results: Record<string, string> = {};
  const deadline = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600);
  const route = (from: string, to: string) => [{ from, to, stable: false, factory }];
  const bal = (t: string, a: string) => new ethers.Contract(t, ERC20_ABI, ethers.provider).balanceOf(a) as Promise<bigint>;

  before(async function () {
    const fork = await assertLocalFork(56);
    console.log(`      fork of 56 at block ${fork.forkBlock}`);
    const out = await deployVaultOnFork(56, { withTopazRouter: true });
    ({ vault, vaultAddress } = out);
    routerAddress = out.record.importSwapFeeRouter.address;
    router = await ethers.getContractAt("ImportSwapFeeRouter", routerAddress);
    topaz = new ethers.Contract(TOPAZ_ROUTER, TOPAZ_ABI, ethers.provider);
    factory = await topaz.defaultFactory();
    wbnb = await topaz.weth();
    expect(await router.protocolBps()).to.equal(100n);
    expect(await router.creatorBps()).to.equal(0n);
    expect(await router.protocolReceiver()).to.equal(vaultAddress);
    expect(await router.creatorReceiver()).to.equal(vaultAddress);
    expect(await router.v3Router()).to.equal(ethers.ZeroAddress);
    expect(await router.v2Factory()).to.equal(factory);

    const f = new ethers.Contract(factory, FACTORY_ABI, ethers.provider);
    if (process.env.IMPORT_FEE_TOPAZ_TOKEN) {
      token = ethers.getAddress(process.env.IMPORT_FEE_TOPAZ_TOKEN);
    } else {
      let best = { token: "", wbnb: 0n, pool: "" };
      const n = Number(await f.allPoolsLength());
      for (let i = 0; i < n; i++) {
        const p = new ethers.Contract(await f.allPools(i), POOL_ABI, ethers.provider);
        if (await p.stable()) continue;
        const [t0, t1] = [await p.token0(), await p.token1()];
        if (t0 !== wbnb && t1 !== wbnb) continue;
        const [r0, r1] = await p.getReserves();
        const w = t0 === wbnb ? r0 : r1;
        if (w > best.wbnb) best = { token: t0 === wbnb ? t1 : t0, wbnb: w, pool: await p.getAddress() };
      }
      token = best.token;
      console.log(`      Topaz volatile WBNB pool ${best.pool}: ${ethers.formatEther(best.wbnb)} WBNB`);
    }
    const pair = await f.getPool(token, wbnb, false);
    expect(pair).to.not.equal(ethers.ZeroAddress);
    let symbol = "?";
    try { symbol = await new ethers.Contract(token, ERC20_ABI, ethers.provider).symbol(); } catch {}
    results.token = `${symbol} ${token} pair ${pair}`;
    trader = await freshWallet("5");
  });

  after(() => {
    for (const [k, v] of Object.entries(results)) console.log(`      ${k}: ${v}`);
  });

  async function routerHoldsNothing() {
    expect(await ethers.provider.getBalance(routerAddress)).to.equal(0n);
    expect(await bal(token, routerAddress)).to.equal(0n);
    expect(await bal(wbnb, routerAddress)).to.equal(0n);
  }

  it("buyV2: one Deposit (from = router) of 1%; tokens == a direct Topaz swap of value - fee; min-out exact", async function () {
    const value = ethers.parseEther("0.05");
    const fee = (value * BPS) / 10_000n;
    const snap = await rpc("evm_snapshot");
    // Direct Topaz swap of (value - fee) to the same recipient, from the same state.
    const t0 = await bal(token, trader.address);
    await (await (topaz.connect(trader) as any).swapExactETHForTokensSupportingFeeOnTransferTokens(0, route(wbnb, token), trader.address, await deadline(), { value: value - fee })).wait();
    const direct = (await bal(token, trader.address)) - t0;
    await rpc("evm_revert", [snap]);
    expect(direct > 0n).to.equal(true);

    await expect((router.connect(trader) as any).buyV2(token, false, direct + 1n, trader.address, await deadline(), { value })).to.be.revertedWithCustomError(router, "InsufficientOutput");
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const tx = await (router.connect(trader) as any).buyV2(token, false, direct, trader.address, await deadline(), { value });
    const rc = await tx.wait();
    const got = (await bal(token, trader.address)) - t0;
    expect(got).to.equal(direct);
    const deposits = vaultDeposits(vault, rc);
    expect(deposits.length).to.equal(1);
    expect(deposits[0].from).to.equal(routerAddress);
    expect(deposits[0].amount).to.equal(fee);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(fee);
    await expect(tx).to.emit(router, "ImportSwap").withArgs(trader.address, token, 2, true, value, fee, 0n, direct, trader.address);
    await routerHoldsNothing();
    results.buy = `value ${value}, vault Deposit ${fee} from router, tokens ${got} == direct Topaz swap of ${value - fee}, gas ${rc.gasUsed}`;
  });

  it("sellV2: one Deposit (from = router) of 1% of the gross; recipient gets gross - fee; min-out exact", async function () {
    const amountIn = (await bal(token, trader.address)) / 2n;
    const recipient = ethers.Wallet.createRandom().address; // holds nothing and pays no gas: its delta is the payout
    const erc20 = new ethers.Contract(token, ERC20_ABI, trader);
    await (await erc20.approve(TOPAZ_ROUTER, amountIn)).wait();
    await (await erc20.approve(routerAddress, amountIn)).wait();
    const snap = await rpc("evm_snapshot");
    await (await (topaz.connect(trader) as any).swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, 0, route(token, wbnb), recipient, await deadline())).wait();
    const gross = await ethers.provider.getBalance(recipient);
    await rpc("evm_revert", [snap]);
    expect(gross > 0n).to.equal(true);
    const fee = (gross * BPS) / 10_000n;
    const net = gross - fee;

    await expect((router.connect(trader) as any).sellV2(token, false, amountIn, net + 1n, recipient, await deadline())).to.be.revertedWithCustomError(router, "InsufficientOutput");
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const t0 = await bal(token, trader.address);
    const tx = await (router.connect(trader) as any).sellV2(token, false, amountIn, net, recipient, await deadline());
    const rc = await tx.wait();
    expect(t0 - (await bal(token, trader.address))).to.equal(amountIn);
    expect(await ethers.provider.getBalance(recipient)).to.equal(net);
    const deposits = vaultDeposits(vault, rc);
    expect(deposits.length).to.equal(1);
    expect(deposits[0].from).to.equal(routerAddress);
    expect(deposits[0].amount).to.equal(fee);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(fee);
    await expect(tx).to.emit(router, "ImportSwap").withArgs(trader.address, token, 2, false, gross, fee, 0n, amountIn, recipient);
    await routerHoldsNothing();
    results.sell = `tokens ${amountIn}, gross ${gross} (== direct Topaz swap), vault Deposit ${fee} from router, recipient ${net}, gas ${rc.gasUsed}`;
  });

  it("the app's module (importSwapFeeRouter.mjs) trades it: 0-slippage minimums are exact; finance attributes from the real ImportSwap", async function () {
    const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
    const lib = await esmImport(pathToFileURL(path.resolve(__dirname, "..", "frontend", "src", "lib", "importSwapFeeRouter.mjs")).href);
    const fin = await esmImport(pathToFileURL(path.resolve(__dirname, "..", "frontend", "api", "lib", "financeImportSwapFees.js")).href);
    // The shape resolveImportedTopazRoute returns (arenaImportedTopaz.ts), volatile pool.
    const resolved = { routerAddress: TOPAZ_ROUTER, factoryAddress: factory, wrappedNativeAddress: wbnb, tokenAddress: token, route: [{ from: wbnb, to: token, stable: false, factory }] };
    const nowSeconds = (await ethers.provider.getBlock("latest"))!.timestamp;
    const value = ethers.parseEther("0.02");
    const qb = await lib.quoteFeeRouterTrade({ provider: ethers.provider, routerAddress, resolved, side: "buy", amountIn: value, slippageBps: 0, nowSeconds });
    expect(qb.feeBps).to.equal(100);
    expect(qb.feeWei).to.equal((value * BPS) / 10_000n);
    expect(qb.minOut).to.equal(qb.amountOut);
    const t0 = await bal(token, trader.address);
    const buyHash = await lib.executeFeeRouterTrade({ signer: trader, account: trader.address, quote: qb });
    const rcBuy = (await ethers.provider.getTransactionReceipt(buyHash))!;
    expect((await bal(token, trader.address)) - t0).to.equal(qb.amountOut);
    expect(vaultDeposits(vault, rcBuy).map((d: any) => d.amount)).to.deep.equal([qb.feeWei]);

    const amountIn = (await bal(token, trader.address)) / 3n;
    const qs = await lib.quoteFeeRouterTrade({ provider: ethers.provider, routerAddress, resolved, side: "sell", amountIn, slippageBps: 0, nowSeconds });
    expect(qs.minOut).to.equal(qs.amountOut);
    const sellHash = await lib.executeFeeRouterTrade({ signer: trader, account: trader.address, quote: qs });
    const rcSell = (await ethers.provider.getTransactionReceipt(sellHash))!;
    expect(vaultDeposits(vault, rcSell).map((d: any) => d.amount)).to.deep.equal([qs.feeWei]);
    const swap = rcSell.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "ImportSwap");
    expect(swap!.args.nativeGross).to.equal(qs.grossOut);
    expect(await new ethers.Contract(token, ["function allowance(address,address) view returns (uint256)"], ethers.provider).allowance(trader.address, routerAddress)).to.equal(0n, "exact approval, nothing left standing");

    // Finance: the split source with the router as payer reads both Deposits and attributes them from ImportSwap.
    const [source] = fin.importSwapFeeSplitSources({ IMPORT_FEE_VAULT_56: vaultAddress, IMPORT_FEE_VAULT_START_BLOCK_56: String(rcBuy.blockNumber), IMPORT_SWAP_FEE_ROUTER_56: routerAddress });
    expect(source.feeRouters).to.deep.equal([routerAddress.toLowerCase()]);
    const scan = await fin.scanEvmImportSwapFees({ source: { ...source, confirmations: 0 }, rpc: (m: string, p: unknown[]) => ethers.provider.send(m, p), fromBlock: rcBuy.blockNumber, maxBlocks: rcSell.blockNumber - rcBuy.blockNumber + 1 });
    const rows = scan.rows.filter((r: any) => [buyHash.toLowerCase(), sellHash.toLowerCase()].includes(r.txHash));
    expect(rows.map((r: any) => [r.txHash, r.side, r.tokenAddress, r.wallet, r.feeRaw, r.router])).to.deep.equal([
      [buyHash.toLowerCase(), "buy", token.toLowerCase(), trader.address.toLowerCase(), qb.feeWei.toString(), routerAddress.toLowerCase()],
      [sellHash.toLowerCase(), "sell", token.toLowerCase(), trader.address.toLowerCase(), qs.feeWei.toString(), routerAddress.toLowerCase()],
    ]);
    await routerHoldsNothing();
    results.module = `buy ${value} -> ${qb.amountOut} tokens (min exact), fee ${qb.feeWei}; sell ${amountIn} -> gross ${qs.grossOut}, net ${qs.amountOut} (min exact), fee ${qs.feeWei}; finance rows attributed buy/sell to ${trader.address}`;
  });

  it("V3 venue is off (v3Router = 0)", async function () {
    await expect((router.connect(trader) as any).buyV3(token, 2500, 1n, trader.address, await deadline(), { value: 1000n })).to.be.revertedWithCustomError(router, "VenueNotConfigured");
  });
});
