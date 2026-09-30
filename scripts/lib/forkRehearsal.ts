/**
 * Fork rehearsal networks: `bscForkRehearsal` (chain 56) and `robinhoodForkRehearsal` (chain 4663), both
 * served by a local anvil forked from mainnet (hardhat.config.ts). The mainnet deploy scripts accept them as
 * aliases of `bscMainnet` / `robinhoodMainnet` -- same pins, same guards, same code path -- with three
 * differences that exist only because nothing on a fork is real:
 *
 *   1. the alias is honoured only after the node proves it is a local anvil fork (`anvil_nodeInfo` answers
 *      with a fork URL, and the RPC is on 127.0.0.1/localhost); a real mainnet RPC never answers that;
 *   2. the interactive-terminal guard is not required (the rehearsal runs the scripts in-process);
 *   3. every record and Safe batch a script writes lands under the rehearsal output directory
 *      (REHEARSAL_OUT_DIR, default deployments/fork-rehearsal/<network>/, gitignored), never over the
 *      mainnet records under deployments/.
 *
 * The networks carry no private key: the signer is whatever the fork has impersonated (`accounts: "remote"`),
 * so a rehearsal cannot sign anything that would be valid on mainnet.
 */
import path from "node:path";
import { ethers, network } from "hardhat";

export const FORK_REHEARSAL_NETWORKS: Record<string, { profile: string; chainId: number }> = {
  bscForkRehearsal: { profile: "bscMainnet", chainId: 56 },
  robinhoodForkRehearsal: { profile: "robinhoodMainnet", chainId: 4663 },
};

const ROOT = path.resolve(__dirname, "..", "..");
const DEPLOYMENTS = path.join(ROOT, "deployments");

export function isForkRehearsalNetwork(name = network.name): boolean {
  return Object.prototype.hasOwnProperty.call(FORK_REHEARSAL_NETWORKS, name);
}

/** Refuses unless the provider is a local anvil fork of the expected chain. */
export async function assertLocalFork(expectedChainId?: number) {
  const url = String((network.config as any).url || "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) throw new Error(`fork rehearsal network ${network.name} must point at a local anvil, not ${url}`);
  let info: any;
  try {
    info = await ethers.provider.send("anvil_nodeInfo", []);
  } catch {
    throw new Error(`${url} does not answer anvil_nodeInfo: not a local anvil fork, refusing the mainnet alias`);
  }
  const forkUrl = info?.forkConfig?.forkUrl;
  if (!forkUrl) throw new Error(`${url} is an anvil without a fork; the rehearsal needs mainnet state`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (expectedChainId !== undefined && chainId !== expectedChainId) throw new Error(`fork reports chain ${chainId}, expected ${expectedChainId}`);
  return { forkUrl: String(forkUrl), forkBlock: Number(info?.forkConfig?.forkBlockNumber ?? 0), chainId };
}

/** The deploy profile to use: the network name, or the mainnet profile a verified fork network stands for. */
export async function profileNetworkName(): Promise<string> {
  const alias = FORK_REHEARSAL_NETWORKS[network.name];
  if (!alias) return network.name;
  await assertLocalFork(alias.chainId);
  return alias.profile;
}

/** Where a record goes: unchanged on a real network; under the rehearsal directory on a fork network. */
export function rehearsalPath(file: string): string {
  if (!isForkRehearsalNetwork()) return file;
  const outDir = String(process.env.REHEARSAL_OUT_DIR || "").trim() || path.join(DEPLOYMENTS, "fork-rehearsal", network.name);
  const rel = path.relative(DEPLOYMENTS, path.resolve(file));
  const safeRel = rel.startsWith("..") || path.isAbsolute(rel) ? path.basename(file) : rel;
  return path.join(outDir, safeRel);
}
