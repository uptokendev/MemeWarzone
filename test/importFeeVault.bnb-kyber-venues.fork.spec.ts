/**
 * Founder 2026-10-08: an imported BNB coin trades wherever its pool is, always with the import fee. Proof on a local
 * anvil fork of BNB 56 that frontend/api/importSwap.js's own handlers (importSwapQuote / importSwapBuild) route REAL
 * KyberSwap swaps through each newly allowed venue family (KYBER_BSC_POOL_SOURCES) with exactly 1% to a fork
 * ImportFeeVault (IMPORT_FEE_VAULT_56 = IMPORT_SWAP_FEE_RECEIVER_56 = the vault, the CI2 switch), buy and sell:
 *   buy:  ONE vault Deposit (from = Kyber router 0x6131B5fa) = amountIn * 100 / 10_000
 *   sell: ONE vault Deposit (from = Kyber router) = gross * 100 / 10_000, gross = what the wallet got + fee
 * Topaz V2 runs on the API's own source list, unmodified (Airo has no PancakeSwap pool: before 2026-10-08 Kyber
 * answered "route not found"). For the other venues the coin also has deeper pools elsewhere, so the test narrows the
 * Kyber request's includedSources to that venue (a subset of KYBER_BSC_POOL_SOURCES, checked) to force the route
 * through it; assertBscRouteTerms still runs against the full list and every quoted hop is checked to be the venue.
 * Read-only HTTP calls to the Kyber API; the built transactions run only on the fork. Nothing is sent to BNB Chain.
 *
 *   anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id 56 --port 8645 --accounts 0 --no-rate-limit
 *   npx hardhat test test/importFeeVault.bnb-kyber-venues.fork.spec.ts --network bscForkRehearsal
 * Kyber quotes live mainnet state: fork at the latest block just before running.
 */
import { expect } from "chai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { assertLocalFork } from "../scripts/lib/forkRehearsal";
import { deployVaultOnFork, freshWallet, gasCost, vaultDeposits } from "./helpers/importFeeVaultFork";

const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const BPS = 100n;
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

