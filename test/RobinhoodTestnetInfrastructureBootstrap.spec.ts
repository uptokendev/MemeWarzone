import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

const TOOL_ROOT = path.resolve("tools/robinhood-testnet-infra/node_modules");
const SQRT_PRICE_1_1 = 2n ** 96n;
const FEE = 3000;

function loadArtifact(packagePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, packagePath), "utf8"));
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
        chars.splice(start, length, ...replacement);
      }
    }
  }
  return `0x${chars.join("")}`;
}

async function deployArtifact(artifact: any, args: any[] = [], libraries: Record<string, string> = {}) {
  const [signer] = await ethers.getSigners();
  const factory = new ethers.ContractFactory(artifact.abi, linkedBytecode(artifact, libraries), signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function loadAuthority() {
  return Function("specifier", "return import(specifier)")(
    pathToFileURL(path.resolve("scripts/robinhoodTestnetInfrastructureAuthority.mjs")).href,
  );
}

async function loadCurrentStageAuthority() {
  return Function("specifier", "return import(specifier)")(
    pathToFileURL(path.resolve("scripts/robinhoodCurrentStageAuthority.mjs")).href,
  );
}

async function deployStack() {
  const [deployer, updater, other] = await ethers.getSigners();
  const WETH = await ethers.getContractFactory("RobinhoodTestnetWETH9", deployer);
  const weth = await WETH.deploy(true);
  await weth.waitForDeployment();

  const factoryArtifact = loadArtifact("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const nftDescriptorArtifact = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json");
  const descriptorArtifact = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json");
  const npmArtifact = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const routerArtifact = loadArtifact("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

  const v3Factory = await deployArtifact(factoryArtifact);
  const nftDescriptor = await deployArtifact(nftDescriptorArtifact);
  const descriptor = await deployArtifact(descriptorArtifact, [await weth.getAddress(), ethers.encodeBytes32String("ETH")], { NFTDescriptor: await nftDescriptor.getAddress() });
  const npm = await deployArtifact(npmArtifact, [await v3Factory.getAddress(), await weth.getAddress(), await descriptor.getAddress()]);
  const router = await deployArtifact(routerArtifact, [ethers.ZeroAddress, await v3Factory.getAddress(), await npm.getAddress(), await weth.getAddress()]);

  const Oracle = await ethers.getContractFactory("RobinhoodTestnetEthUsdOracle", deployer);
  const oracle = await Oracle.deploy(await updater.getAddress(), 2500n * 10n ** 8n, true);
  await oracle.waitForDeployment();

  const Token = await ethers.getContractFactory("MockERC20", deployer);
  const token = await Token.deploy("Robinhood Test Token", "RTT", ethers.parseEther("1000000"), await deployer.getAddress());
  await token.waitForDeployment();

  return { deployer, updater, other, weth, v3Factory, npm, router, oracle, token };
}

describe("Robinhood 46630 testnet infrastructure bootstrap", function () {
  it("pins the canonical upstream generations and fail-closes the real broadcast boundary", async function () {
    const authority = await loadAuthority();
    expect(authority.BOOTSTRAP_SOURCE_IDENTITIES.v3Core).to.equal("@uniswap/v3-core@1.0.1");
    expect(authority.BOOTSTRAP_SOURCE_IDENTITIES.v3Periphery).to.equal("@uniswap/v3-periphery@1.4.4");
    expect(authority.BOOTSTRAP_SOURCE_IDENTITIES.swapRouter02).to.equal("@uniswap/swap-router-contracts@1.3.1");
    expect(() => authority.validateBootstrapBoundary({ chainId: 4663, networkName: "robinhoodMainnet" })).to.throw("production chain 4663");
    expect(() => authority.validateBootstrapBoundary({ chainId: 31337, networkName: "hardhat", broadcastToken: authority.INFRA_BROADCAST_TOKEN })).to.throw("requires robinhoodTestnet / 46630");
    expect(() => authority.validateBootstrapBoundary({ chainId: 46630, networkName: "robinhoodTestnet", broadcastToken: authority.INFRA_BROADCAST_TOKEN, manifestExists: true })).to.throw("refusing overwrite");
  });

  it("WETH performs deposit, transfer and withdraw", async function () {
    const { deployer, other, weth } = await deployStack();
    await weth.deposit({ value: ethers.parseEther("2") });
    expect(await weth.balanceOf(await deployer.getAddress())).to.equal(ethers.parseEther("2"));
    await weth.transfer(await other.getAddress(), ethers.parseEther("0.5"));
    expect(await weth.balanceOf(await other.getAddress())).to.equal(ethers.parseEther("0.5"));
    await weth.connect(other).withdraw(ethers.parseEther("0.25"));
    expect(await weth.balanceOf(await other.getAddress())).to.equal(ethers.parseEther("0.25"));
  });

  it("deploys canonical V3 factory/NPM/SwapRouter02 with exact bindings and fee 3000", async function () {
    const { weth, v3Factory, npm, router } = await deployStack();
    expect(await v3Factory.feeAmountTickSpacing(FEE)).to.equal(60);
    expect(await npm.factory()).to.equal(await v3Factory.getAddress());
    expect(await npm.WETH9()).to.equal(await weth.getAddress());
    expect(await router.factory()).to.equal(await v3Factory.getAddress());
    expect(await router.WETH9()).to.equal(await weth.getAddress());

    const authority = await loadAuthority();
    const routerCode = await ethers.provider.getCode(await router.getAddress());
    expect(authority.requireSwapRouter02Runtime(routerCode)).to.equal(true);
    expect(() => authority.requireSwapRouter02Runtime(`0x600063${authority.LEGACY_V3_EXACT_INPUT_SINGLE_SELECTOR}14600057`)).to.throw("0x04e45aaf");
  });

  it("creates a real V3 pool, mints an NFT position, and executes no-deadline exactInputSingle", async function () {
    const { deployer, weth, v3Factory, npm, router, token } = await deployStack();
    const wethAddress = await weth.getAddress();
    const tokenAddress = await token.getAddress();
    const [token0, token1] = tokenAddress.toLowerCase() < wethAddress.toLowerCase() ? [tokenAddress, wethAddress] : [wethAddress, tokenAddress];

    await weth.deposit({ value: ethers.parseEther("100") });
    await token.approve(await npm.getAddress(), ethers.MaxUint256);
    await weth.approve(await npm.getAddress(), ethers.MaxUint256);
    await npm.createAndInitializePoolIfNecessary(token0, token1, FEE, SQRT_PRICE_1_1);
    const pool = await v3Factory.getPool(token0, token1, FEE);
    expect(pool).to.not.equal(ethers.ZeroAddress);

    const block = await ethers.provider.getBlock("latest");
    await npm.mint({
      token0,
      token1,
      fee: FEE,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: ethers.parseEther("50"),
      amount1Desired: ethers.parseEther("50"),
      amount0Min: 0,
      amount1Min: 0,
      recipient: await deployer.getAddress(),
      deadline: Number(block!.timestamp) + 3600,
    });
    expect(await npm.balanceOf(await deployer.getAddress())).to.equal(1);

    const tokenIn = tokenAddress;
    const tokenOut = wethAddress;
    await token.approve(await router.getAddress(), ethers.parseEther("1"));
    const before = await weth.balanceOf(await deployer.getAddress());
    await router.exactInputSingle({
      tokenIn,
      tokenOut,
      fee: FEE,
      recipient: await deployer.getAddress(),
      amountIn: ethers.parseEther("1"),
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
    expect(await weth.balanceOf(await deployer.getAddress())).to.be.greaterThan(before);
  });

  it("oracle enforces updater authority and valid monotonically increasing positive rounds", async function () {
    const { updater, other, oracle } = await deployStack();
    const first = await oracle.latestRoundData();
    expect(first[0]).to.equal(1);
    expect(first[1]).to.be.greaterThan(0);
    expect(first[3]).to.be.greaterThan(0);
    expect(first[4]).to.equal(first[0]);

    await expect(oracle.connect(other).updateAnswer(2600n * 10n ** 8n)).to.be.revertedWithCustomError(oracle, "UnauthorizedUpdater");
    await expect(oracle.connect(updater).updateAnswer(0)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
    await expect(oracle.connect(updater).updateAnswer(-1)).to.be.revertedWithCustomError(oracle, "InvalidAnswer");
    await oracle.connect(updater).updateAnswer(2600n * 10n ** 8n);
    const second = await oracle.latestRoundData();
    expect(second[0]).to.equal(2);
    expect(second[4]).to.equal(2);
  });

  it("oracle preflight rejects stale, zero, negative and malformed rounds and accepts a refreshed valid round", async function () {
    const authority = await loadAuthority();
    const now = 1_800_000_000;
    const base = { decimals: 8, roundId: 2, answer: 2500n * 10n ** 8n, updatedAt: now - 1, answeredInRound: 2, currentTimestamp: now, maxAgeSeconds: 900 };
    expect(authority.validateOracleObservation(base)).to.equal(true);
    expect(() => authority.validateOracleObservation({ ...base, updatedAt: now - 901 })).to.throw("stale");
    expect(() => authority.validateOracleObservation({ ...base, answer: 0 })).to.throw("invalid");
    expect(() => authority.validateOracleObservation({ ...base, answer: -1 })).to.throw("invalid");
    expect(() => authority.validateOracleObservation({ ...base, answeredInRound: 1 })).to.throw("invalid");
    expect(() => authority.validateOracleObservation({ ...base, roundId: 0 })).to.throw("invalid");
    expect(authority.validateOracleObservation({ ...base, roundId: 3, answeredInRound: 3, answer: 2600n * 10n ** 8n, updatedAt: now })).to.equal(true);
  });

  it("locally deployed identities satisfy the current-stage infrastructure qualification surfaces", async function () {
    const { weth, v3Factory, npm, router, oracle } = await deployStack();
    const current = await loadCurrentStageAuthority();
    const infra = await loadAuthority();
    const addresses = {
      weth: await weth.getAddress(),
      v3Factory: await v3Factory.getAddress(),
      positionManager: await npm.getAddress(),
      swapRouter: await router.getAddress(),
      nativeUsdOracle: await oracle.getAddress(),
    };
    for (const [label, address] of Object.entries(addresses)) current.requireRuntimeCode(label, await ethers.provider.getCode(address));
    current.requireBoundAddress("position manager factory", await npm.factory(), addresses.v3Factory);
    current.requireBoundAddress("position manager WETH", await npm.WETH9(), addresses.weth);
    current.requireBoundAddress("swap router factory", await router.factory(), addresses.v3Factory);
    current.requireBoundAddress("swap router WETH", await router.WETH9(), addresses.weth);
    infra.requireSwapRouter02Runtime(await ethers.provider.getCode(addresses.swapRouter));
    expect(await v3Factory.feeAmountTickSpacing(FEE)).to.be.greaterThan(0);
    const round = await oracle.latestRoundData();
    const block = await ethers.provider.getBlock("latest");
    infra.validateOracleObservation({ decimals: await oracle.decimals(), roundId: round[0], answer: round[1], updatedAt: round[3], answeredInRound: round[4], currentTimestamp: block!.timestamp, maxAgeSeconds: 900 });

    expect(() => current.validateOperatorBoundary({ chainId: 31337 })).to.throw("requires chain 46630");
    expect(network.name).to.equal("hardhat");
  });

  it("does not auto-select historical Stonk or Robinhood-mainnet infrastructure", async function () {
    const source = fs.readFileSync(path.resolve("scripts/deploy-robinhood-testnet-infrastructure.ts"), "utf8").toLowerCase();
    const forbidden = [
      "0x37e402b8081efce1d82a09a066512278006e4691",
      "0xfeccb63cd759d768538458ea56f47ea8004323c1",
      "0xbc82a9aa33ff24fcd56d36a0fb0a2105b193a327",
      "0x1b32f47434a7ef83e97d0675c823e547f9266725",
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    ];
    for (const address of forbidden) expect(source).to.not.include(address);
  });
});
