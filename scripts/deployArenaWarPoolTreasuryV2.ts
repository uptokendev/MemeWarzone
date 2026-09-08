import { ethers } from "hardhat";

/**
 * Deploys the EVM Arena competition V2 money path without touching historical V1.
 *
 * Founder-locked V2 economics:
 *   entry/buy-in: 75% prize / 20% Post-Grad League / 5% protocol
 *   Battle/Tournament Boost: 90% prize / 10% protocol
 *   Post-Grad League V2: 60% Monthly MWL / 40% Quarterly reserve
 *
 * Supported production/test deployment pass: BSC mainnet (56) and BSC testnet (97).
 * Solana and Robinhood money paths are explicitly out of scope here.
 * Chain 31337 is accepted only when ARENA_V2_ALLOW_LOCAL=1 for isolated CI/local rehearsal.
 *
 * Required:
 *   ARENA_V2_RESOLVER=<address>
 *   ARENA_BOOST_QUOTE_SIGNER_ADDRESS=<address>
 *   ARENA_PROTOCOL_RECEIVER=<address>
 *
 * And either:
 *   ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS_<chain>=<existing address>
 *
 * Or both receivers so this script can deploy PostGradLeagueTreasuryV2:
 *   ARENA_MONTHLY_MWL_RECEIVER=<address>
 *   ARENA_QUARTERLY_RESERVE_RECEIVER=<address>
 *
 * Optional:
 *   ARENA_V2_OWNER=<address>                 defaults to deployer
 *   ARENA_LEAGUE_V2_OWNER=<address>          defaults to ARENA_V2_OWNER
 *
 * A fresh League V2 is bootstrapped under the deployer only long enough to
 * authorize the new WarPool source, then ownership is transferred to the
 * configured final League owner before the script exits.
 *
 * Example:
 *   npx hardhat run scripts/deployArenaWarPoolTreasuryV2.ts --network bscTestnet
 */

function envAddress(names: string[], required = true): string {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (!value) continue;
    if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
      throw new Error(`${name} must be a non-zero EVM address`);
    }
    return ethers.getAddress(value);
  }
  if (required) throw new Error(`Missing required address env: ${names.join(" or ")}`);
  return "";
}

function truthy(value: unknown) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

