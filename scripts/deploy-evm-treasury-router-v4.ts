/**
 * EVM launch generation, fees stack (spec docs/evm-launch/spec/C1-C6-fees.md, C1 + C6):
 *   TreasuryRouterV4 (admin = Safe) -> CreatorRewardsVaultV2 (admin = Safe) -> holder RewardDistributor (owner = Safe)
 * and the Safe transaction list per chain, written as Safe Transaction Builder batches (scripts/make-safe-batch.ts).
 *
 * The deployer only deploys. Every setter on these contracts is admin/owner-only and the admin is the Safe from
 * construction (TreasuryRouterV4.admin and CreatorRewardsVaultV2.admin are immutable), so all wiring comes back
 * as Safe batches:
 *   A  (right after this deploy)  pause the old factory, V4 vault setters, community vault -> V4, holder distributor
 *                                 wiring, vault operator + caps. No holder batch is pre-authorized (audit 5 M1).
 *   H  (weekly, per holder batch) holderWeekCalls: after the operator proposes, the Safe approves that batch's
 *                                 exact merkle root + total on the vault and authorizes its id on the distributor
 *                                 for exactly that total. Without a Safe-approved root nothing executes, so the
 *                                 payout operator (an EOA) cannot pay itself; the Safe can still veto.
 *   B  (after the new factory)    V4 authorizes + makes primary the factory's locker, VaultV2.setFactoryOnce(factory)
 *                                 and, per approved quote token, VaultV2.setQuoteRoute
 * Batch B is written only when EVMGEN_NEW_FACTORY is set (the core builder's factory must exist first).
 *
 * Sends happen only from the founder's terminal: a known network profile, CONFIRM_EVMGEN_FEES_DEPLOY equal to the
 * profile's phrase, an interactive TTY, no CI. `--network hardhat` is a local rehearsal (no confirm needed).
 *
 *   CONFIRM_EVMGEN_FEES_DEPLOY=I_UNDERSTAND_MAINNET EVMGEN_BUYBACK_MAX_PER_TX=... \
 *     npx hardhat run scripts/deploy-evm-treasury-router-v4.ts --network bscMainnet
 *
 * Off chain afterwards (spec C1): add V4 to TREASURY_ROUTERS_<id>, realtime-indexer/src/abis.ts and
 * scripts/check-evm-payout-bounds.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { buildBatch } from "./make-safe-batch";

export type ChainPins = {
  chainId: number;
  safe: string;
  oldRouter: string;
  oldFactory: string;
  weekly: string;
  monthly: string;
  recruiter: string;
  community: string;
  protocol: string;
  wrappedNative: string;
  dexKind: 1 | 2; // 1 Topaz V2 (BNB), 2 Uniswap V3 (Robinhood)
  dexFactory: string;
  payoutOperator: string;
};

// Read from chain 2026-09-30 (old V3 routers' getters); the script re-reads and refuses on any difference.
export const PINS: Record<string, ChainPins> = {
  bscMainnet: {
    chainId: 56,
    safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7",
    oldRouter: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
    oldFactory: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
    weekly: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5",
    monthly: "0x42D254A7451808Bb01df879d71BcAfDC5D605A38",
    recruiter: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78",
    community: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    protocol: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    dexKind: 1,
    dexFactory: "0x65E6cD0eF5D3467030103cf3d433034E570b5784",
    payoutOperator: "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50",
  },
  robinhoodMainnet: {
    chainId: 4663,
    safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7",
    oldRouter: "0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb",
    oldFactory: "0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA",
    weekly: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    monthly: "0x576c1d6Ba6975020702Aa13dE0899D8CD92ECD1A",
    recruiter: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7",
    community: "0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a",
    protocol: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    dexKind: 2,
    dexFactory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    payoutOperator: "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50",
  },
};

const PROFILES: Record<string, { confirm: string; dir: string; mainnet: boolean }> = {
  bscMainnet: { confirm: "I_UNDERSTAND_MAINNET", dir: "bnb", mainnet: true },
  robinhoodMainnet: { confirm: "I_UNDERSTAND_MAINNET", dir: "robinhood", mainnet: true },
  bscTestnet: { confirm: "I_UNDERSTAND_TESTNET", dir: "bnb", mainnet: false },
  robinhoodTestnet: { confirm: "I_UNDERSTAND_TESTNET", dir: "robinhood", mainnet: false },
};

export const UPGRADE_DELAY_SECONDS = 3600;
export const HOLDER_BATCH_DELAY_SECONDS = 24 * 3600;
const DAY = 86_400;

export type Caps = {
  maxBuyPerTx: bigint;
  maxBuybackPerCampaignWeek: bigint;
  minBuyInterval: bigint;
  maxImpactBps: bigint;
  maxHolderBatchPerWeek: bigint;
  holderBatchAuthorizationMax: bigint;
};

/** Same id the weekly runner uses (scripts/make-airdrop-recovery-batch.ts), program "airdrop_holders". */
export function holderBatchId(chainId: number, epochId: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(`mwz-weekly-airdrop:${chainId}:${epochId}:airdrop_holders`));
}