type Venue = { name: string; token: string; sources: string[] | null; buyBnb: string };
const VENUES: Venue[] = [
  // Topaz-only coin, the API's own source list (no narrowing).
  { name: "Topaz V2 (Airo, Topaz-only)", token: "0x019078cAe01e065aCb4189C0A82d0eaDF6a1Def1", sources: null, buyBnb: "0.05" },
  { name: "Topaz V3 (TOPAZ)", token: "0xdf002282C1474C9592780618Adda7EaA99998Abd", sources: ["topazdex-v3"], buyBnb: "0.05" },
  { name: "Uniswap V2 on BNB (CAKE)", token: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", sources: ["uniswap"], buyBnb: "0.01" },
  { name: "Uniswap V3 on BNB (TST)", token: "0x86Bb94DdD16Efc8bc58e6b056e8df71D9e666429", sources: ["uniswapv3"], buyBnb: "0.05" },
  { name: "Uniswap V4 on BNB (TST)", token: "0x86Bb94DdD16Efc8bc58e6b056e8df71D9e666429", sources: ["uniswap-v4"], buyBnb: "0.05" },
  { name: "THENA (THE)", token: "0xF4C8E32EaDEC4BFe97E0F595AdD0f4450a863a11", sources: ["thena", "thena-fusion", "thena-fusion-v3"], buyBnb: "0.05" },
  { name: "Biswap (BSW)", token: "0x965F527D9159dCe6288a2219DB51fc6Eef120dD1", sources: ["biswap"], buyBnb: "0.05" },
  // BabyDogeSwap with CAKE: the BabyDoge token's own sell on its BabyDogeSwap pair reverts through Kyber ("Call failed",
  // fork block 126494509; the buy passes). Kyber's full-source route for BabyDoge goes through PancakeSwap and passes.
  { name: "BabyDogeSwap (CAKE)", token: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", sources: ["babydogeswap"], buyBnb: "0.01" },
  { name: "BabyDoge, the API's own source list", token: "0xc748673057861a797275CD8A068AbB95A902e8de", sources: null, buyBnb: "0.05" },
];

/** Calls an API handler the way server.mjs does (req.body already parsed), returns the JSON it wrote. */
async function callHandler(handler: any, body: unknown) {
  let status = 0;
  let payload = "";
  const res = { statusCode: 0, setHeader() {}, end(s: string) { payload = s; status = this.statusCode; } } as any;
  await handler({ method: "POST", body }, res);
  const out = JSON.parse(payload);
  if (status !== 200 || !out.ok) throw new Error(`handler ${status}: ${payload}`);
  return out;
}

const d = network.name === "bscForkRehearsal" ? describe : describe.skip;

d("Kyber BNB import swaps on every venue family pay exactly 1% to ImportFeeVault (BSC fork, real routes)", function () {
  this.timeout(1_800_000);
  let vault: any;
  let vaultAddress: string;
  let api: any;
  const realFetch = globalThis.fetch;
  let forced: string[] | null = null;
  const results: string[] = [];

  before(async function () {
    const fork = await assertLocalFork(56);
    console.log(`      fork of 56 at block ${fork.forkBlock} (${fork.forkUrl})`);
    ({ vault, vaultAddress } = await deployVaultOnFork(56));
    delete process.env.IMPORT_SWAP_FEE_BPS;
    process.env.IMPORT_FEE_VAULT_56 = vaultAddress;
    process.env.IMPORT_SWAP_FEE_RECEIVER_56 = vaultAddress;
    api = await esmImport(pathToFileURL(path.resolve(__dirname, "..", "frontend", "api", "importSwap.js")).href + "?venues");
    expect(api.importSwapFeeBps(56)).to.equal(Number(BPS));
    // Narrow the Kyber route request to one venue (a subset of the API's list); everything else passes through.
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(String(input));
      if (forced && url.pathname.endsWith("/routes")) {
        const sent = String(url.searchParams.get("includedSources")).split(",");
        expect(sent).to.deep.equal([...api.KYBER_BSC_POOL_SOURCES]);
        for (const id of forced) expect(sent).to.include(id);
        url.searchParams.set("includedSources", forced.join(","));
      }
      return realFetch(url, init);
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    for (const line of results) console.log(`      ${line}`);
  });

  for (const venue of VENUES) {
    it(`${venue.name}: buy and sell, one Deposit of exactly 1% each`, async function () {
      forced = venue.sources;
      const token = ethers.getAddress(venue.token);
      const erc20 = (signer?: any) => new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], signer ?? ethers.provider);
      const wallet = await freshWallet("2");
      const allowed = new Set<string>(venue.sources ?? api.KYBER_BSC_POOL_SOURCES);

      // Buy
      const amountRaw = ethers.parseEther(venue.buyBnb);
      const bq = await callHandler(api.importSwapQuote, { chainId: 56, side: "buy", token, amountRaw: amountRaw.toString() });
      expect(bq.provider).to.equal("kyberswap");
      expect(bq.feeBps).to.equal(100);
      expect(bq.quote.extraFee).to.deep.include({ feeAmount: "100", chargeFeeBy: "currency_in", isInBps: true });
      expect(String(bq.quote.extraFee.feeReceiver).toLowerCase()).to.equal(vaultAddress.toLowerCase());
      for (const hop of bq.route) expect(allowed.has(hop), `buy hop ${hop}`).to.equal(true);
      const bb = await callHandler(api.importSwapBuild, { chainId: 56, side: "buy", token, wallet: wallet.address, quote: bq.quote, slippageBps: 300 });
      expect(bb.to.toLowerCase()).to.equal(KYBER_ROUTER.toLowerCase());
      expect(BigInt(bb.value)).to.equal(amountRaw);
      const t0 = await erc20().balanceOf(wallet.address);
      const b0 = await ethers.provider.getBalance(wallet.address);
      const v0 = await ethers.provider.getBalance(vaultAddress);
      const brc = await (await wallet.sendTransaction({ to: bb.to, data: bb.data, value: BigInt(bb.value) })).wait();
      expect(brc.status).to.equal(1);
      const bdep = vaultDeposits(vault, brc);
      expect(bdep.length).to.equal(1);
      expect(bdep[0].from.toLowerCase()).to.equal(KYBER_ROUTER.toLowerCase());
      expect(bdep[0].amount).to.equal((amountRaw * BPS) / 10_000n);
      expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(bdep[0].amount);
      expect(b0 - (await ethers.provider.getBalance(wallet.address))).to.equal(amountRaw + gasCost(brc));
      const got = (await erc20().balanceOf(wallet.address)) - t0;
      expect(got > 0n).to.equal(true);
      const gotPct = Number((got * 10_000n) / BigInt(bq.amountOut)) / 100;

      // Sell half of what arrived
      const amountIn = got / 2n;
      const sq = await callHandler(api.importSwapQuote, { chainId: 56, side: "sell", token, amountRaw: amountIn.toString() });
      expect(sq.quote.extraFee).to.deep.include({ feeAmount: "100", chargeFeeBy: "currency_out", isInBps: true });
      for (const hop of sq.route) expect(allowed.has(hop), `sell hop ${hop}`).to.equal(true);
      const sb = await callHandler(api.importSwapBuild, { chainId: 56, side: "sell", token, wallet: wallet.address, quote: sq.quote, slippageBps: 300 });
      expect(BigInt(sb.value)).to.equal(0n);
      expect((await (await erc20(wallet).approve(sb.spender, amountIn)).wait()).status).to.equal(1);
      const s0 = await erc20().balanceOf(wallet.address);
      const sb0 = await ethers.provider.getBalance(wallet.address);
      const sv0 = await ethers.provider.getBalance(vaultAddress);
      const src = await (await wallet.sendTransaction({ to: sb.to, data: sb.data, value: 0n })).wait();
      expect(src.status).to.equal(1);
      expect(s0 - (await erc20().balanceOf(wallet.address))).to.equal(amountIn);
      const received = (await ethers.provider.getBalance(wallet.address)) - sb0 + gasCost(src);
      const sdep = vaultDeposits(vault, src);
      expect(sdep.length).to.equal(1);
      expect(sdep[0].from.toLowerCase()).to.equal(KYBER_ROUTER.toLowerCase());
      const fee = sdep[0].amount;
      const gross = received + fee;
      expect(fee).to.equal((gross * BPS) / 10_000n);
      expect((await ethers.provider.getBalance(vaultAddress)) - sv0).to.equal(fee);
      expect(received > 0n).to.equal(true);
      const recvPct = Number((received * 10_000n) / BigInt(sq.amountOut)) / 100;

      results.push(
        `${venue.name}: buy ${amountRaw} wei via ${bq.route.join(">")} -> Deposit ${bdep[0].amount} (1%), tokens ${got} (${gotPct}% of quote); ` +
          `sell ${amountIn} via ${sq.route.join(">")} -> gross ${gross}, Deposit ${fee} (1%), wallet ${received} wei (${recvPct}% of quote)`,
      );
    });
  }
});
