/**
 * RobinhoodV3NativeSwapAdapterV2 (docs/evm-launch/CO-IMPORT-SWAP-FEE.md A.2): the live RobinhoodV3NativeSwapAdapter with
 * start-of-call balance checks, so a donated token / WETH / forced native can no longer brick trades. Same ABI; the app
 * switches by setting VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_<chainId> (unset = today's adapter).
 *
 * The constructor args are READ FROM THE LIVE ADAPTER (swapRouter(), wrappedNative()), never typed in, so V2 trades on
 * exactly the router / WETH the app already verifies against the market route. The source adapter must have the
 * deadline ABI the app calls (selectors 0x1da7d616 / 0xbb592133). No owner, no admin calls, nothing to configure.
 *
 *   4663   source 0xDfd381EC (gen 6, live)     CONFIRM_RH_SWAP_ADAPTER_V2=I_UNDERSTAND_MAINNET + interactive terminal
 *   46630  source 0x116f9Bfe (gen 6b record)   CONFIRM_RH_SWAP_ADAPTER_V2=I_UNDERSTAND_TESTNET
 *   RH_SWAP_ADAPTER_V2_SOURCE overrides the source (must still pass the ABI check).
 *
 * Usage (each line a founder go):
 *   CONFIRM_RH_SWAP_ADAPTER_V2=I_UNDERSTAND_MAINNET npx hardhat run scripts/deploy-robinhood-swap-adapter-v2.ts --network robinhoodMainnet
 *   CONFIRM_RH_SWAP_ADAPTER_V2=I_UNDERSTAND_TESTNET npx hardhat run scripts/deploy-robinhood-swap-adapter-v2.ts --network robinhoodTestnet
 * Rehearsals (nothing leaves the machine; records under deployments/fork-rehearsal/, gitignored):
 *   robinhoodForkRehearsal (local anvil fork of 4663, proven by anvil_nodeInfo), the in-process `hardhat` network
 *   (e.g. --config hardhat.rh-fork.config.ts) and localhost. A re-run with a record resumes: it never deploys twice.
 * Record: deployments/robinhood/<mainnet|testnet>.native-swap-adapter-v2.json.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { assertLocalFork } from "./lib/forkRehearsal";

const ROOT = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.join(ROOT, "deployments");

export const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
export const TESTNET_DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
/** The app's adapter ABI (frontend/src/lib/robinhoodV3Trade.ts): buy / sell with a deadline. */
export const REQUIRED_SELECTORS = { buyExactNativeIn: "0x1da7d616", sellExactTokenIn: "0xbb592133" } as const;

type Profile = "mainnet" | "testnet" | "local";
export type AdapterChain = { chainId: number; profile: Profile; defaultSource: string | null };

export const ADAPTER_CHAINS: Record<number, AdapterChain> = {
  4663: { chainId: 4663, profile: "mainnet", defaultSource: "0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296" },
  46630: { chainId: 46630, profile: "testnet", defaultSource: null /* deployments/robinhood/testnet.gen6b.json */ },
  31337: { chainId: 31337, profile: "local", defaultSource: null },
};

const REAL_NETWORKS: Record<string, number> = { robinhoodMainnet: 4663, robinhoodTestnet: 46630 };
const ANVIL_FORKS: Record<string, number> = { robinhoodForkRehearsal: 4663 };

const log = (line: string) => console.log(`[rh-swap-adapter-v2] ${line}`);
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);

export function isRehearsal(name = network.name) {
  return name === "hardhat" || name === "localhost" || Object.prototype.hasOwnProperty.call(ANVIL_FORKS, name);
}

export async function resolveChain(): Promise<AdapterChain> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (ANVIL_FORKS[network.name] !== undefined) {
    await assertLocalFork(ANVIL_FORKS[network.name]);
  } else if (REAL_NETWORKS[network.name] !== undefined) {
    if (REAL_NETWORKS[network.name] !== chainId) throw new Error(`REFUSED: ${network.name} reports chain ${chainId}`);
  } else if (network.name === "localhost") {
    if (chainId !== 31337) throw new Error(`REFUSED: localhost reports chain ${chainId}; use a named fork network`);
  } else if (network.name !== "hardhat") {
    throw new Error(`REFUSED: network ${network.name} is not a Robinhood swap-adapter network`);
  }
  const chain = ADAPTER_CHAINS[chainId];
  if (!chain) throw new Error(`REFUSED: chain ${chainId} (4663, 46630 or a local 31337 only)`);
  return chain;
}

/** The live adapter whose immutables V2 copies: env override, else the chain default (46630: the gen-6b record). */
export function sourceAdapterFor(chain: AdapterChain, env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.RH_SWAP_ADAPTER_V2_SOURCE || "").trim();
  if (raw) return ethers.getAddress(raw);
  if (chain.chainId === 46630) {
    const rec = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, "robinhood", "testnet.gen6b.json"), "utf8"));
    return ethers.getAddress(rec.generation.deployed.RobinhoodV3NativeSwapAdapter);
  }
  if (!chain.defaultSource) throw new Error(`RH_SWAP_ADAPTER_V2_SOURCE is required on chain ${chain.chainId}`);
  return ethers.getAddress(chain.defaultSource);
}

export function outPath(chain: AdapterChain): string {
  const file = `${chain.profile}.native-swap-adapter-v2.json`;
  if (!isRehearsal()) return path.join(DEPLOYMENTS, "robinhood", file);
  const dirName = network.name === "hardhat" || network.name === "localhost" ? `${network.name}-${chain.chainId}` : network.name;
  const outDir = String(process.env.REHEARSAL_OUT_DIR || "").trim() || path.join(DEPLOYMENTS, "fork-rehearsal", dirName);
  return path.join(outDir, "robinhood", file);
}

