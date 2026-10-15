// Barkswap (Algebra Integral 1.2.1) on DogeOS Chikyu 6281971: addresses and fork helpers for the Bark fork tests.
// Addresses: docs/dogeos/barkswap-facts.md §1 (bytecode-matched against upstream v1.2.1-integral). Every helper
// acts on the in-process hardhat fork only (hardhat.dogeos-bark-fork.config.ts); nothing reaches Chikyu.
import { ethers, network } from "hardhat";
import type { Signer } from "ethers";

export const DOGEOS_CHIKYU_CHAIN_ID = 6281971n;
export const DOGEOS_CHIKYU_BLOCK_GAS_LIMIT = 10_000_000n;

/** The deployed Barkswap contracts (all created by `admin`, blocks 5,032,996 - 5,033,042), EIP-55 checksummed
 *  (the facts doc spells the router and QuoterV2 with a wrong checksum case). */
export const BARKSWAP = {
  factory: "0xF3961157f56C983316657f0267B4C04460beE43f",
  poolDeployer: "0x4151224471B0EeA41eE4295c632cc61779d339C2",
  customPoolEntryPoint: "0x19B1A502Ea56843343E60e44a4a95B3cf4C914f5",
  defaultPluginFactory: "0xa3411873111B2A6d2C107Ba146764C6E636d4b29",
  vaultFactory: "0x1dB26728A2f5E56A3652aE766301dBa038346b56",
  communityVault: "0xA305F8BDf7EaA3233b3918A39d1e0867c6116c83",
  swapRouter: "0x911E5A1630fD1768E5A1710DAAFaBb865cB79531",
  quoterV2: "0x187b41968063Cb8A04A5f4d2113844EF2Ba21493",
  nonfungiblePositionManager: "0xf596329a6c7E03F0708199cB5435f86783DB4302",
  wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
  /** factory owner and sole DEFAULT_ADMIN (an EOA) */
  admin: "0xFB1525e16FDA109a5180a3Ec23A7146b870E045b",
} as const;

export const CUSTOM_POOL_DEPLOYER_ROLE = ethers.id("CUSTOM_POOL_DEPLOYER");
export const POOLS_ADMINISTRATOR_ROLE = ethers.id("POOLS_ADMINISTRATOR");

/** Hardhat refuses calls at the forked block itself ("No known hardfork for historical block"), so every fork
 *  test first mines one local block on top of it (the research proof's workaround). Also asserts the chain. */
export async function readyFork(): Promise<{ forkBlock: number; block: number }> {
  const forking = (network.config as { forking?: { blockNumber?: number } }).forking;
  if (!forking?.blockNumber) throw new Error("not a forked network: run with --config hardhat.dogeos-bark-fork.config.ts");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== DOGEOS_CHIKYU_CHAIN_ID) throw new Error(`expected chain ${DOGEOS_CHIKYU_CHAIN_ID}, got ${chainId}`);
  let block = await ethers.provider.getBlockNumber();
  if (block <= forking.blockNumber) {
    await network.provider.send("evm_mine", []);
    block = await ethers.provider.getBlockNumber();
  }
  return { forkBlock: forking.blockNumber, block };
}

/** Typed handles on the deployed Barkswap contracts (interfaces from contracts/dogeos/barkswap/interfaces). */
export async function barkswapContracts() {
  return {
    factory: await ethers.getContractAt("IAlgebraFactory", BARKSWAP.factory),
    customPoolEntryPoint: await ethers.getContractAt("IAlgebraCustomPoolEntryPoint", BARKSWAP.customPoolEntryPoint),
    swapRouter: await ethers.getContractAt("ISwapRouter", BARKSWAP.swapRouter),
    swapRouterState: await ethers.getContractAt("IPeripheryImmutableState", BARKSWAP.swapRouter),
    swapRouterMulticall: await ethers.getContractAt("IMulticall", BARKSWAP.swapRouter),
    swapRouterPayments: await ethers.getContractAt("IPeripheryPayments", BARKSWAP.swapRouter),
    quoterV2: await ethers.getContractAt("IQuoterV2", BARKSWAP.quoterV2),
    nonfungiblePositionManager: await ethers.getContractAt("INonfungiblePositionManager", BARKSWAP.nonfungiblePositionManager),
    wdoge: await ethers.getContractAt("IWNativeToken", BARKSWAP.wdoge),
    wdogeMetadata: await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata", BARKSWAP.wdoge),
  };
}

/** The pool at `address` through the 1.2.1 IAlgebraPool interface. */
export async function algebraPool(address: string) {
  return ethers.getContractAt("IAlgebraPool", address);
}

/** The factory's AccessControlEnumerable surface (not part of IAlgebraFactory). */
export function factoryAccessControl() {
  return new ethers.Contract(
    BARKSWAP.factory,
    [
      "function hasRole(bytes32 role, address account) view returns (bool)",
      "function getRoleMemberCount(bytes32 role) view returns (uint256)",
      "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
    ],
    ethers.provider,
  );
}

/** Sets the fork balance of `address` to exactly `wei` native DOGE. */
export async function setNativeBalance(address: string, wei: bigint): Promise<void> {
  await network.provider.send("hardhat_setBalance", [address, ethers.toBeHex(wei)]);
}

/** Impersonates `address` on the fork (gas money included) and returns its signer. Undo with stopImpersonating. */
export async function impersonate(address: string, gasMoney: bigint = ethers.parseEther("10")): Promise<Signer> {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  if ((await ethers.provider.getBalance(address)) < gasMoney) await setNativeBalance(address, gasMoney);
  return ethers.getSigner(address);
}

export async function stopImpersonating(address: string): Promise<void> {
  await network.provider.send("hardhat_stopImpersonatingAccount", [address]);
}

/** Wraps `wei` of `signer`'s native DOGE into WDOGE (WDOGE.deposit on the fork). */
export async function fundWdoge(signer: Signer, wei: bigint): Promise<void> {
  const wdoge = await ethers.getContractAt("IWNativeToken", BARKSWAP.wdoge, signer);
  await (await wdoge.deposit({ value: wei })).wait();
}
