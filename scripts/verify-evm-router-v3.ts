/**
 * Read-only. Given a TreasuryRouterV3 address, verify it and print the Safe
 * transactions still owed, so a truncated deploy log costs nothing.
 *
 *   ROUTER=0x... npx hardhat run scripts/verify-evm-router-v3.ts --network bscMainnet
 *   ROUTER=0x... RECRUITER=0x... PROTOCOL=0x... npx hardhat run scripts/verify-evm-router-v3.ts --network bscMainnet
 *
 * RECRUITER / PROTOCOL default to the BNB mainnet vaults. Community and creator
 * vaults are read from the deployment record if present.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const ABI = [
  "function admin() view returns (address)",
  "function weeklyLeagueVault() view returns (address)",
  "function monthlyLeagueTreasury() view returns (address)",
  "function recruiterRewardsVault() view returns (address)",
  "function communityRewardsVault() view returns (address)",
  "function protocolRevenueVault() view returns (address)",
  "function creatorRewardsVault() view returns (address)",
  "function forwardingPaused() view returns (bool)",
  "function upgradeDelay() view returns (uint64)",
  "function setRecruiterRewardsVault(address)",
  "function setCommunityRewardsVault(address)",
  "function setProtocolRevenueVault(address)",
  "function setCreatorRewardsVault(address)",
];

async function main() {
  const router = ethers.getAddress(String(process.env.ROUTER || "").trim());
  const net = await ethers.provider.getNetwork();
  const recordFile: Record<string, string> = { bscMainnet: "bnb/mainnet.treasury-router-v3.json", bscTestnet: "bnb/testnet.treasury-router-v3.json", robinhoodMainnet: "robinhood/mainnet.treasury-router-v3.json", robinhoodTestnet: "robinhood/testnet.treasury-router-v3.json" };
  const recordPath = path.join(__dirname, "..", "deployments", recordFile[network.name] || "");
  const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf8")) : null;

  const defaults = network.name === "bscMainnet"
    ? { recruiter: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78", protocol: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c" }
    : { recruiter: "", protocol: "" };
  const want = {
    recruiter: ethers.getAddress(String(process.env.RECRUITER || record?.contracts?.recruiterRewardsVault || defaults.recruiter || "").trim() || ethers.ZeroAddress),
    community: ethers.getAddress(String(process.env.COMMUNITY || record?.contracts?.CommunityRewardsVault || "").trim() || ethers.ZeroAddress),
    protocol: ethers.getAddress(String(process.env.PROTOCOL || record?.contracts?.protocolRevenueVault || defaults.protocol || "").trim() || ethers.ZeroAddress),
    creator: ethers.getAddress(String(process.env.CREATOR || record?.contracts?.CreatorRewardsVault || "").trim() || ethers.ZeroAddress),
  };

  const r = await ethers.getContractAt(ABI, router);
  const code = await ethers.provider.getCode(router);
  console.log(`[verify-router] ${network.name} chain ${net.chainId} router ${router} code ${code === "0x" ? "NONE" : (code.length / 2 - 1) + " B"}`);
  if (code === "0x") throw new Error("no code at ROUTER");
  const state = {
    admin: await (r as any).admin(),
    weeklyLeagueVault: await (r as any).weeklyLeagueVault(),
    monthlyLeagueTreasury: await (r as any).monthlyLeagueTreasury(),
    recruiterRewardsVault: await (r as any).recruiterRewardsVault(),
    communityRewardsVault: await (r as any).communityRewardsVault(),
    protocolRevenueVault: await (r as any).protocolRevenueVault(),
    creatorRewardsVault: await (r as any).creatorRewardsVault(),
    forwardingPaused: await (r as any).forwardingPaused(),
    upgradeDelay: String(await (r as any).upgradeDelay()),
  };
  for (const [k, v] of Object.entries(state)) console.log(`  ${k.padEnd(22)} ${v}`);

  const owed: Array<[string, string]> = [];
  const pairs: Array<[string, string, string]> = [
    ["setRecruiterRewardsVault", state.recruiterRewardsVault, want.recruiter],
    ["setCommunityRewardsVault", state.communityRewardsVault, want.community],
    ["setProtocolRevenueVault", state.protocolRevenueVault, want.protocol],
    ["setCreatorRewardsVault", state.creatorRewardsVault, want.creator],
  ];
  for (const [fn, current, target] of pairs) {
    if (target === ethers.ZeroAddress) { console.log(`  ?    ${fn}: target unknown (pass ${fn.replace("set", "").replace("RewardsVault", "").replace("RevenueVault", "").toUpperCase()}=0x… or keep the deployment record)`); continue; }
    if (current.toLowerCase() === target.toLowerCase()) { console.log(`  ok   ${fn} already ${target}`); continue; }
    owed.push([fn, target]);
  }
  if (owed.length) {
    console.log(`\n[verify-router] Safe transactions still owed by admin ${state.admin}:`);
    for (const [fn, target] of owed) {
      console.log(`  to=${router}`);
      console.log(`  data=${(r as any).interface.encodeFunctionData(fn, [target])}   # ${fn}(${target})`);
    }
    console.log("[verify-router] the generation script refuses to run until all four are set.");
  } else {
    console.log("\n[verify-router] all four vaults set; ready for the generation step");
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