/** Monday 00:00 UTC ends of the next `weeks` epochs after `nowSec`. */
export function nextEpochEnds(nowSec: number, weeks: number): number[] {
  const mondayEpoch = 4 * DAY; // 1970-01-05 was a Monday
  const next = Math.floor((nowSec - mondayEpoch) / (7 * DAY)) * 7 * DAY + mondayEpoch + 7 * DAY;
  return Array.from({ length: weeks }, (_, i) => next + i * 7 * DAY);
}

type Call = { contract: string; to: string; fn: string; args: unknown[]; note?: string };

export function batchACalls(p: ChainPins, d: { router: string; vault: string; holderDistributor: string }, caps: Caps, _nowSec?: number): Call[] {
  return [
    { contract: "LaunchFactory", to: p.oldFactory, fn: "setCreatePaused", args: [true], note: "old generation stops creating first (spec C1 step 1)" },
    { contract: "TreasuryRouterV4", to: d.router, fn: "setRecruiterRewardsVault", args: [p.recruiter] },
    { contract: "TreasuryRouterV4", to: d.router, fn: "setCommunityRewardsVault", args: [p.community] },
    { contract: "TreasuryRouterV4", to: d.router, fn: "setProtocolRevenueVault", args: [p.protocol] },
    { contract: "TreasuryRouterV4", to: d.router, fn: "setCreatorRewardsVault", args: [d.vault], note: "set once: the router's creator vault can never be rotated (audit F1)" },
    { contract: "CommunityRewardsVault", to: p.community, fn: "setRouter", args: [d.router], note: "after this the old V3 router's airdrop/squad routes revert" },
    { contract: "RewardDistributor", to: d.holderDistributor, fn: "setBatchOperator", args: [d.vault] },
    { contract: "CreatorRewardsVaultV2", to: d.vault, fn: "setHolderDistributorOnce", args: [d.holderDistributor] },
    { contract: "CreatorRewardsVaultV2", to: d.vault, fn: "setOperator", args: [p.payoutOperator, false] },
    {
      contract: "CreatorRewardsVaultV2",
      to: d.vault,
      fn: "setCaps",
      args: [caps.maxBuyPerTx, caps.maxBuybackPerCampaignWeek, caps.minBuyInterval, caps.maxImpactBps, caps.maxHolderBatchPerWeek].map(String),
    },
  ];
}

/**
 * The weekly Safe batch for one proposed holder batch (audit 5 M1). The operator has already called
 * proposeHolderBatch(batchId, root, claimDeadline, campaigns, amounts) and published the leaf file; the Safe
 * signers recompute the root from that file and check the total before signing this batch:
 *   1. CreatorRewardsVaultV2.approveHolderBatch(batchId, root, total): reverts unless the proposal has exactly
 *      this root and total, so the signed content is what executes.
 *   2. RewardDistributor.authorizeBatch(batchId, total, now, now + 6 days): max = the exact total.
 * executeHolderBatch then runs after the vault's 24 h veto window. Refuses a total above the authorization cap.
 */
export function holderWeekCalls(
  d: { vault: string; holderDistributor: string },
  batch: { batchId: string; root: string; total: bigint },
  caps: Pick<Caps, "holderBatchAuthorizationMax">,
  nowSec: number,
): Call[] {
  if (batch.total <= 0n) throw new Error("holder batch total must be positive");
  if (batch.total > caps.holderBatchAuthorizationMax) {
    throw new Error(`holder batch total ${batch.total} is above EVMGEN_HOLDER_BATCH_AUTH_MAX ${caps.holderBatchAuthorizationMax}`);
  }
  return [
    { contract: "CreatorRewardsVaultV2", to: d.vault, fn: "approveHolderBatch", args: [batch.batchId, batch.root, String(batch.total)], note: "Safe approves this exact root + total" },
    {
      contract: "RewardDistributor",
      to: d.holderDistributor,
      fn: "authorizeBatch",
      args: [batch.batchId, String(batch.total), String(nowSec), String(nowSec + 6 * DAY)],
      note: "publishable after the vault's 24 h veto window, for 6 days",
    },
  ];
}

