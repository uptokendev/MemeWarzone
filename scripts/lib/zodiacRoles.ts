/**
 * The vendored Zodiac Roles v2.1.0 mastercopy (scripts/lib/zodiac/roles-v2.1.0.json: GitHub gnosisguild/
 * zodiac-modifier-roles packages/evm/mastercopies.json at 1ddde84d, cross-checked with npm @gnosis.pm/zodiac 4.0.3)
 * and what the payout watchdog tooling does with it:
 *
 *   - expected on-chain code: the runtime keccak of Roles, its two linked libraries (Integrity, Packer), the
 *     ModuleProxyFactory and the ERC-2470 singleton factory. scripts/verify-zodiac-roles-mastercopy.ts proves those
 *     hashes are what the published init code produces (local EVM) and what 56 / 4663 / 97 / 46630 hold;
 *     assertZodiacCode refuses any chain whose code differs (the deploy script runs it before anything else).
 *   - installZodiacLocally: the same contracts on an in-process hardhat chain, deployed through the real ERC-2470
 *     factory at their canonical addresses, for unit tests (no fork, no RPC).
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

export const ZODIAC_VENDOR_FILE = path.join(__dirname, "zodiac", "roles-v2.1.0.json");

export type ZodiacVendor = {
  sources: any;
  singletonFactory: string;
  singletonFactoryRuntime: string;
  singletonFactoryRuntimeKeccak: string;
  contracts: Record<"Roles" | "Integrity" | "Packer", {
    address: string;
    salt: string;
    factory: string;
    bytecode: string;
    constructorArgs: { types: string[]; values: unknown[] };
    compilerVersion: string;
    runtimeKeccak: string;
    runtimeBytes: number;
    abi?: any[];
  }>;
  moduleProxyFactory: { address: string; salt: string; initCode: string; runtimeKeccak: string; runtimeBytes: number };
};

let cached: ZodiacVendor | null = null;
export function zodiacVendor(): ZodiacVendor {
  cached ??= JSON.parse(fs.readFileSync(ZODIAC_VENDOR_FILE, "utf8")) as ZodiacVendor;
  return cached;
}

export const ROLES_MASTERCOPY = "0x9646fDAD06d3e24444381f44362a3B0eB343D337";
export const MODULE_PROXY_FACTORY = "0x000000000000aDdB49795b0f9bA5BC298cDda236";

export function rolesAbi(): any[] {
  return zodiacVendor().contracts.Roles.abi!;
}

/** Init code (creation bytecode + ABI-encoded constructor arguments) of a vendored contract. */
export function initCodeOf(name: "Roles" | "Integrity" | "Packer"): string {
  const c = zodiacVendor().contracts[name];
  return ethers.concat([c.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(c.constructorArgs.types, c.constructorArgs.values)]);
}

/** CREATE2 address through the ERC-2470 singleton factory for each vendored contract; throws on a mismatch. */
export function assertVendorCreate2(): Record<string, string> {
  const v = zodiacVendor();
  const out: Record<string, string> = {};
  for (const name of ["Roles", "Integrity", "Packer"] as const) {
    const c = v.contracts[name];
    const a = ethers.getCreate2Address(c.factory, c.salt, ethers.keccak256(initCodeOf(name)));
    if (a !== ethers.getAddress(c.address)) throw new Error(`${name}: CREATE2(${c.factory}, ${c.salt}, init code) = ${a}, the vendored file says ${c.address}`);
    if (ethers.getAddress(c.factory) !== ethers.getAddress(v.singletonFactory)) throw new Error(`${name}: factory ${c.factory} is not the ERC-2470 singleton`);
    out[name] = a;
  }
  const f = ethers.getCreate2Address(v.singletonFactory, v.moduleProxyFactory.salt, ethers.keccak256(v.moduleProxyFactory.initCode));
  if (f !== ethers.getAddress(v.moduleProxyFactory.address)) throw new Error(`ModuleProxyFactory: CREATE2 = ${f}, vendored ${v.moduleProxyFactory.address}`);
  out.ModuleProxyFactory = f;
  return out;
}

/** The chain holds exactly the verified code at every address the payout module relies on. */
export async function assertZodiacCode(provider: ethers.Provider): Promise<Record<string, string>> {
  const v = zodiacVendor();
  const want: Array<[string, string, string]> = [
    ["ERC-2470 singleton factory", v.singletonFactory, v.singletonFactoryRuntimeKeccak],
    ["Roles v2.1.0 mastercopy", v.contracts.Roles.address, v.contracts.Roles.runtimeKeccak],
    ["Roles library Integrity", v.contracts.Integrity.address, v.contracts.Integrity.runtimeKeccak],
    ["Roles library Packer", v.contracts.Packer.address, v.contracts.Packer.runtimeKeccak],
    ["ModuleProxyFactory", v.moduleProxyFactory.address, v.moduleProxyFactory.runtimeKeccak],
  ];
  const out: Record<string, string> = {};
  for (const [label, address, hash] of want) {
    const code = await provider.getCode(address);
    if (!code || code === "0x") throw new Error(`REFUSED: no ${label} at ${address} on this chain`);
    const got = ethers.keccak256(code);
    if (got.toLowerCase() !== hash.toLowerCase()) throw new Error(`REFUSED: ${label} at ${address} has runtime ${got}, the verified one is ${hash}`);
    out[label] = got;
  }
  return out;
}

type RpcSend = (method: string, params: unknown[]) => Promise<any>;

/**
 * Installs the ERC-2470 factory (code from the vendored runtime) and deploys Integrity, Packer, the Roles
 * mastercopy and the ModuleProxyFactory through it, so they land at their canonical addresses on a local chain.
 */
export async function installZodiacLocally(send: RpcSend, signer: ethers.Signer): Promise<void> {
  const v = zodiacVendor();
  await send("hardhat_setCode", [v.singletonFactory, v.singletonFactoryRuntime]);
  const factory = new ethers.Contract(v.singletonFactory, ["function deploy(bytes initCode, bytes32 salt) returns (address)"], signer);
  const provider = signer.provider!;
  const deploy = async (initCode: string, salt: string, address: string) => {
    if ((await provider.getCode(address)) !== "0x") return;
    await (await factory.deploy(initCode, salt, { gasLimit: 15_000_000 })).wait();
    if ((await provider.getCode(address)) === "0x") throw new Error(`local deploy of ${address} failed`);
  };
  for (const name of ["Integrity", "Packer", "Roles"] as const) await deploy(initCodeOf(name), v.contracts[name].salt, v.contracts[name].address);
  await deploy(v.moduleProxyFactory.initCode, v.moduleProxyFactory.salt, v.moduleProxyFactory.address);
}
