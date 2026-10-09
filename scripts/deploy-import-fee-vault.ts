/**
 * CO-IMP revision 2, CI1 (docs/evm-launch/CO-IMPORT-SWAP-FEE.md): `ImportFeeVault` on BNB 56 / Robinhood 4663 and
 * their testnets 97 / 46630. The vault is the UNCHANGED `RecruiterRewardsVault` bytecode (contracts/RecruiterRewardsVault.sol
 * on NativeTreasuryVaultBase): receive() takes plain value from any sender and emits Deposit(from, amount, newBalance);
 * payout(to, amount) is operator-only with a per-tx and a daily cap; it deploys paused with no operator; admin is
 * immutable and can withdraw. The whole 1% import fee lands here (Kyber extraFee on BNB, Universal Router PAY_PORTION on
 * Robinhood, ImportSwapFeeRouter for BNB Topaz-only imports) and the CI6 worker splits it afterwards with payout().
 *
 * What this script does, per chain:
 *   1. deploys RecruiterRewardsVault(admin)  admin = the Safe 0x1edcEdf5 on 56 / 4663, the deployer on 97 / 46630
 *      (the gen-6 / gen-7 testnet records' admin 0x77F96A7d) and on a local 31337 node;
 *   2. the three admin calls  setOperator(IMPORT_FEE_PAYOUT_OPERATOR_<chainId>)   a NEW key; the existing payout
 *                                                                                  operator 0xdcf07EB0 is refused
 *                             setPayoutCaps(perTx, daily)                          env or the defaults below
 *                             setPayoutsPaused(false)                              (needs the two before it)
 *      mainnet: written as Safe batch IF1 (deployments/<dir>/mainnet.IF1-import-fee-vault.safe-batch.json), the first
 *      two simulated as the Safe; testnet / local: sent by the deployer (the admin) and read back;
 *   3. optional (IMPORT_FEE_DEPLOY_TOPAZ_ROUTER=1, BNB 56 / 97 only): the audited ImportSwapFeeRouter for CI4, deployed
 *      UNCHANGED with protocolBps 100, creatorBps 0, protocolReceiver = creatorReceiver = the vault, v3Router 0,
 *      v2Router = Topaz (56: 0x1E98c822..., 97: the authoritative 30 bps testnet router from
 *      deployments/bscTestnet/testnet.gen6.json). Every Topaz import swap is then ONE vault Deposit (from = router) of
 *      the full 1% (creatorBps 0 sends nothing to the creator receiver). Step 4 of the change order: only after the
 *      router's audit and a founder go;
 *   4. writes the record deployments/<dir>/<mainnet|testnet>.import-fee-vault.json.
 *
 * Caps (ether units). The sweep of the protocol half to ProtocolRevenueVault also goes through payout(), so the daily
 * cap must cover a whole day of import fees, not only creator payouts. Measured import volume (read-only getLogs of
 * ProtocolRevenueVault Deposit(from = router), 2026-10-08, see the CO results block): small, so the defaults are sized
 * like the live recruiter vault's P1 caps (BNB 2 / 10, ETH 0.5 / 3), which bound a stolen operator key to one day's
 * cap while leaving ~100x headroom over today's daily fee total. The monitor (CI1 notes) alerts on a hit cap.
 *   IMPORT_FEE_MAX_PAYOUT_PER_TX_<chainId>   default 56: 2,  4663: 0.5, testnets / local: 0.5
 *   IMPORT_FEE_DAILY_PAYOUT_CAP_<chainId>    default 56: 10, 4663: 3,   testnets / local: 2
 *
 * Usage (each line a founder go; mainnet only from an interactive terminal):
 *   IMPORT_FEE_PAYOUT_OPERATOR_56=0x<new key> CONFIRM_IMPORT_FEE_VAULT=I_UNDERSTAND_MAINNET \
 *     npx hardhat run scripts/deploy-import-fee-vault.ts --network bscMainnet
 *   IMPORT_FEE_PAYOUT_OPERATOR_4663=0x<new key> CONFIRM_IMPORT_FEE_VAULT=I_UNDERSTAND_MAINNET \
 *     npx hardhat run scripts/deploy-import-fee-vault.ts --network robinhoodMainnet
 *   IMPORT_FEE_PAYOUT_OPERATOR_97=0x<key> CONFIRM_IMPORT_FEE_VAULT=I_UNDERSTAND_TESTNET [IMPORT_FEE_DEPLOY_TOPAZ_ROUTER=1] \
 *     npx hardhat --config hardhat.bsc-testnet.config.ts run scripts/deploy-import-fee-vault.ts --network bscTestnet
 *   IMPORT_FEE_PAYOUT_OPERATOR_46630=0x<key> CONFIRM_IMPORT_FEE_VAULT=I_UNDERSTAND_TESTNET \
 *     npx hardhat run scripts/deploy-import-fee-vault.ts --network robinhoodTestnet
 *   IMPORT_FEE_BATCH_ONLY=1 ...   rewrites the Safe batch for the recorded vault (deploys nothing, mainnet only)
 * Rehearsals: bscForkRehearsal / robinhoodForkRehearsal / bscTestnetForkRehearsal (local anvil forks, proven by
 * anvil_nodeInfo; records under deployments/fork-rehearsal/<network>/, gitignored), the in-process `hardhat` network
 * (any chain id, it is always local) and localhost 31337. A re-run with a record resumes: it never deploys a second vault.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { assertLocalFork } from "./lib/forkRehearsal";
import { simulateAsAdmin, writeSafeBatch, encodePlannedCall, type PlannedCall } from "./lib/safeCallPlan";

const ROOT = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.join(ROOT, "deployments");

export const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
/** The existing payout operator (recruiter / league / airdrop, batch P1). The import vault must get its own key. */
export const EXISTING_PAYOUT_OPERATOR = "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50";
export const TESTNET_ADMIN = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
export const IMPORT_FEE_TOTAL_BPS = 100n;

