/**
 * Real Uniswap V3 (factory + NonfungiblePositionManager, the exact runtime bytecode deployed on Robinhood
 * mainnet 4663) installed at its canonical addresses on the plain in-process hardhat network, so the
 * Robinhood V2 graduation adapters run against real V3 math without a fork. WETH at its canonical
 * address is MockWETH9 (the NPM's WETH9 immutable points there). Storage the constructors would have
 * written is set explicitly: factory owner + fee tiers, NPM token ids starting at 1.
 *
 * Bytecode: test/fixtures/evmgen-rh-uniswap-v3-bytecode.json (read-only `cast code`).
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const FIXTURE = path.join(__dirname, "..", "fixtures", "evmgen-rh-uniswap-v3-bytecode.json");

export const RH_V3 = {
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  swapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
};

const word = (v: bigint) => ethers.toBeHex(v, 32);

export async function installRealV3() {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const [owner] = await ethers.getSigners();
  await network.provider.send("hardhat_setCode", [RH_V3.v3Factory, fx.v3Factory.code]);
  await network.provider.send("hardhat_setCode", [RH_V3.positionManager, fx.positionManager.code]);
  await network.provider.send("hardhat_setCode", [RH_V3.swapRouter02, fx.swapRouter02.code]);
  // SwapRouter02: amountInCached (slot 0) starts at type(uint256).max, as its constructor leaves it.
  await network.provider.send("hardhat_setStorageAt", [RH_V3.swapRouter02, word(0n), word((1n << 256n) - 1n)]);
  const wethArtifact = await ethers.getContractFactory("MockWETH9");
  const tmp = await wethArtifact.deploy();
  await network.provider.send("hardhat_setCode", [RH_V3.weth, await ethers.provider.getCode(await tmp.getAddress())]);

  // UniswapV3Factory: slots 0-2 are the deployer's transient `parameters`; owner = slot 3,
  // feeAmountTickSpacing = mapping at slot 4 (both read from 4663).
  await network.provider.send("hardhat_setStorageAt", [RH_V3.v3Factory, word(3n), word(BigInt(owner.address))]);
  for (const [fee, spacing] of [
    [500n, 10n],
    [3000n, 60n],
    [10000n, 200n],
  ]) {
    const slot = ethers.solidityPackedKeccak256(["uint256", "uint256"], [fee, 4n]);
    await network.provider.send("hardhat_setStorageAt", [RH_V3.v3Factory, slot, word(spacing)]);
  }
  // NonfungiblePositionManager: slot 13 packs uint176 _nextId (low) and uint80 _nextPoolId; both start at 1.
  // Only on first install: tokens minted by an earlier test in the same run keep their ids.
  const slot13 = await network.provider.send("eth_getStorageAt", [RH_V3.positionManager, word(13n), "latest"]);
  if (BigInt(slot13) === 0n) {
    await network.provider.send("hardhat_setStorageAt", [RH_V3.positionManager, word(13n), word((1n << 176n) | 1n)]);
  }

  return {
    v3Factory: await ethers.getContractAt(
      [
        "function getPool(address,address,uint24) view returns (address)",
        "function createPool(address,address,uint24) returns (address)",
        "function feeAmountTickSpacing(uint24) view returns (int24)",
      ],
      RH_V3.v3Factory,
    ),
    positionManager: await ethers.getContractAt(
      [
        "function ownerOf(uint256) view returns (address)",
        "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)",
      ],
      RH_V3.positionManager,
    ),
    weth: await ethers.getContractAt("MockWETH9", RH_V3.weth),
  };
}

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)",
];

/** Full-range liquidity in a (tokenA, tokenB, fee) pool at `priceBPerA` (raw B per raw A, wad), from `signer`. */
export async function seedFullRangePool(signer: any, tokenA: any, tokenB: any, fee: number, amountA: bigint, amountB: bigint) {
  const a = await tokenA.getAddress();
  const b = await tokenB.getAddress();
  const aIs0 = BigInt(a) < BigInt(b);
  const [t0, t1, amt0, amt1] = aIs0 ? [a, b, amountA, amountB] : [b, a, amountB, amountA];
  let x = 1n << 200n;
  const v = (amt1 << 192n) / amt0;
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  const npm = await ethers.getContractAt(NPM_ABI, RH_V3.positionManager, signer);
  await npm.createAndInitializePoolIfNecessary(t0, t1, fee, x);
  await tokenA.connect(signer).approve(RH_V3.positionManager, amountA);
  await tokenB.connect(signer).approve(RH_V3.positionManager, amountB);
  const spacing = fee === 500 ? 10 : fee === 3000 ? 60 : 200;
  const maxTick = Math.floor(887272 / spacing) * spacing;
  const block = await ethers.provider.getBlock("latest");
  await npm.mint({
    token0: t0,
    token1: t1,
    fee,
    tickLower: -maxTick,
    tickUpper: maxTick,
    amount0Desired: amt0,
    amount1Desired: amt1,
    amount0Min: 0,
    amount1Min: 0,
    recipient: signer.address,
    deadline: BigInt(block!.timestamp) + 3600n,
  });
}
