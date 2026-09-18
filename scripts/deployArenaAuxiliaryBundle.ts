import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const NETWORK_BY_CHAIN: Record<number, string> = {
  56: "bscMainnet",
  97: "bscTestnet",
  4663: "robinhoodMainnet",
  46630: "robinhoodTestnet",
};

function requiredAddress(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
  return ethers.getAddress(value);
}

function optionalAddress(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) return "";
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero EVM address`);
  return ethers.getAddress(value);
}

function chainSuffix(chainId: number) {
  if (chainId === 56) return "bsc56";
  if (chainId === 97) return "bsc97";
  if (chainId === 4663) return "robinhood4663";
  if (chainId === 46630) return "robinhood46630";
  throw new Error(`Unsupported Arena auxiliary deployment chain ${chainId}`);
}

async function codeHash(address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`Missing runtime bytecode at ${address}`);
  return ethers.keccak256(code);
}

async function receipt(tx: any, label: string) {
  const r = await tx.wait();
  if (!r || Number(r.status) !== 1) throw new Error(`${label} failed`);
  return { txHash: tx.hash, blockNumber: Number(r.blockNumber) };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Arena auxiliary deployer signer is required");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const expectedNetwork = NETWORK_BY_CHAIN[chainId];
  if (!expectedNetwork || network.name !== expectedNetwork) {
    throw new Error(`Arena auxiliary bundle requires exact supported network binding; got ${network.name}/${chainId}`);
  }

  const outputFile = String(process.env.ARENA_AUX_DEPLOYMENT_FILE || "").trim() ||
    path.join("deployments", "arena", `auxiliary.${chainSuffix(chainId)}.json`);
  if (fs.existsSync(outputFile)) throw new Error(`Arena auxiliary deployment artifact already exists; refusing to overwrite: ${outputFile}`);

  const owner = requiredAddress(`ARENA_AUX_OWNER_${chainId}`);
  const quoteSigner = requiredAddress(`ARENA_SPONSORSHIP_QUOTE_SIGNER_ADDRESS_${chainId}`);
  const marketingReceiver = requiredAddress(`ARENA_SPONSORSHIP_MARKETING_RECEIVER_${chainId}`);
  const protocolReceiver = requiredAddress(`ARENA_PROTOCOL_RECEIVER_${chainId}`);
  const voteFeeReceiver = requiredAddress(`ARENA_VOTE_FEE_RECEIVER_${chainId}`);
  const launchpadVoteTreasury = optionalAddress(`VOTE_TREASURY_ADDRESS_${chainId}`);

  if (quoteSigner === marketingReceiver || quoteSigner === protocolReceiver) {
    throw new Error("Sponsorship quote signer must be distinct from payment receivers");
  }
  if (marketingReceiver === protocolReceiver) {
    throw new Error("Sponsorship marketing and protocol receivers must be distinct");
  }

  const Vault = await ethers.getContractFactory("EventPrizeVaultV1", deployer);
  const vault = await Vault.deploy(owner);
  const vaultDeployTx = vault.deploymentTransaction();
  const vaultDeploy = vaultDeployTx ? await receipt(vaultDeployTx, "EventPrizeVaultV1 deployment") : null;
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  const Router = await ethers.getContractFactory("WarzoneSponsorshipRouterV1", deployer);
  const router = await Router.deploy(owner, quoteSigner, vaultAddress, marketingReceiver, protocolReceiver);
  const routerDeployTx = router.deploymentTransaction();
  const routerDeploy = routerDeployTx ? await receipt(routerDeployTx, "WarzoneSponsorshipRouterV1 deployment") : null;
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();

  const setRouter = await receipt(await vault.setRouter(routerAddress), "EventPrizeVaultV1.setRouter");
  const pauseRouter = await receipt(await router.setPaymentsPaused(true), "WarzoneSponsorshipRouterV1.setPaymentsPaused");

  const Vote = await ethers.getContractFactory("UPVoteTreasury", deployer);
  const vote = await Vote.deploy(owner, voteFeeReceiver);
  const voteDeployTx = vote.deploymentTransaction();
  const voteDeploy = voteDeployTx ? await receipt(voteDeployTx, "Arena UPVoteTreasury deployment") : null;
  await vote.waitForDeployment();
  const voteAddress = await vote.getAddress();

  if (launchpadVoteTreasury && launchpadVoteTreasury.toLowerCase() === voteAddress.toLowerCase()) {
    throw new Error("Arena vote treasury unexpectedly collides with launchpad vote treasury");
  }
  const disableNativeVote = await receipt(
    await vote.setAsset(ethers.ZeroAddress, false, 0),
    "Arena UPVoteTreasury disable native asset",
  );

  if ((await vault.owner()).toLowerCase() !== owner.toLowerCase()) throw new Error("EventPrizeVaultV1 owner mismatch");
  if ((await vault.router()).toLowerCase() !== routerAddress.toLowerCase()) throw new Error("EventPrizeVaultV1 router mismatch");
  if ((await router.owner()).toLowerCase() !== owner.toLowerCase()) throw new Error("Sponsorship router owner mismatch");
  if ((await router.quoteSigner()).toLowerCase() !== quoteSigner.toLowerCase()) throw new Error("Sponsorship quote signer mismatch");
  if ((await router.eventPrizeVault()).toLowerCase() !== vaultAddress.toLowerCase()) throw new Error("Sponsorship vault mismatch");
  if ((await router.marketingReceiver()).toLowerCase() !== marketingReceiver.toLowerCase()) throw new Error("Sponsorship marketing receiver mismatch");
  if ((await router.protocolReceiver()).toLowerCase() !== protocolReceiver.toLowerCase()) throw new Error("Sponsorship protocol receiver mismatch");
  if ((await router.paymentsPaused()) !== true) throw new Error("Sponsorship router must deploy dark/paused");
  if ((await vote.owner()).toLowerCase() !== owner.toLowerCase()) throw new Error("Arena vote owner mismatch");
  if ((await vote.feeReceiver()).toLowerCase() !== voteFeeReceiver.toLowerCase()) throw new Error("Arena vote fee receiver mismatch");
  const nativeVote = await vote.assetConfig(ethers.ZeroAddress);
  if (nativeVote.enabled !== false) throw new Error("Arena vote native asset must remain disabled until activation");

  const artifact = {
    schema: "memewarzone.arena-auxiliary-bundle.v1",
    createdAt: new Date().toISOString(),
    chainId,
    network: network.name,
    deployer: ethers.getAddress(deployer.address),
    contracts: {
      eventPrizeVaultV1: {
        address: vaultAddress,
        generation: Number(await vault.GENERATION()),
        owner,
        router: routerAddress,
        runtimeBytecodeHash: await codeHash(vaultAddress),
        deploymentTxHash: vaultDeploy?.txHash || null,
      },
      warzoneSponsorshipRouterV1: {
        address: routerAddress,
        generation: Number(await router.GENERATION()),
        owner,
        quoteSigner,
        eventPrizeVault: vaultAddress,
        marketingReceiver,
        protocolReceiver,
        paymentsPaused: true,
        runtimeBytecodeHash: await codeHash(routerAddress),
        deploymentTxHash: routerDeploy?.txHash || null,
      },
      arenaVoteTreasury: {
        address: voteAddress,
        owner,
        feeReceiver: voteFeeReceiver,
        launchpadVoteTreasury: launchpadVoteTreasury || null,
        nativeAssetEnabled: false,
        runtimeBytecodeHash: await codeHash(voteAddress),
        deploymentTxHash: voteDeploy?.txHash || null,
      },
    },
    economics: {
      sponsorship: { eventBps: 7000, marketingBps: 2000, protocolBps: 1000 },
    },
    configurationTransactions: {
      vaultSetRouter: setRouter.txHash,
      sponsorshipPause: pauseRouter.txHash,
      arenaVoteDisableNative: disableNativeVote.txHash,
    },
    activation: {
      sponsorshipPayments: false,
      arenaVoteNativeAsset: false,
      note: "Deployment only. Configure event receivers/enabled events and vote minimums before activation.",
    },
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    chainId,
    network: network.name,
    artifact: outputFile,
    EVENT_PRIZE_VAULT_V1_ADDRESS: vaultAddress,
    WARZONE_SPONSORSHIP_ROUTER_V1_ADDRESS: routerAddress,
    ARENA_VOTE_TREASURY_ADDRESS: voteAddress,
    activation: "dark",
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
