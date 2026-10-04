/**
 * Safe Transaction Builder batches that make ProtocolRevenueForwarder TreasuryRouterV4's protocol revenue
 * vault, one pair per chain (the forwarder address is known only after its deploy):
 *
 *   S1  TreasuryRouterV4.proposeProtocolRevenueVault(forwarder)   starts the router's 3600 s timelock
 *   S2  TreasuryRouterV4.acceptProtocolRevenueVault()             at least 3600 s after S1 executed
 *
 * Until S2 executes the router keeps routing to the current ProtocolRevenueVault; there is no gap and no
 * pause. Rollback is the same pair with the old vault as the argument (ROLLBACK=1 writes it).
 *
 * Every `data` is encoded from the compiled ABI and re-encoded independently (scripts/make-safe-batch.ts).
 * With an RPC (FORWARDER_RPC, or the public default for the chain) the script also reads, with eth_call
 * only: the router's admin / delay / current vault / pending vault, the forwarder's code and immutables
 * (admin = Safe, nativeSink = current vault, wrappedNative = the chain's WBNB / WETH), and simulates S1 as
 * the Safe. S2 cannot be simulated before S1 has executed (the router answers "no pending"); the fork test
 * test/ProtocolRevenueForwarder.fork.spec.ts executes both exactly as written here.
 *
 * Usage (no key, no transaction; needs `npx hardhat compile` first for the artifacts):
 *   npx ts-node scripts/make-protocol-forwarder-batches.ts <bnb|robinhood> <forwarder> [outDir]
 *   OFFLINE=1 ...      skip the chain reads (encoding only)
 *   ROLLBACK=1 ...     write the rollback pair (propose the old vault again) instead; <forwarder> is still
 *                      required so the files name what they roll back from
 * Default outDir: deployments/<bnb|robinhood>/.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { buildBatch, verifyBatchFile } from "./make-safe-batch";

export type ForwarderChainKey = "bnb" | "robinhood";

export type ForwarderPins = {
  chainId: number;
  label: string;
  safe: string;
  router: string;
  /** The ProtocolRevenueVault the router points at today; it stays the forwarder's native sink. */
  vault: string;
  wrappedNative: string;
  wrappedSymbol: string;
  rpc: string;
};

// Read from chain 2026-10-04 with eth_call (router.admin / upgradeDelay / protocolRevenueVault, vault.admin).
export const FORWARDER_PINS: Record<ForwarderChainKey, ForwarderPins> = {
  bnb: {
    chainId: 56,
    label: "BNB",
    safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7",
    router: "0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa",
    vault: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    wrappedSymbol: "WBNB",
    rpc: "https://bsc-dataseed.bnbchain.org",
  },
  robinhood: {
    chainId: 4663,
    label: "Robinhood Chain",
    safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7",
    router: "0x49Ae38B19664d90b410AE860B9604e1Bc5f7Ab5d",
    vault: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    wrappedSymbol: "WETH",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
  },
};

export const ROUTER_UPGRADE_DELAY_SECONDS = 3600;

type Call = { contract: string; to: string; fn: string; args: unknown[] };

export function forwarderBatchCalls(key: ForwarderChainKey, forwarder: string, rollback = false): { s1: Call[]; s2: Call[] } {
  const p = FORWARDER_PINS[key];
  if (!p) throw new Error(`unknown chain ${key}`);
  const fwd = ethers.getAddress(forwarder);
  if (fwd === ethers.getAddress(p.vault)) throw new Error("forwarder equals the current vault");
  const target = rollback ? ethers.getAddress(p.vault) : fwd;
  return {
    s1: [{ contract: "TreasuryRouterV4", to: p.router, fn: "proposeProtocolRevenueVault", args: [target] }],
    s2: [{ contract: "TreasuryRouterV4", to: p.router, fn: "acceptProtocolRevenueVault", args: [] }],
  };
}

export function forwarderBatchFiles(key: ForwarderChainKey, outDir: string, rollback = false) {
  const tag = rollback ? "PFR" : "PF";
  return {
    s1: path.join(outDir, `mainnet.${tag}1-protocol-forwarder-${rollback ? "rollback-" : ""}propose.safe-batch.json`),
    s2: path.join(outDir, `mainnet.${tag}2-protocol-forwarder-${rollback ? "rollback-" : ""}accept.safe-batch.json`),
  };
}

