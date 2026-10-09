/**
 * The payout watchdog's Safe module (founder, 2026-10-08: "Safe module: yes"): a Zodiac Roles v2.1.0 proxy whose
 * owner, avatar and target are the treasury Safe, and the Safe batch that scopes ONE role ("payout-watchdog") to
 * approveHolderBatch on the creator vaults and authorizeBatch on the holder and airdrop distributors
 * (scripts/lib/payoutRolesPolicy.ts), gives that role to the watchdog key, and enables the module on the Safe.
 * Audit: docs/evm-launch/audit/PAYOUT_ROLES_MODULE.md. Founder steps: docs/runbooks/payout-watchdog.md.
 *
 * Sequence per chain (each line a founder go; mainnet only from an interactive terminal):
 *   1. this script: verifies the Zodiac code on chain, deploys the Roles proxy through the ModuleProxyFactory
 *      (any key pays the gas; the proxy's owner is the Safe from its first instruction), writes the Safe batch
 *      and the record. PAYOUT_ROLES_DEPLOY_IN_BATCH=1 deploys nothing: the Safe batch's first call deploys it.
 *   2. Safe signers: import deployments/<chain>/mainnet.payout-roles.safe-batch.json in the Transaction Builder,
 *      check it against the record's permission table, sign, execute.
 *   3. Coolify: the watchdog env (printed at the end).
 *
 *   PAYOUT_WATCHDOG_ADDRESS_56=0x<new key> CONFIRM_PAYOUT_ROLES=I_UNDERSTAND_MAINNET \
 *     npx hardhat run scripts/deploy-payout-roles-module.ts --network bscMainnet
 *   PAYOUT_WATCHDOG_ADDRESS_4663=0x<new key> CONFIRM_PAYOUT_ROLES=I_UNDERSTAND_MAINNET \
 *     npx hardhat run scripts/deploy-payout-roles-module.ts --network robinhoodMainnet
 *   PAYOUT_ROLES_MODE=disable ... writes the Safe's disableModule batch (the off switch) from the current module list.
 *
 * Inputs (env, <id> = chain id):
 *   PAYOUT_WATCHDOG_ADDRESS_<id>          the watchdog's NEW address (refused: any operator, the deployer, the route
 *                                         authority, the Safe, its owners, the signer of this run)
 *   PAYOUT_ROLES_GEN6_VAULT_<id>          default: deployments/<chain>/mainnet.evmgen-fees.json contracts.vault ("none" = skip)
 *   PAYOUT_ROLES_GEN7_VAULT_<id>          default: deployments/<chain>/mainnet.gen7.json fees.vault (absent = skip)
 *   PAYOUT_ROLES_AIRDROP_DISTRIBUTOR_<id> default: deployments/<chain>/mainnet.reward-distributor.json address ("none" = skip)
 *   PAYOUT_ROLES_GEN7_AIRDROP_DISTRIBUTOR_<id> default: the gen-7 record's airdrop distributor (absent = skip)
 *   PAYOUT_ROLES_HOLDER_CAP_<id>          ether units; default each vault's limits().holderBatchPerWeek
 *   PAYOUT_ROLES_AIRDROP_CAP_<id>         ether units; default the main pot's current authorization max on chain
 *   PAYOUT_ROLES_GEN7_AIRDROP_CAP_<id>    ether units; default the main pot's cap
 *   PAYOUT_ROLES_ALLOWANCE_MAX_WEEKS      default 2: an allowance never holds more than 2 weeks of authorizations
 *   PAYOUT_ROLES_ALLOWANCE_INITIAL_WEEKS  default 2
 *   PAYOUT_ROLES_RUNWAY_WEEKS             default 12: the batch also authorizes (as the Safe, directly) every missing
 *                                         id of the coming weeks, so the watchdog only extends by one week per week
 *   PAYOUT_ROLES_SALT_NONCE               default keccak("mwz-payout-watchdog-roles-v1")
 *   PAYOUT_ROLES_SAFE_<id>                testnets / local only (mainnet is pinned to the Safe below)
 * The holder distributor of each vault is read from the vault (holderDistributor()), never from a record.
 *
 * Forks: bscForkRehearsal / robinhoodForkRehearsal (anvil forks of 56 / 4663, scripts/lib/forkRehearsal.ts) behave as
 * mainnet without the terminal guard; records and batches land under deployments/fork-rehearsal/<network>/.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { artifacts, ethers, network } from "hardhat";
import { assertLocalFork } from "./lib/forkRehearsal";
import { writeSafeBatch, type PlannedCall } from "./lib/safeCallPlan";
import { mainAirdropCap } from "./lib/gen7AirdropPot";
import { assertZodiacCode, MODULE_PROXY_FACTORY, ROLES_MASTERCOPY, rolesAbi, zodiacVendor } from "./lib/zodiacRoles";
import {
  buildPayoutRolesPolicy,
  disableModuleCall,
  KNOWN_FORBIDDEN_WATCHDOGS,
  PAYOUT_WATCHDOG_ROLE,
  rolesProxyPlan,
  rolesRevertName,
  SENTINEL_MODULES,
  type PolicyDistributor,
  type PolicyVault,
} from "./lib/payoutRolesPolicy";

const ROOT = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.join(ROOT, "deployments");
export const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const esm = (rel: string): Promise<any> => Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, rel)).href);

type Chain = { chainId: number; profile: "mainnet" | "testnet" | "local"; dir: string; native: string };
const CHAINS: Record<number, Chain> = {
  56: { chainId: 56, profile: "mainnet", dir: "bnb", native: "BNB" },
  4663: { chainId: 4663, profile: "mainnet", dir: "robinhood", native: "ETH" },
  97: { chainId: 97, profile: "testnet", dir: "bscTestnet", native: "tBNB" },
  46630: { chainId: 46630, profile: "testnet", dir: "robinhood", native: "ETH" },
  31337: { chainId: 31337, profile: "local", dir: "localhost", native: "ETH" },
};
const REAL_NETWORKS: Record<string, number> = { bscMainnet: 56, robinhoodMainnet: 4663, bscTestnet: 97, robinhoodTestnet: 46630 };
const ANVIL_FORKS: Record<string, number> = { bscForkRehearsal: 56, robinhoodForkRehearsal: 4663 };

const VAULT_ABI = [
  "function admin() view returns (address)",
  "function operator() view returns (address)",
  "function holderDistributor() view returns (address)",
  "function limits() view returns (bool paused, uint256 buyPerTx, uint256 buybackPerCampaignWeek, uint256 buyInterval, uint256 impactBps, uint256 holderBatchPerWeek)",
];
const DISTRIBUTOR_ABI = [
  "function owner() view returns (address)",
  "function batchOperator() view returns (address)",
  "function batchAuthorization(bytes32) view returns (uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline, bool authorized, bool consumed)",
  "function batches(bytes32) view returns (bytes32 merkleRoot, uint256 totalFunded, uint256 totalClaimed, uint64 claimDeadline, bool paused, bool exists)",
];
const COMMUNITY_ABI = ["function admin() view returns (address)", "function airdropOperator() view returns (address)"];
const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isModuleEnabled(address) view returns (bool)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
];
const ROLES_VIEW_ABI = ["function owner() view returns (address)", "function avatar() view returns (address)", "function target() view returns (address)"];

const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const log = (line: string) => console.log(`[payout-roles] ${line}`);
const truthy = (v: unknown) => ["1", "true", "yes"].includes(String(v ?? "").trim().toLowerCase());

export function isRehearsal(name = network.name) {
  return name === "hardhat" || name === "localhost" || Object.prototype.hasOwnProperty.call(ANVIL_FORKS, name);
}

export async function resolveChain(): Promise<Chain> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (ANVIL_FORKS[network.name] !== undefined) await assertLocalFork(ANVIL_FORKS[network.name]);
  else if (REAL_NETWORKS[network.name] !== undefined) {
    if (REAL_NETWORKS[network.name] !== chainId) throw new Error(`REFUSED: ${network.name} reports chain ${chainId}`);
  } else if (network.name === "localhost") {
    if (chainId !== 31337) throw new Error(`REFUSED: localhost reports chain ${chainId}; use a named fork network`);
  } else if (network.name !== "hardhat") throw new Error(`REFUSED: network ${network.name} is not a payout-roles network`);
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`REFUSED: chain ${chainId} (56, 4663, 97, 46630 or local 31337 only)`);
  return chain;
}

/** Real path on a real network; under deployments/fork-rehearsal/<network>[-<chainId>]/ otherwise. */
export function outPath(chain: Chain, file: string, env: NodeJS.ProcessEnv = process.env): string {
  const real = path.join(DEPLOYMENTS, chain.dir, file);
  if (!isRehearsal()) return real;
  const dirName = network.name === "hardhat" || network.name === "localhost" ? `${network.name}-${chain.chainId}` : network.name;
  const outDir = String(env.REHEARSAL_OUT_DIR || "").trim() || path.join(DEPLOYMENTS, "fork-rehearsal", dirName);
  return path.join(outDir, chain.dir, file);
}