type Profile = "mainnet" | "testnet" | "local";
export type ImportFeeChain = {
  chainId: number;
  profile: Profile;
  native: string;
  dir: string;
  protocolRevenueVault: string | null;
  /** The live RecruiterRewardsVault (admin = the Safe, batch P1): the new vault's runtime code must equal it byte for byte. */
  liveRecruiterVault: string | null;
  topazRouter: string | null;
  defaultCaps: { perTx: string; daily: string };
};

export const IMPORT_FEE_CHAINS: Record<number, ImportFeeChain> = {
  56: { chainId: 56, profile: "mainnet", native: "BNB", dir: "bnb", protocolRevenueVault: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c", liveRecruiterVault: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78", topazRouter: "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3", defaultCaps: { perTx: "2", daily: "10" } },
  4663: { chainId: 4663, profile: "mainnet", native: "ETH", dir: "robinhood", protocolRevenueVault: "0x632061cA786f7B585Bbd46A792FDA92B02f70671", liveRecruiterVault: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7", topazRouter: null, defaultCaps: { perTx: "0.5", daily: "3" } },
  97: { chainId: 97, profile: "testnet", native: "tBNB", dir: "bscTestnet", protocolRevenueVault: null, liveRecruiterVault: null, topazRouter: null /* from testnet.gen6.json */, defaultCaps: { perTx: "0.5", daily: "2" } },
  46630: { chainId: 46630, profile: "testnet", native: "ETH", dir: "robinhood", protocolRevenueVault: null, liveRecruiterVault: null, topazRouter: null, defaultCaps: { perTx: "0.5", daily: "2" } },
  31337: { chainId: 31337, profile: "local", native: "ETH", dir: "localhost", protocolRevenueVault: null, liveRecruiterVault: null, topazRouter: null, defaultCaps: { perTx: "0.5", daily: "2" } },
};

const REAL_NETWORKS: Record<string, number> = { bscMainnet: 56, robinhoodMainnet: 4663, bscTestnet: 97, robinhoodTestnet: 46630 };
const ANVIL_FORKS: Record<string, number> = { bscForkRehearsal: 56, robinhoodForkRehearsal: 4663, bscTestnetForkRehearsal: 97 };

const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const log = (line: string) => console.log(`[import-fee-vault] ${line}`);

/** True when nothing this run sends can reach a public network. */
export function isRehearsal(name = network.name) {
  return name === "hardhat" || name === "localhost" || Object.prototype.hasOwnProperty.call(ANVIL_FORKS, name);
}

/** The chain this network stands for, after proving forks are local. Anything else is refused. */
export async function resolveChain(): Promise<ImportFeeChain> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (ANVIL_FORKS[network.name] !== undefined) {
    await assertLocalFork(ANVIL_FORKS[network.name]);
  } else if (REAL_NETWORKS[network.name] !== undefined) {
    if (REAL_NETWORKS[network.name] !== chainId) throw new Error(`REFUSED: ${network.name} reports chain ${chainId}`);
  } else if (network.name === "localhost") {
    if (chainId !== 31337) throw new Error(`REFUSED: localhost reports chain ${chainId}; use a named fork network`);
  } else if (network.name !== "hardhat") {
    throw new Error(`REFUSED: network ${network.name} is not an import-fee-vault network`);
  }
  const chain = IMPORT_FEE_CHAINS[chainId];
  if (!chain) throw new Error(`REFUSED: chain ${chainId} (56, 4663, 97, 46630 or a local 31337 only)`);
  return chain;
}