/** Writes S1 and S2 for one chain and re-verifies each file; returns the paths. */
export function writeForwarderBatches(key: ForwarderChainKey, forwarder: string, outDir: string, rollback = false) {
  const p = FORWARDER_PINS[key];
  const fwd = ethers.getAddress(forwarder);
  const calls = forwarderBatchCalls(key, fwd, rollback);
  const files = forwarderBatchFiles(key, outDir, rollback);
  const short = (a: string) => `${a.slice(0, 10)}`;
  const s1Name = rollback ? "MWZ PFR1: protocol vault rollback, propose" : "MWZ PF1: protocol forwarder, propose";
  const s2Name = rollback ? "MWZ PFR2: protocol vault rollback, accept" : "MWZ PF2: protocol forwarder, accept";
  const s1Desc = rollback
    ? `TreasuryRouterV4 ${short(p.router)} on ${p.label}: propose the ProtocolRevenueVault ${short(p.vault)} again (rollback from forwarder ${short(fwd)}). The forwarder stays live until PFR2. Execute PFR2 no earlier than ${ROUTER_UPGRADE_DELAY_SECONDS} s after this executes.`
    : `TreasuryRouterV4 ${short(p.router)} on ${p.label}: propose ProtocolRevenueForwarder ${short(fwd)} as the protocol revenue vault. It forwards native to the current ProtocolRevenueVault ${short(p.vault)} and unwraps the LP protocol 20% (${p.wrappedSymbol}) through flush(). Nothing changes until PF2. Execute PF2 no earlier than ${ROUTER_UPGRADE_DELAY_SECONDS} s after this executes.`;
  const s2Desc = rollback
    ? `TreasuryRouterV4 ${short(p.router)} on ${p.label}: accept the pending protocol revenue vault (the old ProtocolRevenueVault ${short(p.vault)}). Reverts "delay" before ${ROUTER_UPGRADE_DELAY_SECONDS} s since PFR1 and "no pending" without PFR1.`
    : `TreasuryRouterV4 ${short(p.router)} on ${p.label}: accept the pending protocol revenue vault (ProtocolRevenueForwarder ${short(fwd)}). Reverts "delay" before ${ROUTER_UPGRADE_DELAY_SECONDS} s since PF1 and "no pending" without PF1. After it: router.protocolRevenueVault() == ${fwd}.`;
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, name, desc, c] of [
    [files.s1, s1Name, s1Desc, calls.s1],
    [files.s2, s2Name, s2Desc, calls.s2],
  ] as const) {
    const batch = buildBatch(p.chainId, name, desc, c as Call[]);
    fs.writeFileSync(file, `${JSON.stringify(batch, null, 2)}\n`);
    verifyBatchFile(file, p.chainId, p.router);
  }
  return files;
}

const ROUTER_ABI = [
  "function admin() view returns (address)",
  "function upgradeDelay() view returns (uint64)",
  "function protocolRevenueVault() view returns (address)",
  "function pendingProtocolRevenueVault() view returns (address)",
  "function pendingProtocolRevenueVaultSince() view returns (uint64)",
];
const FORWARDER_ABI = [
  "function admin() view returns (address)",
  "function nativeSink() view returns (address)",
  "function wrappedNative() view returns (address)",
];

