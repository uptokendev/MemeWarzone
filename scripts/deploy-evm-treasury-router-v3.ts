/**
 * Deploy TreasuryRouterV3 and the vaults it routes into.
 *
 * This is the prerequisite for scripts/deploy-bnb-quote-generation.ts, which
 * takes a router as input and refuses one that cannot serve strict routing.
 * BNB mainnet's current router has no creatorRewardsVault and fails that check,
 * so the new generation needs a new router.
 *
 * The admin may be an EOA -- TreasuryRouterV3 does not require a contract -- and
 * on a testnet that is the point: one key deploys and wires everything, with no
 * multisig ceremony in the way. On mainnet pass the Safe as BNB_ROUTER_ADMIN and
 * the vault wiring will have to come from the Safe, because the setters are
 * onlyAdmin. The script tells you which of the two it is doing.
 *
 *   CONFIRM_ROUTER_DEPLOY=I_UNDERSTAND_TESTNET \
 *     npx hardhat run scripts/deploy-evm-treasury-router-v3.ts --network bscTestnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const PROFILES: Record<string, { chainId: bigint; confirm: string; file: string }> = {
  bscTestnet: { chainId: 97n, confirm: "I_UNDERSTAND_TESTNET", file: "bnb/testnet.treasury-router-v3.json" },
  bscMainnet: { chainId: 56n, confirm: "I_UNDERSTAND_MAINNET", file: "bnb/mainnet.treasury-router-v3.json" },
  robinhoodTestnet: { chainId: 46630n, confirm: "I_UNDERSTAND_TESTNET", file: "robinhood/testnet.treasury-router-v3.json" },
  robinhoodMainnet: { chainId: 4663n, confirm: "I_UNDERSTAND_MAINNET", file: "robinhood/mainnet.treasury-router-v3.json" },
};

const UPGRADE_DELAY_SECONDS = 3600;

async function waitTx(txPromise: Promise<any> | any, label: string) {
  const tx = await txPromise;
  console.log(`[router] submitted ${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  return receipt;
}

async function main() {
  const profile = PROFILES[network.name];
  if (!profile) throw new Error(`Unsupported network ${network.name}`);
  if (String(process.env.CONFIRM_ROUTER_DEPLOY || "").trim() !== profile.confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_ROUTER_DEPLOY=${profile.confirm}.`);
  }

  const net = await ethers.provider.getNetwork();
  if (net.chainId !== profile.chainId) {
    throw new Error(`${network.name} expects chain ${profile.chainId}; got ${net.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer configured for this network.");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const admin = ethers.getAddress(String(process.env.BNB_ROUTER_ADMIN || "").trim() || deployerAddress);
  const adminIsDeployer = admin.toLowerCase() === deployerAddress.toLowerCase();

  const balance = await ethers.provider.getBalance(deployerAddress);
  console.log(`[router] network=${network.name} chainId=${net.chainId}`);
  console.log(`[router] deployer=${deployerAddress} balance=${ethers.formatEther(balance)}`);
  console.log(`[router] admin=${admin} (${adminIsDeployer ? "the deployer: this script can wire the vaults" : "not the deployer: vault wiring must come from it"})`);
  if (balance === 0n) throw new Error("Deployer has no gas on this network.");

  // League destinations. Overridable so a real vault can be used where one
  // exists; otherwise a plain receiver, which is all a testnet needs.
  //
  // Never on mainnet. A placeholder here is an AcceptingReceiver: it takes the
  // money and has no way to pay anyone out of it, so a mainnet router wired to
  // one would route real league fees into a contract nobody can spend from.
  // Nothing about that fails loudly, which is exactly why it is refused rather
  // than warned about.
  const isMainnet = profile.confirm === "I_UNDERSTAND_MAINNET";
  const Receiver = await ethers.getContractFactory("AcceptingReceiver");
  async function destination(envName: string, label: string): Promise<string> {
    const supplied = String(process.env[envName] || "").trim();
    if (supplied) {
      const address = ethers.getAddress(supplied);
      const code = await ethers.provider.getCode(address);
      if (!code || code === "0x") throw new Error(`${envName} ${address} has no code`);
      console.log(`[router] ${label} = ${address} (supplied)`);
      return address;
    }
    if (isMainnet) {
      throw new Error(
        `${envName} is required on ${network.name}. This script only deploys a placeholder receiver, ` +
          `which accepts ${label} fees and can never pay them out. Supply the real vault.`,
      );
    }
    const deployed = await Receiver.deploy();
    await deployed.waitForDeployment();
    const address = ethers.getAddress(await deployed.getAddress());
    console.log(`[router] ${label} = ${address} (deployed placeholder -- testnet only)`);
    return address;
  }

  const weeklyLeagueVault = await destination("BNB_WEEKLY_LEAGUE_VAULT", "weeklyLeagueVault");
  const monthlyLeagueTreasury = await destination("BNB_MONTHLY_LEAGUE_TREASURY", "monthlyLeagueTreasury");
  const recruiterRewardsVault = await destination("BNB_RECRUITER_VAULT", "recruiterRewardsVault");
  const protocolRevenueVault = await destination("BNB_PROTOCOL_VAULT", "protocolRevenueVault");

  const Router = await ethers.getContractFactory("TreasuryRouterV3");
  const router = await Router.deploy(admin, weeklyLeagueVault, monthlyLeagueTreasury, UPGRADE_DELAY_SECONDS);
  await router.waitForDeployment();
  const routerAddress = ethers.getAddress(await router.getAddress());
  console.log(`[router] TreasuryRouterV3 = ${routerAddress}`);

  // These two take the router in their constructor, so they come after it.
  const Community = await ethers.getContractFactory("CommunityRewardsVault");
  const communityRewardsVault = await Community.deploy(admin, routerAddress);
  await communityRewardsVault.waitForDeployment();
  const communityAddress = ethers.getAddress(await communityRewardsVault.getAddress());

  const Creator = await ethers.getContractFactory("CreatorRewardsVault");
  const creatorRewardsVault = await Creator.deploy(admin, routerAddress);
  await creatorRewardsVault.waitForDeployment();
  const creatorAddress = ethers.getAddress(await creatorRewardsVault.getAddress());
  console.log(`[router] CommunityRewardsVault = ${communityAddress}`);
  console.log(`[router] CreatorRewardsVault = ${creatorAddress}`);

  const wiring: Array<[string, string]> = [
    ["setRecruiterRewardsVault", recruiterRewardsVault],
    ["setCommunityRewardsVault", communityAddress],
    ["setProtocolRevenueVault", protocolRevenueVault],
    ["setCreatorRewardsVault", creatorAddress],
  ];

  if (adminIsDeployer) {
    for (const [fn, target] of wiring) {
      await waitTx((router as any)[fn](target), `${fn}(${target})`);
    }
    // The check deploy-bnb-quote-generation.ts will make.
    for (const name of ["creatorRewardsVault", "recruiterRewardsVault", "communityRewardsVault", "protocolRevenueVault"] as const) {
      const value = await (router as any)[name]();
      if (value === ethers.ZeroAddress) throw new Error(`${name} is still unset`);
      console.log(`[router] ok ${name}=${value}`);
    }
    console.log("[router] router is ready to be passed to deploy-bnb-quote-generation.ts");
  } else {
    const iface = (router as any).interface;
    console.log("\n[router] admin is not the deployer, so these four calls must come from it:");
    for (const [fn, target] of wiring) {
      console.log(`  to=${routerAddress}`);
      console.log(`  data=${iface.encodeFunctionData(fn, [target])}   # ${fn}`);
    }
    console.log("[router] the generation cannot be deployed until all four have executed.");
  }

  const artifact = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    admin,
    adminIsDeployer,
    wired: adminIsDeployer,
    contracts: {
      TreasuryRouterV3: routerAddress,
      CommunityRewardsVault: communityAddress,
      CreatorRewardsVault: creatorAddress,
      weeklyLeagueVault,
      monthlyLeagueTreasury,
      recruiterRewardsVault,
      protocolRevenueVault,
    },
  };
  const out = path.join(__dirname, "..", "deployments", profile.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[router] wrote ${out}`);
  // Which generation script follows depends on the chain, not on this script.
  const generation = network.name.startsWith("robinhood")
    ? `RH_TREASURY_ROUTER=${routerAddress} npx hardhat run scripts/deploy-robinhood-quote-generation.ts --network ${network.name}`
    : `BNB_TREASURY_ROUTER=${routerAddress} npx hardhat run scripts/deploy-bnb-quote-generation.ts --network ${network.name}`;
  console.log(`[router] next (after the admin has set all four vaults): ${generation}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
