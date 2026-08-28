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

function validDeployedAddress(value: unknown): string {
  const address = String(value || "").trim();
  return ethers.isAddress(address) && address !== ethers.ZeroAddress ? address : "";
}

function firstDeployedAddress(...values: unknown[]): string {
  for (const value of values) {
    const address = validDeployedAddress(value);
    if (address) return address;
  }
  return "";
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
  manifest.auxiliaryFeatures ||= {};
  let changed = false;

  const feeReceiver = validDeployedAddress(manifest.contracts.protocolRevenueVault);
  if (!feeReceiver) throw new Error("Staged manifest is missing ProtocolRevenueVault for UPVote fee forwarding.");
  await requireCode(feeReceiver, "ProtocolRevenueVault");

  let voteTreasuryAddress = validDeployedAddress(manifest.contracts.upVoteTreasury);
  if (voteTreasuryAddress && (await ethers.provider.getCode(voteTreasuryAddress)) !== "0x") {
    console.log(`[robinhood-aux] UPVoteTreasury already deployed at ${voteTreasuryAddress}`);
  } else {
    const UPVoteTreasury = await ethers.getContractFactory("UPVoteTreasury");
    const voteTreasury = await UPVoteTreasury.deploy(deployerAddress, feeReceiver);
    await voteTreasury.waitForDeployment();
    voteTreasuryAddress = await voteTreasury.getAddress();
    await requireCode(voteTreasuryAddress, "UPVoteTreasury");

    if ((await voteTreasury.owner()).toLowerCase() !== deployerAddress.toLowerCase()) throw new Error("UPVoteTreasury owner mismatch");
    if ((await voteTreasury.feeReceiver()).toLowerCase() !== feeReceiver.toLowerCase()) throw new Error("UPVoteTreasury fee receiver mismatch");
    const nativeConfig = await voteTreasury.assetConfig(ethers.ZeroAddress);
    if (!nativeConfig.enabled) throw new Error("UPVoteTreasury native voting is not enabled");

    manifest.contracts.upVoteTreasury = voteTreasuryAddress;
    manifest.auxiliaryFeatures.upVoteTreasury = {
      enabled: true,
      owner: deployerAddress,
      feeReceiver,
      nativeAssetEnabled: true,
      testnetOnly: true,
    };
    changed = true;
    console.log(`[robinhood-aux] UPVoteTreasury deployed at ${voteTreasuryAddress}`);
  }

  // The staged deployment manifest deliberately uses explicit mock-prefixed keys
  // so testnet infrastructure cannot be confused with production contracts.
  // Accept both the canonical production-style names and those staging-only keys.
  const swapRouter = firstDeployedAddress(
    manifest.contracts.v3SwapRouter,
    manifest.contracts.swapRouter,
    manifest.contracts.mockSwapRouter02,
    manifest.contracts.MockUniswapV3SwapRouter,
  );
  const wrappedNative = firstDeployedAddress(
    manifest.contracts.weth9,
    manifest.contracts.wrappedNative,
    manifest.contracts.mockWeth9,
    manifest.contracts.MockWETH9,
  );
  if (!swapRouter || !wrappedNative) {
    throw new Error("Staged manifest is missing Robinhood V3 swap router or wrapped native token.");
  }
  await Promise.all([
    requireCode(swapRouter, "Robinhood V3 swap router"),
    requireCode(wrappedNative, "Robinhood wrapped native"),
  ]);

  let nativeSwapAdapter = validDeployedAddress(manifest.contracts.v3NativeSwapAdapter);
  if (nativeSwapAdapter && (await ethers.provider.getCode(nativeSwapAdapter)) !== "0x") {
    console.log(`[robinhood-aux] RobinhoodV3NativeSwapAdapter already deployed at ${nativeSwapAdapter}`);
  } else {
    const Adapter = await ethers.getContractFactory("RobinhoodV3NativeSwapAdapter");
    const adapter = await Adapter.deploy(swapRouter, wrappedNative);
    await adapter.waitForDeployment();
    nativeSwapAdapter = await adapter.getAddress();
    await requireCode(nativeSwapAdapter, "RobinhoodV3NativeSwapAdapter");

    if ((await adapter.swapRouter()).toLowerCase() !== swapRouter.toLowerCase()) throw new Error("V3 native adapter router mismatch");
    if ((await adapter.wrappedNative()).toLowerCase() !== wrappedNative.toLowerCase()) throw new Error("V3 native adapter wrapped native mismatch");

    manifest.contracts.v3NativeSwapAdapter = nativeSwapAdapter;
    manifest.auxiliaryFeatures.v3NativeSwapAdapter = {
      enabled: true,
      swapRouter,
      wrappedNative,
      nativeAsset: "ETH",
      testnetOnly: true,
    };
    changed = true;
    console.log(`[robinhood-aux] RobinhoodV3NativeSwapAdapter deployed at ${nativeSwapAdapter}`);
  }

  if (changed) {
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log("[robinhood-aux] auxiliary Robinhood contracts ready", {
    upVoteTreasury: voteTreasuryAddress,
    v3NativeSwapAdapter: nativeSwapAdapter,
    manifest: manifestFile,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