function readJson(file: string): any | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** env value: "none" -> null (skip), an address, or undefined (use the default). */
function envTarget(env: NodeJS.ProcessEnv, name: string): string | null | undefined {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return undefined;
  if (raw.toLowerCase() === "none") return null;
  return ethers.getAddress(raw);
}

function envEther(env: NodeJS.ProcessEnv, name: string): bigint | null {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return null;
  const v = ethers.parseEther(raw);
  if (v <= 0n) throw new Error(`${name} must be positive`);
  return v;
}

/** Default target addresses of a chain from the repo's deployment records. */
export function recordTargets(chain: Chain) {
  const dir = path.join(DEPLOYMENTS, chain.dir);
  if (chain.profile === "mainnet") {
    const fees = readJson(path.join(dir, "mainnet.evmgen-fees.json"));
    const airdrop = readJson(path.join(dir, "mainnet.reward-distributor.json"));
    const gen7 = readJson(path.join(dir, "mainnet.gen7.json"));
    return {
      gen6Vault: fees?.contracts?.vault ?? null,
      gen7Vault: gen7?.fees?.vault ?? null,
      airdropDistributor: airdrop?.address ?? null,
      gen7AirdropDistributor: gen7?.fees?.airdropDistributor ?? gen7?.airdrop?.distributor ?? null,
    };
  }
  if (chain.chainId === 97) {
    const gen6 = readJson(path.join(dir, "testnet.gen6.json"));
    const gen7 = readJson(path.join(dir, "testnet.gen7.json"));
    return { gen6Vault: gen6?.fees?.creatorRewardsVaultV2 ?? null, gen7Vault: gen7?.fees?.vault ?? null, airdropDistributor: null, gen7AirdropDistributor: gen7?.fees?.airdropDistributor ?? null };
  }
  if (chain.chainId === 46630) {
    const gen6 = readJson(path.join(dir, "testnet.gen6b.json"));
    const gen7 = readJson(path.join(dir, "testnet.gen7.json"));
    return { gen6Vault: gen6?.fees?.creatorRewardsVaultV2 ?? null, gen7Vault: gen7?.fees?.vault ?? null, airdropDistributor: null, gen7AirdropDistributor: gen7?.fees?.airdropDistributor ?? null };
  }
  return { gen6Vault: null, gen7Vault: null, airdropDistributor: null, gen7AirdropDistributor: null };
}

