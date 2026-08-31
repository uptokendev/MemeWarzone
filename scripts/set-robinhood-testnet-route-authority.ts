import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { resolveRobinhoodRouteAuthority, sameAddress } from "./robinhoodRouteAuthority";

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`Route-authority retarget is restricted to chain ${ROBINHOOD_TESTNET_CHAIN_ID}; connected ${chainId}`);
  }

  const manifestPath = path.resolve(
    String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || "deployments/robinhood/testnet.staged.json"),
  );
  if (!fs.existsSync(manifestPath)) throw new Error(`Staged manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const factoryAddress = String(manifest.contracts?.launchFactory || "").trim();
  if (!ethers.isAddress(factoryAddress)) throw new Error("manifest contracts.launchFactory is missing");

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  if (!sameAddress(deployerAddress, manifest.admin)) {
    throw new Error(`Connected deployer ${deployerAddress} is not staged admin ${manifest.admin}`);
  }

  const resolved = resolveRobinhoodRouteAuthority({ chainId, deployerAddress });
  if (sameAddress(resolved.address, deployerAddress)) {
    throw new Error("Refusing to retarget route authority to the deployer");
  }

  const factory = await ethers.getContractAt("LaunchFactory", factoryAddress, deployer);
  const current = await factory.routeAuthority();
  console.log("[robinhood-route-authority] retarget", {
    network: network.name,
    chainId,
    factory: factoryAddress,
    current,
    next: resolved.address,
    source: resolved.source,
  });

  if (!sameAddress(current, resolved.address)) {
    const tx = await factory.setRouteAuthority(resolved.address);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("setRouteAuthority transaction failed");
    console.log("[robinhood-route-authority] setRouteAuthority confirmed", { tx: receipt.hash });
  } else {
    console.log("[robinhood-route-authority] on-chain route authority already matches");
  }

  const onChain = await factory.routeAuthority();
  if (!sameAddress(onChain, resolved.address)) {
    throw new Error(`On-chain route authority ${onChain} did not become ${resolved.address}`);
  }

  manifest.routeAuthority = resolved.address;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("[robinhood-route-authority] manifest updated", { manifest: manifestPath, routeAuthority: resolved.address });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