export function batchBCalls(d: { router: string; vault: string }, factory: string, locker: string, quoteRoutes: Array<{ quote: string; feeTier: number }>): Call[] {
  const calls: Call[] = [
    { contract: "TreasuryRouterV4", to: d.router, fn: "setAuthorizedLpLocker", args: [locker, true], note: "first locker on V4: direct, no timelock" },
    { contract: "TreasuryRouterV4", to: d.router, fn: "setPrimaryLpLocker", args: [locker] },
    { contract: "CreatorRewardsVaultV2", to: d.vault, fn: "setFactoryOnce", args: [factory] },
  ];
  for (const r of quoteRoutes) {
    calls.push({ contract: "CreatorRewardsVaultV2", to: d.vault, fn: "setQuoteRoute", args: [r.quote, r.feeTier] });
  }
  return calls;
}

function envBig(name: string, fallback: bigint | null, mainnet: boolean, parse: (v: string) => bigint): bigint {
  const raw = String(process.env[name] || "").trim();
  if (raw) return parse(raw);
  if (mainnet || fallback === null) throw new Error(`${name} is required on this network (a founder decision, no default on mainnet)`);
  return fallback;
}

export function readCaps(mainnet: boolean): Caps {
  const eth = (v: string) => ethers.parseEther(v);
  const int = (v: string) => BigInt(v);
  const caps: Caps = {
    maxBuyPerTx: envBig("EVMGEN_BUYBACK_MAX_PER_TX", ethers.parseEther("0.5"), mainnet, eth),
    maxBuybackPerCampaignWeek: envBig("EVMGEN_BUYBACK_MAX_PER_CAMPAIGN_WEEK", ethers.parseEther("3"), mainnet, eth),
    minBuyInterval: envBig("EVMGEN_BUYBACK_MIN_INTERVAL_SECONDS", 3600n, false, int),
    maxImpactBps: envBig("EVMGEN_BUYBACK_MAX_IMPACT_BPS", 50n, false, int),
    maxHolderBatchPerWeek: envBig("EVMGEN_HOLDER_MAX_PER_WEEK", ethers.parseEther("10"), mainnet, eth),
    holderBatchAuthorizationMax: envBig("EVMGEN_HOLDER_BATCH_AUTH_MAX", ethers.parseEther("10"), mainnet, eth),
  };
  if (caps.maxImpactBps > 50n) throw new Error("EVMGEN_BUYBACK_MAX_IMPACT_BPS above 50 is refused by the vault");
  return caps;
}

