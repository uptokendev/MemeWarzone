/**
 * Proves the Zodiac Roles v2.1.0 mastercopy the payout watchdog module proxies to is the genuine, audited one
 * (docs/evm-launch/audit/PAYOUT_ROLES_MODULE.md, "Mastercopy verification"). Reads only.
 *
 *   npx hardhat run scripts/verify-zodiac-roles-mastercopy.ts            (in-process hardhat network: required, it
 *                                                                          runs the published init code locally)
 *   ZODIAC_SOLC=/path/to/solc-0.8.21 ZODIAC_MASTERCOPIES_JSON=/path/to/mastercopies.json  (optional: recompile)
 *   ZODIAC_VERIFY_RPC_<chainId>=<url>                                    (defaults: public RPCs of 56, 4663, 97, 46630)
 *
 * Checks, each one a hard failure:
 *   1. CREATE2: every vendored init code, through the ERC-2470 singleton factory and its salt, lands exactly on its
 *      published address (Roles 0x9646fDAD…, Integrity 0x6a6Af4b1…, Packer 0x61C5B1bE…, ModuleProxyFactory
 *      0x000000000000aDdB…). A CREATE2 address commits to the keccak of the init code, so code at that address can
 *      only have come from that init code (given the factory, checked in 3).
 *   2. Runtime: the init code executed on a local EVM yields runtime whose keccak is the vendored expected hash
 *      (libraries carry their own address after the leading PUSH20, so that slot is set to the canonical address).
 *   3. Every chain: eth_getCode at each address has exactly that keccak (and the ERC-2470 factory its own).
 *   4. Optional: solc 0.8.21 compiling the published standard-JSON sources reproduces the published creation bytecode
 *      byte for byte, CBOR metadata hash included (libraries linked after compilation, as Hardhat built it).
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ethers, network } from "hardhat";
import { ethers as E } from "ethers";
import { assertVendorCreate2, initCodeOf, zodiacVendor } from "./lib/zodiacRoles";

const DEFAULT_RPCS: Record<number, string> = {
  56: "https://bsc-dataseed.bnbchain.org",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  97: "https://bsc-testnet-rpc.publicnode.com",
  46630: "https://rpc.testnet.chain.robinhood.com",
};

/** A library's runtime embeds its own address (PUSH20 at byte 1, the call-protection check); set it to `address`. */
function libraryRuntimeAt(runtime: string, address: string): string {
  const hex = runtime.toLowerCase().replace(/^0x/, "");
  if (!hex.startsWith("73")) throw new Error("library runtime does not start with PUSH20");
  return `0x73${E.getAddress(address).slice(2).toLowerCase()}${hex.slice(42)}`;
}

/** Splits creation bytecode into executable code and the trailing CBOR metadata (last 2 bytes = its length). */
function stripMetadata(bytecode: string): { code: string; metadata: string } {
  const hex = bytecode.toLowerCase().replace(/^0x/, "");
  const len = parseInt(hex.slice(-4), 16) * 2 + 4;
  return { code: hex.slice(0, hex.length - len), metadata: hex.slice(hex.length - len) };
}

