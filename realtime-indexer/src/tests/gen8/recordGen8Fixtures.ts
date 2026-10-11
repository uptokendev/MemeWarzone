/**
 * Records the gen-8 log fixtures used by src/tests/evmGen8Decode.test.ts from a real local run (anvil + the production
 * contracts): a launch with a first buy, the four swap types, a graduation crossing and post-graduation swaps.
 *   npx tsx src/tests/gen8/recordGen8Fixtures.ts > src/tests/fixtures/gen8-logs.json
 */
import { ethers } from "ethers";
import { deployGen8Local, launchCoin, startAnvil, swap, WAD } from "./gen8LocalChain.js";

const anvil = await startAnvil(Number(process.env.GEN8_ANVIL_PORT || 8772));
try {
  const provider = new ethers.JsonRpcProvider(anvil.url, 97, { staticNetwork: true, cacheTimeout: -1 });
  const env = await deployGen8Local(provider, { display: true });
  const coin = await launchCoin(env, env.creator, { firstBuyValue: WAD / 1000n });
  await provider.send("evm_increaseTime", [120]);
  const steps: Array<{ label: string; rc: any }> = [{ label: "launch_with_first_buy", rc: coin.rc }];
  steps.push({ label: "buy_exact_in", rc: await swap(env, coin, env.buyer, { buy: true, exactIn: true, amount: WAD / 500n }) });
  steps.push({ label: "buy_exact_out", rc: await swap(env, coin, env.buyer, { buy: true, exactIn: false, amount: 1_000_000n * WAD, maxIn: WAD }) });
  steps.push({ label: "sell_exact_in", rc: await swap(env, coin, env.buyer, { buy: false, exactIn: true, amount: 100_000n * WAD }) });
  steps.push({ label: "sell_exact_out", rc: await swap(env, coin, env.buyer, { buy: false, exactIn: false, amount: WAD / 10_000n }) });
  steps.push({ label: "crossing_buy", rc: await swap(env, coin, env.buyer, { buy: true, exactIn: true, amount: WAD / 10n }) });
  steps.push({ label: "post_buy_exact_in", rc: await swap(env, coin, env.buyer, { buy: true, exactIn: true, amount: WAD / 500n }) });
  steps.push({ label: "post_sell_exact_in", rc: await swap(env, coin, env.buyer, { buy: false, exactIn: true, amount: 100_000n * WAD }) });
  const out = {
    note: "Recorded on a local anvil (chain 97) with the build/evm-gen8 contracts by src/tests/gen8/recordGen8Fixtures.ts",
    addresses: {
      launcher: (await env.launcher.getAddress()).toLowerCase(), hook: (await env.hook.getAddress()).toLowerCase(), poolManager: (await env.pm.getAddress()).toLowerCase(),
      splitter: (await env.splitter.getAddress()).toLowerCase(), choiceVault: (await env.vault.getAddress()).toLowerCase(), escrow: (await env.escrow.getAddress()).toLowerCase(),
      trader: (await env.trader.getAddress()).toLowerCase(), creator: env.creator.address.toLowerCase(), buyer: env.buyer.address.toLowerCase(),
    },
    token: coin.token.toLowerCase(),
    poolId: coin.id,
    steps: steps.map(({ label, rc }) => ({
      label,
      txHash: rc.hash,
      from: rc.from.toLowerCase(),
      blockNumber: rc.blockNumber,
      logs: rc.logs.map((l: any) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, index: l.index, blockHash: l.blockHash })),
    })),
  };
  console.log(JSON.stringify(out, null, 2));
} finally {
  await anvil.stop();
}