/** Record / batch path: the real one on a real network, else under deployments/fork-rehearsal/<network>[-<chainId>]/. */
export function outPath(chain: ImportFeeChain, file: string): string {
  const real = path.join(DEPLOYMENTS, chain.dir, file);
  if (!isRehearsal()) return real;
  const dirName = network.name === "hardhat" || network.name === "localhost" ? `${network.name}-${chain.chainId}` : network.name;
  const outDir = String(process.env.REHEARSAL_OUT_DIR || "").trim() || path.join(DEPLOYMENTS, "fork-rehearsal", dirName);
  return path.join(outDir, chain.dir, file);
}

function envAddress(name: string): string | null {
  const raw = String(process.env[name] || "").trim();
  return raw ? ethers.getAddress(raw) : null;
}

/** Caps in wei from env (ether units) or the chain defaults; perTx <= daily, both > 0. */
export function resolveCaps(chain: ImportFeeChain, env: NodeJS.ProcessEnv = process.env) {
  const perTxRaw = String(env[`IMPORT_FEE_MAX_PAYOUT_PER_TX_${chain.chainId}`] || chain.defaultCaps.perTx).trim();
  const dailyRaw = String(env[`IMPORT_FEE_DAILY_PAYOUT_CAP_${chain.chainId}`] || chain.defaultCaps.daily).trim();
  const perTx = ethers.parseEther(perTxRaw);
  const daily = ethers.parseEther(dailyRaw);
  if (perTx <= 0n || daily <= 0n) throw new Error("payout caps must be > 0");
  if (perTx > daily) throw new Error(`per-tx cap ${perTxRaw} is above the daily cap ${dailyRaw}`);
  return { perTx, daily };
}

/** The new import payout operator: required, an EOA, and none of the keys that already hold a role. */
export async function resolveOperator(chain: ImportFeeChain, deployer: string, admin: string, env: NodeJS.ProcessEnv = process.env) {
  const name = `IMPORT_FEE_PAYOUT_OPERATOR_${chain.chainId}`;
  const raw = String(env[name] || "").trim();
  if (!raw) throw new Error(`${name} is required: the address of a NEW, dedicated import payout operator key`);
  const op = ethers.getAddress(raw);
  if (op === ethers.ZeroAddress) throw new Error(`${name} is zero`);
  if (same(op, EXISTING_PAYOUT_OPERATOR)) throw new Error(`${name} is the existing payout operator ${EXISTING_PAYOUT_OPERATOR}; the import vault needs its own key (CO-IMP I8)`);
  if (same(op, SAFE)) throw new Error(`${name} is the Safe`);
  if (same(op, deployer) && chain.profile === "mainnet") throw new Error(`${name} is the deployer`);
  if (same(op, admin) && chain.profile === "mainnet") throw new Error(`${name} is the vault admin`);
  const code = await ethers.provider.getCode(op);
  if (code && code !== "0x" && !code.startsWith("0xef0100")) throw new Error(`${name} ${op} has contract code; the operator must be an EOA`);
  return op;
}

/** The three admin calls of batch IF1, in order. */
export function importFeeVaultCalls(vault: string, operator: string, caps: { perTx: bigint; daily: bigint }): PlannedCall[] {
  return [
    { contract: "RecruiterRewardsVault", to: vault, fn: "setOperator", args: [operator], note: "new dedicated import payout operator (not 0xdcf07EB0)" },
    { contract: "RecruiterRewardsVault", to: vault, fn: "setPayoutCaps", args: [caps.perTx.toString(), caps.daily.toString()] },
    { contract: "RecruiterRewardsVault", to: vault, fn: "setPayoutsPaused", args: [false], note: "requires the operator and both caps (the two calls before it)" },
  ];
}