async function requireCode(label: string, address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
  return code;
}

/** swapRouter / wrappedNative of the live adapter, after proving it is the deadline-ABI adapter the app calls. */
export async function readSourceAdapter(source: string) {
  const code = (await requireCode("source adapter", source)).toLowerCase();
  for (const [fn, sel] of Object.entries(REQUIRED_SELECTORS)) {
    if (!code.includes(sel.slice(2))) throw new Error(`source adapter ${source} has no ${fn} with a deadline (${sel}); not the app's adapter`);
  }
  const a = new ethers.Contract(source, ["function swapRouter() view returns (address)", "function wrappedNative() view returns (address)"], ethers.provider);
  const swapRouter = ethers.getAddress(await a.swapRouter());
  const wrappedNative = ethers.getAddress(await a.wrappedNative());
  await requireCode("swapRouter", swapRouter);
  await requireCode("wrappedNative", wrappedNative);
  return { swapRouter, wrappedNative };
}

export async function main(opts: { signer?: any } = {}) {
  const chain = await resolveChain();
  // In-process fork: EDR treats a call at the fork block itself as historical; one local block fixes that.
  if (network.name === "hardhat" && (network.config as any).forking?.url) await network.provider.send("evm_mine", []);
  const deployer = opts.signer ?? (await ethers.getSigners())[0];
  if (!deployer) throw new Error("no deployer signer for this network");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const mainnet = chain.profile === "mainnet";

  const confirm = mainnet ? "I_UNDERSTAND_MAINNET" : "I_UNDERSTAND_TESTNET";
  if (chain.profile !== "local" && !isRehearsal() && String(process.env.CONFIRM_RH_SWAP_ADAPTER_V2 || "").trim() !== confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_RH_SWAP_ADAPTER_V2=${confirm}.`);
  }
  if (mainnet && !isRehearsal() && (process.env.CI || !process.stdin.isTTY)) {
    throw new Error("Refusing a mainnet send from a non-interactive shell: this runs only from the founder's terminal.");
  }
  if (same(deployerAddress, SAFE)) throw new Error("deployer resolved to the Safe; deploy from the EOA");
  if (chain.profile === "testnet" && !isRehearsal() && !same(deployerAddress, TESTNET_DEPLOYER)) {
    throw new Error(`testnet deployer ${deployerAddress} is not the gen-6 / gen-7 testnet deployer ${TESTNET_DEPLOYER}`);
  }

  const source = sourceAdapterFor(chain);
  const { swapRouter, wrappedNative } = await readSourceAdapter(source);
  log(`chain ${chain.chainId} (${network.name}, ${chain.profile}) deployer ${deployerAddress}; source ${source} -> router ${swapRouter}, WETH ${wrappedNative}`);

  const recordFile = outPath(chain);
  const existing = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : null;
  const rec: any = existing ?? {
    kind: "robinhood-native-swap-adapter-v2",
    changeOrder: "CO-IMP A.2",
    contract: "contracts/integrations/RobinhoodV3NativeSwapAdapterV2.sol:RobinhoodV3NativeSwapAdapterV2",
    network: network.name,
    chainId: chain.chainId,
    profile: chain.profile,
    deployer: deployerAddress,
    sourceAdapter: source,
    constructorArgs: { swapRouter, wrappedNative },
    startedAt: new Date().toISOString(),
  };
  if (existing && (!same(existing.constructorArgs.swapRouter, swapRouter) || !same(existing.constructorArgs.wrappedNative, wrappedNative))) {
    throw new Error(`${recordFile} records other constructor args than the live adapter ${source} has now`);
  }

  if (rec.address && (await ethers.provider.getCode(rec.address)) !== "0x") {
    log(`already deployed: ${rec.address}`);
  } else {
    const id = Number((await ethers.provider.getNetwork()).chainId);
    if (id !== chain.chainId) throw new Error(`REFUSED: chain ${id}, expected ${chain.chainId}`);
    const adapter = await (await ethers.getContractFactory("RobinhoodV3NativeSwapAdapterV2", deployer)).deploy(swapRouter, wrappedNative);
    await adapter.waitForDeployment();
    rec.address = await adapter.getAddress();
    rec.deployTx = adapter.deploymentTransaction()?.hash ?? null;
    rec.startBlock = (await adapter.deploymentTransaction()?.wait())?.blockNumber ?? (await ethers.provider.getBlockNumber());
    writeRecord(recordFile, rec);
    log(`RobinhoodV3NativeSwapAdapterV2 ${rec.address} at block ${rec.startBlock}`);
  }

  const v2 = await ethers.getContractAt("RobinhoodV3NativeSwapAdapterV2", rec.address);
  if (!same(await v2.swapRouter(), swapRouter)) throw new Error(`V2 swapRouter ${await v2.swapRouter()} != ${swapRouter}`);
  if (!same(await v2.wrappedNative(), wrappedNative)) throw new Error(`V2 wrappedNative ${await v2.wrappedNative()} != ${wrappedNative}`);
  const code = await ethers.provider.getCode(rec.address);
  for (const sel of Object.values(REQUIRED_SELECTORS)) {
    if (!code.toLowerCase().includes(sel.slice(2))) throw new Error(`V2 runtime code lacks ${sel}`);
  }
  rec.runtimeBytes = (code.length - 2) / 2;
  rec.env = { [`VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_${chain.chainId}`]: rec.address };
  rec.finishedAt = new Date().toISOString();
  writeRecord(recordFile, rec);
  log(`wrote ${recordFile}`);
  for (const [k, val] of Object.entries(rec.env)) log(`env ${k}=${val}`);
  log("Nothing to configure (no owner). The app switches when the env above is set on the APP service and rebuilt.");
  return { record: rec, recordFile };
}

function writeRecord(file: string, rec: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
