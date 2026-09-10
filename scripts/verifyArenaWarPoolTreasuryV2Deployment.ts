import fs from "node:fs";
import { ethers, network } from "hardhat";

const {
  assertArenaV2DeploymentTarget,
  defaultArenaV2DeploymentFile,
} = require("./lib/arenaV2DeploymentPolicy.cjs");

function truthy(value: unknown) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function expectEq(actual: unknown, expected: unknown, label: string) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function requireSuccessfulReceipt(hash: string | null | undefined, label: string) {
  if (!hash) return null;
  const receipt = await ethers.provider.getTransactionReceipt(hash);
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} receipt missing or failed: ${hash}`);
  return receipt;
}

async function main() {
  const providerNetwork = await ethers.provider.getNetwork();
  const chainId = Number(providerNetwork.chainId);
  assertArenaV2DeploymentTarget(chainId, network.name, {
    allowLocal: truthy(process.env.ARENA_V2_ALLOW_LOCAL),
  });

  const artifactPath = String(process.env.ARENA_V2_DEPLOYMENT_FILE || "").trim() || defaultArenaV2DeploymentFile(chainId);
  if (!fs.existsSync(artifactPath)) throw new Error(`Arena V2 deployment artifact not found: ${artifactPath}`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  expectEq(artifact.schema, "memewarzone.arena-war-pool-treasury-v2.deployment.v1", "artifact schema");
  expectEq(artifact.chainId, chainId, "artifact chainId");
  expectEq(artifact.network, network.name, "artifact network");

  const war = artifact.contracts?.arenaWarPoolTreasuryV2;
  const leagueRecord = artifact.contracts?.postGradLeagueTreasuryV2;
  if (!war?.address || !leagueRecord?.address) throw new Error("Artifact is missing Arena/League V2 addresses");

  const warCode = await ethers.provider.getCode(war.address);
  const leagueCode = await ethers.provider.getCode(leagueRecord.address);
  if (!warCode || warCode === "0x") throw new Error(`ArenaWarPoolTreasuryV2 has no bytecode: ${war.address}`);
  if (!leagueCode || leagueCode === "0x") throw new Error(`PostGradLeagueTreasuryV2 has no bytecode: ${leagueRecord.address}`);
  expectEq(ethers.keccak256(warCode), war.runtimeBytecodeHash, "ArenaWarPoolTreasuryV2 runtime bytecode hash");
  expectEq(ethers.keccak256(leagueCode), leagueRecord.runtimeBytecodeHash, "PostGradLeagueTreasuryV2 runtime bytecode hash");

  const warPool: any = await ethers.getContractAt("ArenaWarPoolTreasuryV2", war.address);
  const league: any = await ethers.getContractAt("PostGradLeagueTreasuryV2", leagueRecord.address);

  expectEq(await warPool.GENERATION(), 2n, "ArenaWarPoolTreasuryV2 generation");
  expectEq(await league.GENERATION(), 2n, "PostGradLeagueTreasuryV2 generation");
  expectEq(await warPool.owner(), war.owner, "Arena owner");
  expectEq(await warPool.resolver(), war.resolver, "Arena resolver");
  expectEq(await warPool.boostQuoteSigner(), war.boostQuoteSigner, "Arena Boost quote signer");
  expectEq(await warPool.protocolReceiver(), war.protocolReceiver, "Arena protocol receiver");
  expectEq(await warPool.postGradLeagueTreasury(), leagueRecord.address, "Arena League V2 address");
  expectEq(await league.owner(), leagueRecord.owner, "League owner");
  expectEq(await league.monthlyReceiver(), leagueRecord.monthlyReceiver, "League monthly receiver");
  expectEq(await league.quarterlyReceiver(), leagueRecord.quarterlyReceiver, "League quarterly receiver");

  if (!(await league.authorizedSources(war.address))) throw new Error("WarPool is not authorized as PostGradLeagueTreasuryV2 source");

  expectEq(await warPool.ENTRY_LEAGUE_BPS(), 2_000n, "competition league BPS");
  expectEq(await warPool.ENTRY_PROTOCOL_BPS(), 500n, "competition protocol BPS");
  expectEq(await warPool.BOOST_PROTOCOL_BPS(), 1_000n, "Boost protocol BPS");
  expectEq(await league.MONTHLY_BPS(), 6_000n, "PostGrad League monthly BPS");
  expectEq(artifact.economics?.competition?.prizeBps, 7_500, "artifact competition prize BPS");
  expectEq(artifact.economics?.competition?.leagueBps, 2_000, "artifact competition league BPS");
  expectEq(artifact.economics?.competition?.protocolBps, 500, "artifact competition protocol BPS");
  expectEq(artifact.economics?.boost?.prizeBps, 9_000, "artifact Boost prize BPS");
  expectEq(artifact.economics?.boost?.protocolBps, 1_000, "artifact Boost protocol BPS");

  const warDeployReceipt = await requireSuccessfulReceipt(war.deploymentTxHash, "ArenaWarPoolTreasuryV2 deployment");
  await requireSuccessfulReceipt(leagueRecord.deploymentTxHash, "PostGradLeagueTreasuryV2 deployment");
  await requireSuccessfulReceipt(
    artifact.configurationTransactions?.leagueSourceAuthorization,
    "PostGradLeagueTreasuryV2 source authorization",
  );
  await requireSuccessfulReceipt(
    artifact.configurationTransactions?.leagueOwnershipTransfer,
    "PostGradLeagueTreasuryV2 ownership transfer",
  );

  if (warDeployReceipt && Number(warDeployReceipt.blockNumber) !== Number(artifact.deploymentBlock)) {
    throw new Error(
      `Arena deployment block mismatch: artifact=${artifact.deploymentBlock} receipt=${warDeployReceipt.blockNumber}`,
    );
  }

  console.log(`Arena V2 deployment attested: ${network.name}/${chainId}`);
  console.log(`ArenaWarPoolTreasuryV2=${war.address}`);
  console.log(`PostGradLeagueTreasuryV2=${leagueRecord.address}`);
  console.log(`GENERATION=2 LeagueGeneration=2`);
  console.log(`Competition=75/20/5 Boost=90/10`);
  console.log(`Artifact=${artifactPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