/** The calls still missing on chain (a resumed run or a partly executed batch). */
export async function pendingCalls(vault: string, operator: string, caps: { perTx: bigint; daily: bigint }): Promise<PlannedCall[]> {
  const v = await ethers.getContractAt("RecruiterRewardsVault", vault);
  const all = importFeeVaultCalls(vault, operator, caps);
  const out: PlannedCall[] = [];
  if (!same(await v.operator(), operator)) out.push(all[0]);
  if ((await v.maxPayoutPerTx()) !== caps.perTx || (await v.dailyPayoutCap()) !== caps.daily) out.push(all[1]);
  if (await v.payoutsPaused()) out.push(all[2]);
  return out;
}

async function requireCode(label: string, address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function assertChain(expected: number) {
  const id = Number((await ethers.provider.getNetwork()).chainId);
  if (id !== expected) throw new Error(`REFUSED: chain ${id}, expected ${expected}`);
}

/** Topaz router for CI4: 56 pinned, 97 from the gen-6 testnet record (the authoritative 30 bps one), IMPORT_FEE_TOPAZ_ROUTER on local. */
export function topazRouterFor(chain: ImportFeeChain): string | null {
  if (chain.chainId === 97) {
    const rec = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, "bscTestnet", "testnet.gen6.json"), "utf8"));
    return ethers.getAddress(rec.topaz.router);
  }
  if (chain.chainId === 31337) return envAddress("IMPORT_FEE_TOPAZ_ROUTER");
  return chain.topazRouter ? ethers.getAddress(chain.topazRouter) : null;
}

/** Deploys the audited ImportSwapFeeRouter unchanged, both receivers = the vault, 100 / 0 bps, Topaz only. */
export async function deployTopazFeeRouter(deployer: any, vault: string, topazRouter: string) {
  await requireCode("Topaz router", topazRouter);
  const topaz = new ethers.Contract(topazRouter, ["function weth() view returns (address)", "function defaultFactory() view returns (address)"], ethers.provider);
  const wrapped = ethers.getAddress(await topaz.weth());
  const factory = ethers.getAddress(await topaz.defaultFactory());
  const router = await (await ethers.getContractFactory("ImportSwapFeeRouter", deployer)).deploy(wrapped, vault, vault, IMPORT_FEE_TOTAL_BPS, 0n, ethers.ZeroAddress, topazRouter);
  await router.waitForDeployment();
  const address = await router.getAddress();
  const checks: Array<[string, unknown, unknown]> = [
    ["wrappedNative", await router.wrappedNative(), wrapped],
    ["protocolReceiver", await router.protocolReceiver(), vault],
    ["creatorReceiver", await router.creatorReceiver(), vault],
    ["protocolBps", await router.protocolBps(), IMPORT_FEE_TOTAL_BPS],
    ["creatorBps", await router.creatorBps(), 0n],
    ["v3Router", await router.v3Router(), ethers.ZeroAddress],
    ["v2Router", await router.v2Router(), topazRouter],
    ["v2Factory", await router.v2Factory(), factory],
  ];
  for (const [label, got, want] of checks) {
    if (String(got).toLowerCase() !== String(want).toLowerCase()) throw new Error(`ImportSwapFeeRouter.${label}=${got}, expected ${want}`);
  }
  log(`ImportSwapFeeRouter ${address} (Topaz ${topazRouter}, factory ${factory}, wrapped ${wrapped}, 100 bps -> vault ${vault})`);
  return { address, wrappedNative: wrapped, v2Router: topazRouter, v2Factory: factory, protocolBps: 100, creatorBps: 0, protocolReceiver: vault, creatorReceiver: vault };
}

