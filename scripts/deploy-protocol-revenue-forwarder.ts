/**
 * Deploys ProtocolRevenueForwarder (contracts/ProtocolRevenueForwarder.sol) on BNB 56 or Robinhood 4663 and
 * writes the two Safe batches that point TreasuryRouterV4 at it (scripts/make-protocol-forwarder-batches.ts).
 *
 * The deployer only pays gas for one CREATE. The constructor is not payable, the forwarder has no owner and no
 * setter, its admin is the Safe from construction, and it holds nothing after a flush: the deployer never holds
 * or controls user money. Every router change is a Safe transaction (S1 propose, >= 3600 s, S2 accept).
 *
 * Default is a DRY RUN: it reads the live pins with eth_call, prints the deployer, its nonce and balance, the
 * predicted forwarder address and the constructor arguments, simulates the deployment with eth_call, and
 * sends nothing. Sending requires all of:
 *   CONFIRM_PROTOCOL_FORWARDER_DEPLOY=I_UNDERSTAND_MAINNET, an interactive terminal, no CI,
 *   and a network profile below (or a verified local anvil fork alias, scripts/lib/forkRehearsal.ts).
 *
 *   npx hardhat run scripts/deploy-protocol-revenue-forwarder.ts --network bscMainnet          # dry run
 *   CONFIRM_PROTOCOL_FORWARDER_DEPLOY=I_UNDERSTAND_MAINNET \
 *     npx hardhat run scripts/deploy-protocol-revenue-forwarder.ts --network bscMainnet        # deploy
 *   (same with --network robinhoodMainnet)
 *
 * Afterwards (printed at the end): add the forwarder to config/verification/mainnet-contracts.json and run
 * `ONLY=ProtocolRevenueForwarder npx hardhat run scripts/verify-mainnet-contracts.ts --network <net>`
 * (BscScan via Etherscan v2 on 56, Sourcify on 4663); then import S1 in the Safe Transaction Builder.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { FORWARDER_PINS, ROUTER_UPGRADE_DELAY_SECONDS, writeForwarderBatches, type ForwarderChainKey } from "./make-protocol-forwarder-batches";
import { isForkRehearsalNetwork, profileNetworkName, rehearsalPath } from "./lib/forkRehearsal";

const PROFILES: Record<string, { key: ForwarderChainKey; dir: string; confirm: string }> = {
  bscMainnet: { key: "bnb", dir: "bnb", confirm: "I_UNDERSTAND_MAINNET" },
  robinhoodMainnet: { key: "robinhood", dir: "robinhood", confirm: "I_UNDERSTAND_MAINNET" },
};

/** The mainnet deployer of every EVM generation (deployments/bnb/mainnet.quote-generation.json). */
const DEFAULT_DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function verifyForwarderPins(key: ForwarderChainKey) {
  const p = FORWARDER_PINS[key];
  const router = new ethers.Contract(
    p.router,
    [
      "function admin() view returns (address)",
      "function upgradeDelay() view returns (uint64)",
      "function protocolRevenueVault() view returns (address)",
      "function pendingProtocolRevenueVault() view returns (address)",
    ],
    ethers.provider,
  );
  const vault = new ethers.Contract(p.vault, ["function admin() view returns (address)", "function operator() view returns (address)", "function overflowTreasury() view returns (address)"], ethers.provider);
  const read = {
    routerAdmin: String(await router.admin()),
    upgradeDelay: Number(await router.upgradeDelay()),
    protocolRevenueVault: String(await router.protocolRevenueVault()),
    pendingProtocolRevenueVault: String(await router.pendingProtocolRevenueVault()),
    vaultAdmin: String(await vault.admin()),
    vaultOperator: String(await vault.operator()),
    vaultOverflow: String(await vault.overflowTreasury()),
    wrappedHasCode: (await ethers.provider.getCode(p.wrappedNative)).length > 2,
  };
  const problems: string[] = [];
  if (!same(read.routerAdmin, p.safe)) problems.push(`router.admin ${read.routerAdmin} != Safe ${p.safe}`);
  if (read.upgradeDelay !== ROUTER_UPGRADE_DELAY_SECONDS) problems.push(`router.upgradeDelay ${read.upgradeDelay}`);
  if (!same(read.protocolRevenueVault, p.vault)) problems.push(`router.protocolRevenueVault ${read.protocolRevenueVault} != pinned vault ${p.vault}`);
  if (read.pendingProtocolRevenueVault !== ethers.ZeroAddress) problems.push(`a protocol vault is already pending: ${read.pendingProtocolRevenueVault}`);
  if (!same(read.vaultAdmin, p.safe)) problems.push(`vault.admin ${read.vaultAdmin} != Safe`);
  if (!read.wrappedHasCode) problems.push(`no code at ${p.wrappedSymbol} ${p.wrappedNative}`);
  if (problems.length) throw new Error(`pins differ from chain:\n  ${problems.join("\n  ")}`);
  return read;
}

function sendAllowed(profileName: string): boolean {
  const profile = PROFILES[profileName];
  if (String(process.env.CONFIRM_PROTOCOL_FORWARDER_DEPLOY || "").trim() !== profile.confirm) return false;
  if (isForkRehearsalNetwork()) return true;
  if (process.env.CI || !process.stdin.isTTY) throw new Error("Refusing to send from a non-interactive shell: this runs only from the founder's terminal.");
  return true;
}

