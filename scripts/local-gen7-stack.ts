/**
 * LOCAL HARDHAT NODE ONLY (chain 31337): the gen-7 stack for step 3 of docs/evm-launch/EVM_GEN7_V2_PLAN.md,
 * so the API, app maths and indexer code can be exercised against a live chain.
 *
 *   npx hardhat node                                                     # terminal 1
 *   npx hardhat run scripts/local-gen7-stack.ts --network localhost      # terminal 2
 *
 * Deploys the same mock stack as the unit tests (test/fixtures/evmgen7Core.ts, BNB at $600), creates two coins
 * ($50K with a 30% first buy, $30K without), trades on the first, and writes every address to
 * deployments/localhost/gen7.json. Refuses any chain other than 31337. Uses only hardhat's public test keys.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { deployEvmGen7, createCoin, req, E, buyTokens, sellTokens, increaseTime } from "../test/fixtures/evmgen7Core";

const OUT = path.join(__dirname, "..", "deployments", "localhost", "gen7.json");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 31337) throw new Error(`local-gen7-stack runs on the local hardhat node only (31337), not ${chainId}`);

  const esmImport = new Function("p", "return import(p)") as (p: string) => Promise<any>;
  const m = await esmImport(require("node:url").pathToFileURL(path.join(__dirname, "..", "frontend", "shared", "evmGen7Curve.mjs")).href);

  const env = await deployEvmGen7({ nativeUsd: 600 });
  const config = await env.factory.config();
  const protocolFeeBps = BigInt(await env.factory.protocolFeeBps());

  // Coin A: $50K market cap, first buy of 30% of supply planned with the app's module.
  const targetA = E(50_000);
  const mcA = BigInt(await env.oracle.nativeTargetForUsd(targetA));
  const max = m.planGen7FirstBuy({ budgetWei: 0n, config, protocolFeeBps, marketCapNativeWei: mcA });
  const thirty = m.quoteGen7FirstBuy({ tokens: (BigInt(config.totalSupply) * 3000n) / 10000n, ...max.curve, protocolFeeBps });
  const a = await createCoin(env, req({ name: "Local Gen7 A", symbol: "LGA", graduationTarget: targetA, firstBuyTokens: thirty.tokens, firstBuyMaxCost: thirty.total }), { value: thirty.total });
  await increaseTime(120);
  await buyTokens(env, a.campaign, env.alice, E(20_000_000));
  await buyTokens(env, a.campaign, env.bob, E(5_000_000));
  await sellTokens(env, a.campaign, a.token, env.alice, E(2_000_000));

  // Coin B: $30K market cap, no first buy.
  const b = await createCoin(env, req({ name: "Local Gen7 B", symbol: "LGB", graduationTarget: E(30_000) }));

  const addr = async (c: any) => String(await c.getAddress());
  const record = {
    chainId,
    note: "local hardhat node only; mock router/vault/adapter as in test/fixtures/evmgen7Core.ts; BNB at $600",
    rpc: "http://127.0.0.1:8545",
    factory: await addr(env.factory),
    campaignImplementation: await addr(env.impl),
    oracle: await addr(env.oracle),
    feed: await addr(env.feed),
    feeRouter: await addr(env.evmRouter),
    creatorRewardsVault: await addr(env.vault),
    nativeAdapter: await addr(env.adapter),
    locker: await addr(env.locker),
    wrappedNative: await addr(env.wbnb),
    dexFactory: await addr(env.topazFactory),
    dexRouter: await addr(env.topazRouter),
    routeAuthority: await env.authority.getAddress(),
    creator: await env.creator.getAddress(),
    traders: [await env.alice.getAddress(), await env.bob.getAddress()],
    coins: [
      { name: "Local Gen7 A", campaign: await addr(a.campaign), token: await addr(a.token), targetUsd: "50000", firstBuyTokens: thirty.tokens.toString() },
      { name: "Local Gen7 B", campaign: await addr(b.campaign), token: await addr(b.token), targetUsd: "30000", firstBuyTokens: "0" },
    ],
    block: await ethers.provider.getBlockNumber(),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
  console.log(`gen-7 local stack on ${network.name}: factory ${record.factory}`);
  for (const c of record.coins) console.log(`  ${c.name}: campaign ${c.campaign} token ${c.token}`);
  console.log(`written ${path.relative(process.cwd(), OUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
