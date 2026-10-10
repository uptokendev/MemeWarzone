// DogeOS Chikyu testnet (chain 6281971) staging DEX: canonical Uniswap V3 on the official WDOGE.
//
// Same deploy shape as scripts/deploy-robinhood-testnet-infrastructure.ts:122-150 (the real 46630 V3
// stack), from the same pinned npm artifacts in tools/robinhood-testnet-infra, plus QuoterV2 from
// v3-periphery. Spec 2026-10-10-dogeos-foundation-launch-design.md §1 "Staging DEX": not the mock V3 set,
// whose pool has no slot0()/swap() for the gen-7 graduation path.
//
// The deploy refuses any chain except 6281971, or local 31337 with an explicit rehearsal flag. On 6281971
// the wrapped native must be the official WDOGE. No key is read here; the caller passes the signer.

import fs from "node:fs";
import path from "node:path";
import { Contract, ContractFactory, ZeroAddress, encodeBytes32String, getAddress, isAddress, keccak256 } from "ethers";
import type { BaseContract, Signer } from "ethers";

export const DOGEOS_V3_CHAIN_ID = 6281971;
export const LOCAL_REHEARSAL_CHAIN_ID = 31337;
/** Official WDOGE on Chikyu (spec "Verified chain facts"). */
export const DOGEOS_TESTNET_WDOGE = "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE";
export const DOGEOS_V3_DESCRIPTOR_LABEL = "DOGE";
/** Decision E6: the graduated pool is Uniswap V3 0.30%, tick spacing 60 (as assertFeeTierSpacing pins). */
export const DOGEOS_V3_FEE_TIER = 3000;
export const DOGEOS_V3_TICK_SPACING = 60n;

export const DOGEOS_V3_TOOL_ROOT = path.resolve(__dirname, "../../tools/robinhood-testnet-infra/node_modules");

/** The exact upstream generations the 46630 stack was built from (tools/robinhood-testnet-infra/package.json). */
export const DOGEOS_V3_SOURCE_IDENTITIES = {
  v3Core: "@uniswap/v3-core@1.0.1",
  v3Periphery: "@uniswap/v3-periphery@1.4.4",
  swapRouterContracts: "@uniswap/swap-router-contracts@1.3.1",
} as const;

const ARTIFACTS = {
  v3Factory: "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json",
  nftDescriptor: "@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json",
  tokenDescriptor:
    "@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json",
  positionManager: "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json",
  swapRouter02: "@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json",
  quoterV2: "@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json",
} as const;

export type DogeosV3ContractKey = keyof typeof ARTIFACTS;

export interface DogeosV3DeploymentEvidence {
  address: string;
  txHash: string;
  blockNumber: number;
  runtimeCodeHash: string;
}

export interface DogeosV3Stack {
  chainId: number;
  wrappedNative: string;
  feeTier: number;
  tickSpacing: bigint;
  sourceIdentities: typeof DOGEOS_V3_SOURCE_IDENTITIES;
  v3Factory: string;
  nftDescriptor: string;
  tokenDescriptor: string;
  positionManager: string;
  swapRouter02: string;
  quoterV2: string;
  deployments: Record<DogeosV3ContractKey, DogeosV3DeploymentEvidence>;
}

export interface DeployDogeosV3StackParams {
  signer: Signer;
  wrappedNative: string;
  chainId: number;
  allowLocalRehearsal?: boolean;
}