function assertFoundersTerminal(profileName: string) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unsupported network ${profileName}`);
  if (String(process.env.CONFIRM_EVMGEN_FEES_DEPLOY || "").trim() !== profile.confirm) {
    throw new Error(`Refusing to send on ${profileName}. Set CONFIRM_EVMGEN_FEES_DEPLOY=${profile.confirm}.`);
  }
  if (process.env.CI || !process.stdin.isTTY) {
    throw new Error("Refusing to send from a non-interactive shell: this runs only from the founder's terminal.");
  }
}

async function verifyPinsOnChain(p: ChainPins) {
  const r = new ethers.Contract(
    p.oldRouter,
    [
      "function admin() view returns (address)",
      "function weeklyLeagueVault() view returns (address)",
      "function monthlyLeagueTreasury() view returns (address)",
      "function recruiterRewardsVault() view returns (address)",
      "function communityRewardsVault() view returns (address)",
      "function protocolRevenueVault() view returns (address)",
    ],
    ethers.provider,
  );
  const read = {
    safe: await r.admin(),
    weekly: await r.weeklyLeagueVault(),
    monthly: await r.monthlyLeagueTreasury(),
    recruiter: await r.recruiterRewardsVault(),
    community: await r.communityRewardsVault(),
    protocol: await r.protocolRevenueVault(),
  };
  for (const [k, v] of Object.entries(read)) {
    if (ethers.getAddress(v) !== ethers.getAddress((p as any)[k])) throw new Error(`pin ${k}: chain says ${v}, script pins ${(p as any)[k]}`);
  }
  for (const a of [p.safe, p.wrappedNative, p.dexFactory, p.oldFactory, p.weekly, p.monthly, p.recruiter, p.community, p.protocol]) {
    if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`${a} has no code on chain ${p.chainId}`);
  }
}

export async function deployFeesStack(signer: any, p: Pick<ChainPins, "safe" | "weekly" | "monthly" | "wrappedNative" | "dexKind" | "dexFactory">) {
  const Router = await ethers.getContractFactory("TreasuryRouterV4", signer);
  const router = await Router.deploy(p.safe, p.weekly, p.monthly, UPGRADE_DELAY_SECONDS);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  const Vault = await ethers.getContractFactory("CreatorRewardsVaultV2", signer);
  const vault = await Vault.deploy(p.safe, routerAddress, p.wrappedNative, p.dexKind, p.dexFactory, HOLDER_BATCH_DELAY_SECONDS);
  await vault.waitForDeployment();
  const Dist = await ethers.getContractFactory("RewardDistributor", signer);
  const holderDistributor = await Dist.deploy(p.safe);
  await holderDistributor.waitForDeployment();
  return { router: routerAddress, vault: await vault.getAddress(), holderDistributor: await holderDistributor.getAddress() };
}

async function main() {
  const profile = PROFILES[network.name];
  const pins = PINS[network.name] ?? PINS[network.name.replace("Testnet", "Mainnet")];
  if (!profile || !pins) throw new Error(`Unsupported network ${network.name} (bscMainnet, robinhoodMainnet, bscTestnet, robinhoodTestnet)`);
  if (!profile.mainnet) throw new Error("Testnet pins are not in this script yet: supply a testnet ChainPins entry before using it there.");
  assertFoundersTerminal(network.name);
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== pins.chainId) throw new Error(`${network.name} expects chain ${pins.chainId}; RPC reports ${net.chainId}`);
  await verifyPinsOnChain(pins);
  const caps = readCaps(profile.mainnet);

  const [deployer] = await ethers.getSigners();
  console.log(`[fees-v4] chain ${pins.chainId} deployer ${await deployer.getAddress()} admin/owner = Safe ${pins.safe}`);
  const d = await deployFeesStack(deployer, pins);
  console.log(`[fees-v4] TreasuryRouterV4 ${d.router}\n[fees-v4] CreatorRewardsVaultV2 ${d.vault}\n[fees-v4] holder RewardDistributor ${d.holderDistributor}`);

  const outDir = path.join(__dirname, "..", "deployments", profile.dir);
  fs.mkdirSync(outDir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const a = buildBatch(pins.chainId, "MWZ fees V4: A wiring", "Router V4 vaults, community vault -> V4, holder distributor, vault operator/caps (no holder batch pre-authorized)", batchACalls(pins, d, caps, now) as any);
  fs.writeFileSync(path.join(outDir, "mainnet.evmgen-fees.A.safe-batch.json"), `${JSON.stringify(a, null, 2)}\n`);
  const factory = String(process.env.EVMGEN_NEW_FACTORY || "").trim();
  if (factory) {
    const locker = await new ethers.Contract(factory, ["function permanentLpLocker() view returns (address)"], ethers.provider).permanentLpLocker();
    const routes = JSON.parse(String(process.env.EVMGEN_QUOTE_ROUTES || "[]"));
    const b = buildBatch(pins.chainId, "MWZ fees V4: B factory", "V4 authorizes the new locker; VaultV2 pins the factory; quote routes", batchBCalls(d, factory, locker, routes) as any);
    fs.writeFileSync(path.join(outDir, "mainnet.evmgen-fees.B.safe-batch.json"), `${JSON.stringify(b, null, 2)}\n`);
  } else {
    console.log("[fees-v4] batch B not written: set EVMGEN_NEW_FACTORY once the new factory is deployed and re-run with --batches-only");
  }
  fs.writeFileSync(
    path.join(outDir, "mainnet.evmgen-fees.json"),
    `${JSON.stringify({ chainId: pins.chainId, deployedAt: new Date().toISOString(), contracts: d, caps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.toString()])) }, null, 2)}\n`,
  );
  console.log(`[fees-v4] wrote ${outDir}/mainnet.evmgen-fees.*.json`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
