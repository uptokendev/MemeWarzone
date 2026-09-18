import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) === 56) throw new Error("REJECTED: chain 56 production broadcast is forbidden");
  if (Number(net.chainId) !== 97) throw new Error(`expected chain 97, got ${net.chainId}`);

  const manifestFile = path.resolve(String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "deployments/bnb/testnet.staged.json"));
  if (!fs.existsSync(manifestFile)) throw new Error(`missing staged manifest ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

  const topazFactory = await ethers.getContractAt("MockTopazFactory", manifest.contracts.mockTopazFactory);
  const locker = await ethers.getContractAt("PermanentLpLocker", manifest.contracts.permanentLpLocker);

  const controlledTopazFeeBps = await topazFactory.feeBps();
  const lockerRequiredFeeBps = await locker.REQUIRED_POOL_FEE_BPS();
  const creatorEntitlementBps = await locker.CREATOR_FEE_BPS();
  const protocolEntitlementBps = await locker.PROTOCOL_FEE_BPS();
  const externalTopazObservedFeeBps = manifest?.liveBnbUntouched?.externalTopazObservedFeeBps ?? null;
  const controlledTopaz = manifest?.certificationAuthority?.controlledTopaz === true;

  if (controlledTopazFeeBps !== 30n) throw new Error(`controlled Topaz configured fee must be 30 bps, got ${controlledTopazFeeBps}`);
  if (lockerRequiredFeeBps !== 30n) throw new Error(`locker required pool fee must be 30 bps, got ${lockerRequiredFeeBps}`);
  if (creatorEntitlementBps !== 8000n || protocolEntitlementBps !== 2000n) {
    throw new Error(`locker entitlement must be 80/20, got ${creatorEntitlementBps}/${protocolEntitlementBps}`);
  }
  if (!controlledTopaz) throw new Error("staged manifest does not mark controlled Topaz certification authority");

  console.log("[bnb97-topaz-evidence] EXTERNAL OBSERVATION");
  console.log(`[bnb97-topaz-evidence] externalTopazObservedFeeBps: ${externalTopazObservedFeeBps}`);
  console.log("[bnb97-topaz-evidence] CERTIFICATION AUTHORITY");
  console.log(`[bnb97-topaz-evidence] controlledTopazFeeBps: ${Number(controlledTopazFeeBps)}`);
  console.log(`[bnb97-topaz-evidence] lockerRequiredFeeBps: ${Number(lockerRequiredFeeBps)}`);
  console.log(`[bnb97-topaz-evidence] creatorEntitlementBps: ${Number(creatorEntitlementBps)}`);
  console.log(`[bnb97-topaz-evidence] protocolEntitlementBps: ${Number(protocolEntitlementBps)}`);
  console.log(`[bnb97-topaz-evidence] controlledTopaz: ${controlledTopaz}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
