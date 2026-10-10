// MuchFi (PancakeSwap V3 fork) on DogeOS Chikyū testnet (6281971): addresses, minimal ABIs and the fork guard.
//
// MuchFi publishes no source, so these ABIs are the minimal shapes proven against the real bytecode by
// test/MuchfiFork.facts.spec.ts. Addresses come from the plan's global constraints (spec §1).
import { AbiCoder, getCreate2Address, keccak256 } from "ethers";
import { network } from "hardhat";

export const CHIKYU_CHAIN_ID = 6281971;

export const MUCHFI = {
  WDOGE: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
  FACTORY: "0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B",
  POOL_DEPLOYER: "0x6c04e808d5FfFb597cb6a5b539f2a1dDF3529348",
  NPM: "0x7932C91f3BAD326ecd6C2bE81697D732714B9eC5",
  SMART_ROUTER: "0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB",
  SWAP_ROUTER: "0xd34FE9553CE3012F81c8a7D86F3063AcADb8201c",
  QUOTER_V2: "0x5DE1Ea595653419f295511DEb781b98387a77cc2",
} as const;

/** Pool init code hash: CREATE2(POOL_DEPLOYER, keccak(abi.encode(token0, token1, fee)), this). */
export const MUCHFI_POOL_INIT_CODE_HASH = "0xaf5299b6f16b0c8e07f2a9c2863ab244f4c405d6a2d552229605c5c1b5678b78";

/** The graduation tier: 1% fee, tick spacing 200 (3000 is not enabled on MuchFi). */
export const MUCHFI_FEE = 10000;
export const MUCHFI_TICK_SPACING = 200;
/** Full-range ticks for spacing 200: ±887272 floored to a multiple of 200. */
export const MUCHFI_MIN_TICK = -887200;
export const MUCHFI_MAX_TICK = 887200;

/** TickMath bounds, for direct pool.swap price limits. */
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

export const MUCHFI_FACTORY_ABI = [
  "function owner() view returns (address)",
  "function poolDeployer() view returns (address)",
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
] as const;

export const MUCHFI_NPM_ABI = [
  "function WETH9() view returns (address)",
  "function factory() view returns (address)",
  "function deployer() view returns (address)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
] as const;

/** SmartRouter: SwapRouter02 shape, exactInputSingle WITHOUT a deadline field. */
export const MUCHFI_SMART_ROUTER_ABI = [
  "function WETH9() view returns (address)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
] as const;

/** Periphery getters shared by NPM, SmartRouter, SwapRouter and QuoterV2 (PancakeV3 PeripheryImmutableState). */
export const MUCHFI_PERIPHERY_ABI = [
  "function WETH9() view returns (address)",
  "function factory() view returns (address)",
  "function deployer() view returns (address)",
] as const;

/** Pool: PancakeV3 slot0 with feeProtocol as uint32 (protocol fee per side packed as low|high<<16, denominator 10000). */
export const MUCHFI_POOL_ABI = [
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
] as const;

export const WDOGE_ABI = [
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

export function computeMuchfiPoolAddress(tokenA: string, tokenB: string, fee: number): string {
  const [token0, token1] = BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  const salt = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [token0, token1, fee]));
  return getCreate2Address(MUCHFI.POOL_DEPLOYER, salt, MUCHFI_POOL_INIT_CODE_HASH);
}

/** True only on the in-process hardhat network forked from Chikyū (hardhat.dogeos-testnet-fork.config.ts). */
export function isChikyuFork(): boolean {
  if (network.name !== "hardhat") return false;
  const cfg = network.config as { chainId?: number; forking?: { enabled?: boolean; url?: string } };
  return cfg.chainId === CHIKYU_CHAIN_ID && Boolean(cfg.forking?.url) && cfg.forking?.enabled !== false;
}

/** Skip unless running under the Chikyū fork config; MuchFi bytecode exists nowhere else. */
export function skipUnlessChikyuFork(ctx: Mocha.Context): void {
  if (isChikyuFork()) return;
  console.log("    [env] skipped: not a Chikyū fork (run with --config hardhat.dogeos-testnet-fork.config.ts)");
  ctx.skip();
}