export async function main(opts: { signer?: any } = {}) {
  const chain = await resolveChain();
  const deployer = opts.signer ?? (await ethers.getSigners())[0];
  if (!deployer) throw new Error("no deployer signer for this network");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const mainnet = chain.profile === "mainnet";
  const admin = mainnet ? SAFE : deployerAddress;
  const recordFile = outPath(chain, `${chain.profile}.import-fee-vault.json`);
  const batchFile = outPath(chain, "mainnet.IF1-import-fee-vault.safe-batch.json");
  const existing = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : null;

  if (["1", "true"].includes(String(process.env.IMPORT_FEE_BATCH_ONLY || "").trim())) {
    if (!mainnet || !existing?.vault) throw new Error("IMPORT_FEE_BATCH_ONLY needs a mainnet record with a vault");
    const calls = await pendingCalls(existing.vault, existing.operator, { perTx: BigInt(existing.caps.perTx), daily: BigInt(existing.caps.daily) });
    return { record: existing, batchFile: calls.length ? writeBatch(chain, batchFile, existing.vault, calls) : null, calls };
  }

  const confirm = mainnet ? "I_UNDERSTAND_MAINNET" : "I_UNDERSTAND_TESTNET";
  if (chain.profile !== "local" && String(process.env.CONFIRM_IMPORT_FEE_VAULT || "").trim() !== confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_IMPORT_FEE_VAULT=${confirm}.`);
  }
  if (mainnet && !isRehearsal() && (process.env.CI || !process.stdin.isTTY)) {
    throw new Error("Refusing a mainnet send from a non-interactive shell: this runs only from the founder's terminal.");
  }
  if (mainnet && same(deployerAddress, SAFE)) throw new Error("deployer resolved to the Safe; deploy from the EOA");
  if (chain.profile === "testnet" && !isRehearsal() && !same(deployerAddress, TESTNET_ADMIN)) {
    throw new Error(`testnet deployer ${deployerAddress} is not the gen-6 / gen-7 testnet admin ${TESTNET_ADMIN}`);
  }
  if (mainnet) {
    await requireCode("Safe", SAFE);
    await requireCode("ProtocolRevenueVault", chain.protocolRevenueVault!);
  }
  const operator = await resolveOperator(chain, deployerAddress, admin);
  const caps = resolveCaps(chain);
  const wantRouter = ["1", "true"].includes(String(process.env.IMPORT_FEE_DEPLOY_TOPAZ_ROUTER || "").trim());
  const topazRouter = wantRouter ? topazRouterFor(chain) : null;
  if (wantRouter && !topazRouter) throw new Error(`IMPORT_FEE_DEPLOY_TOPAZ_ROUTER: no Topaz router on chain ${chain.chainId} (BNB 56 / 97 only)`);
  log(`chain ${chain.chainId} (${network.name}, ${chain.profile}) deployer ${deployerAddress} admin ${admin} operator ${operator} caps ${ethers.formatEther(caps.perTx)} / ${ethers.formatEther(caps.daily)} ${chain.native}`);

  const rec: any = existing ?? {
    kind: "import-fee-vault", changeOrder: "CO-IMP rev 2 CI1", network: network.name, chainId: chain.chainId, profile: chain.profile,
    contract: "RecruiterRewardsVault (unchanged bytecode, used as ImportFeeVault)", deployer: deployerAddress, admin,
    protocolRevenueVault: chain.protocolRevenueVault, startedAt: new Date().toISOString(),
    balanceBefore: (await ethers.provider.getBalance(deployerAddress)).toString(),
  };
  if (existing && !same(existing.admin, admin)) throw new Error(`${recordFile} records admin ${existing.admin}, this run resolves ${admin}`);
  rec.operator = operator;
  rec.caps = { perTx: caps.perTx.toString(), daily: caps.daily.toString(), perTxNative: ethers.formatEther(caps.perTx), dailyNative: ethers.formatEther(caps.daily) };

  if (!rec.vault) {
    await assertChain(chain.chainId);
    const vault = await (await ethers.getContractFactory("RecruiterRewardsVault", deployer)).deploy(admin);
    await vault.waitForDeployment();
    rec.vault = await vault.getAddress();
    rec.deployTx = vault.deploymentTransaction()?.hash ?? null;
    rec.startBlock = (await vault.deploymentTransaction()?.wait())?.blockNumber ?? (await ethers.provider.getBlockNumber());
    writeRecord(recordFile, rec); // resumable: a re-run never deploys a second vault
    log(`ImportFeeVault (RecruiterRewardsVault) ${rec.vault} at block ${rec.startBlock}`);
  } else {
    log(`vault already recorded: ${rec.vault}`);
  }
  const v = await ethers.getContractAt("RecruiterRewardsVault", rec.vault);
  if (!same(await v.admin(), admin)) throw new Error(`vault admin ${await v.admin()} != ${admin}`);
  if (chain.liveRecruiterVault) {
    // Same source, same compiler profile, same immutable admin (the Safe): the runtime code is the live vault's, byte for byte.
    const code = await ethers.provider.getCode(rec.vault);
    if (code !== (await ethers.provider.getCode(chain.liveRecruiterVault))) throw new Error(`vault ${rec.vault} runtime code differs from the live RecruiterRewardsVault ${chain.liveRecruiterVault}`);
    rec.runtimeCodeEqualsLiveRecruiterVault = chain.liveRecruiterVault;
    log(`runtime code == live RecruiterRewardsVault ${chain.liveRecruiterVault} (${(code.length - 2) / 2} bytes)`);
  }

  const calls = await pendingCalls(rec.vault, operator, caps);
  if (mainnet) {
    // The Safe sends these. setPayoutsPaused(false) needs the operator and caps of the same batch, so it is simulated
    // only when the two before it are already done on chain.
    const independent = calls.filter((c) => !(c.fn === "setPayoutsPaused" && calls.length > 1));
    if (independent.length) await simulateAsAdmin(admin, independent, (l) => log(l.trim()));
    rec.batchFile = calls.length ? writeBatch(chain, batchFile, rec.vault, calls) : null;
    rec.status = calls.length ? "deployed-paused (Safe batch IF1 pending)" : "deployed-open";
  } else {
    for (const c of calls) {
      await assertChain(chain.chainId);
      const tx = await deployer.sendTransaction({ to: c.to, data: await encodePlannedCall(c) });
      const rc = await tx.wait(1);
      if (!rc || rc.status !== 1) throw new Error(`${c.fn} failed`);
      log(`sent ${c.fn}(${c.args.map(String).join(", ")}): ${tx.hash}`);
    }
    if ((await pendingCalls(rec.vault, operator, caps)).length) throw new Error("vault still has pending admin calls after sending them");
    rec.adminCallsSent = calls.map((c) => `${c.fn}(${c.args.map(String).join(",")})`);
    rec.status = "deployed-open";
  }

  if (topazRouter && !rec.importSwapFeeRouter) {
    await assertChain(chain.chainId);
    rec.importSwapFeeRouter = await deployTopazFeeRouter(deployer, rec.vault, topazRouter);
  }

  rec.env = {
    [`IMPORT_FEE_VAULT_${chain.chainId}`]: rec.vault,
    [`IMPORT_FEE_PAYOUT_OPERATOR_${chain.chainId}`]: operator,
    ...(rec.importSwapFeeRouter ? { [`IMPORT_SWAP_FEE_ROUTER_${chain.chainId}`]: rec.importSwapFeeRouter.address } : {}),
  };
  rec.balanceAfter = (await ethers.provider.getBalance(deployerAddress)).toString();
  rec.finishedAt = new Date().toISOString();
  writeRecord(recordFile, rec);
  log(`wrote ${recordFile}`);
  for (const [k, val] of Object.entries(rec.env)) log(`env ${k}=${val}`);
  log(mainnet
    ? "STOP. Vault deployed paused. Next: the Safe executes IF1; then the env switch (bps 100 + receiver) in the release window."
    : `Vault open on the ${chain.profile} profile (operator + caps set by the deployer, the admin).`);
  return { record: rec, recordFile, batchFile: rec.batchFile ?? null, calls };
}

function writeBatch(chain: ImportFeeChain, file: string, vault: string, calls: PlannedCall[]) {
  writeSafeBatch(file, chain.chainId, `IF1 ImportFeeVault (${chain.native})`,
    `CO-IMP CI1: ImportFeeVault ${vault} (RecruiterRewardsVault bytecode): setOperator (new import payout operator), setPayoutCaps, setPayoutsPaused(false).`, calls);
  for (const c of calls) log(`  IF1 ${c.fn}(${c.args.map(String).join(", ")}) -> ${c.to}${c.note ? `  # ${c.note}` : ""}`);
  log(`wrote Safe batch ${file}`);
  return file;
}

function writeRecord(file: string, rec: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rec, big, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
