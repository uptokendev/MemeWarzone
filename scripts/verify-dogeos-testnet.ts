/**
 * DogeOS Chikyū testnet (6281971): read the Bark stack back against its manifest and verify its contracts on L2Scan
 * (barkswap plan t15; spec section 5 "Deployment 1": explorer verification, manifest).
 *
 *   npm run verify:dogeos-testnet        reused contracts, root 0.8.24 build (hardhat.dogeos-verify.config.ts)
 *   npm run verify:dogeos-bark-testnet   Bark contracts + their libraries, 0.8.26 build (hardhat.dogeos-bark-verify.config.ts)
 *
 * Both runs read config/verification/dogeos-testnet-contracts.json (chains["6281971"], written by
 * deploy-dogeos-testnet.ts), require it to be exactly the entry list deployments/dogeos/testnet.bark.json implies, and
 * read every address and role of the stack back from chain (readBackDogeosBarkStack) before submitting anything. Then
 * each run verifies the entries of its own build (the config's artifacts directory decides: artifacts = root,
 * artifacts-bark = bark) with the recorded constructor arguments and, for the launcher, its linked libraries.
 * "Already verified" counts as done; any other failure is collected and the run exits non-zero after trying every
 * entry. Barkswap and WDOGE are external and never listed. Sends no transaction: verification is an HTTP submission.
 */
import fs from "node:fs";
import path from "node:path";
import hre, { ethers, network } from "hardhat";
import { loadDogeosDeployGuards, readBackDogeosBarkStack } from "./lib/dogeosBarkStack";

const ROOT = path.join(__dirname, "..");

async function main() {
  const guards = await loadDogeosDeployGuards();
  const log = (line: string) => console.log(`[verify-dogeos] ${line}`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const custom = ((hre.config as any).etherscan?.customChains ?? []).find((c: any) => c.network === network.name);
  guards.assertVerifyTarget({ chainId, networkName: network.name, explorerApiUrl: custom?.urls?.apiURL });
  const build = guards.verificationBuildOf(hre.config.paths.artifacts);

  const file = path.join(ROOT, ...String(guards.DOGEOS_VERIFICATION_PATH).split("/"));
  if (!fs.existsSync(file)) throw new Error(`${file} not found; run deploy-dogeos-testnet.ts first`);
  const entries: Array<{ name: string; address: string; contract: string; args: unknown[]; build: string; libraries?: Record<string, string> }> =
    guards.readVerificationList(JSON.parse(fs.readFileSync(file, "utf8")));
  // The JSON must describe the stack the manifest records, and the chain must match the manifest, before anything is submitted.
  const manifestFile = path.join(ROOT, ...String(guards.DOGEOS_MANIFEST_PATH).split("/"));
  if (!fs.existsSync(manifestFile)) throw new Error(`${manifestFile} not found; the verification JSON cannot be cross-checked`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  guards.assertVerificationMatchesManifest(entries, manifest);
  const checks = await readBackDogeosBarkStack(manifest, { provider: ethers.provider });
  log(`read-back: ${checks} checks passed against ${manifestFile}`);

  const mine = guards.entriesForBuild(entries, build);
  log(`build ${build}: ${mine.length} of ${entries.length} contracts`);
  const failures: string[] = [];
  for (const e of mine) {
    if ((await ethers.provider.getCode(e.address)) === "0x") {
      failures.push(`${e.name} ${e.address}: no code on chain ${chainId}`);
      continue;
    }
    try {
      await hre.run("verify:verify", { address: e.address, constructorArguments: e.args, contract: e.contract, libraries: e.libraries ?? {} });
      log(`verified ${e.name} ${e.address}`);
    } catch (error) {
      if (guards.isAlreadyVerified(error)) {
        log(`already verified ${e.name} ${e.address}`);
        continue;
      }
      failures.push(`${e.name} ${e.address}: ${(error as Error)?.message ?? String(error)}`);
    }
  }
  if (failures.length) throw new Error(`L2Scan verification failed for ${failures.length}/${mine.length}:\n  ${failures.join("\n  ")}`);
  log(`all ${mine.length} ${build}-build contracts verified on L2Scan`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