/** eth_call-only checks of the live state the batches assume. Throws on any mismatch. */
export async function checkForwarderOnChain(key: ForwarderChainKey, forwarder: string, provider: ethers.Provider, rollback = false) {
  const p = FORWARDER_PINS[key];
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== p.chainId) throw new Error(`RPC is chain ${net.chainId}, expected ${p.chainId}`);
  const router = new ethers.Contract(p.router, ROUTER_ABI, provider);
  const fwd = new ethers.Contract(forwarder, FORWARDER_ABI, provider);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const read = {
    routerAdmin: String(await router.admin()),
    upgradeDelay: Number(await router.upgradeDelay()),
    currentVault: String(await router.protocolRevenueVault()),
    pendingVault: String(await router.pendingProtocolRevenueVault()),
    pendingSince: Number(await router.pendingProtocolRevenueVaultSince()),
    forwarderCode: (await provider.getCode(forwarder)).length > 2,
    forwarderAdmin: "",
    forwarderSink: "",
    forwarderWrapped: "",
  };
  if (read.forwarderCode) {
    read.forwarderAdmin = String(await fwd.admin());
    read.forwarderSink = String(await fwd.nativeSink());
    read.forwarderWrapped = String(await fwd.wrappedNative());
  }
  const problems: string[] = [];
  if (!same(read.routerAdmin, p.safe)) problems.push(`router.admin ${read.routerAdmin} != Safe ${p.safe}`);
  if (read.upgradeDelay !== ROUTER_UPGRADE_DELAY_SECONDS) problems.push(`router.upgradeDelay ${read.upgradeDelay} != ${ROUTER_UPGRADE_DELAY_SECONDS}`);
  const expectedCurrent = rollback ? forwarder : p.vault;
  if (!same(read.currentVault, expectedCurrent)) problems.push(`router.protocolRevenueVault ${read.currentVault} != expected ${expectedCurrent}`);
  if (!read.forwarderCode) problems.push(`no code at forwarder ${forwarder}`);
  else {
    if (!same(read.forwarderAdmin, p.safe)) problems.push(`forwarder.admin ${read.forwarderAdmin} != Safe`);
    if (!same(read.forwarderSink, p.vault)) problems.push(`forwarder.nativeSink ${read.forwarderSink} != vault ${p.vault}`);
    if (!same(read.forwarderWrapped, p.wrappedNative)) problems.push(`forwarder.wrappedNative ${read.forwarderWrapped} != ${p.wrappedNative}`);
  }
  if (problems.length) throw new Error(`on-chain check failed on ${p.label}:\n  ${problems.join("\n  ")}`);
  // S1 simulated as the Safe (eth_call, nothing is sent).
  const iface = new ethers.Interface(["function proposeProtocolRevenueVault(address)"]);
  await provider.call({ from: p.safe, to: p.router, data: iface.encodeFunctionData("proposeProtocolRevenueVault", [rollback ? p.vault : forwarder]) });
  return read;
}

async function cli() {
  const [chainArg, forwarderArg, outArg] = process.argv.slice(2);
  const key = String(chainArg || "").toLowerCase() as ForwarderChainKey;
  if (!FORWARDER_PINS[key] || !forwarderArg) throw new Error("usage: make-protocol-forwarder-batches <bnb|robinhood> <forwarder> [outDir]");
  const forwarder = ethers.getAddress(forwarderArg);
  const rollback = ["1", "true"].includes(String(process.env.ROLLBACK || "").toLowerCase());
  const outDir = outArg || path.join(__dirname, "..", "deployments", key);
  const p = FORWARDER_PINS[key];
  if (!["1", "true"].includes(String(process.env.OFFLINE || "").toLowerCase())) {
    const provider = new ethers.JsonRpcProvider(process.env.FORWARDER_RPC || p.rpc, p.chainId, { staticNetwork: true });
    const read = await checkForwarderOnChain(key, forwarder, provider, rollback);
    console.log(`on-chain (eth_call) ${p.label}: ${JSON.stringify(read)}`);
    if (read.pendingVault !== ethers.ZeroAddress) console.log(`NOTE: a protocol vault is already pending (${read.pendingVault} since ${read.pendingSince}); S1 overwrites it and restarts the delay.`);
    console.log("S1 simulated as the Safe: ok");
  }
  const files = writeForwarderBatches(key, forwarder, outDir, rollback);
  for (const f of [files.s1, files.s2]) {
    const b = JSON.parse(fs.readFileSync(f, "utf8"));
    console.log(`wrote ${f}`);
    for (const tx of b.transactions) console.log(`  ${tx.contractMethod.name}(${Object.values(tx.contractInputsValues).join(", ")}) -> ${tx.to}  data ${tx.data}`);
  }
}

if (require.main === module) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
