/**
 * DogeOS Chikyū testnet (6281971): verify every contract of the gen-7 stack on L2Scan (plan t8, spec §1 "Deploy
 * outputs": all contracts verified via L2Scan's Etherscan-style /api).
 *
 *   npx hardhat --config hardhat.dogeos-verify.config.ts run scripts/verify-dogeos-testnet.ts --network dogeosTestnet
 *
 * Reads config/verification/dogeos-testnet-contracts.json (chains["6281971"], written by deploy-dogeos-testnet.ts)
 * and verifies each entry with its recorded constructor arguments. "Already verified" counts as done; any other
 * failure is collected and the run exits non-zero after trying every entry. MuchFi and WDOGE are external and never
 * listed. Sends no transaction: verification is an HTTP submission to L2Scan.
 */
import fs from "node:fs";
import path from "node:path";
import hre, { ethers, network } from "hardhat";
import { loadDogeosDeployGuards } from "./deploy-dogeos-testnet";

const ROOT = path.join(__dirname, "..");

async function main() {
  const guards = await loadDogeosDeployGuards();
  const log = (line: string) => console.log(`[verify-dogeos] ${line}`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const custom = ((hre.config as any).etherscan?.customChains ?? []).find((c: any) => c.network === network.name);
  guards.assertVerifyTarget({ chainId, networkName: network.name, explorerApiUrl: custom?.urls?.apiURL });

  const file = path.join(ROOT, ...String(guards.DOGEOS_VERIFICATION_PATH).split("/"));
  if (!fs.existsSync(file)) throw new Error(`${file} not found; run deploy-dogeos-testnet.ts first`);
  const entries: Array<{ name: string; address: string; contract: string; args: unknown[] }> = guards.readVerificationList(
    JSON.parse(fs.readFileSync(file, "utf8")),
  );

  const failures: string[] = [];
  for (const e of entries) {
    if ((await ethers.provider.getCode(e.address)) === "0x") {
      failures.push(`${e.name} ${e.address}: no code on chain ${chainId}`);
      continue;
    }
    try {
      await hre.run("verify:verify", { address: e.address, constructorArguments: e.args, contract: e.contract });
      log(`verified ${e.name} ${e.address}`);
    } catch (error) {
      if (guards.isAlreadyVerified(error)) {
        log(`already verified ${e.name} ${e.address}`);
        continue;
      }
      failures.push(`${e.name} ${e.address}: ${(error as Error)?.message ?? String(error)}`);
    }
  }
  if (failures.length) throw new Error(`L2Scan verification failed for ${failures.length}/${entries.length}:\n  ${failures.join("\n  ")}`);
  log(`all ${entries.length} contracts verified on L2Scan`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
