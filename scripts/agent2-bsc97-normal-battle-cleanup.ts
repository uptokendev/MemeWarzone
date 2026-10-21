import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { sameAddress } from "./bnb6cRouteAuthority";

async function main() {
  if (network.name !== "bscTestnet") throw new Error(`refusing network ${network.name}`);
  const manifestPath = path.resolve(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "deployments/bnb/testnet.staged.json");
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const [deployer] = await ethers.getSigners();
  if (!sameAddress(await deployer.getAddress(), manifest.admin)) throw new Error("deployer/admin mismatch during cleanup");
  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory, deployer);
  if (!(await factory.createPaused())) await (await factory.setCreatePaused(true)).wait();
  console.log(JSON.stringify({ chainId: 97, factory: await factory.getAddress(), createPaused: await factory.createPaused(), cleanup: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