export async function main() {
  if (network.name !== "hardhat") throw new Error("run on the in-process hardhat network: it executes the published init code locally");
  const v = zodiacVendor();
  const report: any = { checkedAt: new Date().toISOString(), sources: v.sources, create2: {}, runtime: {}, chains: {}, recompile: null };
  report.create2 = assertVendorCreate2();
  console.log("[zodiac] 1 CREATE2 addresses match the init code", report.create2);

  const runtimes: Record<string, string> = {};
  for (const name of ["Roles", "Integrity", "Packer"] as const) {
    let rt = await ethers.provider.call({ data: initCodeOf(name) });
    if (name !== "Roles") rt = libraryRuntimeAt(rt, v.contracts[name].address);
    const hash = E.keccak256(rt);
    if (hash !== v.contracts[name].runtimeKeccak) throw new Error(`${name}: local runtime ${hash} != vendored ${v.contracts[name].runtimeKeccak}`);
    runtimes[name] = rt;
    report.runtime[name] = { keccak: hash, bytes: (rt.length - 2) / 2 };
  }
  const factoryRt = await ethers.provider.call({ data: v.moduleProxyFactory.initCode });
  if (E.keccak256(factoryRt) !== v.moduleProxyFactory.runtimeKeccak) throw new Error("ModuleProxyFactory: local runtime differs from the vendored hash");
  report.runtime.ModuleProxyFactory = { keccak: E.keccak256(factoryRt), bytes: (factoryRt.length - 2) / 2 };
  if (E.keccak256(v.singletonFactoryRuntime) !== v.singletonFactoryRuntimeKeccak) throw new Error("ERC-2470 runtime hash mismatch in the vendored file");
  console.log("[zodiac] 2 init code executed locally gives the expected runtimes", report.runtime);

  const chains = String(process.env.ZODIAC_VERIFY_CHAINS || "56,4663,97,46630").split(",").map((s) => Number(s.trim())).filter(Boolean);
  for (const chainId of chains) {
    const url = String(process.env[`ZODIAC_VERIFY_RPC_${chainId}`] || DEFAULT_RPCS[chainId] || "");
    if (!url) throw new Error(`no RPC for chain ${chainId}`);
    const p = new E.JsonRpcProvider(url, chainId, { staticNetwork: true });
    const row: Record<string, boolean> = {};
    const at = async (a: string) => E.keccak256(await p.getCode(a));
    row.singletonFactory = (await at(v.singletonFactory)) === v.singletonFactoryRuntimeKeccak;
    for (const name of ["Roles", "Integrity", "Packer"] as const) row[name] = (await at(v.contracts[name].address)) === v.contracts[name].runtimeKeccak;
    row.ModuleProxyFactory = (await at(v.moduleProxyFactory.address)) === v.moduleProxyFactory.runtimeKeccak;
    report.chains[chainId] = row;
    console.log(`[zodiac] 3 chain ${chainId}`, row);
    if (Object.values(row).some((ok) => !ok)) throw new Error(`chain ${chainId}: code differs from the verified mastercopy`);
  }

  const solc = String(process.env.ZODIAC_SOLC || "").trim();
  const inputFile = String(process.env.ZODIAC_MASTERCOPIES_JSON || "").trim();
  if (solc && inputFile) {
    const upstream = JSON.parse(fs.readFileSync(inputFile, "utf8"));
    const sha = E.sha256(fs.readFileSync(inputFile));
    if (sha.slice(2) !== v.sources.github.sha256) throw new Error(`${inputFile} sha256 ${sha} is not the pinned ${v.sources.github.sha256}`);
    report.recompile = {};
    const where: Record<string, [string, string]> = { Roles: ["contracts/Roles.sol", "Roles"], Integrity: ["contracts/Integrity.sol", "Integrity"], Packer: ["contracts/packers/Packer.sol", "Packer"] };
    for (const name of ["Roles", "Integrity", "Packer"] as const) {
      // Compiled the way the mastercopy was built (Hardhat: libraries unlinked at compile time, linked at deploy):
      // the published input names the libraries in settings.libraries for verifiers, which would change the CBOR
      // metadata hash; without it and with the addresses linked into the link references, the bytecode is identical.
      const input = JSON.parse(JSON.stringify(upstream[name]["2.1.0"].compilerInput));
      const libraries: Record<string, Record<string, string>> = input.settings.libraries || {};
      delete input.settings.libraries;
      const out = spawnSync(solc, ["--standard-json"], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      const json = JSON.parse(out.stdout);
      const errors = (json.errors || []).filter((e: any) => e.severity === "error");
      if (errors.length) throw new Error(`${name}: solc errors ${JSON.stringify(errors.slice(0, 2))}`);
      const evm = json.contracts[where[name][0]][where[name][1]].evm.bytecode;
      let hex: string = evm.object;
      for (const [file, names] of Object.entries(evm.linkReferences || {}) as Array<[string, Record<string, Array<{ start: number; length: number }>>]>) {
        for (const [lib, refs] of Object.entries(names)) {
          const address = String(libraries[file]?.[lib] || "").toLowerCase().replace(/^0x/, "");
          if (address.length !== 40) throw new Error(`${name}: no address for linked library ${file}:${lib}`);
          for (const ref of refs) hex = hex.slice(0, ref.start * 2) + address + hex.slice(ref.start * 2 + 40);
        }
      }
      const compiled = "0x" + hex;
      const a = stripMetadata(compiled);
      const b = stripMetadata(v.contracts[name].bytecode);
      report.recompile[name] = { identical: compiled.toLowerCase() === v.contracts[name].bytecode.toLowerCase(), executableIdentical: a.code === b.code, metadata: b.metadata, libraries };
      if (!report.recompile[name].identical) throw new Error(`${name}: recompiled bytecode differs from the published bytecode`);
    }
    console.log("[zodiac] 4 recompiled from the published sources", report.recompile);
  } else {
    console.log("[zodiac] 4 recompile skipped (set ZODIAC_SOLC and ZODIAC_MASTERCOPIES_JSON)");
  }
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