export async function main() {
  const profileName = await profileNetworkName();
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`run with --network bscMainnet | robinhoodMainnet (or their fork aliases); got ${network.name}`);
  const p = FORWARDER_PINS[profile.key];
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== p.chainId) throw new Error(`provider is chain ${chainId}, expected ${p.chainId}`);

  const pins = await verifyForwarderPins(profile.key);
  console.log(`[forwarder] ${p.label} pins read back: ${JSON.stringify(pins)}`);

  // No key is needed for the dry run: without a signer it plans from the known mainnet deployer
  // (FORWARDER_DEPLOYER_ADDRESS overrides) and can never send.
  const [signer] = await ethers.getSigners();
  const deployerAddress = signer?.address ?? ethers.getAddress(process.env.FORWARDER_DEPLOYER_ADDRESS || DEFAULT_DEPLOYER);
  if (same(deployerAddress, p.safe)) throw new Error("the deployer must not be the Safe");
  const nonce = await ethers.provider.getTransactionCount(deployerAddress, "pending");
  const predicted = ethers.getCreateAddress({ from: deployerAddress, nonce });
  const args = [p.safe, p.vault, p.wrappedNative] as const;
  const Forwarder = await ethers.getContractFactory("ProtocolRevenueForwarder");
  const deployTx = await Forwarder.getDeployTransaction(...args);
  // eth_call the creation: the constructor's checks (codes, sink admin == Safe) run against live state.
  await ethers.provider.call({ from: deployerAddress, data: deployTx.data });
  const gas = await ethers.provider.estimateGas({ from: deployerAddress, data: deployTx.data });
  console.log(`[forwarder] deployer ${deployerAddress} nonce ${nonce} balance ${ethers.formatEther(await ethers.provider.getBalance(deployerAddress))}${signer ? "" : " (no signer loaded: plan only)"}`);
  console.log(`[forwarder] constructor(admin=${args[0]}, nativeSink=${args[1]}, wrappedNative=${args[2]})  est. gas ${gas}`);
  console.log(`[forwarder] predicted address ${predicted}`);

  if (!signer || !sendAllowed(profileName)) {
    console.log(`[forwarder] DRY RUN: nothing sent. Set CONFIRM_PROTOCOL_FORWARDER_DEPLOY=${profile.confirm} in the founder's terminal (deployer key loaded) to deploy.`);
    return { dryRun: true, predicted, deployer: deployerAddress, gas };
  }
  const deployer = signer;

  const forwarder: any = await Forwarder.connect(deployer).deploy(...args);
  const receipt = await forwarder.deploymentTransaction()!.wait();
  const address = await forwarder.getAddress();
  if (!same(address, predicted)) throw new Error(`forwarder landed at ${address}, predicted ${predicted}`);
  const readBack = { admin: String(await forwarder.admin()), nativeSink: String(await forwarder.nativeSink()), wrappedNative: String(await forwarder.wrappedNative()) };
  if (!same(readBack.admin, p.safe) || !same(readBack.nativeSink, p.vault) || !same(readBack.wrappedNative, p.wrappedNative)) throw new Error(`read-back mismatch ${JSON.stringify(readBack)}`);
  if ((await ethers.provider.getBalance(address)) !== 0n) throw new Error("forwarder holds native right after deploy");

  const record = {
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contract: "ProtocolRevenueForwarder",
    address,
    deployTx: receipt?.hash,
    deployBlock: receipt?.blockNumber,
    constructorArgs: { admin: p.safe, nativeSink: p.vault, wrappedNative: p.wrappedNative },
    router: p.router,
    note: "Router change pending: Safe batches PF1 (propose) then, >= 3600 s later, PF2 (accept).",
  };
  const dir = path.join(__dirname, "..", "deployments", profile.dir);
  const recordFile = rehearsalPath(path.join(dir, "mainnet.protocol-revenue-forwarder.json"));
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  const batchDir = path.dirname(rehearsalPath(path.join(dir, "x.json")));
  const files = writeForwarderBatches(profile.key, address, batchDir);
  console.log(`[forwarder] deployed ${address} (tx ${receipt?.hash}, block ${receipt?.blockNumber})`);
  console.log(`[forwarder] record ${recordFile}`);
  console.log(`[forwarder] Safe S1 ${files.s1}`);
  console.log(`[forwarder] Safe S2 ${files.s2} (execute >= ${ROUTER_UPGRADE_DELAY_SECONDS} s after S1)`);
  console.log("[forwarder] verification entry for config/verification/mainnet-contracts.json:");
  console.log(JSON.stringify({ name: "ProtocolRevenueForwarder", contract: "contracts/ProtocolRevenueForwarder.sol:ProtocolRevenueForwarder", address, args: [p.safe, p.vault, p.wrappedNative] }, null, 2));
  console.log(`[forwarder] then: ONLY=ProtocolRevenueForwarder npx hardhat run scripts/verify-mainnet-contracts.ts --network ${profileName}`);
  return { dryRun: false, address, files, record };
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
