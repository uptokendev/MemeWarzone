import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
const LOCAL_CHAIN_ID = 31337;

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

async function requireCode(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no bytecode at ${address}`);
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const allowLocal = truthy(process.env.ALLOW_LOCAL_RH_PROTOCOL_STAGE);
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID && !(allowLocal && chainId === LOCAL_CHAIN_ID)) {
    throw new Error(`Robinhood auxiliary deployment is restricted to ${ROBINHOOD_TESTNET_CHAIN_ID}${allowLocal ? ` or local ${LOCAL_CHAIN_ID}` : ""}; got ${chainId}.`);
  }

  const defaultManifest = chainId === ROBINHOOD_TESTNET_CHAIN_ID
    ? "deployments/robinhood/testnet.staged.json"
    : ".tmp/robinhood-testnet-stage.local.json";
  const manifestFile = path.resolve(String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || defaultManifest));
  if (!fs.existsSync(manifestFile)) throw new Error(`Staged deployment manifest not found: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (Number(manifest.targetChainId) !== ROBINHOOD_TESTNET_CHAIN_ID) throw new Error("Wrong staged manifest target chain.");

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  if (String(manifest.admin || "").toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(`Connected deployer must be staged admin. deployer=${deployerAddress} admin=${manifest.admin}`);
  }

  manifest.contracts ||= {};
  const existing = String(manifest.contracts.upVoteTreasury || "").trim();
  if (existing && ethers.isAddress(existing) && (await ethers.provider.getCode(existing)) !== "0x") {
    console.log(`[robinhood-aux] UPVoteTreasury already deployed at ${existing}`);
    return;
  }

  const feeReceiver = String(manifest.contracts.protocolRevenueVault || "").trim();
  if (!ethers.isAddress(feeReceiver) || feeReceiver === ethers.ZeroAddress) {
    throw new Error("Staged manifest is missing ProtocolRevenueVault for UPVote fee forwarding.");
  }
  await requireCode(feeReceiver, "ProtocolRevenueVault");

  const UPVoteTreasury = await ethers.getContractFactory("UPVoteTreasury");
  const voteTreasury = await UPVoteTreasury.deploy(deployerAddress, feeReceiver);
  await voteTreasury.waitForDeployment();
  const voteTreasuryAddress = await voteTreasury.getAddress();
  await requireCode(voteTreasuryAddress, "UPVoteTreasury");

  if ((await voteTreasury.owner()).toLowerCase() !== deployerAddress.toLowerCase()) throw new Error("UPVoteTreasury owner mismatch");
  if ((await voteTreasury.feeReceiver()).toLowerCase() !== feeReceiver.toLowerCase()) throw new Error("UPVoteTreasury fee receiver mismatch");
  const nativeConfig = await voteTreasury.assetConfig(ethers.ZeroAddress);
  if (!nativeConfig.enabled) throw new Error("UPVoteTreasury native voting is not enabled");

  manifest.contracts.upVoteTreasury = voteTreasuryAddress;
  manifest.auxiliaryFeatures = {
    ...(manifest.auxiliaryFeatures || {}),
    upVoteTreasury: {
      enabled: true,
      owner: deployerAddress,
      feeReceiver,
      nativeAssetEnabled: true,
      testnetOnly: true,
    },
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("[robinhood-aux] UPVoteTreasury deployed and appended to staged manifest", {
    address: voteTreasuryAddress,
    feeReceiver,
    manifest: manifestFile,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
