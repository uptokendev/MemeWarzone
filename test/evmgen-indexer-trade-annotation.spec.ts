import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, createCoin, req, E, area, setNextTimestamp, signTrade, buyTokens } from "./fixtures/evmgenCore";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

// The indexer's pure trade maths, checked against the compiled contract. realtime-indexer is an ES module
// package, so its (import-free) source is transpiled here rather than required.
function loadIndexerTradeMaths() {
  const file = path.join(__dirname, "../realtime-indexer/src/evm/evmGen5Trade.ts");
  const js = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as any };
  new Function("module", "exports", js)(mod, mod.exports);
  return mod.exports as { annotateGen5Trade: (input: any) => any };
}
const { annotateGen5Trade } = loadIndexerTradeMaths();

/**
 * The indexer derives the fee actually charged on a gen-5 trade from the event amount, the block time and
 * launchAt (the events carry no fee). This drives real trades through LaunchCampaign and compares what the
 * indexer would write with what the router was actually paid (MockTreasuryRouterEvmGen.lastTradeValue).
 */
describe("indexer: gen-5 trade fee and creator-buy flags match the contract", function () {
  async function indexed(env: any, campaign: any, receipt: any, side: "buy" | "sell") {
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const iface = campaign.interface;
    let wallet = "";
    let amount = 0n;
    let firstBuy: { costNoFee: bigint; fee: bigint } | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== (await campaign.getAddress()).toLowerCase()) continue;
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      if (parsed.name === "TokensPurchased" && side === "buy") {
        wallet = parsed.args.buyer;
        amount = parsed.args.cost;
      }
      if (parsed.name === "TokensSold" && side === "sell") {
        wallet = parsed.args.seller;
        amount = parsed.args.payout;
      }
      if (parsed.name === "CreatorFirstBuy") firstBuy = { costNoFee: parsed.args.costNoFee, fee: parsed.args.fee };
    }
    return annotateGen5Trade({
      side,
      amountRaw: amount,
      blockTimeSec: BigInt(block!.timestamp),
      launchAt: await campaign.launchAt(),
      baseFeeBps: await campaign.protocolFeeBps(),
      wallet,
      creator: env.creator.address,
      firstBuy,
    });
  }

  for (const elapsed of [1, 7, 30, 59, 60, 900]) {
    it(`buy and sell at +${elapsed}s: indexed fee == routed fee`, async () => {
      const env = await deployEvmGen();
      const { campaign, token } = await createCoin(env);
      const t0 = Number(await campaign.launchAt());
      const amount = E(1_234_567);
      const cost = area(amount) * 2n;
      const a = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 0, amount, cost);
      await setNextTimestamp(t0 + elapsed);
      const buy = await (await campaign.connect(env.alice).buyExactTokensAuthorized(amount, cost, a.profile, a.deadline, a.signature, { value: cost })).wait();
      const b = await indexed(env, campaign, buy, "buy");
      expect(b.feeRaw).to.eq(await env.evmRouter.lastTradeValue());
      expect(b.grossRaw).to.eq(area(amount));
      expect(b.leagueExcluded).to.eq(false);

      await token.connect(env.alice).approve(await campaign.getAddress(), amount / 3n);
      const s = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 2, amount / 3n, 0n);
      await setNextTimestamp(t0 + elapsed + 2);
      const sell = await (await campaign.connect(env.alice).sellExactTokensAuthorized(amount / 3n, 0n, s.profile, s.deadline, s.signature)).wait();
      const x = await indexed(env, campaign, sell, "sell");
      const routed = await env.evmRouter.lastTradeValue();
      // Sells may be 1 wei ambiguous where the fee floor steps; never more.
      expect(x.feeRaw! === routed || x.feeRaw! + 1n === routed).to.eq(true);
    });
  }

  it("first buy at create: flat 2% from CreatorFirstBuy, flagged, league-excluded", async () => {
    const env = await deployEvmGen();
    const tokens = E(50_000_000);
    const c = area(tokens);
    const cost = c + (c * 200n) / 10000n;
    const { campaign, receipt } = await createCoin(env, req({ firstBuyTokens: tokens, firstBuyMaxCost: cost }), { value: cost });
    const f = await indexed(env, campaign, receipt, "buy");
    expect(f.creatorBuyKind).to.eq("first_buy");
    expect(f.feeRaw).to.eq(await env.evmRouter.lastTradeValue());
    expect(f.feeBps).to.eq(200);
    expect(f.leagueExcluded).to.eq(true);
  });

  it("a later creator buy is escrowed, priced with the live fee, and league-excluded", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    const t0 = Number(await campaign.launchAt());
    await setNextTimestamp(t0 + 20);
    const receipt = await (await buyTokens(env, campaign, env.creator, E(2_000_000))).wait();
    const e = await indexed(env, campaign, receipt, "buy");
    expect(e.creatorBuyKind).to.eq("escrow");
    expect(e.leagueExcluded).to.eq(true);
    expect(e.feeBps).to.eq(5000 - 80 * 20);
    expect(e.feeRaw).to.eq(await env.evmRouter.lastTradeValue());
  });
});