/** Pure target check: the allowed chain, and on 6281971 only the official WDOGE as the wrapped native. */
export function assertDogeosV3StackTarget(params: { chainId: number; wrappedNative: string; allowLocalRehearsal?: boolean }) {
  const { chainId, wrappedNative, allowLocalRehearsal } = params;
  const allowed = chainId === DOGEOS_V3_CHAIN_ID || (chainId === LOCAL_REHEARSAL_CHAIN_ID && allowLocalRehearsal === true);
  if (!allowed) {
    throw new Error(
      `DogeOS V3 stack: refusing chain ${chainId}; only ${DOGEOS_V3_CHAIN_ID}, or ${LOCAL_REHEARSAL_CHAIN_ID} with allowLocalRehearsal`,
    );
  }
  if (!isAddress(wrappedNative) || getAddress(wrappedNative) === ZeroAddress) {
    throw new Error(`DogeOS V3 stack: wrappedNative ${wrappedNative} is not a non-zero address`);
  }
  if (chainId === DOGEOS_V3_CHAIN_ID && getAddress(wrappedNative) !== getAddress(DOGEOS_TESTNET_WDOGE)) {
    throw new Error(`DogeOS V3 stack: on ${DOGEOS_V3_CHAIN_ID} wrappedNative must be the official WDOGE ${DOGEOS_TESTNET_WDOGE}, got ${wrappedNative}`);
  }
}

