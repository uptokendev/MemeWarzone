/**
 * Source-verify every mainnet contract on the chain's explorer, from
 * config/verification/mainnet-contracts.json.
 *
 * BSC (56): Etherscan v2 API with ETHERSCAN_API_KEY. Robinhood Chain (4663):
 * Sourcify -- the chain's Blockscout sits behind a Cloudflare challenge that
 * blocks scripted requests, and Blockscout reads Sourcify. A contract whose
 * bytecode does not match the recorded constructor arguments fails; nothing
 * is ever verified with guessed arguments. Already-verified contracts are
 * reported and skipped. Sends no transactions.
 *
 *   npx hardhat run scripts/verify-mainnet-contracts.ts --network bscMainnet
 *   npx hardhat run scripts/verify-mainnet-contracts.ts --network robinhoodMainnet
 *   ONLY=LaunchFactory,RiskRegistry ...   restricts to names containing those strings
 */
import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config", "verification", "mainnet-contracts.json"), "utf8"));
  const chainId = String((await hre.ethers.provider.getNetwork()).chainId);
  const chain = manifest.chains[chainId];
  if (!chain) throw new Error(`no verification manifest for chain ${chainId}`);
  const only = String(process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  (hre.config as any).etherscan.enabled = chain.provider === "etherscan";
  (hre.config as any).sourcify.enabled = chain.provider === "sourcify";
  console.log(`[verify] chain ${chainId} (${hre.network.name}) via ${chain.provider}: ${chain.contracts.length} contracts`);
  const summary: Record<string, string> = {};
  for (const c of chain.contracts) {
    if (only.length && !only.some((o) => c.name.includes(o))) continue;
    try {
      await hre.run("verify:verify", { address: c.address, constructorArguments: c.args, contract: c.contract });
      summary[c.name] = "verified";
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (/already verified|already been verified|is already verified/i.test(msg)) summary[c.name] = "already verified";
      else summary[c.name] = `FAILED: ${msg.split("\n")[0].slice(0, 160)}`;
    }
    console.log(`  ${summary[c.name].padEnd(20)} ${c.name} ${c.address}`);
  }
  const failed = Object.entries(summary).filter(([, v]) => v.startsWith("FAILED"));
  console.log(`[verify] done: ${Object.keys(summary).length} processed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