async function requireContract(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode: ${address}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const localRehearsal = chainId === 31337 && truthy(process.env.ARENA_V2_ALLOW_LOCAL);
  if (![56, 97].includes(chainId) && !localRehearsal) {
    throw new Error(`Arena EVM V2 deployment is restricted to BSC 56/97 in this phase; got chain ${chainId}`);
  }

  const owner = envAddress(["ARENA_V2_OWNER"], false) || deployer.address;
  const leagueOwner = envAddress(["ARENA_LEAGUE_V2_OWNER"], false) || owner;
  const resolver = envAddress(["ARENA_V2_RESOLVER", "ARENA_WAR_POOL_RESOLVER", "RESOLVER"]);
  const boostQuoteSigner = envAddress([
    `ARENA_BOOST_QUOTE_SIGNER_ADDRESS_${chainId}`,
    "ARENA_BOOST_QUOTE_SIGNER_ADDRESS",
  ]);
  const protocolReceiver = envAddress([
    `ARENA_PROTOCOL_RECEIVER_${chainId}`,
    "ARENA_PROTOCOL_RECEIVER",
    `PROTOCOL_REVENUE_VAULT_ADDRESS_${chainId}`,
    "PROTOCOL_REVENUE_VAULT_ADDRESS",
  ]);

  const existingLeague = envAddress(
    [
      `ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS_${chainId}`,
      "ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS",
    ],
    false,
  );

  let leagueAddress: string;
  let league: any;
  let deployedLeague = false;
  if (existingLeague) {
    await requireContract(existingLeague, "PostGradLeagueTreasuryV2");
    leagueAddress = existingLeague;
    league = await ethers.getContractAt("PostGradLeagueTreasuryV2", leagueAddress);
    const generation = await league.GENERATION();
    if (generation !== 2n) throw new Error(`Existing PostGradLeagueTreasuryV2 has unexpected generation ${generation}`);
    console.log("PostGradLeagueTreasuryV2: attaching", leagueAddress);
  } else {
    const monthlyReceiver = envAddress([
      `ARENA_MONTHLY_MWL_RECEIVER_${chainId}`,
      "ARENA_MONTHLY_MWL_RECEIVER",
    ]);
    const quarterlyReceiver = envAddress([
      `ARENA_QUARTERLY_RESERVE_RECEIVER_${chainId}`,
      "ARENA_QUARTERLY_RESERVE_RECEIVER",
    ]);
    const League = await ethers.getContractFactory("PostGradLeagueTreasuryV2");
    league = await League.deploy(deployer.address, monthlyReceiver, quarterlyReceiver);
    await league.waitForDeployment();
    leagueAddress = await league.getAddress();
    deployedLeague = true;
    console.log("PostGradLeagueTreasuryV2: deployed", leagueAddress);
  }

  const WarPool = await ethers.getContractFactory("ArenaWarPoolTreasuryV2");
  const warPool = await WarPool.deploy(owner, resolver, boostQuoteSigner, protocolReceiver, leagueAddress);
  await warPool.waitForDeployment();
  const warPoolAddress = await warPool.getAddress();

  if ((await warPool.GENERATION()) !== 2n) throw new Error("ArenaWarPoolTreasuryV2 generation invariant failed");
  if ((await warPool.ENTRY_LEAGUE_BPS()) !== 2_000n) throw new Error("Arena V2 league split invariant failed");
  if ((await warPool.ENTRY_PROTOCOL_BPS()) !== 500n) throw new Error("Arena V2 protocol split invariant failed");
  if ((await warPool.BOOST_PROTOCOL_BPS()) !== 1_000n) throw new Error("Arena V2 Boost split invariant failed");
  if ((await warPool.boostQuoteSigner()).toLowerCase() !== boostQuoteSigner.toLowerCase()) {
    throw new Error("Arena V2 Boost quote signer invariant failed");
  }
  if ((await warPool.postGradLeagueTreasury()).toLowerCase() !== leagueAddress.toLowerCase()) {
    throw new Error("Arena V2 League treasury invariant failed");
  }

  const currentLeagueOwner = ethers.getAddress(await league.owner());
  if (currentLeagueOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Existing PostGradLeagueTreasuryV2 owner ${currentLeagueOwner} must authorize ${warPoolAddress} as a source. ` +
        `Rerun this script with the League owner signer or authorize the source explicitly before activation.`,
    );
  }

  const sourceTx = await league.setSource(warPoolAddress, true);
  await sourceTx.wait();
  if (!(await league.authorizedSources(warPoolAddress))) {
    throw new Error("PostGradLeagueTreasuryV2 source authorization invariant failed");
  }

  if (deployedLeague && leagueOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    const transferTx = await league.transferOwnership(leagueOwner);
    await transferTx.wait();
  }
  if ((await league.owner()).toLowerCase() !== leagueOwner.toLowerCase()) {
    throw new Error("PostGradLeagueTreasuryV2 final ownership invariant failed");
  }

  console.log("ArenaWarPoolTreasuryV2:", warPoolAddress);
  console.log("Boost quote signer:", boostQuoteSigner);
  console.log("Protocol receiver:", protocolReceiver);
  console.log("Post-Grad League V2:", leagueAddress);
  console.log("Post-Grad League V2 owner:", await league.owner());
  console.log("");
  console.log(`# Persist these server/runtime addresses for chain ${chainId}:`);
  console.log(`ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${chainId}=${warPoolAddress}`);
  console.log(`ARENA_POSTGRAD_LEAGUE_TREASURY_V2_ADDRESS_${chainId}=${leagueAddress}`);
  console.log(`ARENA_BOOST_QUOTE_SIGNER_ADDRESS_${chainId}=${boostQuoteSigner}`);
  console.log("");
  console.log("Do not set ARENA_BATTLE_BOOSTS=true until indexer confirmation and pricing freshness config are ready.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