function readJson(relative: string): any {
  const absolute = path.join(DOGEOS_V3_TOOL_ROOT, relative);
  if (!fs.existsSync(absolute)) {
    throw new Error(
      `missing pinned Uniswap file ${absolute}; run npm install --prefix tools/robinhood-testnet-infra --no-package-lock`,
    );
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

/** The installed packages must be exactly the pinned generations; the tool installs without a lockfile. */
function assertInstalledSourceIdentities() {
  const installed = {
    v3Core: `@uniswap/v3-core@${readJson("@uniswap/v3-core/package.json").version}`,
    v3Periphery: `@uniswap/v3-periphery@${readJson("@uniswap/v3-periphery/package.json").version}`,
    swapRouterContracts: `@uniswap/swap-router-contracts@${readJson("@uniswap/swap-router-contracts/package.json").version}`,
  };
  for (const key of Object.keys(DOGEOS_V3_SOURCE_IDENTITIES) as (keyof typeof DOGEOS_V3_SOURCE_IDENTITIES)[]) {
    if (installed[key] !== DOGEOS_V3_SOURCE_IDENTITIES[key]) {
      throw new Error(`DogeOS V3 stack: installed ${installed[key]}, pinned ${DOGEOS_V3_SOURCE_IDENTITIES[key]}`);
    }
  }
}

function linkedBytecode(artifact: any, libraries: Record<string, string>): string {
  let bytecode = String(artifact.bytecode || "");
  if (!bytecode.startsWith("0x")) bytecode = `0x${bytecode}`;
  const chars = bytecode.slice(2).split("");
  for (const [sourceName, refs] of Object.entries<any>(artifact.linkReferences || {})) {
    for (const [libraryName, positions] of Object.entries<any>(refs || {})) {
      const address = libraries[libraryName] || libraries[`${sourceName}:${libraryName}`];
      if (!address) throw new Error(`missing linked library ${sourceName}:${libraryName}`);
      const replacement = address.toLowerCase().replace(/^0x/, "");
      for (const position of positions) {
        const start = Number(position.start) * 2;
        const length = Number(position.length) * 2;
        if (replacement.length !== length) throw new Error(`invalid linked address length for ${libraryName}`);
        chars.splice(start, length, ...replacement);
      }
    }
  }
  const linked = `0x${chars.join("")}`;
  if (linked.includes("__")) throw new Error("unlinked library placeholder left in bytecode");
  return linked;
}

async function deployArtifact(
  key: DogeosV3ContractKey,
  signer: Signer,
  args: unknown[],
  libraries: Record<string, string> = {},
): Promise<DogeosV3DeploymentEvidence> {
  const artifact = readJson(ARTIFACTS[key]);
  const factory = new ContractFactory(artifact.abi, linkedBytecode(artifact, libraries), signer);
  const contract: BaseContract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error(`${key} deployment transaction missing`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${key} deployment failed`);
  const address = await contract.getAddress();
  const code = await signer.provider!.getCode(address);
  if (!code || code === "0x") throw new Error(`${key}: runtime bytecode missing at ${address}`);
  return { address, txHash: tx.hash, blockNumber: receipt.blockNumber, runtimeCodeHash: keccak256(code) };
}

function requireBound(label: string, actual: string, expected: string) {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`DogeOS V3 stack: ${label} is ${actual}, expected ${expected}`);
  }
}

export async function deployDogeosV3Stack(params: DeployDogeosV3StackParams): Promise<DogeosV3Stack> {
  const { signer, chainId } = params;
  assertDogeosV3StackTarget(params);
  const provider = signer.provider;
  if (!provider) throw new Error("DogeOS V3 stack: signer has no provider");
  const connected = Number((await provider.getNetwork()).chainId);
  if (connected !== chainId) {
    throw new Error(`DogeOS V3 stack: chainId ${chainId} requested but the signer is connected to chain ${connected}`);
  }
  const wrappedNative = getAddress(params.wrappedNative);
  if ((await provider.getCode(wrappedNative)) === "0x") {
    throw new Error(`DogeOS V3 stack: wrappedNative ${wrappedNative} has no code on chain ${chainId}`);
  }
  assertInstalledSourceIdentities();

  const v3Factory = await deployArtifact("v3Factory", signer, []);
  const nftDescriptor = await deployArtifact("nftDescriptor", signer, []);
  const tokenDescriptor = await deployArtifact(
    "tokenDescriptor",
    signer,
    [wrappedNative, encodeBytes32String(DOGEOS_V3_DESCRIPTOR_LABEL)],
    { NFTDescriptor: nftDescriptor.address },
  );
  const positionManager = await deployArtifact("positionManager", signer, [v3Factory.address, wrappedNative, tokenDescriptor.address]);
  const swapRouter02 = await deployArtifact("swapRouter02", signer, [ZeroAddress, v3Factory.address, positionManager.address, wrappedNative]);
  const quoterV2 = await deployArtifact("quoterV2", signer, [v3Factory.address, wrappedNative]);

  const factoryRead = new Contract(v3Factory.address, ["function feeAmountTickSpacing(uint24) view returns (int24)"], provider);
  const spacing = BigInt(await factoryRead.feeAmountTickSpacing(DOGEOS_V3_FEE_TIER));
  if (spacing !== DOGEOS_V3_TICK_SPACING) {
    throw new Error(
      `V3 factory ${v3Factory.address}: fee ${DOGEOS_V3_FEE_TIER} has tick spacing ${spacing}, expected ${DOGEOS_V3_TICK_SPACING}`,
    );
  }

  const boundAbi = ["function factory() view returns (address)", "function WETH9() view returns (address)"];
  for (const [label, address] of [
    ["NPM", positionManager.address],
    ["router", swapRouter02.address],
    ["quoter", quoterV2.address],
  ] as const) {
    const bound = new Contract(address, boundAbi, provider);
    requireBound(`${label} factory`, await bound.factory(), v3Factory.address);
    requireBound(`${label} WETH9`, await bound.WETH9(), wrappedNative);
  }
  const descriptorRead = new Contract(tokenDescriptor.address, ["function WETH9() view returns (address)"], provider);
  requireBound("descriptor WETH9", await descriptorRead.WETH9(), wrappedNative);

  return {
    chainId,
    wrappedNative,
    feeTier: DOGEOS_V3_FEE_TIER,
    tickSpacing: spacing,
    sourceIdentities: DOGEOS_V3_SOURCE_IDENTITIES,
    v3Factory: v3Factory.address,
    nftDescriptor: nftDescriptor.address,
    tokenDescriptor: tokenDescriptor.address,
    positionManager: positionManager.address,
    swapRouter02: swapRouter02.address,
    quoterV2: quoterV2.address,
    deployments: { v3Factory, nftDescriptor, tokenDescriptor, positionManager, swapRouter02, quoterV2 },
  };
}
