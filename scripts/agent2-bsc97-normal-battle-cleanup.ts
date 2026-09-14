import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { sameAddress } from "./bnb6cRouteAuthority";

async function main() {
  if (network.name !== "bscTestnet") throw new Error(`refusing network ${network.name}`);
  const manifestPath = path.resolve(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "certification/agent2-bsc97-stage-20260914.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (Number(manifest.chainId) !== 97) throw new Error("cleanup manifest is not BSC97");
  const key = String(process.env.BSC_TESTNET_PRIVATE_KEY || process.env.DEPLOYER_PK || process.env.PRIVATE_KEY_DEPLOY || "").trim();
  if (!key) throw new Error("BSC_TESTNET_PRIVATE_KEY required for cleanup");
  const deployer = new ethers.Wallet(key, ethers.provider);
  if (!sameAddress(deployer.address, manifest.admin)) throw new Error(`cleanup admin mismatch: ${deployer.address}`);
  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory, deployer);
  if (!(await factory.createPaused())) {
    const tx = await factory.setCreatePaused(true);
    await tx.wait();
    console.log(`restored create pause tx=${tx.hash}`);
  } else {
    console.log("create pause already restored");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