async function requireCode(label: string, address: string) {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`REFUSED: ${label} ${address} has no code on this chain`);
}

const view = (address: string, abi: string[]) => new ethers.Contract(address, abi, ethers.provider);

export type ResolvedInputs = {
  safe: string;
  watchdog: string;
  vaults: PolicyVault[];
  distributors: PolicyDistributor[];
  forbidden: Array<{ address: string; label: string }>;
  communityVaults: Record<string, string>;
};

/** Every target, cap and refused address, read from env, records and the chain. Throws on any inconsistency. */
export async function resolveInputs(chain: Chain, signerAddress: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedInputs> {
  const id = chain.chainId;
  const safe = chain.profile === "mainnet" ? SAFE : ethers.getAddress(String(env[`PAYOUT_ROLES_SAFE_${id}`] || ""));
  await requireCode("Safe", safe);
  const watchdogRaw = String(env[`PAYOUT_WATCHDOG_ADDRESS_${id}`] || "").trim();
  if (!watchdogRaw) throw new Error(`PAYOUT_WATCHDOG_ADDRESS_${id} is required (the watchdog's own new address)`);
  const watchdog = ethers.getAddress(watchdogRaw);
  const owners: string[] = (await view(safe, SAFE_ABI).getOwners()).map((a: string) => ethers.getAddress(a));
  const forbidden: Array<{ address: string; label: string }> = [
    ...owners.map((a) => ({ address: a, label: "Safe owner" })),
    { address: signerAddress, label: "signer of this deploy" },
  ];
  const rec = recordTargets(chain);
  const pick = (name: string, fallback: string | null) => {
    const e = envTarget(env, name);
    return e === undefined ? (fallback ? ethers.getAddress(fallback) : null) : e;
  };
  const vaultAddrs: Array<{ label: string; address: string; program: string }> = [];
  const g6 = pick(`PAYOUT_ROLES_GEN6_VAULT_${id}`, rec.gen6Vault);
  if (g6) vaultAddrs.push({ label: "gen-6", address: g6, program: "airdrop_holders" });
  const g7 = pick(`PAYOUT_ROLES_GEN7_VAULT_${id}`, rec.gen7Vault);
  if (g7) vaultAddrs.push({ label: "gen-7", address: g7, program: "airdrop_holders_gen7" });

  const holderCapEnv = envEther(env, `PAYOUT_ROLES_HOLDER_CAP_${id}`);
  const vaults: PolicyVault[] = [];
  const distributors: PolicyDistributor[] = [];
  for (const v of vaultAddrs) {
    await requireCode(`${v.label} vault`, v.address);
    const c = view(v.address, VAULT_ABI);
    if (!same(await c.admin(), safe)) throw new Error(`REFUSED: ${v.label} vault ${v.address} admin is ${await c.admin()}, not the Safe ${safe}`);
    const limits = await c.limits();
    const cap = holderCapEnv ?? BigInt(limits.holderBatchPerWeek);
    if (cap <= 0n) throw new Error(`${v.label} vault ${v.address}: weekly holder cap is 0; set it first (setCaps) or PAYOUT_ROLES_HOLDER_CAP_${id}`);
    const operator = ethers.getAddress(await c.operator());
    if (operator !== ethers.ZeroAddress) forbidden.push({ address: operator, label: `${v.label} vault operator` });
    vaults.push({ label: v.label, address: v.address, maxTotalWei: cap });
    const hd = ethers.getAddress(await c.holderDistributor());
    if (hd === ethers.ZeroAddress) throw new Error(`REFUSED: ${v.label} vault ${v.address} has no holder distributor pinned yet`);
    const d = view(hd, DISTRIBUTOR_ABI);
    if (!same(await d.owner(), safe)) throw new Error(`REFUSED: ${v.label} holder distributor ${hd} owner is not the Safe`);
    if (!same(await d.batchOperator(), v.address)) throw new Error(`REFUSED: ${v.label} holder distributor ${hd} batchOperator is not its vault`);
    distributors.push({ label: `${v.label} holder`, kind: "holders", address: hd, capWei: cap, idsPerWeek: 1, scheme: `keccak256("mwz-weekly-airdrop:${id}:<week>:${v.program}")` });
  }

  const communityVaults: Record<string, string> = {};
  const mainCapEnv = envEther(env, `PAYOUT_ROLES_AIRDROP_CAP_${id}`);
  const gen7CapEnv = envEther(env, `PAYOUT_ROLES_GEN7_AIRDROP_CAP_${id}`);
  const airdrops: Array<{ label: string; address: string; pot: string }> = [];
  const main = pick(`PAYOUT_ROLES_AIRDROP_DISTRIBUTOR_${id}`, rec.airdropDistributor);
  if (main) airdrops.push({ label: "main airdrop", address: main, pot: "main" });
  const g7a = pick(`PAYOUT_ROLES_GEN7_AIRDROP_DISTRIBUTOR_${id}`, rec.gen7AirdropDistributor);
  if (g7a) airdrops.push({ label: "gen-7 airdrop", address: g7a, pot: "gen7" });
  let mainCap: bigint | null = mainCapEnv;
  for (const a of airdrops) {
    await requireCode(`${a.label} distributor`, a.address);
    const d = view(a.address, DISTRIBUTOR_ABI);
    if (!same(await d.owner(), safe)) throw new Error(`REFUSED: ${a.label} distributor ${a.address} owner is not the Safe`);
    const community = ethers.getAddress(await d.batchOperator());
    if (community === ethers.ZeroAddress) throw new Error(`REFUSED: ${a.label} distributor ${a.address} has no batch operator (community vault) yet`);
    const cv = view(community, COMMUNITY_ABI);
    if (!same(await cv.admin(), safe)) throw new Error(`REFUSED: ${a.label} community vault ${community} admin is not the Safe`);
    const op = ethers.getAddress(await cv.airdropOperator());
    if (op !== ethers.ZeroAddress) forbidden.push({ address: op, label: `${a.label} airdrop operator` });
    communityVaults[a.address] = community;
    let cap: bigint;
    if (a.pot === "main") {
      mainCap ??= (await mainAirdropCap({ chainId: id, mainDistributor: a.address })).cap;
      cap = mainCap;
    } else {
      cap = gen7CapEnv ?? mainCap ?? mainCapEnv ?? (await mainAirdropCap({ chainId: id, mainDistributor: main })).cap;
    }
    const scheme = a.pot === "main"
      ? `keccak256("mwz-weekly-airdrop:${id}:<epoch>:<airdrop_trader|airdrop_creator>")`
      : `keccak256("mwz-weekly-airdrop:${id}:<epoch>:<airdrop_trader|airdrop_creator>:gen7")`;
    distributors.push({ label: a.label, kind: "airdrop", address: a.address, capWei: cap, idsPerWeek: 2, scheme });
  }
  return { safe, watchdog, vaults, distributors, forbidden: [...KNOWN_FORBIDDEN_WATCHDOGS, ...forbidden], communityVaults };
}

const DAY = 86_400;

/**
 * The Safe's own authorizeBatch calls that fill each distributor's runway to `weeks` weeks at setup (only ids that
 * are not authorized-and-open, consumed, created or revoked), built with the existing generators so the ids are
 * exactly the runner's / worker's.
 */
export async function runwayCalls(chainId: number, inputs: ResolvedInputs, weeks: number, nowSec: number): Promise<PlannedCall[]> {
  if (weeks <= 0 || ![56, 97, 4663, 46630].includes(chainId)) return [];
  const { holderPreauthCalls } = await esm("scripts/make-holder-batch-preauth-calls.mjs");
  const { airdropSetupCalls } = await esm("scripts/make-airdrop-setup-calls.mjs");
  const now = new Date(nowSec * 1000);
  const out: PlannedCall[] = [];
  for (const d of inputs.distributors) {
    let calls: any[];
    if (d.kind === "holders") {
      const program = d.label.startsWith("gen-7") ? "airdrop_holders_gen7" : "airdrop_holders";
      calls = holderPreauthCalls({ chainId, distributor: d.address, cap: d.capWei, program, weeks, now });
    } else {
      const pot = d.label.startsWith("gen-7") ? "gen7" : "main";
      calls = airdropSetupCalls({ chainId, pots: [{ pot, vault: inputs.communityVaults[d.address], distributor: d.address, cap: d.capWei, operator: null, wire: false }], weeks, now });
    }
    const dist = view(d.address, DISTRIBUTOR_ABI);
    for (const c of calls) {
      const [batchId, , , deadline] = c.args;
      if (Number(deadline) <= nowSec) continue;
      const a = await dist.batchAuthorization(batchId);
      if (a.consumed || (await dist.batches(batchId)).exists) continue;
      if (a.authorized) continue;
      if (BigInt(a.maxAmount) > 0n) continue; // revoked by the Safe: never re-authorized automatically
      out.push({ contract: "RewardDistributor", to: d.address, fn: "authorizeBatch", args: c.args.map(String), note: `${c.note} (${d.label}, Safe runway)` });
    }
  }
  return out;
}

/** eth_call each call from the Safe against current state (interfaces have no bytecode, so encode from the artifact ABI). */
export async function simulateFromSafe(safe: string, calls: PlannedCall[]) {
  const refusals: string[] = [];
  for (const c of calls) {
    const iface = new ethers.Interface((await artifacts.readArtifact(c.contract)).abi);
    const data = iface.encodeFunctionData(c.fn, c.args as any[]);
    try {
      await ethers.provider.call({ from: safe, to: c.to, data });
    } catch (error: any) {
      const raw = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
      refusals.push(`${c.contract}.${c.fn} -> ${c.to}: ${rolesRevertName(raw, rolesAbi()) ?? String(error?.shortMessage || error?.message || error).split("\n")[0]}`);
    }
  }
  if (refusals.length) throw new Error(`simulation as the Safe ${safe} refused:\n  ${refusals.join("\n  ")}`);
}

async function enabledModules(safe: string): Promise<string[]> {
  const [list] = await view(safe, SAFE_ABI).getModulesPaginated(SENTINEL_MODULES, 50);
  return list.map((a: string) => ethers.getAddress(a));
}

export async function main(opts: { signer?: any; env?: NodeJS.ProcessEnv; nowSec?: number } = {}) {
  const env = opts.env ?? process.env;
  const chain = await resolveChain();
  const mode = String(env.PAYOUT_ROLES_MODE || "deploy").trim();
  if (!["deploy", "disable"].includes(mode)) throw new Error("PAYOUT_ROLES_MODE must be deploy or disable");
  const mainnet = chain.profile === "mainnet";
  const recordFile = outPath(chain, `${chain.profile}.payout-roles.json`, env);
  const batchFile = outPath(chain, `${chain.profile}.payout-roles.safe-batch.json`, env);

  const zodiacCode = await assertZodiacCode(ethers.provider);
  log(`chain ${chain.chainId} (${network.name}): Zodiac Roles v2.1.0, its libraries and the ModuleProxyFactory verified on chain`);

  if (mode === "disable") {
    const rec = readJson(recordFile);
    if (!rec?.roles) throw new Error(`no payout-roles record at ${recordFile}`);
    const modules = await enabledModules(rec.safe);
    const call = disableModuleCall(rec.safe, modules, rec.roles);
    await simulateFromSafe(rec.safe, [call]);
    const file = outPath(chain, `${chain.profile}.payout-roles.disable.safe-batch.json`, env);
    writeSafeBatch(file, chain.chainId, "MWZ payout watchdog: DISABLE", `Safe ${rec.safe} disables the payout watchdog Roles module ${rec.roles}; the watchdog key can do nothing afterwards.`, [call]);
    log(`wrote ${path.relative(ROOT, file)} (disableModule(${call.args[0]}, ${call.args[1]}))`);
    return { mode, batchFile: file, calls: [call] };
  }

  const confirm = mainnet ? "I_UNDERSTAND_MAINNET" : "I_UNDERSTAND_TESTNET";
  if (chain.profile !== "local" && !isRehearsal() && String(env.CONFIRM_PAYOUT_ROLES || "").trim() !== confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_PAYOUT_ROLES=${confirm}.`);
  }
  if (mainnet && !isRehearsal() && (env.CI || !process.stdin.isTTY)) {
    throw new Error("Refusing a mainnet send from a non-interactive shell: this runs only from the founder's terminal.");
  }
  const signer = opts.signer ?? (await ethers.getSigners())[0];
  const signerAddress = ethers.getAddress(await signer.getAddress());
  const inputs = await resolveInputs(chain, signerAddress, env);
  const inBatch = truthy(env.PAYOUT_ROLES_DEPLOY_IN_BATCH);
  const saltNonce = BigInt(String(env.PAYOUT_ROLES_SALT_NONCE || "").trim() || ethers.id("mwz-payout-watchdog-roles-v1"));
  const plan = rolesProxyPlan({ factory: MODULE_PROXY_FACTORY, mastercopy: ROLES_MASTERCOPY, safe: inputs.safe, saltNonce });
  const policy = buildPayoutRolesPolicy({
    chainId: chain.chainId,
    safe: inputs.safe,
    roles: plan.proxy,
    watchdog: inputs.watchdog,
    vaults: inputs.vaults,
    distributors: inputs.distributors,
    allowance: { maxWeeks: Number(env.PAYOUT_ROLES_ALLOWANCE_MAX_WEEKS || 2), initialWeeks: Number(env.PAYOUT_ROLES_ALLOWANCE_INITIAL_WEEKS || 2) },
    forbidden: inputs.forbidden,
  });
  log(`Safe ${inputs.safe}, watchdog ${inputs.watchdog}, Roles proxy ${plan.proxy} (salt nonce ${saltNonce})`);

  // The proxy: reuse it only if it is exactly ours (owner = avatar = target = Safe, minimal proxy to the mastercopy).
  let deployTx: string | null = null;
  const preCalls: PlannedCall[] = [];
  const existing = await ethers.provider.getCode(plan.proxy);
  if (existing !== "0x") {
    if (existing.toLowerCase() !== plan.proxyRuntime.toLowerCase()) throw new Error(`REFUSED: ${plan.proxy} holds unexpected code`);
    const r = view(plan.proxy, ROLES_VIEW_ABI);
    for (const fn of ["owner", "avatar", "target"]) if (!same(await r.getFunction(fn)(), inputs.safe)) throw new Error(`REFUSED: existing proxy ${plan.proxy} ${fn} is not the Safe`);
    log(`Roles proxy ${plan.proxy} already deployed with owner = avatar = target = Safe; reused`);
  } else if (inBatch) {
    preCalls.push({ contract: "IZodiacModuleProxyFactory", to: MODULE_PROXY_FACTORY, fn: "deployModule", args: [ROLES_MASTERCOPY, plan.initializer, saltNonce.toString()], note: "the Safe deploys its Roles proxy" });
    log("PAYOUT_ROLES_DEPLOY_IN_BATCH: the Safe batch deploys the proxy first");
  } else {
    const factory = new ethers.Contract(MODULE_PROXY_FACTORY, ["function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)"], signer);
    const tx = await factory.deployModule(ROLES_MASTERCOPY, plan.initializer, saltNonce);
    const rc = await tx.wait();
    if (!rc || rc.status !== 1) throw new Error("deployModule failed");
    deployTx = rc.hash;
    const r = view(plan.proxy, ROLES_VIEW_ABI);
    for (const fn of ["owner", "avatar", "target"]) if (!same(await r.getFunction(fn)(), inputs.safe)) throw new Error(`deployed proxy ${fn} is not the Safe`);
    log(`deployed Roles proxy ${plan.proxy} (tx ${deployTx}, gas ${rc.gasUsed})`);
  }

  const alreadyEnabled = await view(inputs.safe, SAFE_ABI).isModuleEnabled(plan.proxy);
  const policyCalls = alreadyEnabled ? policy.calls.filter((c) => c.fn !== "enableModule") : policy.calls;
  const nowSec = opts.nowSec ?? Number((await ethers.provider.getBlock("latest"))!.timestamp);
  const runway = await runwayCalls(chain.chainId, inputs, Number(env.PAYOUT_ROLES_RUNWAY_WEEKS ?? 12), nowSec);
  const calls = [...preCalls, ...policyCalls, ...runway];
  if (!inBatch || existing !== "0x") await simulateFromSafe(inputs.safe, calls);
  else await simulateFromSafe(inputs.safe, runway);

  const fmt = (v: bigint) => `${ethers.formatEther(v)} ${chain.native}`;
  writeSafeBatch(
    batchFile,
    chain.chainId,
    "MWZ payout watchdog: Roles module",
    `Roles proxy ${plan.proxy} (Zodiac Roles v2.1.0, owner = avatar = target = Safe). Role ${PAYOUT_WATCHDOG_ROLE} -> ${inputs.watchdog}: approveHolderBatch on ${inputs.vaults.map((v) => `${v.label} ${v.address} (total <= ${fmt(v.maxTotalWei)})`).join(", ") || "no vault"}; authorizeBatch on ${inputs.distributors.map((d) => `${d.label} ${d.address} (<= ${fmt(d.capWei)} per id)`).join(", ")}; value 0, call only, nothing else. ${runway.length} runway authorizations by the Safe. Last: Safe.enableModule.`,
    calls,
  );
  const record = {
    kind: "payout-roles-module",
    network: network.name,
    chainId: chain.chainId,
    profile: chain.profile,
    generatedAt: new Date().toISOString(),
    safe: inputs.safe,
    roles: plan.proxy,
    mastercopy: ROLES_MASTERCOPY,
    moduleProxyFactory: MODULE_PROXY_FACTORY,
    saltNonce: saltNonce.toString(),
    initializer: plan.initializer,
    deployTx,
    deployedInBatch: inBatch && existing === "0x",
    zodiacSource: zodiacVendor().sources,
    zodiacCode,
    role: PAYOUT_WATCHDOG_ROLE,
    roleKey: policy.roleKey,
    watchdog: inputs.watchdog,
    vaults: inputs.vaults,
    distributors: inputs.distributors,
    communityVaults: inputs.communityVaults,
    allowances: policy.allowances,
    permissionTable: policy.table,
    refusedWatchdogs: inputs.forbidden,
    runwayAuthorizations: runway.length,
    batchFile: path.relative(ROOT, batchFile),
    calls: calls.length,
  };
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, `${JSON.stringify(record, big, 2)}\n`);
  log(`wrote ${path.relative(ROOT, batchFile)} (${calls.length} calls: ${preCalls.length} deploy, ${policyCalls.length} scope/role/module, ${runway.length} runway) and ${path.relative(ROOT, recordFile)}`);
  log("after the Safe executes the batch, set on the indexer (Coolify):");
  for (const line of [
    `PAYOUT_WATCHDOG_ENABLED_${chain.chainId}=true`,
    `PAYOUT_WATCHDOG_ROLES_${chain.chainId}=${plan.proxy}`,
    `PAYOUT_WATCHDOG_SAFE_${chain.chainId}=${inputs.safe}`,
    `PAYOUT_WATCHDOG_PK_${chain.chainId}=<the watchdog key for ${inputs.watchdog}>`,
    ...inputs.distributors.filter((d) => d.kind === "airdrop").map((d) => `${d.label.startsWith("gen-7") ? `PAYOUT_WATCHDOG_GEN7_AIRDROP_DISTRIBUTOR_${chain.chainId}` : `PAYOUT_WATCHDOG_AIRDROP_DISTRIBUTOR_${chain.chainId}`}=${d.address}`),
    ...inputs.distributors.filter((d) => d.kind === "airdrop").map((d) => `${d.label.startsWith("gen-7") ? `PAYOUT_WATCHDOG_GEN7_AIRDROP_CAP_WEI_${chain.chainId}` : `PAYOUT_WATCHDOG_AIRDROP_CAP_WEI_${chain.chainId}`}=${d.capWei}`),
    "PAYOUT_WATCHDOG_SEND=true   (only after a dry-run day)",
  ]) log(`    ${line}`);
  return { mode, record, recordFile, batchFile, calls, plan, policy, runway };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
